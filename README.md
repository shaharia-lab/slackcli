# SlackCLI

![GitHub Downloads (all assets, all releases)](https://img.shields.io/github/downloads/shaharia-lab/slackcli/total)
[![Release](https://img.shields.io/github/v/release/shaharia-lab/slackcli)](https://github.com/shaharia-lab/slackcli/releases)
[![Stars](https://img.shields.io/github/stars/shaharia-lab/slackcli)](https://github.com/shaharia-lab/slackcli/stargazers)
[![License](https://img.shields.io/github/license/shaharia-lab/slackcli)](https://github.com/shaharia-lab/slackcli/blob/main/LICENSE)
[![Last Commit](https://img.shields.io/github/last-commit/shaharia-lab/slackcli)](https://github.com/shaharia-lab/slackcli/commits/main)

> **Disclaimer:** This is an unofficial, open-source CLI tool for interacting with Slack. It is not affiliated with, endorsed by, or supported by Slack Technologies. Slack has an official CLI — see the [Slack CLI documentation](https://docs.slack.dev/tools/slack-cli/) for the officially supported tooling.

A fast, developer-friendly command-line interface tool for interacting with Slack workspaces. Built with TypeScript and Bun, it enables AI agents, automation tools, and developers to access Slack functionality directly from the terminal.

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

## Authentication

SlackCLI supports two authentication methods:

### 1. Standard Slack App Tokens (Recommended for Production)

Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps) and obtain a bot token (xoxb-*) or user token (xoxp-*).

```bash
slackcli auth login --token=xoxb-YOUR-TOKEN --workspace-name="My Team"
```

### 2. Automatic Browser Login (Easiest)

Sign into Slack in a browser and let SlackCLI capture the tokens. No Slack app, no DevTools, no copy-paste.

```bash
slackcli auth login-auto
```

A browser window opens on Slack. Sign in as you normally would, and SlackCLI enrols **every workspace you are signed into** — one sign-in covers them all.

| Option | Purpose |
|---|---|
| `--workspace-url <url>` | Open a specific workspace instead of the Slack home |
| `--timeout <seconds>` | How long to wait for sign-in (default `300`) |
| `--headless` | No visible window — only works once you are already signed in |
| `SLACKCLI_BROWSER` | Path to a browser, if yours is not auto-detected |
| `SLACKCLI_BROWSER_PROFILE` | Override the profile directory |

**Requirements:** Chrome, Edge, Chromium, or Brave installed. Nothing is downloaded and no extra dependency is installed — SlackCLI drives the browser you already have.

**Why you sign in again the first time.** SlackCLI runs the browser against its own profile in `~/.config/slackcli/browser-profile`, separate from your everyday browsing. It has to: since Chrome 136 the browser refuses remote debugging against the default profile, so your existing session cannot be reused. The profile persists, so **only the first run needs interaction** — after that the window opens and closes on its own.

**Security notes.**

- Token values are never printed.
- **The browser profile is a credential store.** While it exists, `login-auto` can re-mint working tokens with no prompt. `slackcli auth logout` therefore deletes it along with `workspaces.json`; pass `--keep-browser-session` to keep it signed in.
- Only `https://` URLs on a `slack.com` host are ever paired with your session cookie — a URL read from the browser that points anywhere else is refused.
- While the browser is open it exposes a DevTools port on loopback that any local process could connect to. SlackCLI closes the browser as soon as capture finishes, and also on `Ctrl-C` or termination.
- Credentials land in `~/.config/slackcli/workspaces.json` (mode `0600`); the profile directory is `0700` on macOS and Linux (Windows uses ACL defaults).

### 3. Browser Session Tokens (Manual)

Extract tokens from your browser session by hand. No Slack app creation required!

```bash
# Step 1: Get extraction guide
slackcli auth extract-tokens

# Step 2: Login with extracted tokens
slackcli auth login-browser \
  --xoxd=xoxd-YOUR-TOKEN \
  --xoxc=xoxc-YOUR-TOKEN \
  --workspace-url=https://yourteam.slack.com
```

**How to Extract Browser Tokens:**

1. Open your Slack workspace in a web browser
2. Open Developer Tools (F12)
3. Go to Network tab
4. Send a message or refresh
5. Find a Slack API request
6. Extract:
   - `xoxd` token from Cookie header (d=xoxd-...)
   - `xoxc` token from request payload ("token":"xoxc-...")

### 4. Parse cURL Command

The easiest way to extract browser tokens is to copy a Slack API request as cURL and let SlackCLI parse it automatically!

```bash
# Step 1: In browser DevTools, right-click any Slack API request
#         → Copy → Copy as cURL

# Step 2: Interactive mode (recommended) - just paste and press Enter twice
slackcli auth parse-curl --login

# Alternative: Read directly from clipboard
slackcli auth parse-curl --from-clipboard --login

# Alternative: Pipe from clipboard or file
pbpaste | slackcli auth parse-curl --login
cat curl-command.txt | slackcli auth parse-curl --login
```

This automatically extracts:
- Workspace URL and name
- xoxd token from cookies
- xoxc token from request data

## Usage

### Authentication Commands

```bash
# Sign in via a browser; tokens are captured automatically
slackcli auth login-auto

# Refresh tokens later without any interaction (profile stays signed in)
slackcli auth login-auto --headless

# List all authenticated workspaces
slackcli auth list

# Set default workspace
slackcli auth set-default T1234567

# Remove a workspace
slackcli auth remove T1234567

# Logout from all workspaces (also clears the login-auto browser profile)
slackcli auth logout

# Logout but keep the browser signed in
slackcli auth logout --keep-browser-session
```

### Multiple Profiles for One Workspace

By default each Slack workspace is stored once. To keep **more than one identity
for the same workspace** — for example a browser-authenticated user for search
and drafts alongside a bot token for unattended jobs — give each login a
`--profile` name:

```bash
# A user identity (browser auth)
slackcli auth login-browser \
  --xoxd=xoxd-... --xoxc=xoxc-... \
  --workspace-url=https://example.slack.com \
  --profile=rafael

# A bot identity in the same workspace
slackcli auth login \
  --token=xoxb-... \
  --workspace-name=example \
  --profile=automation-bot
```

Select a profile anywhere `--workspace` is accepted:

```bash
slackcli search messages "after:2026-07-01" --workspace=rafael --json
slackcli messages send --recipient-id=C123 --message="Done" --workspace=automation-bot
```

Notes:

- **Backward compatible.** Existing `workspaces.json` files and single-identity
  setups keep working unchanged — `--profile` is optional.
- Re-authenticating the **same** identity refreshes its stored tokens in place.
- Logging in a **second** identity for a workspace **without** `--profile` is
  saved under an auto-generated key (e.g. `T123-2`) instead of overwriting the
  first. The chosen key is printed after login.
- `auth list`, `auth set-default`, and `auth remove` accept a profile name,
  workspace ID, or workspace name. If a bare workspace ID/name matches more than
  one profile, SlackCLI asks you to pick a profile instead of guessing.

### Slack Links and Timestamps

Anywhere the CLI takes a channel, user, or canvas ID, you can paste the Slack URL
instead — the form "Copy link" actually gives you:

```bash
# These are equivalent
slackcli conversations read C1234567890
slackcli conversations read https://myteam.slack.com/archives/C1234567890
```

| Pasted value | Understood as |
|---|---|
| `https://myteam.slack.com/archives/C1234567890` | channel `C1234567890` |
| `https://myteam.slack.com/archives/D0987654321` | DM `D0987654321` |
| `https://myteam.slack.com/team/U9876543210` | user `U9876543210` |
| `https://myteam.slack.com/docs/T012AB/F1234567890` | canvas `F1234567890` |

Timestamps work the same way — the permalink form is accepted wherever the dotted
API form is:

| Pasted value | Understood as |
|---|---|
| `p1234567890123456` | `1234567890.123456` |
| `1234567890123456` | `1234567890.123456` |
| `1234567890.123456` | unchanged |

For commands that target one specific message, `--permalink` replaces the channel
and timestamp in one go:

```bash
# Instead of this
slackcli messages react --channel-id=C1234567890 --timestamp=1234567890.123456 --emoji=heart

# Just paste the link
slackcli messages react --permalink="https://myteam.slack.com/archives/C1234567890/p1234567890123456" --emoji=heart
```

`--permalink` is available on `messages send`, `messages react`, `messages edit`,
`messages draft`, `conversations read`, and `conversations get`. Pass either
`--permalink` or the explicit inputs, not both. When the link points at a threaded
reply, `--thread-ts` consumers correctly use the *parent* message.

Bare IDs and dotted timestamps keep working exactly as before.

### Conversation Commands

```bash
# List all conversations
slackcli conversations list

# List only public channels
slackcli conversations list --types=public_channel

# List DMs
slackcli conversations list --types=im

# Read recent messages from a channel
slackcli conversations read C1234567890

# Read a specific thread
slackcli conversations read C1234567890 --thread-ts=1234567890.123456

# Read with custom limit
slackcli conversations read C1234567890 --limit=50

# Get JSON output (includes ts and thread_ts for replies)
slackcli conversations read C1234567890 --json

# Read the thread a message link points at
slackcli conversations read --permalink="https://myteam.slack.com/archives/C1234567890/p1234567890123456"

# Get one specific message from its link
slackcli conversations get --permalink="https://myteam.slack.com/archives/C1234567890/p1234567890123456"
```

### Message Commands

```bash
# Send message to a channel
slackcli messages send --recipient-id=C1234567890 --message="Hello team!"

# Send DM to a user
slackcli messages send --recipient-id=U9876543210 --message="Hey there!"

# Reply to a thread
slackcli messages send --recipient-id=C1234567890 --thread-ts=1234567890.123456 --message="Great idea!"

# Send a message with a file attachment
slackcli messages send --recipient-id=C1234567890 --message="Here is the file" --file=./report.pdf

# Send a native Block Kit table (not a Markdown or CSV code block)
slackcli messages send \
  --recipient-id=C1234567890 \
  --message="Project status table" \
  --blocks='[
    {
      "type": "table",
      "column_settings": [{"is_wrapped": true}, {"align": "right"}],
      "rows": [
        [
          {
            "type": "rich_text",
            "elements": [{"type": "rich_text_section", "elements": [{"type": "text", "text": "Project", "style": {"bold": true}}]}]
          },
          {
            "type": "rich_text",
            "elements": [{"type": "rich_text_section", "elements": [{"type": "text", "text": "Status", "style": {"bold": true}}]}]
          }
        ],
        [
          {
            "type": "rich_text",
            "elements": [{"type": "rich_text_section", "elements": [{"type": "link", "text": "SlackCLI", "url": "https://github.com/shaharia-lab/slackcli"}]}]
          },
          {"type": "raw_text", "text": "Ready"}
        ]
      ]
    }
  ]'

# Send standard Markdown for Slack to render natively
slackcli messages send \
  --recipient-id=C1234567890 \
  --message="Release notes" \
  --blocks='[{"type":"markdown","text":"# Release notes\n\n- [x] Build\n- [ ] Deploy\n\nSee the [runbook](https://example.com/runbook)."}]'

# Edit an existing message you posted
slackcli messages edit --channel-id=C1234567890 --timestamp=1234567890.123456 --message="Corrected message"

# Create a draft message in a channel (only works with browser session tokens)
slackcli messages draft --recipient-id=C1234567890 --message="Hello team!"

# Add emoji reaction to a message
slackcli messages react --channel-id=C1234567890 --timestamp=1234567890.123456 --emoji=+1

# More reaction examples
slackcli messages react --channel-id=C1234567890 --timestamp=1234567890.123456 --emoji=heart
slackcli messages react --channel-id=C1234567890 --timestamp=1234567890.123456 --emoji=fire
slackcli messages react --channel-id=C1234567890 --timestamp=1234567890.123456 --emoji=eyes

# Target a message by its permalink instead of channel + timestamp
slackcli messages react --permalink="https://myteam.slack.com/archives/C1234567890/p1234567890123456" --emoji=+1
slackcli messages edit --permalink="https://myteam.slack.com/archives/C1234567890/p1234567890123456" --message="Corrected message"

# Reply in the thread a link points at
slackcli messages send --permalink="https://myteam.slack.com/archives/C1234567890/p1234567890123456" --message="Great idea!"
```

File uploads require Slack workspace permissions that allow file upload, such as `files:write` for standard Slack app tokens.

`--blocks` accepts a JSON array of [Block Kit blocks](https://docs.slack.dev/reference/block-kit/blocks/), including native [`table` blocks](https://docs.slack.dev/reference/block-kit/blocks/table-block/) and [`markdown` blocks](https://docs.slack.dev/reference/block-kit/blocks/markdown-block/). Native markdown blocks use standard Markdown rather than Slack mrkdwn and support features such as headings, task lists, syntax-highlighted code blocks, and Markdown tables. Pass JSON inline as above, or store the array in a file and use `--blocks=@blocks.json`. The required `--message` text is used as the notification and accessibility fallback. Structured blocks work with both standard Slack tokens and browser-session authentication. `--blocks` and `--file` cannot be used together.

Editing only works on messages posted by the authenticated user or app; ephemeral messages cannot be edited.

**Common emoji names:**
- `+1` or `thumbsup` - 👍
- `heart` - ❤️
- `fire` - 🔥
- `eyes` - 👀
- `tada` - 🎉
- `rocket` - 🚀

### Canvas Commands

```bash
# List canvases in the workspace
slackcli canvas list
slackcli canvas list --limit=50
slackcli canvas list --channel=C1234567890

# Read canvas content as markdown
slackcli canvas read F1234567890

# Read canvas in JSON format (includes markdown field)
slackcli canvas read F1234567890 --json

# Read raw HTML (no conversion)
slackcli canvas read F1234567890 --raw

# Read the canvas associated with a channel
slackcli canvas read --channel=C1234567890

# Read a canvas from its Slack URL
slackcli canvas read https://myteam.slack.com/docs/T012AB/F1234567890
```

### Update Commands

```bash
# Check for updates
slackcli update check

# Update to latest version
slackcli update
```

### Multi-Workspace Usage

```bash
# Use specific workspace by ID
slackcli conversations list --workspace=T1234567

# Use specific workspace by name
slackcli conversations list --workspace="My Team"
```

## Configuration

Configuration is stored in `~/.config/slackcli/`:

- `workspaces.json` - Workspace credentials
- `config.json` - User preferences (future)

## Development

### Prerequisites

- Bun v1.0+
- TypeScript 5.x+

### Setup

```bash
# Install dependencies
bun install

# Run in development mode
bun run dev --help

# Build binary
bun run build

# Build for all platforms
bun run build:all

# Type check
bun run type-check
```

### Project Structure

```
slackcli/
├── src/
│   ├── index.ts              # CLI entry point
│   ├── commands/             # Command implementations
│   │   ├── auth.ts
│   │   ├── conversations.ts
│   │   ├── messages.ts
│   │   └── update.ts
│   ├── lib/                  # Core library
│   │   ├── auth.ts
│   │   ├── workspaces.ts
│   │   ├── slack-client.ts
│   │   ├── formatter.ts
│   │   └── updater.ts
│   └── types/                # Type definitions
│       └── index.ts
├── .github/workflows/        # CI/CD
└── dist/                     # Build output
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Troubleshooting

### Authentication Issues

**Standard Tokens:**
- Ensure your token has the required OAuth scopes
- Check token validity in your Slack app settings

**Browser Tokens:**
- Tokens expire with your browser session
- Extract fresh tokens if authentication fails
- Verify workspace URL format (https://yourteam.slack.com)

### Permission Errors

If you get permission errors when accessing conversations or sending messages:
- Verify your bot/user has been added to the channel
- Check OAuth scopes include required permissions
- For browser tokens, ensure you have access in the web UI

### Update Issues

If installed via Homebrew, use `brew upgrade slackcli` instead of `slackcli update`.

If `slackcli update` fails:
- Ensure you have write permissions to the binary location
- Try running with sudo if installed system-wide
- Consider installing to user directory (~/.local/bin) instead

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
