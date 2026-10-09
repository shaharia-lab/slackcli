# Authentication: browser session or Slack app token

SlackCLI supports two kinds of credentials, and four ways to obtain them.

| Auth type | Tokens | Obtained by | Best for |
|---|---|---|---|
| **Standard** | `xoxb-*` (bot) or `xoxp-*` (user) | Creating a Slack app | Unattended automation, CI, servers |
| **Browser** | `xoxd-*` cookie + `xoxc-*` token | Reusing your own signed-in session | Personal use, no admin approval needed |

The auth type is stored per workspace and decides how every later request is
made — see [architecture](../development/architecture.md#dual-authentication).

## Which should I use?

- You can create (or already have) a Slack app → **standard tokens**. They are
  stable, scoped, and do not expire with your browser session.
- You cannot get a Slack app approved, or you want the CLI to act as *you* →
  **browser tokens**, easiest via `auth login-auto`.

A few features are browser-only, because Slack exposes no public API for them:
draft creation and listing (`messages draft`, `messages list-drafts`), fast channel/people search
(`search channels`, `search people` fall back to client-side filtering on
standard auth), fetching an arbitrary thread reply by timestamp alone
(`conversations get`), and reading the unread messages and unread thread replies
in one call (`conversations unread --messages`).

## 1. Standard Slack app tokens

Create an app at [api.slack.com/apps](https://api.slack.com/apps), add the OAuth
scopes you need, install it to the workspace, and copy the token.

```bash
slackcli auth login --token=xoxb-YOUR-TOKEN --workspace-name="My Team"
```

The token is validated with `auth.test` before anything is saved, so a bad token
fails immediately rather than at first use.

Useful scopes, by what you want to do:

| Task | Scopes |
|---|---|
| List channels | `channels:read`, `groups:read`, `im:read`, `mpim:read` |
| Read history | `channels:history`, `groups:history`, `im:history`, `mpim:history` |
| Send / edit messages | `chat:write` |
| React | `reactions:write` |
| Upload files | `files:write` |
| Search messages | `search:read` (user tokens only) |
| Read canvases | `files:read` |

## 2. Automatic browser login (easiest)

```bash
slackcli auth login-auto
```

A browser opens on Slack. Sign in as you normally would and SlackCLI captures
the tokens — it enrols **every workspace you are signed into**, not just the one
you opened.

| Option | Purpose |
|---|---|
| `--workspace-url <url>` | Open a specific workspace instead of the Slack home |
| `--timeout <seconds>` | How long to wait for sign-in (default `300`) |
| `--headless` | No visible window; only works once you are already signed in |

| Environment variable | Purpose |
|---|---|
| `SLACKCLI_BROWSER` | Path to a browser, if yours is not auto-detected |
| `SLACKCLI_BROWSER_PROFILE` | Override the profile directory |

**Requirements:** Chrome, Edge, Chromium, or Brave installed. Nothing is
downloaded and no extra dependency is installed — SlackCLI drives the browser
you already have, over the Chrome DevTools Protocol.

**Why you sign in again the first time.** SlackCLI runs the browser against its
own profile in `~/.config/slackcli/browser-profile`, separate from your everyday
browsing. It has to: since Chrome 136 the browser refuses remote debugging
against the default profile, so your existing session cannot be reused. The
profile persists, so **only the first run needs interaction** — afterwards
`slackcli auth login-auto --headless` refreshes tokens with no window and no
prompt.

**Security notes.**

- Token values are never printed.
- **The browser profile is a credential store.** While it exists, `login-auto`
  can re-mint working tokens with no prompt. `slackcli auth logout` therefore
  deletes it along with `workspaces.json`; pass `--keep-browser-session` to keep
  it signed in.
- Only `https://` URLs on a `slack.com` host are ever paired with your session
  cookie — a URL read from the browser that points anywhere else is refused.
- While the browser is open it exposes a DevTools port on loopback that any
  local process could connect to. SlackCLI closes the browser as soon as capture
  finishes, and also on `Ctrl-C` or termination.
- Credentials land in `~/.config/slackcli/workspaces.json` (mode `0600`); the
  profile directory is `0700` on macOS and Linux (Windows uses ACL defaults).

Partial success is still success: if one captured workspace has a stale token,
the others are still saved and the failure is reported.

## 3. Parse a cURL command

If you would rather not let SlackCLI drive a browser, copy one Slack API request
out of DevTools and let it read the tokens from that.

In DevTools → Network, right-click any Slack API request → **Copy** → **Copy as
cURL**, then:

```bash
# Interactive: paste, then press Enter twice (or Ctrl-D)
slackcli auth parse-curl --login

# Straight from the clipboard
slackcli auth parse-curl --from-clipboard --login

# Piped
pbpaste | slackcli auth parse-curl --login
cat curl-command.txt | slackcli auth parse-curl --login
```

This extracts the workspace URL and name, the `xoxd` token from the cookie
header, and the `xoxc` token from the request body. Drop `--login` to print what
was found without saving it.

Clipboard reading uses `pbpaste` on macOS, PowerShell on Windows, and
`xclip`/`xsel` on Linux — install one of those if the clipboard path fails.

## 4. Browser session tokens by hand

```bash
slackcli auth extract-tokens     # prints the step-by-step guide

slackcli auth login-browser \
  --xoxd=xoxd-YOUR-TOKEN \
  --xoxc=xoxc-YOUR-TOKEN \
  --workspace-url=https://yourteam.slack.com
```

Where the values come from: open your workspace in a browser, open DevTools
(F12), go to Network, refresh or send a message, pick any Slack API request, and
read `d=xoxd-…` from the `Cookie` header and `"token":"xoxc-…"` from the request
payload.

## Check who you are signed in as

`auth whoami` answers "which workspace and which user is the CLI acting as, and
do the credentials still work?". It picks the profile the same way every other
command does (`--workspace`, then `SLACKCLI_WORKSPACE`, then the stored
default), makes one `auth.test` call to Slack, and prints the result:

```bash
slackcli auth whoami
slackcli auth whoami --workspace=acme
slackcli auth whoami --json
```

```text
Acme Corp
  ID: T1234567
  Profile: acme
  User: alice (U0123ABCD)
  Auth: 🌐 Browser
  Selected by: stored default
  Status: verified
```

`Selected by` is `--workspace flag`, `SLACKCLI_WORKSPACE`, or `stored default`.
The user is the one Slack reports for the credentials; for a bot token that is
the bot user, shown with its bot ID.

There are three outcomes, and the exit code tells them apart from success:

| `Status` | `--json` `status` | Exit code | Meaning |
|---|---|---|---|
| `verified` | `ok` | `0` | Slack accepted the credentials |
| `authentication failed (<code>)` | `auth_failed` | `1` | Slack refused them. The meaning and the `To fix:` command follow — the same ones as in [troubleshooting](troubleshooting.md#authentication-failed-for-profile--invalid_auth-not_authed-token_expired-token_revoked-account_inactive) |
| `unreachable` | `unreachable` | `1` | Slack did not answer (no connection, an HTTP error, or a rate limit), so the credentials were **not** checked |

When the check fails, the stored profile details are still printed, with the
user ID saved at login if there is one. No workspace configured, an unknown
selector and an ambiguous one are errors as for any other command (exit code
`1`, nothing on stdout).

There is no offline mode: the call to Slack is the point. When Slack cannot be
reached, the check gives up after three retries instead of retrying for
minutes as other commands with an app token do, and with an app token a rate
limit (HTTP 429) is reported at once instead of being waited out.

With `--json`, stdout carries one object in all three outcomes:

```json
{
  "profile": "acme",
  "workspace_id": "T1234567",
  "workspace_name": "Acme Corp",
  "auth_type": "browser",
  "source": "default",
  "status": "ok",
  "user": "alice",
  "user_id": "U0123ABCD"
}
```

| Field | Present | Value |
|---|---|---|
| `profile` | always | The profile key the workspace is stored under |
| `workspace_id`, `workspace_name` | always | As stored at login |
| `auth_type` | always | `browser` or `standard` |
| `source` | always | `flag`, `env`, or `default` |
| `status` | always | `ok`, `auth_failed`, or `unreachable` |
| `user` | `ok` | The user (or bot user) name from Slack |
| `user_id` | `ok`; otherwise only if stored at login | From Slack when `ok`, else the stored ID |
| `bot_id` | `ok`, bot tokens only | The bot ID from Slack |
| `error` | not `ok` | `{code, meaning, fix}` for `auth_failed`; `{message, http_status?}` for `unreachable` |

No token value is ever printed. See
[scripting](scripting.md#patterns) for using it as a gate in a script.

## Check every stored profile

`auth whoami` checks one profile. `auth list --check` checks all of them, with
one `auth.test` call per profile, one after the other, and adds a status under
each:

```bash
slackcli auth list --check
slackcli auth list --check --json
```

```text
📋 Authenticated Workspaces (2):

1. Acme Corp (default)
  ID: T1234567
  Profile: acme
  Auth: 🌐 Browser
  Status: ok (alice, U0123ABCD)

2. Other Team
  ID: T7654321
  Auth: 🔑 Standard
  Status: auth failed (token_revoked: The stored token was revoked by the user or a workspace admin.)
  To fix: slackcli auth login --token <token> --workspace-name <name> (with a new token; the revoked one cannot be reused)
```

| `Status` | `--json` `check.status` | Meaning |
|---|---|---|
| `ok (<user>, <user ID>)` | `ok` | Slack accepted the credentials |
| `auth failed (<code>: <meaning>)`, then `To fix:` | `auth_failed` | Slack refused them; the code, meaning and fix are the ones `auth whoami` shows |
| `auth failed (<message>)` | `auth_failed` | The stored credentials could not be read (for example a missing Keychain item); the message is the store's own |
| `unreachable (<message>)` | `unreachable` | The check did not complete (no connection, an HTTP error, a rate limit), so nothing is known about the credentials |

A failing profile never stops the others from being checked. The exit code is
`1` when any profile is not `ok`, and `0` when all are. Without `--check`,
`auth list` reads only the local config, makes no network call, and exits `0`.

`--check` reads every profile's credentials, which plain `auth list` never does:
with the [macOS Keychain backend](#where-credentials-are-stored) that can mean one
Keychain prompt per profile.

`auth list --json` (with or without `--check`) writes one object:

```json
{
  "default": "acme",
  "workspaces": [
    {
      "profile": "acme",
      "workspace_id": "T1234567",
      "workspace_name": "Acme Corp",
      "auth_type": "browser",
      "is_default": true,
      "secret_backend": "file",
      "check": { "status": "ok", "user": "alice", "user_id": "U0123ABCD" }
    }
  ]
}
```

| Field | Present | Value |
|---|---|---|
| `default` | always | The stored default's profile key, or `null` |
| `profile`, `workspace_id`, `workspace_name`, `auth_type` | always | As stored at login |
| `is_default` | always | Whether this profile is the stored default |
| `secret_backend` | always | `file` or `keychain` |
| `check` | `--check` only | `{status: "ok", user, user_id, bot_id?}`, `{status: "auth_failed", error: {code, meaning, fix}}` (or `error: {message}` when the credentials could not be read), or `{status: "unreachable", error: {message, http_status?}}` |

With nothing stored, `--json` writes `{"default": null, "workspaces": []}` and
exits `0`. No token value is ever printed.

## Managing sessions

```bash
slackcli auth whoami                      # the active profile and user, verified
slackcli auth list                        # every stored workspace, default marked
slackcli auth list --check                # ...and whether each one still works
slackcli auth set-default T1234567        # by profile, workspace ID, or name
slackcli auth remove T1234567
slackcli auth logout                      # clear all workspaces + browser profile
slackcli auth logout --keep-browser-session
```

Workspace metadata (workspace ID/name, auth type, profile) always lives in
`~/.config/slackcli/workspaces.json` (mode `0600`, inside a `0700` directory).
Where the *credentials* themselves live depends on the storage backend — see
below. Nothing is sent anywhere except Slack.

## Where credentials are stored

By default every credential (`xoxb`/`xoxp` token, or the `xoxc`/`xoxd` pair) is
stored inline in `workspaces.json`, exactly as described above — this is the
**file backend**, and it is still the default everywhere, including macOS.

On macOS you can opt a profile into storing its credentials in the **macOS
Keychain** instead, via `--secret-backend keychain` on any login path:

```bash
slackcli auth login --token=xoxb-... --workspace-name="My Team" --secret-backend=keychain
slackcli auth login-browser --xoxd=... --xoxc=... --workspace-url=https://... --secret-backend=keychain
slackcli auth login-auto --secret-backend=keychain
slackcli auth parse-curl --login --secret-backend=keychain
```

`workspaces.json` still holds that profile's metadata, plus a
`"secret_backend": "keychain"` marker — no token value. `auth list` shows which
backend each profile uses. The flag only takes effect on a **new** profile; a
token refresh of an existing profile (e.g. running `auth login` again for the
same identity) keeps whatever backend it is already on, so an ordinary refresh
never silently downgrades a Keychain profile back to plaintext.

**Move an existing profile to a different backend** with `auth migrate-secrets`:

```bash
slackcli auth migrate-secrets --to keychain --profile T1234567   # one profile
slackcli auth migrate-secrets --to keychain                      # every profile
slackcli auth migrate-secrets --to file --profile T1234567 --yes # back to file, unattended
```

Migration writes the credentials to the new backend, reads them back and
verifies every byte matches, and only then removes the old copy — a failure at
any point leaves the original untouched, so it is always safe to re-run.

**Keychain requirements and limitations:**

- macOS only; `--secret-backend keychain` is refused on every other platform,
  and `auth migrate-secrets --to keychain` fails the same way.
- Implemented by shelling out to the built-in `security` CLI (`security
  add/find/delete-generic-password`, service `slackcli`) rather than an FFI
  binding to Security.framework — the same trade-off `cdp-client.ts` makes
  against Playwright, to avoid a new dependency and stay inside the 150MB
  binary budget. One consequence: `security add-generic-password -w <value>`
  has no way to pass the secret except as a command-line argument, so it is
  briefly visible to other processes on the same host via `ps` while the write
  is in flight (not persisted, not logged, but not hidden from a concurrently
  running `ps` either). Keychain access itself may prompt for the login
  password or Touch ID, per your Keychain Access settings for the item.
- The Keychain is not a sandbox against another process running as your user —
  it protects credentials at rest (other users, backups, casual file
  inspection, syncing tools that read `~/.config`), not against something else
  running as you.

Next: [workspaces and profiles](workspaces.md).
