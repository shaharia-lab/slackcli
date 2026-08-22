# Saved items

`slackcli saved list` reads your **Later** / "saved for later" list.

```bash
slackcli saved list
slackcli saved list --limit=50
slackcli saved list --state=to_do
slackcli saved list --json
```

| Option | Purpose |
|---|---|
| `--limit <number>` | Maximum number of items to return |
| `--state <state>` | Filter by `saved`, `to_do`, or `completed` |
| `--workspace <id\|name>` | Workspace to use |
| `--json` | JSON output |

Raw saved entries are only pointers — a channel ID and a timestamp. SlackCLI
paginates the whole list, then resolves each pointer into the actual message
text, the channel name, and the author, so the output is readable without a
second lookup.

Both auth types work: browser auth uses Slack's `saved.list`, standard auth
falls back to `stars.list`. The two return different shapes; the enrichment step
normalises them, so the output and the `--json` schema are the same either way.
