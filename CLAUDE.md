# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SlackCLI is an unofficial TypeScript/Bun CLI tool for interacting with Slack workspaces. It supports both standard Slack app tokens (xoxb/xoxp) and browser session tokens (xoxd/xoxc), enabling automation without creating a Slack app.

## Commands

```bash
# Install dependencies
bun install

# Run in development
bun run dev --help

# Type checking
bun run type-check         # bunx tsc --noEmit

# Tests
bun test                   # Run all tests
bun test src/lib/curl-parser.test.ts  # Run a single test file

# Build
bun run build              # Build binary for current platform
bun run build:linux        # Linux x64
bun run build:macos        # macOS x64
bun run build:all          # All platforms
```

## Architecture

### Entry Point & Command Structure

`src/index.ts` registers four Commander.js command groups: `auth`, `conversations`, `messages`, `update`. Each group is implemented in `src/commands/` and delegates to `src/lib/` modules.

### Dual Authentication

Two auth types coexist throughout the codebase:
- **Standard** (`xoxb`/`xoxp` tokens): Routes through `@slack/web-api`
- **Browser** (`xoxd` cookie + `xoxc` token): Uses raw `fetch` with custom headers, mimicking a browser session

`src/lib/slack-client.ts` is the central abstraction—its methods dispatch to either `standardRequest()` or `browserRequest()` based on the workspace's stored `AuthType`. Draft creation (`drafts.create`) is only available via browser auth.

### Workspace Config Persistence

`src/lib/workspaces.ts` reads/writes `~/.config/slackcli/workspaces.json` (file mode `0o600`). Each workspace entry contains the auth type and tokens. The first workspace is automatically the default; `set-default` changes this.

### Token Extraction via cURL

`src/lib/curl-parser.ts` parses cURL commands copied from browser DevTools to extract `xoxd`/`xoxc` tokens. It handles URL-encoded tokens, multiple cookie header formats (`-b`, `--cookie`, `-H 'Cookie:'`), and enterprise Slack URLs. This parser has the most comprehensive test coverage in the project.

### Key Library Modules

| Module | Purpose |
|---|---|
| `src/lib/auth.ts` | Orchestrates login flows and returns configured `SlackClient` |
| `src/lib/slack-client.ts` | Slack API abstraction (standard via SDK, browser via fetch) |
| `src/lib/workspaces.ts` | Multi-workspace config persistence |
| `src/lib/formatter.ts` | Chalk-colored terminal output helpers |
| `src/lib/curl-parser.ts` | cURL command parsing for token extraction |
| `src/lib/clipboard.ts` | Cross-platform clipboard (`pbpaste`/PowerShell/xclip/xsel) |
| `src/lib/interactive-input.ts` | Multi-line terminal input (double-Enter or Ctrl+D to submit) |
| `src/lib/updater.ts` | Self-update via GitHub releases |

### Type Definitions

All shared TypeScript interfaces are in `src/types/index.ts`, including `AuthType`, `StandardAuthConfig`, `BrowserAuthConfig`, `SlackChannel`, `SlackUser`, and `SlackMessage`.

## Testing

Tests live alongside source files (e.g., `src/lib/curl-parser.test.ts`). The curl parser tests are the most extensive and serve as the best reference for test patterns. Use Bun's native test runner—no separate framework needed.

## CI/CD

- **CI** (`ci.yml`): type-check → build → binary size check (max 150MB) on push/PR to main
- **Release** (`release.yml`): Triggered by `v*.*.*` tags; builds for Linux x64, macOS x64/arm64, Windows x64; publishes GitHub release with SHA256 checksums; updates Homebrew tap at `shaharia-lab/homebrew-tap`

## Version

The app version (`__APP_VERSION__`) is injected at build time from the version string in the build scripts in `package.json`.
