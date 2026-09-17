# Troubleshooting SlackCLI

## `No workspace configured`

Nothing is authenticated yet. Run `slackcli auth login-auto`, or see
[authentication](authentication.md).

## `Workspace not found: <name>`

The selector matched nothing. `slackcli auth list` shows the profile keys,
workspace IDs, and names that are valid.

## `"x" matches multiple profiles`

You have more than one identity for that workspace. Pass the profile name
instead of the bare ID or name — see
[workspaces and profiles](workspaces.md#how-a-selector-is-resolved).

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

Slack apps cannot create drafts. Use a browser-authenticated profile.

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
- **Permission denied**: you lack write access to the binary's location. Install
  to `~/.local/bin` instead of a system directory.
- **Checksum mismatch**: the update is aborted deliberately. Do not work around
  it — download the binary manually and check it against `checksums.txt` from
  the release.

## Rate limits and slow commands

slackcli paces its own traffic: it keeps at most 2 Slack API calls in flight and
leaves at least 200ms between calls, for both app tokens and browser sessions.
Bursting past that is what trips Slack's `unexpected_api_call_volume` anomaly
detection, which on Enterprise Grid can sign the session out.

The visible cost is that commands resolving many names one entity at a time —
`conversations unread`, `saved list` — take noticeably longer on a large
workspace. The spinner keeps running; it is throttling, not hanging. Narrow the
request (`--types`, `--limit`) to make it finish sooner.

If Slack itself rate-limits you anyway, retry after a pause.

## Still stuck?

- [Open an issue](https://github.com/shaharia-lab/slackcli/issues) with the exact
  command, the error, and `slackcli --version`.
- [Discussions](https://github.com/shaharia-lab/slackcli/discussions) for
  questions.
- Never paste a token, a cURL command, or your `workspaces.json` into a public
  issue — all three contain live credentials.
