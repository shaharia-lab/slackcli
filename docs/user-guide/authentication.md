# Authentication

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
drafts (`messages draft`), fast channel/people search
(`search channels`, `search people` fall back to client-side filtering on
standard auth), and fetching an arbitrary thread reply by timestamp alone
(`conversations get`).

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

## Managing sessions

```bash
slackcli auth list                        # every stored workspace, default marked
slackcli auth set-default T1234567        # by profile, workspace ID, or name
slackcli auth remove T1234567
slackcli auth logout                      # clear all workspaces + browser profile
slackcli auth logout --keep-browser-session
```

Credentials live in `~/.config/slackcli/workspaces.json` (mode `0600`, inside a
`0700` directory). Nothing is sent anywhere except Slack.

Next: [workspaces and profiles](workspaces.md).
