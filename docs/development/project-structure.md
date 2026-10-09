# Project structure

```
slackcli/
├── src/
│   ├── index.ts                  CLI entry point: welcome screen or parse, update notice
│   ├── program.ts                createProgram(): registers command groups, hooks and help
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
├── scripts/release-announcement.ts  Builds the Discord release announcement payload for release.yml
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

Each file exports a `create<Group>Command(): Command` factory that
`createProgram()` in `src/program.ts` registers. They parse flags, call into `src/lib/`, print, and set the exit code.
They hold no Slack API knowledge.

| File | Subcommands |
|---|---|
| `auth.ts` | `login`, `login-browser`, `login-auto`, `whoami`, `list`, `set-default`, `remove`, `logout`, `extract-tokens`, `parse-curl` |
| `canvas.ts` | `list`, `read` |
| `conversations.ts` | `list`, `read`, `get`, `unread`, `mark-read`, `members list`/`add`/`remove`, `join`, `leave` |
| `files.ts` | `info`, `read`, `download` |
| `logs.ts` | `path`, `show`, `clear` |
| `messages.ts` | `send`, `react`, `edit`, `draft`, `list-drafts`, `send-draft`, `delete-draft`, `schedule`, `list-scheduled`, `delete-scheduled` |
| `saved.ts` | `list` |
| `search.ts` | `messages`, `channels`, `people` |
| `update.ts` | (default action), `check` |

## `src/lib/`

| Module | Responsibility |
|---|---|
| `slack-client.ts` | The Slack API abstraction. Dispatches every call to `standardRequest()` or `browserRequest()` by auth type, through the shared rate limiter, retries browser-auth calls per `retry.ts`, logs each attempt's method, auth type, duration and outcome, and rethrows an authentication failure as a `SlackAuthError` (`auth-errors.ts`). A call that got no usable HTTP response throws `SlackTransportError` on both auth types. |
| `auth.ts` | Login orchestration; returns a configured `SlackClient`. The only place that decides a token is valid, and the one place the workspace selector (`--workspace`, `SLACKCLI_WORKSPACE`, stored default) is resolved. `checkIdentity()` is the `auth whoami` lookup: one `auth.test` for the selected profile, returned as a typed `ok` / `auth_failed` / `unreachable` result that keeps the profile key. `checkAllProfiles()` runs it over every stored profile for `auth list --check`, turning any per-profile failure into a result, and `buildProfileList()` shapes the `auth list --json` object. |
| `workspaces.ts` | Multi-workspace persistence, profile-key derivation and resolution. |
| `secret-store.ts` | Credential storage seam: the `SecretStore` interface, the inline `FileSecretStore` and macOS `MacOSKeychainSecretStore` backends, `RoutingSecretStore`, and helpers that split a config into metadata and secrets. |
| `browser-auth.ts` | Captures `xoxd`/`xoxc` from a signed-in browser; pure extractors are exported for tests. |
| `browser-launcher.ts` | Finds and launches a local Chromium-family browser; owns the profile directory. |
| `cdp-client.ts` | Minimal Chrome DevTools Protocol client over Bun's WebSocket. |
| `curl-parser.ts` | Extracts tokens from a DevTools cURL command. |
| `curl-input.ts` | Resolves `auth parse-curl`'s input source (argument → `--from-clipboard` → piped stdin → interactive prompt) into a typed result; clipboard, stdin and TTY are injectable for tests. |
| `slack-url-parser.ts` | Slack URL / permalink / timestamp normalisation. |
| `name-resolver.ts` | Channel names (`#general`) and user handles / emails → IDs. `parseNameReference()` is pure, so an ID or URL never reaches Slack; `resolveIdentifier()` is the per-argument entry point commands call after `slack-url-parser.ts` (it also drops the `@`/`#` from a prefixed ID), and `resolveUserList()` resolves a `<users...>` list with one shared `users.list` scan. Exact, case-insensitive matches only; nothing found throws `NotFoundError`, several matches `InvalidInputError`. `lazyClient()` lets write commands create a client only when a lookup needs one, so their no-auth confirmation refusal is unchanged. |
| `message-input.ts` | Resolves the text of `messages send`/`edit`/`draft` from `--message`, `--message-file <path>` or `--message-file -` (stdin). The stdin read is bounded (1 MB, 5 minutes, a zero-length chunk ends it); stdin and the TTY check are injectable for tests. |
| `mrkdwn.ts` | Slack mrkdwn → `rich_text` blocks (drafts). |
| `schedule-time.ts` | `parseScheduleTime()`: the `--at` / `--in` of `messages schedule` → Slack's `post_at` (Unix seconds). Strict regexes instead of `Date.parse` or a date library; refuses impossible dates, skipped local times, the past and anything beyond `MAX_SCHEDULE_DAYS` (120). Pure, with an injected clock. |
| `drafts.ts` | Validates draft-list limits, extracts text from `rich_text`, and projects undocumented responses into the public command contract. |
| `canvas-parser.ts` | Slack canvas HTML → Markdown. |
| `canvas-read.ts` | `canvas read`'s work: resolves the canvas ID (explicit or a channel's canvas), downloads its HTML, and resolves `<@U…>` / `<#C…>` mentions. Expected failures throw `CanvasReadError` carrying their exit code. |
| `rate-limiter.ts` | Concurrency cap and minimum interval shared by every Slack API call. Logs waits at `debug`. |
| `auth-errors.ts` | Pure classifier for Slack's five authentication codes (`invalid_auth`, `token_expired`, `token_revoked`, `not_authed`, `account_inactive`): the meaning and fix for a profile, the three-line message, the `SlackAuthError` that `SlackClient.request()` throws for them on both auth paths, and the separate wording for a token rejected during login. |
| `retry.ts` | Pure retry policy for browser-auth calls: which failures are retried (429 always, 5xx/network errors for the `READ_METHODS` allowlist only), `Retry-After` parsing, backoff with jitter, and the attempt/wait caps. |
| `logger.ts` | Logging configuration: log directory and level resolution, the rotating file and verbose stderr sinks, the `session_start` environment header, and the exit override that logs Commander usage errors. Called once from `src/program.ts`; libs log via LogTape's `getLogger` directly. |
| `log-redaction.ts` | The token/cookie/JWT redaction patterns applied to every log line. |
| `logs.ts` | `logs` command work: lists the log file and its rotations oldest first, reads them line by line, redacts each line again, groups records by `run_id`, selects runs, formats them as text, and deletes only the log files. Also exports `redactText()`, the sink's patterns applied to one string, which `command-errors.ts` uses for the `--json` error object's `message` and `hint`. |
| `tildify.ts` | Home directory as `~` in log records: `tildify()` for a path, `tildifyText()` for free text, `errorMessageForLog()` for an error's message. Its own module so libs can use it without importing `logger.ts`. |
| `process-errors.ts` | Last-resort `unhandledRejection` / `uncaughtException` handlers: log the error with its stack, print the message (the `--json` error object when the command has `--json`), exit 1. Installed from `src/program.ts`. |
| `cli-errors.ts` | The closed set of `--json` error codes (`ERROR_CODES`) and the typed errors the CLI raises itself: `CliError`, `InvalidInputError`, `NotFoundError`, `UnsupportedAuthTypeError`, `ConfirmationRequiredError`. No imports, so any module can throw them. |
| `command-errors.ts` | `classifyError()` (any thrown value → `{code, message, hint?, retryable, slack_error?}`, by type and Slack code, credentials redacted) and `failCommand()`, the one failure path of a command: the usual text, or the JSON error object on stderr under `--json`; sets exit code 1. |
| `mark-read.ts` | `conversations mark-read`: reads the conversation's current read cursor (`last_read` of `conversations.info`, best effort), makes the `conversations.mark` write, and returns `{ channel_id, ts, previous_last_read }`. |
| `message.ts` | Fetch one message by channel + timestamp, per auth type. |
| `poll.ts` | `conversations read`'s polling helpers: exact Slack `ts` comparison, the `ts > --oldest` and `--exclude-self` filters, the `next_oldest` cursor, and resolving the authenticated identity (stored `user_id`, or one `auth.test`). |
| `saved.ts` | Resolves saved-item pointers into messages, channels, and users. |
| `unread.ts` | Fetches and normalises unread channel data across both auth types, plus the workspace-wide thread summary (`threads` of `client.counts`, browser auth only) and each unread conversation's read cursors (`cursors`, kept off the list so the default output does not change). |
| `unread-messages.ts` | `conversations unread --messages` (browser auth only): flag validation, the cut at a conversation's `last_read` (reusing `poll.ts`), the conversation and per-conversation caps, normalising and paging Slack's undocumented thread view (a failure degrades to the summary), and `fetchUnreadDetails()`, which makes the calls one at a time. Logs IDs, counts and durations only, never message content. |
| `formatter.ts` | Chalk-coloured renderers, status helpers, and `writeJson()`. |
| `dry-run.ts` | `--dry-run` on the Slack writes: the `DRY_RUN_FLAG` option, `buildPreview()` (workspace identity, target with a best-effort `#channel` / `@user` name lookup, payload without undefined fields) and `emitDryRun()` (one JSON object under `--json`, else `formatDryRun()`'s text; logs the action and a field count only). |
| `help.ts` | The `--help` layout: `describeCommand()` (summary, description, `Examples`, `Notes`, standard notes for `--json`, browser-only, confirmation and `--dry-run`), the root command tree and footer, and the `--help` pointer after usage errors. |
| `clipboard.ts` | Cross-platform clipboard read (`pbpaste` / PowerShell / `xclip` / `xsel`). |
| `interactive-input.ts` | Multi-line terminal input (double-Enter or Ctrl-D). |
| `json-fields.ts` | `--fields` on the read commands: `parseFields()` / `fieldsOption()` (validation, `--json` required), `projectFields()` (dot-path projection of each list item or of a single record, envelope kept) and `FIELDS_LIST_KEYS`, the one table naming each command's main list. `applyFields()` is what a command calls just before `writeJson()` |
| `updater.ts` | Self-update via GitHub releases, with SHA-256 verification. |
| `banner.ts` | The welcome screen bare `slackcli` prints in a terminal: the pure `renderBanner()` (logo, version, star call-to-action, issue link; narrow-terminal, no-colour and no-Unicode fallbacks), `shouldShowBanner()` (no arguments and stdout a TTY), `supportsUnicode()`, `shouldUseColor()` (chalk's level plus `NO_COLOR`) and the repository URL constants. Called from `src/index.ts` before `program.parse()`. |

## `src/types/index.ts`

Every shared interface: `AuthType`, `TokenType`, `StandardAuthConfig`,
`BrowserAuthConfig`, `WorkspaceConfig`, `WorkspacesData`, `SlackChannel`,
`SlackUser`, `SlackFile`, `SlackMessage`, `SlackDraft`, `DraftSummary`, `SlackScheduledMessage`, `ScheduledMessageSummary`, `SlackAuthTestResponse`, `SavedItem`,
`SearchMatch`, `ChannelSearchResult`, `PeopleSearchResult`, `UnreadChannel`, `UnreadCursor`, `UnreadThread`, `UnreadThreads`, `UnreadSummary`,
`SlackCanvas`, and the per-command option interfaces.

`WorkspaceConfig` is a discriminated union on `auth_type` — narrowing it is what
makes the dual-auth split type-safe rather than a runtime string check.

## Tests

Tests sit beside the code they cover (`src/lib/curl-parser.test.ts` next to
`src/lib/curl-parser.ts`). See [testing](testing.md).
