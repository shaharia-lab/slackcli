# Use several Slack workspaces from one CLI

Every authenticated Slack workspace is stored under a **profile key** in
`~/.config/slackcli/workspaces.json`. The first workspace you add automatically
becomes the default; every command uses the default unless you pass
`--workspace`.

```bash
slackcli auth list                              # what is stored, and which is default
slackcli auth list --check                      # ...and which logins still work
slackcli conversations list --workspace=T1234567
slackcli conversations list --workspace="My Team"
```

`--workspace` is accepted by every command that talks to Slack.

## Pin a workspace for one shell

Set `SLACKCLI_WORKSPACE` to select a workspace for every command in the current
shell, script, or job, without repeating `--workspace` and without changing the
default that other terminals use:

```bash
export SLACKCLI_WORKSPACE=acme
slackcli conversations list                     # runs against acme
slackcli conversations list --workspace=other   # the flag still wins
```

A command picks its workspace from the first of these that is set:

| Order | Source | Scope |
| --- | --- | --- |
| 1 | `--workspace <id\|name>` | That one command |
| 2 | `SLACKCLI_WORKSPACE` | The current shell or process environment |
| 3 | The stored default (`auth set-default`) | Every shell on the machine |

- The variable takes the same values as `--workspace` (see
  [how a selector is resolved](#how-a-selector-is-resolved)).
- An unset, empty, or whitespace-only variable is ignored.
- A value that matches no profile is an error that names the variable —
  `Workspace not found: acme (from SLACKCLI_WORKSPACE)` — and never falls back to
  the stored default. A value that matches several profiles gets the same
  "matches multiple profiles" error as the flag.
- `auth list`, `auth set-default`, `auth remove`, and the login commands ignore
  the variable: `auth list` still marks the stored default, and `auth
  set-default` still changes it.

## See which profile is active

`auth list` marks the stored default, but the flag and the variable can override
it. `auth whoami` resolves the selection the way a real command would and shows
the result, with where it came from:

```bash
slackcli auth whoami                    # Selected by: stored default
SLACKCLI_WORKSPACE=acme slackcli auth whoami   # Selected by: SLACKCLI_WORKSPACE
slackcli auth whoami --workspace=other  # Selected by: --workspace flag
```

It also prints the profile key and the authenticated user, so two profiles for
the same workspace can be told apart, and it verifies the credentials with
Slack — see
[check who you are signed in as](authentication.md#check-who-you-are-signed-in-as).

## Check which logins still work

`auth list` reads only the local config, so a profile whose session expired
weeks ago looks the same as a healthy one. `auth list --check` asks Slack about
every stored profile, one `auth.test` call each, and shows `ok`, `auth failed`
or `unreachable` under each one. It exits `1` if any profile is not `ok`, so a
script or agent can check all of them before picking one to work in:

```bash
slackcli auth list --check
slackcli auth list --check --json | jq -r '.workspaces[] | select(.check.status == "ok") | .profile'
```

`unreachable` means the check did not complete, not that the login is bad: try
again before logging in again. Like plain `auth list`, it ignores
`SLACKCLI_WORKSPACE` — every stored profile is checked. Details in
[check every stored profile](authentication.md#check-every-stored-profile).

## Several identities in one workspace

By default each workspace is stored once. To keep **more than one identity for
the same workspace** — say a browser-authenticated user for search and drafts,
alongside a bot token for unattended jobs — name each login with `--profile`:

```bash
# A user identity (browser auth)
slackcli auth login-browser \
  --xoxd=xoxd-... --xoxc=xoxc-... \
  --workspace-url=https://example.slack.com \
  --profile=rafael

# A bot identity in the same workspace
slackcli auth login \
  --token=xoxb-... \
  --workspace-name=example \
  --profile=automation-bot
```

Then select one anywhere `--workspace` is accepted:

```bash
slackcli search messages "after:2026-07-01" --workspace=rafael --json
slackcli messages send --recipient-id=C123 --message="Done" --workspace=automation-bot
```

## How keys are chosen

- **First identity for a team** keeps the historical `team_id` as its key, so
  existing configs and scripts are unaffected.
- **Re-authenticating the same identity** (same team, same auth type, same user)
  refreshes its tokens in place — it keeps its key, its default status, and any
  name you gave it. This is what makes `auth login-auto --headless` usable as a
  token refresh.
- **A second identity without `--profile`** is saved under an auto-generated key
  such as `T1234567-2` rather than overwriting the first. The key that was used
  is printed after login.
- **`--profile` naming an existing key that belongs to a different team** is
  refused, so you cannot clobber an unrelated record by reusing a name.

## How a selector is resolved

`--workspace`, `SLACKCLI_WORKSPACE`, `auth set-default`, and `auth remove` all accept the same kinds of
value, tried in this order:

1. An exact profile key
2. An explicit `--profile` name
3. A workspace ID (`T…`)
4. A workspace name

If a bare ID or name matches more than one stored profile, SlackCLI stops and
asks you to disambiguate with a profile name instead of silently picking one.

```
"example" matches multiple profiles: T1234567, rafael.
Re-run with --workspace=<profile> (see "slackcli auth list").
```

## Config file

`~/.config/slackcli/workspaces.json`, mode `0600`:

```json
{
  "default_workspace": "T1234567",
  "workspaces": {
    "T1234567": {
      "workspace_id": "T1234567",
      "workspace_name": "example",
      "auth_type": "browser",
      "workspace_url": "https://example.slack.com",
      "xoxd_token": "xoxd-...",
      "xoxc_token": "xoxc-..."
    },
    "automation-bot": {
      "workspace_id": "T1234567",
      "workspace_name": "example",
      "profile": "automation-bot",
      "auth_type": "standard",
      "token": "xoxb-...",
      "token_type": "bot"
    }
  }
}
```

It holds live credentials, except for a profile stored with
`"secret_backend": "keychain"` — there the token fields above are absent and
the credentials live in the macOS Keychain instead. See
[authentication: where credentials are stored](authentication.md#where-credentials-are-stored).
Do not commit this file, sync it, or hand it around.
