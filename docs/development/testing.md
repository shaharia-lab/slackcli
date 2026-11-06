# Testing

Tests use **Bun's native test runner**. There is no Jest, no Vitest, no config
file to learn.

```bash
bun test                                  # everything
bun test src/lib/curl-parser.test.ts      # one file
bun test --watch                          # while iterating
bun test -t "enterprise"                  # by test name
```

`bun test` also runs as a pre-commit hook and in CI, so a failing test blocks the
commit, not just the PR.

## Layout

Tests live **beside the code they cover**:

```
src/lib/curl-parser.ts
src/lib/curl-parser.test.ts
```

`src/lib/curl-parser.test.ts` is the reference: it is the most thoroughly
covered file in the repo and shows the house style. Read it before writing a new
suite.

## What is actually tested

Roughly two thirds of `src/lib` is test code, and the distribution is
deliberate:

- **Pure functions get exhaustive coverage** — parsers (`curl-parser`,
  `slack-url-parser`, `canvas-parser`, `mrkdwn`), the workspace key/resolution
  logic, and formatters. These carry the tricky rules, so they carry the tests.
- **Impure edges get seams, not mocks of the world.** `cdp-client` is driven
  through a `CdpSocket` interface so a session can be unit-tested with no
  browser; only `connectCdpSocket`, the untestable transport edge, is left
  uncovered — and it is kept a few lines long for exactly that reason.
- **Command files have thin tests.** They are argument plumbing; anything worth
  asserting should have been pushed down into `src/lib/`.

## Conventions

**Use `bun:test` imports directly.**

```ts
import { afterEach, describe, expect, it } from 'bun:test';
```

**Subclass rather than mock the network.** The established pattern for
`SlackClient` is a test subclass that overrides `request()` and records calls:

```ts
class TestSlackClient extends SlackClient {
  public readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];

  override async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ method, params });
    return { ok: true, /* canned response */ };
  }
}
```

This asserts on the *exact* method and params sent to Slack — which is what
regressions actually look like here (a dropped `parse: 'none'`, a wrong endpoint
for one auth type).

**Never touch the real config.** Anything that writes to disk uses a temp
directory:

```ts
const dir = await mkdtemp(join(tmpdir(), 'slackcli-'));
afterEach(() => rm(dir, { recursive: true, force: true }));
```

**Restore environment variables.** `browser-launcher.test.ts` snapshots and
restores `SLACKCLI_BROWSER`, `SLACKCLI_BROWSER_PROFILE`, `PATH`, and
`LOCALAPPDATA` — a developer with one of those set locally must not see
different results from CI.

**Test both auth types** whenever you touch a method that branches on
`auth_type`. That branch is where this codebase's bugs live.

**Name the behaviour, not the function.** Existing tests read like
`it('honours SLACKCLI_BROWSER over the built-in table')` and
`it('returns null when SLACKCLI_BROWSER points at nothing, rather than falling
back')` — the name states the rule, so a failure tells you what broke without
opening the file.

**A local stand-in for Slack goes behind `FAKE_SLACK_ORIGIN`.** The browser
transport refuses any workspace URL that is not an `https` `slack.com` origin
(#513), so a test profile cannot point at `http://127.0.0.1:<port>`. Store
`FAKE_SLACK_ORIGIN` (`https://acme.slack.com`) from
`src/test-support/fake-slack.ts` instead and reroute fetch to the local server:
in-process with `globalThis.fetch = fakeSlackFetch(serverUrl, realFetch)`, and
for a CLI subprocess with
`[process.execPath, 'run', '--preload', FAKE_SLACK_PRELOAD, entry, ...]` plus
`[FAKE_SLACK_SERVER_ENV]: serverUrl` in its env (`--preload` goes after `run`).
Nothing outside `*.test.ts` imports these, so the binary has no bypass.

**No network, no real Slack, no live credentials.** Tests must pass offline on a
machine that has never authenticated.

## CI

Three workflows exercise tests:

- **Tests** (`test.yml`) — `unit-tests` runs `bun test`; `integration-tests`
  builds the binary and smoke-tests `--help` and `--version` on the real
  artefact.
- **CI** (`ci.yml`) — lints workflow files with `actionlint`, then type-checks,
  builds, verifies the binary runs, and enforces the 150 MB size budget.
- **SonarQube Cloud** (`sonar.yml`) — runs
  `bun test --coverage --coverage-reporter=lcov` and uploads the analysis plus
  `coverage/lcov.info` to SonarQube Cloud. It is non-blocking for now (see
  [build and release](build-and-release.md#sonarqube-cloud)).

To produce the same coverage report locally, run
`bun test --coverage --coverage-reporter=lcov`. It writes `coverage/lcov.info`,
which is git-ignored.

See [build and release](build-and-release.md).
