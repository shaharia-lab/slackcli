# Project structure

```
slackcli/
├── src/
│   ├── index.ts                  CLI entry point; registers command groups
│   ├── version.ts                App version (build-time define, else package.json)
│   ├── commands/                 One file per command group
│   │   ├── auth.ts
│   │   ├── canvas.ts
│   │   ├── conversations.ts
│   │   ├── files.ts
│   │   ├── messages.ts
│   │   ├── saved.ts
│   │   ├── search.ts
│   │   └── update.ts
│   ├── lib/                      All logic; tests live beside each file
│   └── types/index.ts            Shared interfaces
├── scripts/build.ts              Compile wrapper: checks Bun >= 1.4.1, injects __APP_VERSION__
├── .github/workflows/            CI, tests, SonarQube Cloud scan, release, policy checks
├── .github/ISSUE_TEMPLATE/       Issue forms; blank issues are disabled
├── .github/PULL_REQUEST_TEMPLATE.md  Linked-issue reference + checklist
├── .github/requirements/         Hash-locked pip requirements for CI (pre-commit)
├── .pre-commit-config.yaml       Local checks mirroring CI
├── sonar-project.properties      SonarQube Cloud analysis settings (sonar.yml)
├── CLAUDE.md                     Repository constitution + architecture notes
├── CONTRIBUTING.md               Contribution policy
├── RELEASING.md                  Release schedule, versioning and deprecation policy
└── dist/                         Build output (gitignored)
```

## `src/commands/`

Each file exports a `create<Group>Command(): Command` factory that `src/index.ts`
registers. They parse flags, call into `src/lib/`, print, and set the exit code.
They hold no Slack API knowledge.

| File | Subcommands |
|---|---|
| `auth.ts` | `login`, `login-browser`, `login-auto`, `list`, `set-default`, `remove`, `logout`, `extract-tokens`, `parse-curl` |
| `canvas.ts` | `list`, `read` |
| `conversations.ts` | `list`, `read`, `get`, `unread` |
| `files.ts` | `info`, `read`, `download` |
| `logs.ts` | `path`, `show`, `clear` |
| `messages.ts` | `send`, `react`, `edit`, `draft`, `list-drafts` |
| `saved.ts` | `list` |
| `search.ts` | `messages`, `channels`, `people` |
| `update.ts` | (default action), `check` |

## `src/lib/`

| Module | Responsibility |
|---|---|
| `slack-client.ts` | The Slack API abstraction. Dispatches every call to `standardRequest()` or `browserRequest()` by auth type, through the shared rate limiter, retries browser-auth calls per `retry.ts`, and logs each attempt's method, auth type, duration and outcome. |
| `auth.ts` | Login orchestration; returns a configured `SlackClient`. The only place that decides a token is valid. |
| `workspaces.ts` | Multi-workspace persistence, profile-key derivation and resolution. |
| `secret-store.ts` | Credential storage seam: the `SecretStore` interface, the inline `FileSecretStore` and macOS `MacOSKeychainSecretStore` backends, `RoutingSecretStore`, and helpers that split a config into metadata and secrets. |
| `browser-auth.ts` | Captures `xoxd`/`xoxc` from a signed-in browser; pure extractors are exported for tests. |
| `browser-launcher.ts` | Finds and launches a local Chromium-family browser; owns the profile directory. |
| `cdp-client.ts` | Minimal Chrome DevTools Protocol client over Bun's WebSocket. |
| `curl-parser.ts` | Extracts tokens from a DevTools cURL command. |
| `curl-input.ts` | Resolves `auth parse-curl`'s input source (argument → `--from-clipboard` → piped stdin → interactive prompt) into a typed result; clipboard, stdin and TTY are injectable for tests. |
| `slack-url-parser.ts` | Slack URL / permalink / timestamp normalisation. |
| `mrkdwn.ts` | Slack mrkdwn → `rich_text` blocks (drafts). |
| `drafts.ts` | Validates draft-list limits, extracts text from `rich_text`, and projects undocumented responses into the public command contract. |
| `canvas-parser.ts` | Slack canvas HTML → Markdown. |
| `canvas-read.ts` | `canvas read`'s work: resolves the canvas ID (explicit or a channel's canvas), downloads its HTML, and resolves `<@U…>` / `<#C…>` mentions. Expected failures throw `CanvasReadError` carrying their exit code. |
| `rate-limiter.ts` | Concurrency cap and minimum interval shared by every Slack API call. Logs waits at `debug`. |
| `retry.ts` | Pure retry policy for browser-auth calls: which failures are retried (429 always, 5xx/network errors for the `READ_METHODS` allowlist only), `Retry-After` parsing, backoff with jitter, and the attempt/wait caps. |
| `logger.ts` | Logging configuration: log directory and level resolution, the rotating file and verbose stderr sinks, the `session_start` environment header, and the exit override that logs Commander usage errors. Called once from `src/index.ts`; libs log via LogTape's `getLogger` directly. |
| `log-redaction.ts` | The token/cookie/JWT redaction patterns applied to every log line. |
| `logs.ts` | `logs` command work: lists the log file and its rotations oldest first, reads them line by line, redacts each line again, groups records by `run_id`, selects runs, formats them as text, and deletes only the log files. |
| `tildify.ts` | Home directory as `~` in log records: `tildify()` for a path, `tildifyText()` for free text, `errorMessageForLog()` for an error's message. Its own module so libs can use it without importing `logger.ts`. |
| `process-errors.ts` | Last-resort `unhandledRejection` / `uncaughtException` handlers: log the error with its stack, print the message, exit 1. Installed from `src/index.ts`. |
| `message.ts` | Fetch one message by channel + timestamp, per auth type. |
| `saved.ts` | Resolves saved-item pointers into messages, channels, and users. |
| `unread.ts` | Fetches and normalises unread channel data across both auth types. |
| `formatter.ts` | Chalk-coloured renderers, status helpers, and `writeJson()`. |
| `clipboard.ts` | Cross-platform clipboard read (`pbpaste` / PowerShell / `xclip` / `xsel`). |
| `interactive-input.ts` | Multi-line terminal input (double-Enter or Ctrl-D). |
| `updater.ts` | Self-update via GitHub releases, with SHA-256 verification. |

## `src/types/index.ts`

Every shared interface: `AuthType`, `TokenType`, `StandardAuthConfig`,
`BrowserAuthConfig`, `WorkspaceConfig`, `WorkspacesData`, `SlackChannel`,
`SlackUser`, `SlackFile`, `SlackMessage`, `SlackDraft`, `DraftSummary`, `SlackAuthTestResponse`, `SavedItem`,
`SearchMatch`, `ChannelSearchResult`, `PeopleSearchResult`, `UnreadChannel`,
`SlackCanvas`, and the per-command option interfaces.

`WorkspaceConfig` is a discriminated union on `auth_type` — narrowing it is what
makes the dual-auth split type-safe rather than a runtime string check.

## Tests

Tests sit beside the code they cover (`src/lib/curl-parser.test.ts` next to
`src/lib/curl-parser.ts`). See [testing](testing.md).
