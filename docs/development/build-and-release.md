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
`bun build --compile --minify` whose one real job is injecting the version:

```
--define __APP_VERSION__=<version from package.json>
```

A local (untargeted) build also gets `--sourcemap`; cross-compiled targets do
not.

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

Two workflows run on every push and PR to `main`.

**`ci.yml`**

1. `workflow-lint` — runs the pinned `actionlint` pre-commit hook over
   `.github/workflows/`. This exists because an invalid workflow file is a
   *startup* failure: GitHub cannot parse it, so it never resolves the `on:`
   triggers, the run carries no logs, and its scheduled runs are never created.
   `stale.yml` shipped that way and never ran once. CI runs the *same hook id* as
   `.pre-commit-config.yaml`, so local and CI cannot drift.
2. `test` — install, `bun run type-check`, `bun run build`, verify the binary
   answers `--version` and `--help`, and enforce the **150 MB binary size
   budget**.

**`test.yml`** — `bun test`, plus an integration job that builds the binary and
smoke-tests it.

Other policy workflows: `pr-linked-issue.yml` (a PR must link an open issue),
`signed-commits.yml`, and `stale.yml`.

### Why Bun is pinned

CI and the release workflow both pin **Bun 1.3.13**. Bun 1.3.12 produced corrupt
macOS code signatures ([oven-sh/bun#29120](https://github.com/oven-sh/bun/issues/29120)).
Bump the pin deliberately, in both files at once, after reading Bun's release
notes.

### Why the 150 MB budget matters

It is not cosmetic — it is the constraint that shaped `auth login-auto`. A
bundled Playwright would blow the budget, which is why `cdp-client.ts` exists as
a hand-rolled DevTools Protocol client instead. Anything that would add tens of
megabytes needs a different design, not a raised limit.

## Releasing

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
   `sha256sum`, and publishes a GitHub Release with generated notes.
4. **`update-homebrew`** — mints a short-lived token from a GitHub App scoped to
   `shaharia-lab/homebrew-tap` only, and updates the formula there.

Permissions are least-privilege throughout: the workflow default is
`contents: read`, and only the `release` job opts into `contents: write`.

If a tag was pushed with the wrong version, fix `package.json` on `main`, then
delete and re-push the tag — the error message from `verify-version` says the
same.

## The self-updater

`src/lib/updater.ts` backs `slackcli update`. Three behaviours worth knowing
before you change it:

- It **fails closed** on verification: the release asset's digest must be a
  `sha256:` digest published by GitHub and must match what was downloaded.
  A missing or unexpected digest aborts the update rather than installing an
  unverified binary.
- It **refuses to act** when installed via Homebrew (detected from the exec path
  containing `homebrew`, `Cellar`, or `linuxbrew`) or when running under Bun.
- The background check runs at most every 24 hours, caches to
  `~/.config/slackcli/update-check.json`, and prints its notice to **stderr** on
  `beforeExit` — so it never contaminates `--json` on stdout.
