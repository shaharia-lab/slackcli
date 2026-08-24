# Development setup

## Prerequisites

- [Bun](https://bun.sh) 1.0+ (CI pins **1.3.13** — see
  [build and release](build-and-release.md#why-bun-is-pinned))
- TypeScript 5.x (installed as a dev dependency)
- [pre-commit](https://pre-commit.com) — **required**, `brew install pre-commit`
  or `pip install pre-commit`
- Optional: Chrome, Edge, Chromium, or Brave, to exercise `auth login-auto`

## First run

```bash
git clone https://github.com/shaharia-lab/slackcli.git
cd slackcli
bun install
pre-commit install     # required — constitution §5, not optional
```

`pre-commit install` wires up the same checks CI runs, so you find breakage
before you push instead of in a red PR. Working hooks are a prerequisite for
contributing here: if a hook needs a tool this machine does not have, install
it before you start rather than working without the check.

## Everyday commands

```bash
bun run dev --help                          # run from source
bun run dev conversations list --json       # any command, no build step

bun test                                    # whole suite
bun test src/lib/curl-parser.test.ts        # one file
bun test --watch                            # while iterating

bun run type-check                          # bunx tsc --noEmit

bun run build                               # ./dist/slackcli for this platform
bun run build:all                           # linux + macos + windows
```

There is no watch/rebuild step for normal work — `bun run dev` executes the
TypeScript directly.

## What the hooks enforce

`.pre-commit-config.yaml` runs on every commit:

| Hook | Why |
|---|---|
| `trailing-whitespace`, `end-of-file-fixer` | Keeps diffs clean |
| `check-yaml`, `check-json`, `check-merge-conflict` | Catches unparseable files |
| `no-commit-to-branch` (`main`, `master`) | Work happens on a branch |
| `actionlint` | An invalid workflow file is a *startup* failure — no logs, and scheduled runs are silently never created. CI runs the same pinned hook id, so local and CI cannot drift. |
| `bun run type-check` | Types must pass |
| `bun test` | Tests must pass |

Run them all by hand with `pre-commit run --all-files`.

**Never bypass a hook** — no `git commit --no-verify` / `-n`, no `SKIP=`, no
re-running a commit with checks disabled. A failing hook means fix the code.
This is constitution §5 in [CLAUDE.md](../../CLAUDE.md), and it binds AI agents
as strictly as it binds people.

## Signed commits

Commits must be signed — there is a `Signed Commits` workflow that enforces it.
If you have not set signing up:

```bash
git config --global commit.gpgsign true
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519.pub
```

Then add the same public key to GitHub as a **signing key** (separate from an
authentication key). See [CONTRIBUTING.md](../../CONTRIBUTING.md#signed-commits-required).

## Before you open a pull request

The repository policy is binding, and it is stricter than most:

1. **An issue must exist first**, describing WHAT, WHY, and optionally HOW.
2. **The issue must carry the `ready-for-pr` label.** A PR opened before the
   issue is triaged is likely to be rejected even if the code is good.
3. The PR must link that issue — a `PR must link an open issue` workflow checks
   this.
4. Type-check, tests, and hooks must pass; commits must be signed.

Full text: [CONTRIBUTING.md](../../CONTRIBUTING.md) and the constitution in
[CLAUDE.md](../../CLAUDE.md).

## Local config while developing

Running from source uses the same `~/.config/slackcli/workspaces.json` as an
installed binary. If you want a throwaway identity for testing, add it under its
own `--profile` and pass `--workspace=<profile>` rather than changing your
default.

The self-updater and its "update available" notice are disabled automatically
when running under Bun, so `bun run dev` will never nag you or try to replace a
binary that does not exist.
