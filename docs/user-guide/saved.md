# Work through Slack saved items

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
| `--fields <list>` | With `--json`, only these comma-separated fields (dot paths allowed) |

SlackCLI pages through the whole list (or stops at `--limit`). `--limit` caps
the items fetched, before `--state` filters them.

The two auth types read different Slack lists and return different shapes:

- **Browser auth** uses Slack's `saved.list`, the **Later** list. Raw saved
  entries are only pointers — a channel ID and a timestamp — so SlackCLI
  resolves each one into the message text, the channel name, and the author.
  Each `--json` item is `{type, channel_id, channel_name, message, date_saved,
  todo_state}`; non-message items carry only `type`, `channel_id` and
  `date_saved`.
- **Standard auth** (app tokens) falls back to `stars.list`, which returns
  *starred* items with the message inline. They are passed through as Slack
  returns them, so the `--json` item shape is Slack's `stars.list` shape. Those
  items have no `todo_state`, so `--state` matches nothing.

`--json` emits `{item_count, items}`. When there are no items, nothing is
written to stdout and the command exits 0.
