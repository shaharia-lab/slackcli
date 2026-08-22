# Search

`slackcli search` covers messages, channels, and people. Every subcommand
accepts `--workspace <id|name>` and `--json`.

## `search messages`

```bash
slackcli search messages "deployment failed"
slackcli search messages "release" --in=engineering --from=rafael
slackcli search messages "incident" --limit=50 --sort=score
slackcli search messages "after:2026-07-01 has:link" --json
```

| Option | Default | Purpose |
|---|---|---|
| `--in <channel>` | — | Shorthand for the `in:` operator |
| `--from <user>` | — | Shorthand for the `from:` operator |
| `--limit <number>` | `20` | Results per page |
| `--page <number>` | `1` | Which page |
| `--sort <field>` | `timestamp` | `score` or `timestamp` |
| `--sort-dir <dir>` | `desc` | `asc` or `desc` |

The query is passed to Slack, so all of its
[search operators](https://slack.com/help/articles/202528808-Search-in-Slack)
work: `in:`, `from:`, `before:`, `after:`, `on:`, `during:`, `has:`, `is:`,
`with:`. `--in` and `--from` are just conveniences appended to the query.

When more pages exist, the next-page command is printed. In `--json` mode the
`page` and `pages` fields carry the same information.

Standard bot tokens (`xoxb-*`) cannot call `search.messages` at all — Slack
restricts it to user tokens. Use a `xoxp-*` token or browser auth.

## `search channels`

```bash
slackcli search channels platform
slackcli search channels incident --limit=50 --json
```

Matches on channel name, topic, and purpose.

With **browser auth** this hits Slack's own search backend and is fast. With a
**standard token** there is no equivalent API, so SlackCLI lists up to 1000
non-archived channels and filters them locally — correct, but slower on large
workspaces, and capped at that 1000.

## `search people`

```bash
slackcli search people rafael
slackcli search people "@example.com" --limit=50
```

Matches on username, real name, display name, and email.

The same auth-type split applies: browser auth uses Slack's search backend;
standard auth lists up to 1000 users and filters locally, skipping deactivated
accounts and bots.
