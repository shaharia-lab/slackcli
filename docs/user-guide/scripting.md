# Scripting and JSON output

SlackCLI is built to be driven by scripts, cron jobs, and AI agents as much as by
hand.

## `--json`

Every read command supports `--json`: `conversations list`, `conversations read`,
`conversations get`, `conversations unread`, `search messages`, `search channels`,
`search people`, `saved list`, `canvas list`, `canvas read`.

JSON goes to **stdout**. Progress spinners, error messages, and the
update-available notice go to **stderr**, so a pipe normally carries only data:

```bash
slackcli conversations read C1234567890 --json | jq '.messages[].text'
```

One caveat: the workspace-mismatch **warning** is currently written to stdout,
not stderr. It only fires when you pass a `--permalink` or Slack URL whose
subdomain does not match the workspace being called, so it cannot appear in a
pipeline that passes plain IDs or targets the right workspace.

### Shapes

```bash
# Conversations, with a resolved users array so DM ids are not opaque
slackcli conversations list --json | jq '.conversations[] | {id, name}'
slackcli conversations list --json | jq '.next_cursor'

# Messages, with a resolved users array so IDs are not opaque
slackcli conversations read C123 --json | jq '.messages[] | {ts, user, text}'
slackcli conversations read C123 --json | jq '.users[] | {id, real_name}'

# Just the thread replies to one message
slackcli conversations read --permalink="$LINK" --json | jq -r '.messages[].text'

# Search hits with their permalinks
slackcli search messages "deploy failed" --json | jq -r '.matches[] | "\(.channel.name)\t\(.permalink)"'

# Unread channels that have mentions
slackcli conversations unread --json | jq '.unread_channels[] | select(.mention_count > 0)'

# A canvas as Markdown
slackcli canvas read F123 --json | jq -r '.markdown' > canvas.md
```

`--json` output for messages includes `ts`, `thread_ts`, `user`, `text`, `type`,
`reply_count`, `reactions`, `bot_id`, `blocks`, `attachments`, and file metadata
when a message has attachments.

## Exit codes

`0` on success, `1` on failure. Failures print a message to stderr — check the
exit code rather than parsing that text.

```bash
if ! slackcli messages send --recipient-id="$CHANNEL" --message="$TEXT"; then
  echo "post failed" >&2
  exit 1
fi
```

An empty result is *not* a failure: a search with no hits, or an unread list with
nothing in it, exits `0`. Test the data, not the exit code:

```bash
count=$(slackcli search messages "$Q" --json | jq '.total')
[ "$count" -gt 0 ] || echo "nothing found"
```

## Patterns

**Post and keep the timestamp**, so you can edit or react later. The human
output prints it; `--json` is not offered on `messages send`, so parse the line:

```bash
ts=$(slackcli messages send --recipient-id=C123 --message="Working…" \
     | grep -oE '[0-9]{10}\.[0-9]{6}')
slackcli messages edit --channel-id=C123 --timestamp="$ts" --message="Done ✅"
```

**Reply into a thread from a link** — no ID juggling:

```bash
slackcli messages send --permalink="$SLACK_LINK" --message="On it"
```

**Pick an identity explicitly** in unattended jobs, rather than depending on
whichever workspace happens to be the default:

```bash
slackcli messages send --workspace=automation-bot --recipient-id=C123 --message="Nightly build green"
```

**Paginate a search**:

```bash
page=1
while :; do
  out=$(slackcli search messages "$Q" --page="$page" --limit=100 --json)
  echo "$out" | jq -r '.matches[].permalink'
  [ "$page" -lt "$(echo "$out" | jq '.pages')" ] || break
  page=$((page + 1))
done
```

## Notes for unattended use

- **Token freshness.** Browser tokens die with the browser session. Refresh them
  non-interactively with `slackcli auth login-auto --headless`, which works once
  the profile has been signed in once.
- **Rate limits.** Commands that resolve many users or channels
  (`conversations unread`, `saved list` on a long list) make one API call per
  entity and can hit Slack's rate limits on a big workspace.
- **The update notice.** SlackCLI may append a one-line "update available" notice
  after a command. It goes to stderr and never contaminates `--json` on stdout.
- **Credentials.** `~/.config/slackcli/workspaces.json` holds live tokens at mode
  `0600`. Give a CI job its own bot-token profile rather than copying a personal
  browser session around.
