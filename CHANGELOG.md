# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

### Planned for v0.2.0
- File upload/download support
- Reaction management
- User and channel search
- Message editing and deletion
- Thread management

### Planned for v0.3.0
- Interactive REPL mode
- Message block formatting
- Bulk operations
- Export to JSON/CSV
- Shell completion (bash, zsh, fish)

---

[0.1.0]: https://github.com/shaharia-lab/slackcli/releases/tag/v0.1.0

