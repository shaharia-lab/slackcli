# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Native Block Kit messages**: `messages send --blocks <json|@file>` passes a JSON array of structured blocks to `chat.postMessage`, including Slack's native `table` blocks with rich-text cells and `markdown` blocks with standard Markdown. Works with standard and browser-session authentication.

## [0.9.1] - 2026-08-21

### Fixed
- **Editing a message no longer destroys its links**: `messages edit` now sends `parse=none` on `chat.update`, so `<https://example.com|labelled link>` survives an edit instead of being rewritten to escaped literal text (#106)
  - `chat.update` defaults `parse` to `client`, unlike `chat.postMessage`, and omitting the field overwrites the value the message was posted with — it does not inherit it
  - A message broken by an earlier edit stays broken until it is edited again with a fixed build; mentions (`<@U…>`) were never affected

### Security
- **`update` verifies the downloaded binary before installing it**: the release asset is hashed and checked against the `sha256` digest GitHub publishes for it, before anything is written to disk (#104)
  - Fails closed — a missing digest, or one that is not `sha256`, aborts the update and tells the user how to install by hand
  - The download is now staged in a `mkdtemp` directory (created 0700, never reusing a path) instead of the predictable `slackcli-update-${Date.now()}` path, and is removed on every exit path

## [0.9.0] - 2026-08-16

### Added
- **Slack URLs accepted wherever an ID is taken**: paste `https://team.slack.com/archives/C123…`, `/team/U123…`, or `/docs/T…/F…` in place of a channel, user, or canvas ID (#107)
- **Permalink-style timestamps accepted wherever a timestamp is taken**: `p1234567890123456` and `1234567890123456` normalize to `1234567890.123456` (#107)
- **`--permalink <url>`** on `messages send`, `messages react`, `messages edit`, `messages draft`, `conversations read`, and `conversations get` — supplies channel and timestamp from a single message link, resolving a threaded reply to its parent for `--thread-ts` (#107)
- Clear errors instead of a misleading `message_not_found`: wrong-type IDs (a user URL passed to `--channel-id`), `--permalink` combined with explicit inputs, and a warning when a pasted link belongs to a different workspace than the authenticated one (browser auth) (#107)

### Fixed
- **mrkdwn emphasis now requires word boundaries**: an `_` inside a URL or identifier (for example the `merge_requests` segment of a GitLab link) no longer pairs with an unrelated `_` later in the message, which previously italicised the span between them and destroyed both URLs (#103)
  - Scoped to `_` only — Slack applies `*bold*`, `~strike~` and `` `code` `` mid-word, and those are unchanged
  - Behaviour change: `_hello_world_` is now left fully literal, matching Slack leaving `snake_case` unformatted

## [0.8.0] - 2026-08-06

### Added
- **Automatic browser login** (`auth login-auto`): sign into Slack in a browser and let SlackCLI capture the `xoxd`/`xoxc` tokens — no DevTools, no copy-paste (#91)
  - Enrols every workspace the user is signed into from a single sign-in
  - Drives an already-installed Chrome/Edge/Chromium/Brave over the Chrome DevTools Protocol; **no new runtime dependency** and no change to binary size
  - Uses a dedicated browser profile (required: Chrome 136+ refuses remote debugging against the default profile), so only the first run needs interaction
  - `--workspace-url`, `--timeout`, `--headless`; `SLACKCLI_BROWSER` and `SLACKCLI_BROWSER_PROFILE` env overrides
  - Typed failure reasons (browser not found, launch timeout, capture timeout, browser closed, missing cookie) each with actionable guidance
  - Workspace URLs are gated to `https://` on a `slack.com` host before any session cookie is sent to them
- **Multiple authentication profiles per workspace**: store and switch between more than one set of credentials for the same workspace (#89, #99)
- **Edit messages** (`messages edit`): update the text of an existing Slack message you posted (#88)

### Fixed
- `login-auto` now asks Chrome to close itself (CDP `Browser.close`) before falling back to signals, then sweeps any helper the browser leaves behind — previously each run stranded ~5 Chrome processes. Order matters: sweeping *instead of* a clean shutdown leaves the profile unopenable.
- `auth parse-curl` now parses cURL commands that pass the URL via the `--url` flag (#97)

### Changed
- `auth logout` now also deletes the `login-auto` browser profile, which is a credential store in its own right — while it exists, `login-auto` re-mints working tokens without prompting. Use `--keep-browser-session` to retain the old behaviour.

## [0.2.0] - 2026-01-30

### Added
- **Parse cURL Command** (`auth parse-curl`): Automatically extract browser tokens from cURL commands
  - Supports both stdin pipe and command argument input
  - Includes `--login` flag for automatic authentication after parsing
  - Parses workspace URL, name, xoxd and xoxc tokens from cURL commands
  - Significantly simplifies browser token extraction process
- **Message Reactions** (`messages react`): Add emoji reactions to Slack messages programmatically
  - Works with both standard and browser authentication methods
  - Supports all standard Slack emoji names
  - Useful for workflow automation and acknowledgment systems
- `addReaction` and `removeReaction` methods to SlackClient library

### Changed
- Enhanced authentication workflow with easier browser token extraction
- Improved user experience for initial setup and authentication

### Technical Details
- Token extraction uses regex patterns to parse various cURL formats
- Handles URL-encoded tokens correctly with decodeURIComponent
- Supports multiple cURL formats (--data-raw, --data, -b, --cookie, -H)

## [0.1.1] - 2025-11-09

### Added
- JSON output format for `conversations read` command with `--json` flag
- Thread timestamps (`ts` and `thread_ts`) in both JSON and human-readable output
- Support for replying to specific threads using extracted timestamps
- Enhanced documentation with JSON output examples

### Changed
- Message display now includes timestamps for easy thread replies
- Improved conversation read output with structured data support

## [0.1.0] - 2025-11-09

### Added

#### Authentication
- Standard Slack app token authentication (xoxb/xoxp)
- Browser session token authentication (xoxd/xoxc)
- Multi-workspace credential management
- Interactive token extraction guide
- Workspace listing and management
- Default workspace configuration
- Secure credential storage in `~/.config/slackcli/`

#### Conversation Commands
- List all conversations (channels, DMs, groups)
- Filter conversations by type
- Read conversation history
- Read specific threads
- Exclude threaded replies option
- Time-based message filtering

#### Message Commands
- Send messages to channels
- Send direct messages to users
- Reply to threads
- Automatic DM channel opening

#### Update System
- Check for available updates
- Auto-update to latest version
- Platform-specific binary downloads
- SHA256 checksum verification

#### Developer Experience
- Colorful terminal output with Chalk
- Loading spinners with Ora
- User-friendly error messages
- Comprehensive help system
- Version information

#### Build & Distribution
- Cross-platform binary compilation (Linux, macOS, Windows)
- GitHub Actions CI/CD workflows
- Automated release process
- Pre-built binaries for all platforms

### Technical Details
- Built with Bun runtime
- TypeScript with strict type checking
- Commander.js for CLI framework
- @slack/web-api for Slack API integration
- Custom HTTP client for browser token support

---

## Future Releases

### Planned for v0.3.0
- File upload/download support
- User and channel search
- Message editing and deletion
- Thread management

### Planned for v0.4.0
- Interactive REPL mode
- Message block formatting
- Bulk operations
- Export to JSON/CSV
- Shell completion (bash, zsh, fish)

---

[0.2.0]: https://github.com/shaharia-lab/slackcli/releases/tag/v0.2.0
[0.1.1]: https://github.com/shaharia-lab/slackcli/releases/tag/v0.1.1
[0.1.0]: https://github.com/shaharia-lab/slackcli/releases/tag/v0.1.0
