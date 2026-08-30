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
│   │   ├── messages.ts
│   │   ├── saved.ts
│   │   ├── search.ts
│   │   └── update.ts
│   ├── lib/                      All logic; tests live beside each file
│   └── types/index.ts            Shared interfaces
├── scripts/build.ts              Compile wrapper that injects __APP_VERSION__
├── .github/workflows/            CI, tests, release, policy checks
├── .github/ISSUE_TEMPLATE/       Issue forms; blank issues are disabled
├── .github/PULL_REQUEST_TEMPLATE.md  Linked-issue reference + checklist
├── .pre-commit-config.yaml       Local checks mirroring CI
├── CLAUDE.md                     Repository constitution + architecture notes
├── CONTRIBUTING.md               Contribution policy
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
| `messages.ts` | `send`, `react`, `edit`, `draft` |
| `saved.ts` | `list` |
| `search.ts` | `messages`, `channels`, `people` |
| `update.ts` | (default action), `check` |

## `src/lib/`

| Module | Responsibility |
|---|---|
| `slack-client.ts` | The Slack API abstraction. Dispatches every call to `standardRequest()` or `browserRequest()` by auth type. |
| `auth.ts` | Login orchestration; returns a configured `SlackClient`. The only place that decides a token is valid. |
| `workspaces.ts` | Multi-workspace persistence, profile-key derivation and resolution. |
| `browser-auth.ts` | Captures `xoxd`/`xoxc` from a signed-in browser; pure extractors are exported for tests. |
| `browser-launcher.ts` | Finds and launches a local Chromium-family browser; owns the profile directory. |
| `cdp-client.ts` | Minimal Chrome DevTools Protocol client over Bun's WebSocket. |
| `curl-parser.ts` | Extracts tokens from a DevTools cURL command. |
| `slack-url-parser.ts` | Slack URL / permalink / timestamp normalisation. |
| `mrkdwn.ts` | Slack mrkdwn → `rich_text` blocks (drafts). |
| `canvas-parser.ts` | Slack canvas HTML → Markdown. |
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
`SlackUser`, `SlackFile`, `SlackMessage`, `SlackAuthTestResponse`, `SavedItem`,
`SearchMatch`, `ChannelSearchResult`, `PeopleSearchResult`, `UnreadChannel`,
`SlackCanvas`, and the per-command option interfaces.

`WorkspaceConfig` is a discriminated union on `auth_type` — narrowing it is what
makes the dual-auth split type-safe rather than a runtime string check.

## Tests

Tests sit beside the code they cover (`src/lib/curl-parser.test.ts` next to
`src/lib/curl-parser.ts`). See [testing](testing.md).
