# Developer documentation

## Start here

```bash
git clone https://github.com/shaharia-lab/slackcli.git
cd slackcli
bun install
pre-commit install          # do not skip this
bun run dev --help
```

## Pages

| Page | What it covers |
|---|---|
| [Development setup](setup.md) | Toolchain, pre-commit hooks, signed commits, the everyday loop |
| [Architecture](architecture.md) | Dual auth, `SlackClient` dispatch, workspace storage, browser capture |
| [Project structure](project-structure.md) | What each file in `src/` is responsible for |
| [Testing](testing.md) | Layout, conventions, and how to write a test that belongs here |
| [Build and release](build-and-release.md) | Version injection, CI, tagging, Homebrew tap |
| [Adding a command](adding-a-command.md) | A worked example, end to end |
| [Website](website.md) | The Astro site in `web/`, and how docs become pages |

## The short version

- **TypeScript on Bun.** No transpile step in development — `bun run dev` runs
  the source. Ships as a single compiled binary per platform.
- **Commands parse and print; `src/lib/` does the work.** If something is worth
  testing, it does not belong in `src/commands/`.
- **Two auth types, one seam.** `SlackClient.request()` dispatches to the Slack
  SDK or to raw `fetch` based on `auth_type`. Add API calls there.
- **Four dependencies** (`@slack/web-api`, `commander`, `chalk`, `ora`) and a
  150 MB binary budget. New dependencies need a real justification.

## Before opening a pull request

This repository's contribution policy is stricter than most and is binding on
human and AI contributors alike:

1. **An issue must exist first**, filed with one of the issue templates (bug
   report, feature request, improvement) and stating WHAT, WHY, and optionally
   HOW. Blank issues are disabled.
2. **The issue must carry the `ready-for-pr` label** before a PR is opened.
3. The PR must link that issue and follow the PR template, checklist included —
   a workflow enforces the link.
4. Type-check, tests, and pre-commit hooks pass; commits are signed.

Full text: [CONTRIBUTING.md](../../CONTRIBUTING.md), and the constitution at the
top of [CLAUDE.md](../../CLAUDE.md).

Security issues go through [SECURITY.md](../../SECURITY.md), never a public
issue.
