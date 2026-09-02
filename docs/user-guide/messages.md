# Messages

`slackcli messages` sends, edits, reacts to, and drafts messages.

Every subcommand accepts `--workspace <id|name>`.

## `messages send`

```bash
# To a channel
slackcli messages send --recipient-id=C1234567890 --message="Hello team!"

# To a person — the DM is opened for you
slackcli messages send --recipient-id=U9876543210 --message="Hey there!"

# As a thread reply
slackcli messages send --recipient-id=C1234567890 --thread-ts=1234567890.123456 --message="Great idea!"

# Reply in the thread a link points at
slackcli messages send --permalink="https://myteam.slack.com/archives/C1234567890/p1234567890123456" --message="Great idea!"

# With a file attached
slackcli messages send --recipient-id=C1234567890 --message="Here is the file" --file=./report.pdf

# Message text from a file
slackcli messages send --recipient-id=C1234567890 --message-file=./release-notes.md
```

| Option | Purpose |
|---|---|
| `--recipient-id <id>` | Channel ID, user ID, or Slack URL |
| `--message <text>` | Message text. **Required** unless `--message-file` is given |
| `--message-file <path>` | Read the message text from a UTF-8 file; cannot be combined with `--message` |
| `--thread-ts <ts>` | Post as a reply in this thread |
| `--permalink <url>` | Replaces `--recipient-id` and `--thread-ts` |
| `--file <path>` | Attach a file; the message text becomes the comment |
| `--blocks <json\|@file>` | Block Kit JSON array; cannot be combined with `--file` |
| `--json` | Print the delivered message as JSON instead of the human line |

A `--recipient-id` starting with `U` opens a DM first. File uploads need upload
permission in the workspace — `files:write` for standard tokens. Uploads go
through Slack's external-upload flow; empty files, directories, and missing
paths are rejected before anything is sent.

On success the message timestamp is printed — capture it if you want to edit or
react to the message later, or use `--json` to get it as structured data.

### Message text from a file (`--message-file`)

`--message-file` reads the message body from a UTF-8 file instead of an
argument, which avoids quoting and shell-escaping a long or multi-line message:

```bash
slackcli messages send --recipient-id=C1234567890 --message-file=./release-notes.md
```

The file's contents are sent exactly as `--message` would send them, mrkdwn
included. `--message` and `--message-file` are mutually exclusive, and exactly
one of them is required. A missing path, or a file that is empty or only
whitespace, is an error raised **before** anything is sent.

### JSON output (`--json`)

`--json` replaces the human success line with a single object on stdout, so a
script can keep the message's identity for a follow-up call:

```bash
slackcli messages send --recipient-id=C1234567890 --message="Deploying…" --json
```

```json
{
  "channel_id": "C1234567890",
  "ts": "1234567890.123456",
  "permalink": "https://myteam.slack.com/archives/C1234567890/p1234567890123456"
}
```

`permalink` is looked up separately with `chat.getPermalink` after the message
is delivered. If that lookup fails — a token without the scope, say — the key
is **omitted** rather than emitted as `null`; the send itself still succeeded.
Test for the key rather than assuming it.

With `--file`, the upload flow returns the attached file rather than a message
timestamp, so that branch emits `channel_id` and `file_id` only.

Errors are unaffected by `--json`: they still go to stderr with exit code `1`,
and nothing is written to stdout.

### Text formatting

Message text is sent with Slack's `parse=none`, so Slack mrkdwn works as you
write it: `*bold*`, `_italic_`, `~strike~`, `` `code` ``, triple-backtick
blocks, and links as `<https://example.com|label>`. Slack has no `[text](url)`
link syntax and no `#` headings in plain message text — use `--blocks` with a
`markdown` block if you want those.

### Block Kit (`--blocks`)

