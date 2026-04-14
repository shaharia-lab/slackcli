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

### 2. Browser Session Tokens (Quick Setup)

Extract tokens from your browser session. No Slack app creation required!

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

### 3. Easy Method: Parse cURL Command (Recommended for Browser Tokens)

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
# List all authenticated workspaces
slackcli auth list

# Set default workspace
slackcli auth set-default T1234567

# Remove a workspace
slackcli auth remove T1234567

# Logout from all workspaces
slackcli auth logout
```

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
```

### Message Commands

```bash
# Send message to a channel
slackcli messages send --recipient-id=C1234567890 --message="Hello team!"

# Send DM to a user
slackcli messages send --recipient-id=U9876543210 --message="Hey there!"

# Reply to a thread
slackcli messages send --recipient-id=C1234567890 --thread-ts=1234567890.123456 --message="Great idea!"

# Create a draft message in a channel (only works with browser session tokens)
slackcli messages draft --recipient-id=C1234567890 --message="Hello team!"

# Add emoji reaction to a message
slackcli messages react --channel-id=C1234567890 --timestamp=1234567890.123456 --emoji=+1

# More reaction examples
slackcli messages react --channel-id=C1234567890 --timestamp=1234567890.123456 --emoji=heart
slackcli messages react --channel-id=C1234567890 --timestamp=1234567890.123456 --emoji=fire
slackcli messages react --channel-id=C1234567890 --timestamp=1234567890.123456 --emoji=eyes
```

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
