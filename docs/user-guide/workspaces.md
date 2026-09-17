# Use several Slack workspaces from one CLI

Every authenticated Slack workspace is stored under a **profile key** in
`~/.config/slackcli/workspaces.json`. The first workspace you add automatically
becomes the default; every command uses the default unless you pass
`--workspace`.

```bash
slackcli auth list                              # what is stored, and which is default
slackcli conversations list --workspace=T1234567
slackcli conversations list --workspace="My Team"
```

`--workspace` is accepted by every command that talks to Slack.

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

`--workspace`, `auth set-default`, and `auth remove` all accept the same kinds of
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

It holds live credentials. Do not commit it, sync it, or hand it around.
