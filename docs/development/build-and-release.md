# Build and release

## Building

```bash
bun run build            # ./dist/slackcli for the current platform
bun run build:linux      # bun-linux-x64   → dist/slackcli-linux
bun run build:macos      # bun-darwin-x64  → dist/slackcli-macos
bun run build:windows    # bun-windows-x64 → dist/slackcli-windows.exe
bun run build:all        # all three
```

All of them go through `scripts/build.ts`, a thin wrapper around
`bun build --compile --minify --bytecode --splitting --format=esm` whose real
jobs are refusing a Bun older than 1.4.1 (see [Why Bun is pinned](#why-bun-is-pinned))
and injecting the version:

```
--define __APP_VERSION__=<version from package.json>
```

A local (untargeted) build also gets `--sourcemap`; cross-compiled targets do
not. The release workflow calls `bun build` directly with the same flags, so a
change to them must land in both places.

### Why bytecode

`--bytecode` ships precompiled JavaScriptCore bytecode, so the binary skips
parsing at startup. Measured on Linux x64 with Bun 1.4.1 (#137):

| | Plain build | `--bytecode` |
| --- | --- | --- |
| `slackcli --help` cold start | ~130 ms | ~80 ms |
| `bun-linux-x64` | 78 MB | 82 MB |
| `bun-darwin-x64` | 67 MB | 71 MB |
| `bun-windows-x64` | 83 MB | 87 MB |

The few extra MB are well inside the 150 MB budget. Two things to know:

- `--bytecode` switches the default output format to CommonJS. `--format=esm`
  keeps the module semantics of a plain build and is what `--splitting`
  requires. `--splitting` changes nothing today — there are no dynamic
  `import()`s to split on — but lets a future lazily-loaded command stay out of
  the startup path.
- Bytecode is tied to the JavaScriptCore version of the Bun that emits it, so
  release binaries must be built by the Bun that CI pins. Bun 1.4.1 is also the
  first release whose `--bytecode` cross-compiles to Windows x64.
- CI only runs the Linux x64 binary, so `release.yml` runs `--version` and
  `--help` on each binary its own runner can execute (Linux x64, macOS arm64
  after signing, Windows x64) before uploading it. The matrix `smoke` flag is
  `false` for cross-arch targets.

## Versioning

`src/version.ts` resolves the version in one place:

```ts
export function getAppVersion(): string {
  if (typeof __APP_VERSION__ !== 'undefined') return __APP_VERSION__;   // compiled binary
  return packageJson.version;                                           // running from source
}
```

`isRunningUnderBun()` distinguishes a source run from a compiled binary. It is
what disables the self-updater and the "update available" notice during
development.

**`package.json` `version` is the single source of truth.** The release workflow
refuses to build if the pushed tag disagrees with it.

## CI

`ci.yml` and `test.yml` run on every push and PR to `main`. `sonar.yml`
([below](#sonarqube-cloud)) also runs on pushes to `main` and on same-repo PRs.

**`ci.yml`**

1. `workflow-lint` — runs the pinned `actionlint` pre-commit hook over
   `.github/workflows/`. This exists because an invalid workflow file is a
   *startup* failure: GitHub cannot parse it, so it never resolves the `on:`
   triggers, the run carries no logs, and its scheduled runs are never created.
   `stale.yml` shipped that way and never ran once. CI runs the *same hook id* as
   `.pre-commit-config.yaml`, so local and CI cannot drift. `pre-commit` itself
   is installed from `.github/requirements/pre-commit.txt`, a hash-locked
   requirements file (`pip install --require-hashes --only-binary :all: -r
   …`) pinning `pre-commit` and every transitive dependency, so CI never
   resolves a floating version or builds an sdist. Dependabot bumps it (see
   `dependabot.yml`); regenerate the hashes with the command in
   `.github/requirements/pre-commit.in` after bumping the pin by hand.
2. `test` — install, `bun run type-check`, `bun run build`, verify the binary
   answers `--version` and `--help`, and enforce the **150 MB binary size
   budget**.

**`test.yml`** — `bun test`, plus an integration job that builds the binary and
smoke-tests it.

Other policy workflows: `pr-linked-issue.yml` (a PR must link an open issue),
`signed-commits.yml`, and `stale.yml`.

### SonarQube Cloud

**`sonar.yml`** runs on every push to `main` and every PR from a branch in this
repo. It installs with Bun 1.4.1, runs `bun test --coverage
--coverage-reporter=lcov`, then scans with `SonarSource/sonarqube-scan-action`
(pinned to a commit SHA) and waits for the quality gate
(`-Dsonar.qualitygate.wait=true`). Analysis settings live in
`sonar-project.properties` at the repo root:

- **What is analysed:** `src/`, `scripts/`, `web/` and `.github/`, so the
  workflow (`githubactions:*`) and website rules keep running. `*.test.ts` files
  count as tests. Generated `web/` output (the synced docs, `dist/`, the
  release data) is excluded.
- **What counts toward coverage:** only the CLI in `src/`, read from
  `coverage/lcov.info`. This is a scoping decision (#295): `web/` and `.github/`
  are not measured by `bun test` at all, `scripts/` is build tooling, and the
  `src/index.ts` bootstrap and the type-only `src/types/` carry no logic worth a
  coverage target.
- **The quality gate** is SonarCloud's default "Sonar way". Its coverage
  condition is **at least 80% on new code**, not on the overall figure, so a PR
  that adds untested lines (typically in `src/commands/`) fails the gate.
- **What counts as new code.** On a PR it is always the PR's own diff. On
  `main` the project uses SonarCloud's **Previous version** definition: new code
  is everything since the analysed version last changed. The workflow sends
  `sonar.projectVersion` from `package.json` (validated as SemVer first), so the
  period resets when a release PR bumps the version, and `main`'s gate judges
  what is going into the next release. Leave the SonarCloud setting on
  "Previous version"; without a version it would never reset (#306).

Results: [shaharia-lab_slackcli on SonarQube Cloud](https://sonarcloud.io/project/overview?id=shaharia-lab_slackcli).

- **Non-blocking (phase 1).** The scan step has `continue-on-error: true`, so a
  failed quality gate or a scanner error shows only as an annotation on the run.
  A broken `SONAR_TOKEN` also stays green, so read the step's output and the
  dashboard rather than trusting the check colour. Making the check blocking,
  and then required, are later phases.
- **Fork and Dependabot PRs are skipped**, not failed: GitHub gives neither of
  them Actions secrets, so the job's `if:` runs it only for pushes and for
  same-repo PRs not opened by Dependabot.
- **Secrets and permissions.** `SONAR_TOKEN` (an Actions secret) reaches only the
  scan step, through `env:`. The workflow token is `contents: read`; PR
  decoration comes from the SonarCloud GitHub App.
- **Automatic Analysis must stay off** in the SonarCloud project (Administration
  → Analysis Method). With it on, the CI scan fails with "You are running CI
  analysis while Automatic Analysis is enabled", and `continue-on-error` hides
  that.

### Why Bun is pinned

CI (`ci.yml`, `test.yml`, `sonar.yml`) and the release workflow all pin **Bun 1.4.1**. Bun
1.3.12 produced corrupt macOS code signatures
([oven-sh/bun#29120](https://github.com/oven-sh/bun/issues/29120)), and 1.4.1 is
the first release where `--bytecode` works for every target we ship (see
[Why bytecode](#why-bytecode)), so it is also the minimum for building from
source: `scripts/build.ts` exits with `slackcli builds need Bun >= 1.4.1` on an
older Bun instead of Bun's own `format must be 'cjs' when bytecode is true`
error. Bump the pin deliberately, in all three workflow files at once, after
reading Bun's release notes; if the new pin is the new minimum, raise
`MIN_BUN_VERSION` in `scripts/build.ts` and `engines.bun` in `package.json` with
it.

### Why the 150 MB budget matters

It is not cosmetic — it is the constraint that shaped `auth login-auto`. A
bundled Playwright would blow the budget, which is why `cdp-client.ts` exists as
a hand-rolled DevTools Protocol client instead. Anything that would add tens of
megabytes needs a different design, not a raised limit.

## Releasing

*When* releases happen — the weekly schedule, what counts as releasable,
out-of-band fixes, versioning and deprecation — is policy, and lives in
[RELEASING.md](../../RELEASING.md). This section covers the mechanics.

Releases are triggered by pushing a `v*.*.*` tag, and the repo has a `/release`
skill that drives the whole sequence. By hand it is:

1. Open the release issue and get it labelled `ready-for-pr` (the constitution
   applies to releases too).
2. On a branch: bump `version` in `package.json`, promote the Unreleased section
   of `CHANGELOG.md`.
3. Open the PR linking that issue; merge once green.
4. Push the annotated tag from `main`:

   ```bash
   git tag -a v0.9.2 -m "v0.9.2" && git push origin v0.9.2
   ```

`release.yml` then:

1. **`verify-version`** — fails fast if the tag does not match `package.json`,
   so binaries can never ship with a version baked in that drifts from source.
2. **`build`** — a matrix of five targets: `linux-x64`, `linux-arm64`,
   `darwin-x64`, `darwin-arm64`, `windows-x64`.
3. **`release`** — collects the artefacts, generates `checksums.txt` with
   `sha256sum`, and publishes a GitHub Release with generated notes. It also
   exposes the four Unix binaries' checksums from that file as job outputs.
4. **`update-homebrew`** — mints a short-lived token from a GitHub App scoped to
   `shaharia-lab/homebrew-tap` only, and updates the formula there. The formula
   `sha256` values come from the `release` job's `checksums.txt` (nothing is
   re-downloaded), and the job fails before writing to the tap if any of them
   is missing or is not a 64-character hex SHA256.

Permissions are least-privilege throughout: the workflow default is
`contents: read`, and only the `release` job opts into `contents: write`.

If a tag was pushed with the wrong version, fix `package.json` on `main`, then
delete and re-push the tag — the error message from `verify-version` says the
same.

## The self-updater

`src/lib/updater.ts` backs `slackcli update`. Four behaviours worth knowing
before you change it:

- It **fails closed** on verification: the release asset's digest must be a
  `sha256:` digest published by GitHub and must match what was downloaded.
  A missing or unexpected digest aborts the update rather than installing an
  unverified binary.
- It **refuses to act** when installed via Homebrew (detected from the exec path
  containing `homebrew`, `Cellar`, or `linuxbrew`) or when running under Bun.
- It **refuses before downloading** when `isInstallDirWritable()` finds the
  binary's folder unwritable (replacing the binary renames inside that folder),
  and `getUpdateCommand()` then suggests `sudo slackcli update` — on Windows the
  command is unchanged and `getUpdateHint()` adds "from an Administrator
  terminal". The notice, `update check` and the refusal message all build their
  advice with `getUpdateHint()`; the notice builds it only when it prints. The Homebrew
  check comes first. slackcli never elevates itself.
  On Windows the check creates and removes a probe file, because `access(W_OK)`
  there ignores folder ACLs and always reports a folder writable. Tests make a
  folder unwritable with `chmod 0o555` and skip those cases as root or on
  Windows, where mode bits do not apply.
- The background check runs at most every 24 hours, caches to
  `~/.config/slackcli/update-check.json`, and prints its notice to **stderr** on
  `beforeExit` — so it never contaminates `--json` on stdout. Its GitHub lookup
  is aborted after `BACKGROUND_CHECK_TIMEOUT_MS` (1.5 s; `update` / `update check`
  use `FOREGROUND_CHECK_TIMEOUT_MS`, 10 s), a failure is recorded as `failedAt`
  and suppresses retries for `RETRY_AFTER_FAILURE_MS` (1 h), and the notice uses
  the version fetched in the same run when there is one, the cached one
  otherwise. It is skipped
  entirely for `update` and `update check`, which report versions themselves,
  and a successful self-update rewrites the cache with the installed version so
  the next run does not show a stale notice. It is also skipped entirely (no
  cache read, no request, no notice) when `isUpdateNotifierDisabled()` finds
  `SLACKCLI_NO_UPDATE_NOTIFIER` or `CI` set to anything but empty, `0` or
  `false`. Tests point the cache at a temp directory with
  `setUpdateCacheDirForTesting()`, never at the real `~/.config/slackcli`, and
  pass an explicit `env` (e.g. `{}`) to `notifyIfUpdateAvailable()`: CI runners
  set `CI`, so a test that relies on `process.env` would silently skip its
  assertions there.
