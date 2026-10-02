# Troubleshooting SlackCLI

## `No workspace configured`

Nothing is authenticated yet. Run `slackcli auth login-auto`, or see
[authentication](authentication.md).

## `Workspace not found: <name>`

The selector matched nothing. `slackcli auth list` shows the profile keys,
workspace IDs, and names that are valid.

When the message ends with `(from SLACKCLI_WORKSPACE)`, the value came from that
environment variable, not from `--workspace`. Fix the value, `unset
SLACKCLI_WORKSPACE`, or pass `--workspace` to override it — see
[pin a workspace for one shell](workspaces.md#pin-a-workspace-for-one-shell).

## `"x" matches multiple profiles`

You have more than one identity for that workspace. Pass the profile name
instead of the bare ID or name — see
[workspaces and profiles](workspaces.md#how-a-selector-is-resolved).

If you passed no `--workspace`, the selector came from the `SLACKCLI_WORKSPACE`
environment variable: set it to a profile name, or override it with
`--workspace`.

## Authentication fails

**Standard tokens**

- Check the token has the OAuth scopes the command needs — see the
  [scope table](authentication.md#1-standard-slack-app-tokens).
- Re-check the token in your Slack app settings; a reinstall rotates it.
- `not_allowed_token_type` on search means you are using a bot token. Slack
  restricts `search.messages` to user (`xoxp-*`) tokens.

**Browser tokens**

- They expire with your browser session. Refresh with
  `slackcli auth login-auto --headless`, or re-run `parse-curl` / `login-browser`
  with fresh values.
- The workspace URL must be `https://yourteam.slack.com`.

## `invalid_auth` or `not_authed`

The stored token is no longer valid. Re-authenticate the same identity — logging
in again refreshes the tokens in place and keeps your profile key and default.

## Permission errors on channels or messages

- The bot or user must be **a member of the channel** — being able to see it in
  the web UI is not enough for a bot.
- Check the OAuth scopes cover the operation (`chat:write` to post,
  `reactions:write` to react, `files:write` to upload, `files:read` for
  canvases).
- For browser tokens: if you cannot open it in the Slack web UI, the CLI cannot
  either.

## `auth login-auto` cannot find a browser

It needs Chrome, Edge, Chromium, or Brave installed locally. If yours is in a
non-standard place, point at it:

```bash
SLACKCLI_BROWSER=/path/to/chrome slackcli auth login-auto
```

If the browser opens but capture times out, sign in fully (including any SSO
redirect and 2FA) before the `--timeout` window closes, or raise it with
`--timeout=600`. Note that `--headless` only works *after* a first interactive
sign-in has populated the profile.

Every `login-auto` run records in the [log file](#logs) which browser was
used, whether the slackcli browser profile was created or reused, whether the
DevTools port came up, and the failure reason (for example `browser_exited`,
`capture_timeout`, `no_cookie`). Captured tokens and cookies are never logged.
Include those lines when you report a `login-auto` problem.

## `auth parse-curl` cannot read the clipboard

Clipboard access uses `pbpaste` (macOS), PowerShell (Windows), and
`xclip`/`xsel` (Linux). Install one, or use interactive mode
(`slackcli auth parse-curl --login`, paste, press Enter twice) or a pipe.

## `Clipboard content does not appear to be a cURL command`

Copy the request from DevTools with **Copy → Copy as cURL** (not "Copy link" or
"Copy response"). "Copy as cURL (bash)" and "(cmd)" both work.

## Canvas read says authentication expired

The download came back as a Slack sign-in page instead of canvas HTML, which is
what an expired token produces. Re-authenticate and retry.

## Canvas read says the file is too large

Downloads are capped at 10 MB. Use `--raw` and pipe elsewhere, or read the
canvas in the Slack UI.

## `conversations get` cannot find a thread reply

With a standard token, only top-level messages can be fetched by timestamp;
resolving an arbitrary reply needs its parent's `thread_ts`, which no public
Slack API exposes. Read the thread instead:

```bash
slackcli conversations read C1234567890 --thread-ts=<parent-ts>
```

Browser auth does not have this limitation.

## Drafts fail with `requires browser authentication`

Slack apps cannot create or list drafts. Use a browser-authenticated profile.

## Truncated JSON when piping

If output looks cut off around 64 KiB, you have hit
[issue #77](https://github.com/shaharia-lab/slackcli/issues/77), which affects
non-JSON stdout paths (`canvas --raw`, human-readable output). `--json` output is
not affected. Redirect to a file as a workaround, and add a comment on the issue
with what you ran.

## `slackcli update` does nothing or fails

- **Installed via Homebrew**: use `brew upgrade slackcli`. The self-updater
  detects this and refuses so it does not fight the package manager.
- **Running from source**: there is no binary to replace — `git pull`.
- **`No write permission for <folder> — run: sudo slackcli update`**: the binary
  lives in a folder you cannot write to (for example `/usr/local/bin`), so the
  update stops before downloading anything. Run `sudo slackcli update`, or on
  Windows run `slackcli update` from an Administrator terminal. To update
  without elevated rights, install to `~/.local/bin` instead.
- **Checksum mismatch**: the update is aborted deliberately. Do not work around
  it — download the binary manually and check it against `checksums.txt` from
  the release.
- **`Unable to check for updates`**: GitHub did not answer within 10 seconds or
  returned an error. The background update notice is separate and bounded to
  1.5 seconds, so a slow network never delays the end of a normal command.

## Rate limits and slow commands

slackcli paces its own traffic: it keeps at most 2 Slack API calls in flight and
leaves at least 200ms between calls, for both app tokens and browser sessions.
Bursting past that is what trips Slack's `unexpected_api_call_volume` anomaly
detection, which on Enterprise Grid can sign the session out.

The visible cost is that commands resolving many names one entity at a time —
`conversations unread`, `saved list` — take noticeably longer on a large
workspace. The spinner keeps running; it is throttling, not hanging. Narrow the
request (`--types`, `--limit`) to make it finish sooner.

If Slack rate-limits you anyway (HTTP 429), slackcli waits as long as Slack
asks (up to 60 seconds at a time) and retries, up to 3 times and 2 minutes of
waiting per call. That is slackcli's own retry on browser-session workspaces;
app-token workspaces are retried by the Slack SDK instead. Read-only calls are also
retried after a Slack server error (5xx) or a dropped connection; sends and
other changes are not, because the first attempt may already have gone through
— check before re-running a command that failed that way. If a call still fails
after the retries, wait a minute and run it again.

## Logs

Every command writes a diagnostic log. It records what ran (command name and
option names, never their values), your OS and slackcli version, and each Slack
API call's method, outcome, Slack error code and duration. It also records
authentication and `login-auto` steps, workspace config load and save (IDs
only), credential-store failures, update checks, and any unexpected error with
its stack trace. A command line that slackcli rejects (an unknown option or
subcommand, a missing argument, an invalid value) is recorded too, as a
`usage_error` with the error code, so `logs show --last 1` shows that run and
not the one before it; `--help` and `--version` write nothing. Tokens and
cookies are redacted, and message text, file contents and search queries are
never logged.

| OS | Log file |
|---|---|
| Linux | `~/.local/state/slackcli/logs/slackcli.log` (or `$XDG_STATE_HOME/slackcli/logs/`) |
| macOS | `~/Library/Logs/slackcli/slackcli.log` |
| Windows | `%LOCALAPPDATA%\slackcli\logs\slackcli.log` |

The file rotates at 5 MiB and keeps 5 rotated files (`slackcli.log.1` … `.5`)
next to the current one, so it never uses more than about 30 MB. Each line is one JSON object, and every line
from one run shares a `run_id`.

- **See it live**: add `-v` / `--verbose` to any command to also print debug
  logs to stderr: `slackcli conversations list -v`.
- **Choose the level**: `SLACKCLI_LOG_LEVEL=trace|debug|info|warning|error|off`
  (default `info`). `-v` takes precedence and means `debug`
  (or keeps `trace` if `SLACKCLI_LOG_LEVEL=trace`).
- **Turn it off**: `SLACKCLI_LOG_LEVEL=off`.
- **Put it elsewhere**: `SLACKCLI_LOG_DIR=/path/to/dir`.

If the log directory is not writable, the command still runs and prints one
warning.

### The `logs` command

```bash
slackcli logs path                 # where the log file is (works even if logging is off)
slackcli logs show                 # the most recent run, redacted
slackcli logs show --last 3        # the last 3 runs, oldest first
slackcli logs show --run <run_id>  # one run
slackcli logs clear                # delete the log and its rotated copies (asks first)
```

- `logs show` puts each run back together across rotated files and prints its
  environment header (version, OS, install method, command) as `key: value`
  lines, then one line per record. The patterns that redact the file are
  applied again on output, so a token written by an older build is still
  hidden. Unreadable lines are skipped and counted on stderr. `--json` prints
  `{ log_path, runs: [{ run_id, records }], skipped_lines }`. An unknown
  `--run` exits 1.
- `logs path --json` prints `{ log_path, log_dir, exists }`.
- `logs clear` deletes only `slackcli.log` and `slackcli.log.<n>`, never other
  files in the directory. It prompts on a terminal; in a script or pipe it
  refuses unless you pass `--yes`.
- `logs` commands never write to the log themselves, so `logs show` shows the
  command you ran before it.

### Sharing logs in a bug report

1. Reproduce the problem.
2. Run `slackcli logs show --last 1` and paste the output into the issue's
   **Diagnostic log** field.
3. Read it before you paste. Tokens and cookies are redacted automatically, but
   the log still contains IDs (workspace, channel, user) and your OS details;
   remove anything you do not want public.

## Still stuck?

- [Open an issue](https://github.com/shaharia-lab/slackcli/issues) with the exact
  command, the error, and the output of `slackcli logs show --last 1`
  ([how](#sharing-logs-in-a-bug-report)); skim it before pasting.
- [Discussions](https://github.com/shaharia-lab/slackcli/discussions) for
  questions.
- Never paste a token, a cURL command, or your `workspaces.json` into a public
  issue — all three contain live credentials.
