# SlackCLI Documentation

SlackCLI is an unofficial command-line interface for Slack workspaces, built with
TypeScript and Bun. It talks to Slack either through a standard Slack app token
or through the tokens a signed-in browser session already holds — so you can
automate Slack without creating a Slack app.

> **Disclaimer:** not affiliated with, endorsed by, or supported by Slack
> Technologies. Slack has an [official CLI](https://docs.slack.dev/tools/slack-cli/).

## User guide

Start here if you want to *use* SlackCLI.

| Page | What it covers |
|---|---|
| [Installation](user-guide/installation.md) | Homebrew, pre-built binaries, from source, updating |
| [Authentication](user-guide/authentication.md) | The four ways to sign in, and which one to pick |
| [Workspaces and profiles](user-guide/workspaces.md) | Several workspaces, several identities per workspace |
| [Slack links and timestamps](user-guide/links-and-timestamps.md) | Paste a Slack URL anywhere an ID is expected |
| [Conversations](user-guide/conversations.md) | List channels and DMs, read history, threads, unreads |
| [Messages](user-guide/messages.md) | Send, reply, edit, react, draft, attach files, Block Kit |
| [Search](user-guide/search.md) | Search messages, channels, and people |
| [Saved items](user-guide/saved.md) | Read your "saved for later" list |
| [Canvas](user-guide/canvas.md) | List canvases and read them as Markdown |
| [Scripting and JSON output](user-guide/scripting.md) | Piping into `jq`, exit codes, automation patterns |
| [Troubleshooting](user-guide/troubleshooting.md) | Auth failures, permissions, update problems |

## Developer documentation

Start here if you want to *work on* SlackCLI.

| Page | What it covers |
|---|---|
| [Development setup](development/setup.md) | Toolchain, pre-commit hooks, the everyday loop |
| [Architecture](development/architecture.md) | How the pieces fit: commands, client, auth, storage |
| [Project structure](development/project-structure.md) | What each file in `src/` is responsible for |
| [Testing](development/testing.md) | Test layout, conventions, and how to write a good one |
| [Build and release](development/build-and-release.md) | Version injection, CI, tagging, Homebrew tap |
| [Adding a command](development/adding-a-command.md) | A worked example, end to end |
| [Website](development/website.md) | The Astro site in `web/`, and how docs become pages |

## Contributing

Read [CONTRIBUTING.md](../CONTRIBUTING.md) before opening a pull request. In
short: **every PR needs a linked GitHub issue, and that issue must carry the
`ready-for-pr` label.** The full policy — which is binding on human and AI
contributors alike — lives in [CLAUDE.md](../CLAUDE.md).

For security reports, follow [SECURITY.md](../SECURITY.md).
