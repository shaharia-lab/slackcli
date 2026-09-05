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
