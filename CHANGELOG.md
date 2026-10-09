# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **`messages send --file` is repeatable, so several files share ONE message**: pass `--file` once per attachment (`--file chart.png --file table.csv --file report.pdf`) and all of them post to a single message with the one `--message` as the comment, matching the Slack UI — instead of looping `send --file` and posting a separate message per file (#364)
  - All-or-nothing: every path is validated before the first upload, and any per-file failure names the file and the step and posts nothing
  - `--json` is additive — always emits `file_ids`, with `file_id` kept as the first; the dry-run preview adds a `files` list and `total_size` alongside the existing `file`/`file_size` for the first file
  - A single `--file` is unchanged
- **`conversations unread` reports unread thread activity**: with browser auth the output now says whether the threads you follow have unread replies or mentions, so a reply in a thread no longer hides behind "All caught up!" when its channel has nothing unread at the top level (#264)
  - `--json` adds `threads: { has_unreads, mention_count }` next to `unread_channels`; the text output adds a `Threads:` line
  - A workspace-wide summary taken from the same `client.counts` response: no extra API call, and `--types` does not filter it
  - Unread threads alone now print `{ "unread_channels": [], "threads": {...} }` instead of nothing
  - With an app token the `threads` key is left out, since `conversations.list` has no equivalent, and the output is unchanged
- **`emoji list --filter <substring>`**: keeps only the custom emoji whose name contains the substring, matched case-insensitively, so one emoji can be found on a large workspace without `--json | jq` (#365)
  - Applied locally to the full list after `--no-aliases` and before `--limit`, so `--limit` means the first N matches
  - Surrounding colons are stripped as in `emoji get` (`--filter :kiro:` equals `--filter kiro`); an empty value fails with `invalid_input` instead of matching everything
- **Releases are announced on Discord**: after a stable release is published and the Homebrew tap is updated, the release workflow posts the version, a link to the GitHub Release, the release notes and the Homebrew install hint to the Shaharia Lab Discord release channel. Pre-release tags are not announced, a re-run does not post twice, and a Discord failure never fails the release (#358)

### Fixed
- **Large text output no longer truncates on a slow pipe**: every command's human-readable (non-`--json`) result is now written through `process.stdout.write` with backpressure instead of `console.log`, so output over ~64 KiB piped to a slow reader arrives in full — matching the `--json` path and fixing the silent truncation at the pipe-buffer boundary (exit code 0, no error) (#373)
  - A shared `writeText()` sink in `src/lib/formatter.ts` (twin of `writeJson()`) replaces `console.log` at every command result print across the command layer; `success()` and `info()` route through it too
  - A guard test (`src/output-sink.test.ts`) fails the build if any `src/commands/` file reintroduces `console.log`, so the hazard cannot creep back one call site at a time
  - Closes the non-JSON half of the stdout-drain hazard that [#73](https://github.com/shaharia-lab/slackcli/issues/73) fixed for JSON and [#77](https://github.com/shaharia-lab/slackcli/issues/77) tracked
- **`--dry-run` text previews no longer truncate on a slow pipe**: `emitDryRun`'s human-readable preview now writes through the shared `writeText()` sink instead of `console.log`, closing the last command-result stdout print that bypassed the backpressure-safe path, and the guard test (`src/output-sink.test.ts`) now scans every non-test file in `src/commands/` and `src/lib/` (exempting the interactive-prompt helper by name) so a new shared helper is covered by default and the hazard cannot return (#377, follow-up to #373)

## [0.14.0] - 2026-10-03

### Added
- **Message text from standard input with `--message-file -`**: `messages send`, `edit` and `draft` read the text from a pipe or heredoc, so multi-line text, code, quotes, backticks and `$` need no shell quoting and no temporary file (#329)
  - `printf '%s' "$REPORT" | slackcli messages send --recipient-id C0123456789 --message-file -`; one trailing newline (the one `echo` or a heredoc adds) is dropped, everything else is sent as is
  - Fails before any Slack call, with `invalid_input`, when standard input is a terminal (it never waits for typing), is empty or whitespace-only, is larger than 1 MB, or is still open after 5 minutes
  - Only `-` means standard input; `./-` still reads a file named `-`, and `--message` with `--message-file -` is rejected as with a path
  - The Claude Code plugin skill now pipes multi-line text instead of quoting it
- **`--fields` trims `--json` output to the fields you ask for**: `conversations read C0123456789 --json --fields ts,user,text` prints each message with only those keys, so an agent pays for the data it uses instead of full Slack objects (#330)
  - On the 20 read commands with `--json`; comma-separated names, dot paths for nested values (`profile.email`), printed in the order given
  - Applies to each item of the command's main list, or to the record itself; counts, cursors and the resolved `users` array are kept, so paging still works
  - Measured on a real workspace: `conversations read --limit 50` 95,601 → 16,346 bytes, `search messages --limit 20` 110,198 → 10,526
  - Needs `--json`; an empty or malformed list exits 1 with `invalid_input` before any Slack call. Output without `--fields` is unchanged
  - The Claude Code plugin skill and the scripting guide tell agents to request only the fields they need and to use `--limit`
- **Channel names and user handles wherever an ID is accepted**: `--recipient-id="#general"`, `conversations read general`, `--recipient-id=@alice` and `users info alice@example.com` now resolve to the channel or user ID, so a task no longer starts with a `search channels` call (#327)
  - Channels: `#name` or the bare name, matched exactly (case-insensitive) against the public and private, non-archived channels the identity can see
  - Users: `@handle` (exact Slack handle) or an email address (`users.lookupByEmail`, which needs the `users:read.email` scope on an app token)
  - Covers `messages send`/`draft`/`edit`/`react`, `conversations read`/`get`/`members list|add|remove`/`join`/`leave`, `canvas list|read --channel`, `users info`, and the user lists of `usergroups add`/`remove`
  - IDs and Slack URLs make no extra API call; an unknown name exits 1 with `not_found`, a name that matches more than one thing exits 1 with `invalid_input` listing the candidate IDs, and nothing is sent or changed in either case
  - A bare `--recipient-id` name that is both a channel and a user is refused; write `#name` or `@name`
  - An ID written with a prefix (`@U0123456789`, `#C0123456789`) is now used without it, where it used to reach Slack as typed and fail
  - `--json` output carries the resolved ID (`channel_id`, `added`, …); quote a `#` in a shell (`"#general"` or `--flag=#general`)
  - The Claude Code plugin skill passes names directly instead of searching first
- **`--dry-run` on every Slack write**: `messages send`, `edit`, `react`, `draft`, `send-draft`, `delete-draft`, `conversations members add`, `members remove`, `join`, `leave` and the six `usergroups` writes now take `--dry-run`, which resolves the workspace, the target and the final content, runs every check the real command runs, and prints what would be done instead of doing it (#328)
  - The preview shows the workspace and profile, the action, the target (with its `#channel` / `@user` name when Slack returns one) and the content exactly as it would be sent: text from `--message-file`, parsed `--blocks`, the file to upload, the users a channel or user group change would add or remove, and the user group's resulting member list
  - With `--json` it is one object on stdout, `{"dry_run": true, "action", "workspace", "target", "payload"}`; `messages react` has no `--json` and previews as text
  - A dry run never prompts and needs no `--yes`, and exits `0` on a valid preview. Invalid input, a missing file, bad Block Kit JSON or a draft command on an app token fail it with the real command's error and exit `1`. It may make read calls but no write call, and it does not open a DM; Slack checks permissions only on the real write, so a dry run can pass where the write is refused
  - The Claude Code plugin skill previews a write with `--dry-run` when the target or text is uncertain
- **Structured JSON errors with `--json`**: a failing command run with `--json` now ends stderr with one single-line object, `{"error":{"code","message","hint"?,"retryable","slack_error"?}}`, writes nothing to stdout and exits `1`, so scripts and AI agents can branch on the failure instead of parsing text (#326)
  - `code` is one of `auth_failed`, `not_found`, `permission_denied`, `rate_limited`, `invalid_input`, `network`, `confirmation_required`, `unsupported_auth_type`, `unknown`; `slack_error` is Slack's own code verbatim; `retryable` is `true` only for `rate_limited` and `network`. See "Errors under `--json`" in the scripting guide
  - The spinner's failure line is no longer printed in `--json` mode, so a consumer that read the error text from stderr under `--json` must read the JSON object instead. Without `--json`, output and exit codes are unchanged
  - The update-available notice is no longer printed after a failed command
  - The Claude Code plugin skill now reads `error.code` instead of matching error text
- **Welcome screen on bare `slackcli`**: run with no arguments in an interactive terminal, `slackcli` now shows its ASCII logo and version, a pointer to `slackcli --help`, a request to star the repository and the link for reporting a bug or requesting a feature, and exits `0`. Only bare `slackcli` writing to a terminal is affected: from a script, pipe, CI or AI agent it still prints the plain help to stderr and exits `1`, and `--help`, `help`, `--version` and every subcommand are unchanged. The logo is plain ASCII; colour honours `NO_COLOR`, the star emoji falls back to `*` where Unicode is not supported, and a terminal narrower than the logo gets a one-line title instead (#325)
- **`auth list --check` and `auth list --json`**: `--check` verifies every stored profile with one `auth.test` call each and shows `ok` (with the user), `auth failed` (with the Slack code, its meaning and the `To fix:` command) or `unreachable` under each one; a failing profile does not stop the others from being checked, and the command exits `1` unless every profile is `ok`. `--json` writes `{default, workspaces: [{profile, workspace_id, workspace_name, auth_type, is_default, secret_backend, check?}]}`, with `check` only under `--check`. Plain `auth list` is unchanged: local config only, no network call. No token is ever printed (#323)
- **`auth whoami`**: shows which workspace, profile and user the CLI is acting as, and verifies the credentials with one `auth.test` call. It prints the workspace name and ID, the profile key, the user (or bot) name and ID, the auth type and what selected the profile (`--workspace`, `SLACKCLI_WORKSPACE` or the stored default). When Slack refuses the credentials it still prints the stored profile, then the meaning and the `To fix:` command, and exits `1`; when Slack cannot be reached it says `unreachable` instead of blaming the credentials, and exits `1`. `--json` writes one object with `status` `ok`, `auth_failed` or `unreachable`; no token is ever printed (#320)
- **`SLACKCLI_WORKSPACE` selects the workspace for one shell**: set it to a profile key, profile name, workspace ID or workspace name and every command uses that workspace without `--workspace` and without changing the stored default. Precedence is `--workspace`, then `SLACKCLI_WORKSPACE`, then the default from `auth set-default`. An empty value is ignored; a value that matches no profile fails with `Workspace not found: <value> (from SLACKCLI_WORKSPACE)` instead of falling back to the default (#321)
- **Safe polling with `conversations read`**: `--exclude-self` drops messages sent by the authenticated user (or bot), `--json` now includes `next_oldest` (the cursor to pass back as `--oldest`, which still advances when every new message was your own) and `has_more`, and messages at or before `--oldest` are no longer returned, so a thread poll stops re-emitting the parent message. See "Poll a channel or thread safely" in the scripting guide (#316)
- **Diagnostic log file**: every command now writes a rotating JSON Lines log (`~/.local/state/slackcli/logs/slackcli.log` on Linux, `~/Library/Logs/slackcli/` on macOS, `%LOCALAPPDATA%\slackcli\logs\` on Windows) recording the environment and each Slack API call's method, outcome, Slack error code and duration (#279)
  - Tokens and cookies are redacted; message text, file contents and search queries are never logged
  - `-v` / `--verbose` also prints debug logs to stderr; `SLACKCLI_LOG_LEVEL` (`trace` … `off`) sets the level and `SLACKCLI_LOG_DIR` moves the file. stdout and `--json` output are unchanged
  - Rotates at 5 MiB, keeping the current file plus 5 rotated ones (about 30 MB at most); an unwritable log directory produces one warning and never fails the command
- **Diagnostic logging for auth, `login-auto`, config and updates**: the log now records authentication outcomes, each `login-auto` step (chosen browser, profile created or reused, DevTools port discovery, the typed failure reason), workspace config load/save and default changes (IDs only), credential-store failures, update checks and the self-update digest verification, and any unhandled error with its stack trace before the process exits 1. Captured tokens, cookies and CDP payloads are never logged (#280)
- **`slackcli logs`**: `logs path` prints where the log file is, `logs show [--last N | --run <id>]` prints recent runs (put back together across rotated files, redacted again on output, `--json` supported) for pasting into a bug report, and `logs clear` deletes the log files after confirmation (`--yes` when not on a terminal). The bug report template now asks for `slackcli logs show --last 1` (#281)
- **`SLACKCLI_NO_UPDATE_NOTIFIER`**: set it to `1` to turn off the background update check and its "Update available" notice, with no cache read and no request to GitHub. The same applies automatically when the standard `CI` variable is set (`CI=true` / `CI=1`); `slackcli update` and `update check` work as before (#283)

### Changed
- **`--help` is now enough to use any command**: every command's help shows examples and notes after its options, covering accepted value formats (IDs, timestamps, Slack URLs), flags that replace each other, the `--json` output shape, browser-only commands and the `--yes` confirmation rule. `slackcli --help` lists every command under its group, plus how the workspace is chosen, the `SLACKCLI_*` variables and `--json`. A usage error such as an unknown option now ends with `(run "slackcli <command> --help" for usage and examples)` on stderr. No command's behaviour, flags or output changed (#324)
- **Authentication errors now explain themselves**: when Slack refuses a profile's stored credentials (`invalid_auth`, `token_expired`, `token_revoked`, `not_authed`, `account_inactive`), every command prints which profile failed, Slack's code unchanged, what it means and a `To fix:` line, instead of only `Slack API error: invalid_auth`. The wording is the same for app-token and browser-session profiles (#322)
  - The fix is the login command for that profile: `slackcli auth login-auto --workspace-url <stored URL>` for a browser session, `slackcli auth login` for an app token
  - `account_inactive` says that logging in again will not help and to contact a workspace admin
  - A token Slack refuses during `auth login`, `auth login-browser` or `auth login-auto` is reported as a rejected token, not as a profile to log in to again
  - The message still goes to stderr and the exit code is still `1`; other Slack errors are unchanged
- **Building from source needs Bun 1.4.1+**: `bun run build` now stops with `slackcli builds need Bun >= 1.4.1 (found <version>)` on an older Bun instead of Bun's cryptic `format must be 'cjs' when bytecode is true` error, and the README, contributor docs and `package.json` `engines` state 1.4.1 instead of 1.0 (#292)
- **Usage errors are now logged**: a command line slackcli rejects (unknown option or subcommand, missing argument or option value, invalid or conflicting option) now writes a `session_start` header and a `usage_error` record with the error code to the diagnostic log, so `slackcli logs show --last 1` shows that run instead of the previous one. The error message and exit code are unchanged, argument values are never logged, and `--help` / `--version` still write nothing (#291)
- **`slackcli update` in a folder you cannot write to** (such as `/usr/local/bin`): it now stops before downloading and says `No write permission for <folder> — run: sudo slackcli update` (on Windows: run it from an Administrator terminal), instead of downloading the release and then failing with a raw `EACCES` error. The update notice and `update check` suggest `sudo slackcli update` for such installs too; Homebrew and writable installs are unchanged (#284)
- **Corrupt `workspaces.json`**: the load error is now a one-line warning (`Error loading workspaces: <parse error>`) instead of a raw error dump, and quoted fragments of the file are no longer echoed to the terminal (#280)

### Fixed
- **Browser-session workspaces no longer fail on the first rate limit**: a `HTTP error! status: 429` from Slack is now retried after the `Retry-After` delay, as it already was for app tokens, instead of failing the command (#315)
  - Every call is retried on a 429, including sends: Slack rejected the request, so it cannot be applied twice
  - Read-only calls are also retried after a Slack 5xx or a dropped connection, with exponential backoff; sends and other changes are not, since the first attempt may already have gone through
  - At most 3 retries, 60 s per wait and 2 minutes of waiting per call; a waiting call does not hold up other calls
- **Drafts now render mentions, channels, broadcasts and links**: `messages draft` converted only formatting markers into `rich_text` blocks, so `<@U…>`, `<!subteam^S…>`, `<#C…>`, `<!here>` / `<!channel>` / `<!everyone>` and `<https://…|label>` showed up as literal text in the composer. They now become user, usergroup, channel, broadcast and link elements (labels on mentions and channels are dropped, link labels are kept), can carry bold/italic/strike, and an `_` inside a URL no longer opens an italic span. Unrecognised `<…>` text stays literal (#299)
- **`auth login-auto` no longer fails with "The browser started but exposed no page to attach to" while the browser window flashes open and shut**: the page-target lookup now polls for up to 5s instead of probing once, covering the gap between Chrome writing `DevToolsActivePort` and registering its initial tab in `/json/list` (measured ~200–300 ms; previously the one-shot probe missed 5/5 launches on a fast machine) (#274)
- **`slackcli update` on Homebrew installs**: no longer replaces the Homebrew-managed binary (which left brew's record out of sync); it prints `Installed via Homebrew — run: brew upgrade slackcli` and exits without downloading, and `update check` now names `brew upgrade slackcli` there too. `update` and `update check` no longer end with a stale "Update available" notice, and a successful self-update refreshes the update cache with the installed version (#276)
- **Background update check**: no longer delays a finished command on a slow or hanging network. The check now gives up after 1.5 seconds (10 seconds for `update` / `update check`), a failed check waits an hour before retrying instead of retrying on every command, and the "Update available" notice shows a newly found release in the same run rather than one run later (#282)

## [0.13.0] - 2026-09-26

### Added
- **Draft lifecycle**: `messages send-draft <draft-id>` posts a reviewed text draft to its saved channel/thread and removes it after delivery; `messages delete-draft <draft-id>` discards it without posting. Both require browser auth and accept `--yes` for unattended use (#272)
  - Sending returns the posted message identity with `--json`; if cleanup fails after posting, it reports that identity with a nonzero exit to prevent a blind duplicate retry
- **`messages list-drafts`**: lists active drafts for browser-authenticated profiles, with a human-readable preview or a stable `{draft_count, drafts}` JSON projection instead of Slack's raw internal response (#146)
  - Defaults to 100 drafts and accepts a positive-integer `--limit`; Slack apps fail loudly because Slack provides no public drafts API
  - Uses the undocumented web-client `drafts.list` endpoint, which may change without notice
- **macOS Keychain credential storage (opt-in)**: `--secret-backend keychain` on `auth login`, `auth login-browser`, `auth login-auto`, and `auth parse-curl --login` stores a new profile's tokens in the macOS Keychain instead of inline in `workspaces.json`, via the built-in `security` CLI (#219)
  - `auth migrate-secrets --to <file|keychain> [--profile <name>]` moves an existing profile's (or every profile's) credentials between backends, verifying the new copy before the old one is ever removed — safe to re-run after a failure or interruption
  - The file backend stays the default everywhere, including macOS; `workspaces.json`'s shape for an all-file setup is unchanged
  - `auth list` shows which backend each profile uses

### Changed
- **Faster startup**: release binaries are now compiled with Bun's `--bytecode`, cutting `slackcli --help` cold start from ~130 ms to ~80 ms on Linux x64; CI and releases move from Bun 1.3.13 to 1.4.1 (#137)
  - Binary size against the 1.3.13 builds: Linux x64 98 → 82 MB, Windows x64 113 → 87 MB, macOS x64 66 → 71 MB
- **Canvas and cURL parsing stay fast on pathological input**: the canvas attribute and tag strippers and the cURL cookie matcher no longer backtrack quadratically, so a long whitespace run or a run of unclosed `<` parses in milliseconds instead of seconds; output for well-formed input is unchanged (#213)
  - A whitespace-only `-H 'Cookie:'` header no longer hides a later `-b`/`--cookie`

### Security
- **Canvas heading, blockquote and table-cell tag stripping cannot reassemble a tag**: removing one tag no longer joins the text around it into a new one (`<<b>script>` → `<script>`), and a zero-width space in a table cell can no longer split a tag so that it survives. Output for other input is unchanged, and the stripper runs in linear time (#231)
- **`files download --output` is contained to the working directory**: an output path that resolves outside the current directory is now confirmed before anything is downloaded — `--yes` proceeds, an interactive terminal prompts `y/N`, and a non-interactive shell without `--yes` refuses with a non-zero exit (#191)
  - Paths inside the current directory are unchanged and never prompt; the `'wx'` open flag is unchanged, so an existing file still fails with `EEXIST` and is never truncated
  - The check resolves the parent directory through symlinks, so a symlinked subdirectory pointing out of the working tree is caught as well, and the message names the resolved absolute path rather than the string that was typed
  - **Breaking for unattended scripts** that download to an absolute path or a `../` path without `--yes`: add `--yes`, or `cd` into the target directory and pass a relative path

## [0.12.0] - 2026-09-19

### Added
- **`users` command group**: `users info <id>` looks up a single user by ID, and `users list` enumerates workspace users filtered by `--status active|deactivated|all` (#177)
  - `--limit` on `users list` means matches-returned, not scan depth: it pages `users.list` internally, applying the status filter as it goes, and stops once it has that many matches
  - `--resolve-fields`, shared with `search people`, resolves custom profile fields from opaque `Xf…` IDs to their human labels via one cached `team.profile.get` call; fields whose values are themselves user IDs (Manager, Direct Reports) are left as `U…` IDs, not resolved to names
  - Account status is derived from `deleted`, the one deactivation signal Slack always returns
- **`conversations members list <channel>`**: read-only channel membership enumeration, cursor-paginated, accepting a channel ID or a Slack link (#176)
  - On Enterprise Grid, a workspace policy can return `enterprise_is_restricted` for this call regardless of `--team` scoping; the command reports that clearly and exits non-zero instead of hiding or faking success
- **`conversations members add/remove <channel> <users...>`, `conversations join/leave <channel>`**: change channel membership from the CLI (#178)
  - `add` calls `conversations.invite` once for the whole list — Slack's call is all-or-nothing, so a success message never lies about who got added
  - `remove` calls `conversations.kick` per user and is best-effort: it tries every ID, reports which succeeded and which failed, and exits non-zero if any failed; `--json` carries the full `removed`/`failed` split
  - `join` needs no confirmation (joining is harmless, rejoining is a no-op); `leave` confirms like other write commands (`--yes` to skip in a TTY, refused without it otherwise), and leaving a channel you are not in is reported as a no-op

## [0.11.0] - 2026-09-05

### Added
- **Slack files**: a new `files` command group — `files info`, `files read` and `files download` — accepting a file ID, a Slack file permalink, a canvas URL, or a private `files.slack.com` URL (#157)
  - `read` prefers Slack's `plain_text` rendering for email files and refuses to print binary content instead of spraying bytes at the terminal
  - `download` streams the original bytes and will not overwrite an existing path
  - Redirects are followed manually, so browser cookies and bearer tokens are never forwarded to a non-Slack download host
- **`emoji` commands**: `emoji list` and `emoji get` read a workspace's custom emoji under both standard and browser-session authentication, with `--limit` validated up front so a bad value errors instead of reporting an empty workspace (#140)
- **`team` and `usergroups` read commands**: `team info`, `usergroups list` and `usergroups read`, all taking `--team <workspace-id>` for Enterprise Grid scoping, under both auth types (#139)
- **`usergroups` write commands**: `create`, `update`, `add`, `remove`, `enable` and `disable` (#139)
  - `add` and `remove` are read-modify-write against `usergroups.users.update`, which replaces the whole member list: they read the current membership, apply the change, skip a no-op, and refuse to empty the last member
  - Every write confirms first, and refuses with a non-zero exit when stdin is not a TTY and `--yes` is absent
- **`--json` and `--message-file` on `messages send`, `edit` and `draft`**: automation can keep what it just wrote instead of scraping the human success line (#150)
  - `--json` emits `{channel_id, ts, permalink}` on `send`, `{channel_id, file_id}` on `send --file`, `{channel_id, ts}` on `edit`, and `{channel_id, draft_id, thread_ts?}` on `draft`
  - `--message-file` reads the body from a UTF-8 file, mutually exclusive with `--message`; a missing, empty or whitespace-only file is rejected before any Slack call
  - Warnings now go to stderr rather than stdout, so a workspace-mismatch warning can no longer corrupt a `--json` pipe
- **`--json` on `conversations list`**: the last read command without it, though the README and the scripting guide already promised it. Emits `{conversation_count, conversations, users, next_cursor}`, with Slack's empty-string cursor normalised to `null` (#141)
- **Project website**: `web/` builds an Astro site published to GitHub Pages at <https://slackcli.dev>, with a landing page, the full documentation and a blog (#164)
  - The documentation half is generated from `docs/` at build time by `web/scripts/sync-docs.mjs`, so the repository stays the single source and nothing is maintained twice
  - Styled with `@shaharia-lab/agento-code`, the design system shared by every Shaharia Lab project site
  - The version, the per-platform binaries, their sizes and the checksums link all come from the GitHub Releases API at build time, so nothing about a download is written by hand
  - Two workflows: `Site check` builds every pull request that touches `docs/` or `web/` and verifies every internal link and heading anchor, and `Site` deploys on a push to `main` and on every published release
  - No analytics unless the build is given a `PUBLIC_GTM_ID`, and no cookie banner without it
- **Claude Code plugin**: `plugins/slackcli/` ships a `/slackcli` skill that installs the binary if it is missing (after asking), checks or proposes authentication, and then drives the workspace with a bundled command reference. Install with `/plugin marketplace add shaharia-lab/slackcli` then `/plugin install slackcli@slackcli` (#162)

### Fixed
- **Slack API calls are throttled**: every request now goes through a process-wide rate limiter — at most 2 in flight, with at least 200ms between calls — for both standard and browser-session authentication (#147)
  - Unthrottled bursts (one `users.info` per user, one `conversations.info` per channel) could trip Slack's `unexpected_api_call_volume` anomaly detection, which on Enterprise Grid signs the browser session out
  - Commands that resolve many names (`saved list`, `conversations unread`) are correspondingly slower on large workspaces; the spinner keeps running while they are paced
- **`findBrowser`'s PATH scan honours the platform it was given**: it used `node:path`'s host-following `join`/`delimiter`, so simulating a non-host OS scanned with the wrong separators (#154)
  - No effect on `auth login-auto`, whose only call site passes no platform; what it fixes is the cross-platform simulation, which failed the mandatory pre-commit hook on a Windows host

## [0.10.0] - 2026-08-29

### Added
- **Native Block Kit messages**: `messages send --blocks <json|@file>` passes a JSON array of structured blocks to `chat.postMessage`, including Slack's native `table` blocks with rich-text cells and `markdown` blocks with standard Markdown. Works with standard and browser-session authentication (#121)

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
