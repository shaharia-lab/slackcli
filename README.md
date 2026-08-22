# SlackCLI

![GitHub Downloads (all assets, all releases)](https://img.shields.io/github/downloads/shaharia-lab/slackcli/total)
[![Release](https://img.shields.io/github/v/release/shaharia-lab/slackcli)](https://github.com/shaharia-lab/slackcli/releases)
[![Stars](https://img.shields.io/github/stars/shaharia-lab/slackcli)](https://github.com/shaharia-lab/slackcli/stargazers)
[![License](https://img.shields.io/github/license/shaharia-lab/slackcli)](https://github.com/shaharia-lab/slackcli/blob/main/LICENSE)
[![Last Commit](https://img.shields.io/github/last-commit/shaharia-lab/slackcli)](https://github.com/shaharia-lab/slackcli/commits/main)

> **Disclaimer:** This is an unofficial, open-source CLI tool for interacting with Slack. It is not affiliated with, endorsed by, or supported by Slack Technologies. Slack has an official CLI — see the [Slack CLI documentation](https://docs.slack.dev/tools/slack-cli/) for the officially supported tooling.

A fast, developer-friendly command-line interface tool for interacting with Slack workspaces. Built with TypeScript and Bun, it enables AI agents, automation tools, and developers to access Slack functionality directly from the terminal.

## Demo

Sign in, browse conversations, search the workspace, read a thread from a permalink, reply, react, read a canvas as Markdown, and pipe `--json` into `jq` — all from the terminal.

https://github.com/user-attachments/assets/90cf1c89-2859-4b84-a731-b0ff3e1172f3

## Features

- 🔐 **Dual Authentication Support**: Standard Slack tokens (xoxb/xoxp) or browser tokens (xoxd/xoxc)
- 🪄 **Automatic Browser Login**: sign into Slack in a browser and the tokens are captured for you
- 🎯 **Easy Token Extraction**: Automatically parse tokens from browser cURL commands
- 🏢 **Multi-Workspace Management**: Manage multiple Slack workspaces with ease
- 💬 **Conversation Management**: List channels, read messages, send messages
- 🎉 **Message Reactions**: Add emoji reactions to messages programmatically
- 📄 **Canvas Support**: List and read Slack canvas documents as markdown
- 🚀 **Fast & Lightweight**: Built with Bun for blazing fast performance
- 🔄 **Auto-Update**: Built-in self-update mechanism
- 🎨 **Beautiful Output**: Colorful, user-friendly terminal output

## Installation

### Homebrew (macOS and Linux)

```bash
brew tap shaharia-lab/tap
brew install slackcli
```

To upgrade to the latest version:

```bash
brew upgrade slackcli
```

### Pre-built Binaries

#### Linux (x86_64)
```bash
curl -L https://github.com/shaharia-lab/slackcli/releases/latest/download/slackcli-linux -o slackcli
chmod +x slackcli
mkdir -p ~/.local/bin && mv slackcli ~/.local/bin/
```

#### Linux (arm64)
```bash
curl -L https://github.com/shaharia-lab/slackcli/releases/latest/download/slackcli-linux-arm64 -o slackcli
chmod +x slackcli
mkdir -p ~/.local/bin && mv slackcli ~/.local/bin/
```

#### macOS (Intel)
```bash
curl -L https://github.com/shaharia-lab/slackcli/releases/latest/download/slackcli-macos -o slackcli
chmod +x slackcli
mkdir -p ~/.local/bin && mv slackcli ~/.local/bin/
```

#### macOS (Apple Silicon)
```bash
curl -L https://github.com/shaharia-lab/slackcli/releases/latest/download/slackcli-macos-arm64 -o slackcli
chmod +x slackcli
mkdir -p ~/.local/bin && mv slackcli ~/.local/bin/
```

#### Windows
Download `slackcli-windows.exe` from the [latest release](https://github.com/shaharia-lab/slackcli/releases/latest) and add it to your PATH.

### From Source

```bash
# Clone the repository
git clone https://github.com/shaharia-lab/slackcli.git
cd slackcli

# Install dependencies
bun install

# Build binary
bun run build
```


## Documentation

Full documentation lives in [`docs/`](docs/README.md).

**User guide** — [installation](docs/user-guide/installation.md) ·
[authentication](docs/user-guide/authentication.md) ·
[workspaces & profiles](docs/user-guide/workspaces.md) ·
[Slack links & timestamps](docs/user-guide/links-and-timestamps.md) ·
[conversations](docs/user-guide/conversations.md) ·
[messages](docs/user-guide/messages.md) ·
[search](docs/user-guide/search.md) ·
[saved items](docs/user-guide/saved.md) ·
[canvas](docs/user-guide/canvas.md) ·
[scripting & JSON](docs/user-guide/scripting.md) ·
[troubleshooting](docs/user-guide/troubleshooting.md)

**Developer docs** — [setup](docs/development/setup.md) ·
[architecture](docs/development/architecture.md) ·
[project structure](docs/development/project-structure.md) ·
[testing](docs/development/testing.md) ·
[build & release](docs/development/build-and-release.md) ·
[adding a command](docs/development/adding-a-command.md)

## Authentication

SlackCLI works with two kinds of credentials: **standard** Slack app tokens
(`xoxb-*` / `xoxp-*`) and **browser** session tokens (`xoxd-*` + `xoxc-*`). There
are four ways to get signed in:

```bash
# 1. Automatic browser login (easiest) — sign in once, every workspace enrolled
slackcli auth login-auto

# 2. Standard Slack app token
slackcli auth login --token=xoxb-YOUR-TOKEN --workspace-name="My Team"

# 3. Parse a cURL command copied from browser DevTools
slackcli auth parse-curl --login

# 4. Browser session tokens by hand
slackcli auth extract-tokens          # prints the guide
slackcli auth login-browser --xoxd=xoxd-... --xoxc=xoxc-... --workspace-url=https://yourteam.slack.com
```

Which to pick, what `login-auto` does with your browser profile, the security
model, and the OAuth scopes each command needs are all in the
[authentication guide](docs/user-guide/authentication.md).

## Quick tour

```bash
# Conversations
slackcli conversations list --types=public_channel
slackcli conversations read C1234567890 --limit=50
slackcli conversations unread

# Messages — paste a Slack link instead of juggling IDs
slackcli messages send --recipient-id=C1234567890 --message="Hello team!"
slackcli messages send --permalink="https://myteam.slack.com/archives/C123/p1234567890123456" --message="On it"
slackcli messages react --permalink="$LINK" --emoji=+1
slackcli messages edit --channel-id=C123 --timestamp=1234567890.123456 --message="Corrected"

# Search, saved items, canvases
slackcli search messages "deploy failed" --in=engineering
slackcli saved list --state=to_do
slackcli canvas read F1234567890

# Anything that returns data speaks JSON
slackcli conversations read C1234567890 --json | jq '.messages[].text'

# Several workspaces, or several identities in one workspace
slackcli conversations list --workspace=automation-bot
```

`slackcli <group> --help` prints the authoritative options for your version. For
everything else — Block Kit tables and Markdown blocks, file uploads, drafts,
pagination, profiles — see the [user guide](docs/user-guide/README.md).

## Configuration

Configuration lives in `~/.config/slackcli/` (directory mode `0700`):

| File | Contents |
|---|---|
| `workspaces.json` | Workspace credentials (mode `0600`) |
| `update-check.json` | Cached update check, refreshed at most daily |
| `browser-profile/` | The browser profile used by `auth login-auto` |

`workspaces.json` and `browser-profile/` both hold live credentials — do not
commit, sync, or share them. `slackcli auth logout` clears both.

## Development

```bash
bun install
pre-commit install          # enforces the same checks CI runs
bun run dev --help          # run from source
bun test                    # tests
bun run type-check          # bunx tsc --noEmit
bun run build               # ./dist/slackcli
```

See the [developer docs](docs/development/README.md) for the architecture, the
project layout, testing conventions, and the release process.

## Contributing

Contributions are welcome, and the process is a little stricter than most repos:

1. **Open an issue first**, describing WHAT the change is, WHY it is needed, and
   optionally HOW.
2. **Wait for the `ready-for-pr` label.** This is how the maintainer decides
   which features belong in the CLI, and it locks the feature to your PR.
3. Fork, branch, and open a pull request that **links the issue**. A workflow
   enforces the link.
4. Make sure type-check, tests, and pre-commit hooks pass, and that your commits
   are signed.

The full policy is in [CONTRIBUTING.md](CONTRIBUTING.md) and
[CLAUDE.md](CLAUDE.md). Security issues go through [SECURITY.md](SECURITY.md),
never a public issue.

## Troubleshooting

Common problems — expired tokens, missing OAuth scopes, permission errors,
`login-auto` not finding a browser, update failures — are covered in the
[troubleshooting guide](docs/user-guide/troubleshooting.md).

## License

MIT License - see [LICENSE](LICENSE) file for details

## Support

- 🐛 [Report Issues](https://github.com/shaharia-lab/slackcli/issues)
- 💬 [Discussions](https://github.com/shaharia-lab/slackcli/discussions)
- 📧 Email: support@shaharia.com

## 🤝 Contributors

A huge thanks to the amazing people who have contributed to SlackCLI!

<a href="https://github.com/shaharia-lab/slackcli/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=shaharia-lab/slackcli" />
</a>

## Acknowledgments

- Built with [Bun](https://bun.sh)
- Powered by [@slack/web-api](https://slack.dev/node-slack-sdk/)
- Inspired by [gscli](https://github.com/shaharia-lab/gscli)

---

**Made with ❤️ by Shaharia Lab**
