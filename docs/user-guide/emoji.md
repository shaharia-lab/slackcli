# Emoji

`slackcli emoji` reads a workspace's **custom emoji** — the ones an admin or
member uploaded, not the built-in Unicode set.

```bash
slackcli emoji list
slackcli emoji list --limit=50
slackcli emoji list --no-aliases
slackcli emoji list --json
slackcli emoji get party-parrot
slackcli emoji get :party-parrot: --json
```

## `emoji list`

Lists every custom emoji in the workspace, sorted by name.

| Option | Purpose |
|---|---|
| `--limit <number>` | Maximum number of emoji to return |
| `--no-aliases` | Exclude alias emoji, showing only originals |
| `--workspace <id\|name>` | Workspace to use |
| `--json` | JSON output |

## `emoji get <name>`

Shows one emoji's details — whether it is an original (with its image URL) or an
alias (with the emoji it points at). The name matches with or without the
surrounding colons, so both `party-parrot` and `:party-parrot:` work.

| Option | Purpose |
|---|---|
| `--workspace <id\|name>` | Workspace to use |
| `--json` | JSON output |

## Aliases

Slack's `emoji.list` returns two kinds of value per name: an image URL for an
original custom emoji, or the string `alias:<target>` for an alias that reuses
another emoji's image. SlackCLI normalises both into a typed entry — `is_alias`
distinguishes them, and `alias_for` names the target — so the terminal output
and the `--json` schema stay the same regardless of which kind it is.

Both auth types work: `emoji.list` is available to standard (`xoxb`/`xoxp`) and
browser (`xoxd`/`xoxc`) tokens alike.