`--blocks` takes a JSON array of
[Block Kit blocks](https://docs.slack.dev/reference/block-kit/blocks/), inline or
loaded from a file with `--blocks=@blocks.json`. It works with both auth types.
The required `--message` text is still used as the notification and
accessibility fallback.

Native [`markdown` blocks](https://docs.slack.dev/reference/block-kit/blocks/markdown-block/)
take *standard* Markdown rather than Slack mrkdwn, which buys you headings, task
lists, syntax-highlighted code fences, and Markdown tables:

```bash
slackcli messages send \
  --recipient-id=C1234567890 \
  --message="Release notes" \
  --blocks='[{"type":"markdown","text":"# Release notes\n\n- [x] Build\n- [ ] Deploy\n\nSee the [runbook](https://example.com/runbook)."}]'
```

Native [`table` blocks](https://docs.slack.dev/reference/block-kit/blocks/table-block/)
render a real table instead of a code block:

```bash
slackcli messages send \
  --recipient-id=C1234567890 \
  --message="Project status table" \
  --blocks='[
    {
      "type": "table",
      "column_settings": [{"is_wrapped": true}, {"align": "right"}],
      "rows": [
        [
          {"type": "rich_text", "elements": [{"type": "rich_text_section", "elements": [{"type": "text", "text": "Project", "style": {"bold": true}}]}]},
          {"type": "rich_text", "elements": [{"type": "rich_text_section", "elements": [{"type": "text", "text": "Status", "style": {"bold": true}}]}]}
        ],
        [
          {"type": "rich_text", "elements": [{"type": "rich_text_section", "elements": [{"type": "link", "text": "SlackCLI", "url": "https://github.com/shaharia-lab/slackcli"}]}]},
          {"type": "raw_text", "text": "Ready"}
        ]
      ]
    }
  ]'
```

The JSON is validated before the request: it must be an array, and every element
must be an object with a non-empty string `type`. Errors name the offending
index.

## `messages edit`

```bash
slackcli messages edit --channel-id=C1234567890 --timestamp=1234567890.123456 --message="Corrected message"
slackcli messages edit --permalink="https://myteam.slack.com/archives/C1234567890/p1234567890123456" --message="Corrected message"
```

Only messages posted by the authenticated user or app can be edited; ephemeral
messages cannot. Links survive an edit — SlackCLI sends `parse=none` explicitly,
because `chat.update` would otherwise default to `client` and escape
`<url|label>` markup.

`--json` prints the edited message's identity instead of the human line. There
is no permalink lookup here: the caller already had the message's location in
order to edit it.

```json
{
  "channel_id": "C1234567890",
  "ts": "1234567890.123456"
}
```

`--message-file` works here exactly as it does on `messages send` — the new
body comes from a UTF-8 file, mutually exclusive with `--message`.

## `messages react`

```bash
slackcli messages react --channel-id=C1234567890 --timestamp=1234567890.123456 --emoji=+1
slackcli messages react --permalink="https://myteam.slack.com/archives/C1234567890/p1234567890123456" --emoji=heart
```

`--emoji` takes the name without colons: `+1`/`thumbsup` 👍, `heart` ❤️,
`fire` 🔥, `eyes` 👀, `tada` 🎉, `rocket` 🚀. Custom workspace emoji work too.

## `messages draft`

```bash
slackcli messages draft --recipient-id=C1234567890 --message="Hello team!"
```

Creates an unsent draft in the Slack client — useful when you want a human to
review and press send.

**Browser auth only.** Slack apps cannot create drafts; there is no public API
for it. With a standard token the command fails with
`Draft creation requires browser authentication`.

The text is converted from Slack mrkdwn into `rich_text` blocks so the draft
opens in the composer already formatted. `--message-file` works here exactly as
it does on `messages send`.

`--json` prints the draft's identity. A draft is unsent, so it has no message
timestamp and no permalink — the draft id is what a follow-up has to work with.
`thread_ts` is present only when the draft is a threaded reply.

```json
{
  "channel_id": "C1234567890",
  "draft_id": "1234567890.123456"
}
```

## Related

- [Slack links and timestamps](links-and-timestamps.md) — what `--permalink` accepts
- [Scripting and JSON output](scripting.md) — capturing timestamps in a script
