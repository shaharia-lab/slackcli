# List a workspace's custom emoji

`slackcli emoji` reads a workspace's **custom emoji** — the ones an admin or
member uploaded, not the built-in Unicode set.

```bash
slackcli emoji list
slackcli emoji list --filter kiro
slackcli emoji list --limit=50
slackcli emoji list --no-aliases
slackcli emoji list --json
slackcli emoji get party-parrot
slackcli emoji get :party-parrot: --json
```

## `emoji list`

Lists every custom emoji in the workspace, sorted by name. `--no-aliases`,
`--filter` and `--limit` are applied locally to the full list, in that order.
A workspace with no custom emoji prints nothing on stdout, even with `--json`.

`--filter <substring>` keeps emoji whose **name** contains the substring,
matched case-insensitively. It is a local match over the full in-memory list,
not a Slack search (Slack's API has no emoji search), so it does the same thing
the composer's `:name…` autocomplete does. Surrounding
colons are stripped as in `emoji get`, so `--filter :kiro:` and `--filter kiro`
behave the same; an empty value (or one that is only colons/whitespace) is
rejected rather than matching everything.

| Option | Purpose |
|---|---|
| `--limit <number>` | Maximum number of emoji to return |
| `--filter <substring>` | Only emoji whose name contains this substring (case-insensitive) |
| `--no-aliases` | Exclude alias emoji, showing only originals |
| `--workspace <id\|name>` | Workspace to use |
| `--json` | JSON output |
| `--fields <list>` | With `--json`, only these comma-separated fields (dot paths allowed) |

## `emoji get <name>`

Shows one emoji's details — whether it is an original (with its image URL) or an
alias (with the emoji it points at). The name matches with or without the
surrounding colons, so both `party-parrot` and `:party-parrot:` work.

| Option | Purpose |
|---|---|
| `--workspace <id\|name>` | Workspace to use |
| `--json` | JSON output |
| `--fields <list>` | With `--json`, only these comma-separated fields (dot paths allowed) |

## Aliases

Slack's `emoji.list` returns two kinds of value per name: an image URL for an
original custom emoji, or the string `alias:<target>` for an alias that reuses
another emoji's image. SlackCLI normalises both into a typed entry — `is_alias`
distinguishes them, and `alias_for` names the target — so the terminal output
and the `--json` schema stay the same regardless of which kind it is.

Both auth types work: `emoji.list` is available to standard (`xoxb`/`xoxp`) and
browser (`xoxd`/`xoxc`) tokens alike.
