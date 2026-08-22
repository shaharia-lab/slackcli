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
```

| Option | Purpose |
|---|---|
| `--recipient-id <id>` | Channel ID, user ID, or Slack URL |
| `--message <text>` | **Required.** Message text |
| `--thread-ts <ts>` | Post as a reply in this thread |
| `--permalink <url>` | Replaces `--recipient-id` and `--thread-ts` |
| `--file <path>` | Attach a file; `--message` becomes the comment |
| `--blocks <json\|@file>` | Block Kit JSON array; cannot be combined with `--file` |

A `--recipient-id` starting with `U` opens a DM first. File uploads need upload
permission in the workspace — `files:write` for standard tokens. Uploads go
through Slack's external-upload flow; empty files, directories, and missing
paths are rejected before anything is sent.

On success the message timestamp is printed — capture it if you want to edit or
react to the message later.

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
opens in the composer already formatted.

## Related

- [Slack links and timestamps](links-and-timestamps.md) — what `--permalink` accepts
- [Scripting and JSON output](scripting.md) — capturing timestamps in a script
