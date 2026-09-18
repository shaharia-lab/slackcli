# Read Slack channels, threads and unreads

`slackcli conversations` covers channels, DMs, and group DMs: listing them,
reading history and threads, fetching one message, and seeing what is unread.

Every subcommand accepts `--workspace <id|name>`.

## `conversations list`

```bash
slackcli conversations list                          # everything you are in
slackcli conversations list --types=public_channel
slackcli conversations list --types=im               # DMs only
slackcli conversations list --limit=200 --exclude-archived

# Machine-readable
slackcli conversations list --json
```

| Option | Default | Purpose |
|---|---|---|
| `--types <types>` | `public_channel,private_channel,mpim,im` | Comma-separated conversation types |
| `--limit <number>` | `100` | How many to return |
| `--exclude-archived` | off | Skip archived conversations |
| `--cursor <cursor>` | — | Fetch the next page |
| `--json` | off | JSON output with a resolved `users` array |

DM entries are resolved to the other person's name. When more results exist, the
exact `--cursor` command for the next page is printed (human output) or set on
`next_cursor` (`--json`; `null` on the last page).

## `conversations read`

Read channel history, or one thread.

```bash
# Recent messages in a channel (oldest first)
slackcli conversations read C1234567890

# One thread
slackcli conversations read C1234567890 --thread-ts=1234567890.123456

# The thread a message link points at
slackcli conversations read --permalink="https://myteam.slack.com/archives/C1234567890/p1234567890123456"

# Top-level messages only
slackcli conversations read C1234567890 --exclude-replies

# A time window
slackcli conversations read C1234567890 --oldest=1735689600 --latest=1738368000

# Machine-readable
slackcli conversations read C1234567890 --json
```

| Option | Default | Purpose |
|---|---|---|
| `--thread-ts <ts>` | — | Read a specific thread instead of the channel |
| `--permalink <url>` | — | Replaces the channel argument and `--thread-ts` |
| `--exclude-replies` | off | Drop threaded replies from channel history |
| `--limit <number>` | `100` | How many messages |
| `--oldest` / `--latest` | — | Time range bounds |
| `--json` | off | JSON output, including `ts` and `thread_ts` |

Channel history comes back newest-first from Slack and is reversed so you read
top to bottom. Thread replies are already chronological. `--json` also includes
reactions, blocks, attachments, file metadata, and a resolved `users` array.

## `conversations get`

Fetch one message by channel and timestamp.

```bash
slackcli conversations get C1234567890 1234567890.123456
slackcli conversations get --permalink="https://myteam.slack.com/archives/C1234567890/p1234567890123456"
slackcli conversations get C1234567890 p1234567890123456 --json
```

**Auth-type caveat.** With browser auth this resolves both top-level messages and
thread replies. With a standard token it can only resolve **top-level** messages
— looking up an arbitrary reply needs its parent's `thread_ts`, and no public
Slack API returns that from a reply timestamp alone. Read the thread instead:
`conversations read <channel> --thread-ts=<parent>`.

## `conversations unread`

```bash
slackcli conversations unread
slackcli conversations unread --types=dms          # channels, dms, groups
slackcli conversations unread --json
```

Conversations with mentions sort first, then alphabetically. On a workspace with
many unread channels this makes one API call per channel to resolve names and
may hit Slack rate limits.

## `conversations members list`

```bash
slackcli conversations members list C1234567890
slackcli conversations members list C1234567890 --limit=50
slackcli conversations members list C1234567890 --cursor="$NEXT_CURSOR"   # next page
slackcli conversations members list C1234567890 --json
```

Lists the member IDs of a channel or conversation. `--limit` reflects members
**returned** (it pages until it has that many or the conversation is exhausted),
and when more remain the output prints the `--cursor` value to fetch the next
page. `--json` gives `{ channel_id, member_count, members: [...], next_cursor? }`.

**Enterprise-grid caveat.** On an Enterprise Grid org this endpoint can be
blocked by org policy — Slack returns `enterprise_is_restricted`, the command
reports it clearly and exits non-zero (scoping to a team does **not** lift it).
Member *management* (`add`/`remove`) and self ops (`join`/`leave`) are
documented below; this command is read-only.

## `conversations members add`

```bash
slackcli conversations members add C1234567890 U1 U2 U3
slackcli conversations members add C1234567890 U1,U2 --yes    # non-interactive
slackcli conversations members add C1234567890 U1 --json
```

Adds one or more users (or agents/apps) to a channel. IDs are comma- or
space-separated. This is a batch, all-or-nothing operation: Slack's
`conversations.invite` adds the whole set or, if any ID cannot be invited,
adds none and reports the error — a success message never over-reports.

Mutating commands confirm before acting: in a terminal you get a `[y/N]`
prompt; with no terminal the command refuses unless you pass `--yes`, so a
script cannot change membership by accident. `--json` gives
`{ channel_id, added: [...] }`.

## `conversations members remove`

```bash
slackcli conversations members remove C1234567890 U1 U2
slackcli conversations members remove C1234567890 U1 --yes --json
```

Removes one or more users from a channel. Slack's `conversations.kick` removes
one user per call, so this is best-effort per ID: it attempts every ID and
reports which came out and which failed, rather than stopping at the first
error. It exits non-zero if **any** removal failed, and `--json` gives
`{ channel_id, removed: [...], failed: [{ user, error }] }`. Confirmation
works exactly as for `add` (prompt, or `--yes` when non-interactive).

## `conversations join`

```bash
slackcli conversations join C1234567890
slackcli conversations join C1234567890 --json
```

Joins a public channel as yourself. This is a self-op with no confirmation
prompt — it is idempotent (joining a channel you are already in is a no-op) and
only changes your own membership. `--json` gives `{ channel_id, channel }`.

## `conversations leave`

```bash
slackcli conversations leave C1234567890
slackcli conversations leave C1234567890 --yes --json
```

Leaves a channel or conversation as yourself. Like the other mutating commands
it confirms first (or takes `--yes` when non-interactive). Leaving a channel you
are already out of is reported as a no-op, not an error. `--json` gives
`{ channel_id, left, not_in_channel }`.
