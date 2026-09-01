# Team

`slackcli team` reads information about the **workspace (team) itself** — its
name, domain, and ID.

```bash
slackcli team info
slackcli team info --json
```

## `team info`

Shows the workspace name, ID, domain, and (when present) email domain and
verification status. Backed by Slack's `team.info`, which works for both
standard (`xoxb`/`xoxp`) and browser (`xoxd`/`xoxc`) tokens.

| Option | Purpose |
|---|---|
| `--team <workspace-id>` | Target workspace T-id (enterprise org scoping) |
| `--workspace <id\|name>` | Workspace to use |
| `--json` | JSON output |

On a Slack **Enterprise Grid**, `--team <T-id>` scopes the lookup to a specific
member workspace; without it Slack returns the token's own workspace.

For **groups of users** within the workspace — what Slack calls User Groups or
"subteams" — see [User groups](usergroups.md).
