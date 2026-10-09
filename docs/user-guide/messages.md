# Send, reply, edit and react to Slack messages

`slackcli messages` sends, edits, and reacts to messages, creates, lists,
sends, and deletes drafts, and schedules messages for later.

Every subcommand accepts `--workspace <id|name>`.

## Previewing a write (`--dry-run`)

`send`, `edit`, `react`, `draft`, `send-draft`, `delete-draft`, `schedule` and
`delete-scheduled` take `--dry-run`. The message is resolved and checked as for a real send — the text
from `--message` or `--message-file`, parsed `--blocks`, the `--file` to
upload, the target from `--recipient-id`, `--thread-ts` or `--permalink` — and
printed instead of sent. `send`, `edit`, `react`, `draft` and `schedule` have no
confirmation prompt, so this is the way to check one first:

```bash
slackcli messages send --recipient-id C0123456789 --message-file ./note.md --dry-run
slackcli messages send-draft Dr0123456789 --dry-run --json
```

A dry run to a user ID does not open the DM; the preview names the user. The
draft commands still need browser session tokens, and fail on an app token as
the real command does; the scheduled-message commands likewise still need an
app token. See [`--dry-run`](scripting.md#--dry-run) for the
preview format.

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

# With several files on ONE message (repeat --file)
slackcli messages send --recipient-id=C1234567890 --message="Weekly report" --file=./chart.png --file=./table.csv --file=./report.pdf

# Message text from a file
slackcli messages send --recipient-id=C1234567890 --message-file=./release-notes.md

# Message text from standard input
printf '%s' "$REPORT" | slackcli messages send --recipient-id=C1234567890 --message-file -
```

| Option | Purpose |
|---|---|
| `--recipient-id <id>` | Channel ID, user ID, Slack URL, `"#channel"`, `@handle` or email ([names](links-and-timestamps.md#channel-names-and-user-handles)) |
| `--message <text>` | Message text. **Required** unless `--message-file` is given |
| `--message-file <path>` | Read the message text from a UTF-8 file, or from standard input with `-`; cannot be combined with `--message` |
| `--thread-ts <ts>` | Post as a reply in this thread |
| `--permalink <url>` | Replaces `--recipient-id` and `--thread-ts` |
| `--file <path>` | Attach a file; the message text becomes the comment. Repeatable — pass `--file` once per attachment to share several files in one message (all-or-nothing) |
| `--blocks <json\|@file>` | Block Kit JSON array; cannot be combined with `--file` |
| `--json` | Print the delivered message as JSON instead of the human line |

A `--recipient-id` starting with `U` opens a DM first. File uploads need upload
permission in the workspace — `files:write` for standard tokens. Uploads go
through Slack's external-upload flow; empty files, directories, and missing
paths are rejected before anything is sent. Repeating `--file` attaches several
files to one message, and the upload is all-or-nothing: every path is validated
before the first file is sent, and if any file fails the error names it and no
message is posted.

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

### Message text from standard input (`--message-file -`)

Give `-` as the path and the text is read from standard input. Nothing has to
be quoted for the shell and no temporary file is written, so this is the
safest way to send multi-line text, code, or anything containing quotes,
backticks or `$`:

```bash
printf '%s' "$REPORT" | slackcli messages send --recipient-id=C1234567890 --message-file -

slackcli messages send --recipient-id=C1234567890 --message-file - <<'MSG'
Build `main` failed:
  "tests" step, see $LOG
MSG
```

- The text is sent as it arrives. Only **one** trailing newline is dropped,
  the one `echo` or a heredoc adds; every other character, including further
  blank lines, is kept.
- Standard input must be piped or redirected. If it is a terminal, the command
  fails at once and tells you to pipe the text in. It never waits for typing.
- Empty or whitespace-only input is rejected like an empty file, and nothing is
  sent.
- At most 1 MB is read (a Slack message holds about 40 KB). Larger input is an
  error and nothing is sent.
- The command waits for the producer to finish, for up to 5 minutes. A pipe
  that is still open after that is an error and nothing is sent, so a stuck
  producer cannot hang an unattended run. For a step that takes longer, write
  its output to a file first and pass the path.
- Only `-` itself means standard input. To read a file that is really named
  `-`, write `./-`.
- `--message` cannot be combined with `--message-file -`, as with a path.

The same works on `messages edit` and `messages draft`.

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

With `--file`, the upload flow returns the attached files rather than a message
timestamp, so that branch emits `channel_id`, `file_id`, and `file_ids` only.
`file_ids` lists every uploaded file; `file_id` is the first of them, so a
single-file caller reads it unchanged.

A failure with `--json` writes nothing to stdout and exits `1`; the last line of
stderr is a JSON error object with a stable `code`. See
[errors under `--json`](scripting.md#errors-under---json).

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
body comes from a UTF-8 file, or from standard input with `-`, mutually
exclusive with `--message`.

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

To send a reviewed draft or discard it:

```bash
slackcli messages list-drafts --json
slackcli messages send-draft Dr1234567890 --workspace=rafael --yes --json
slackcli messages delete-draft Dr1234567890 --workspace=rafael --yes --json
```

`send-draft` reads the active draft, posts its original rich-text blocks to the saved
channel and `thread_ts` (if present), then deletes the draft. `--json` returns
`{channel_id, ts, permalink?}` like `messages send`. A failed permalink lookup
omits that field. Scheduled drafts, drafts with files, empty drafts, and drafts
with multiple destinations are refused before posting. `delete-draft` removes the
specified draft without posting; with `--json` it returns
`{draft_id, deleted: true}`.

Both actions ask for confirmation in a terminal. In a script or other non-TTY
session, pass `--yes` explicitly. `send-draft` reads the draft (`drafts.list`) before
it asks, so a refused send still makes that one read call; it posts nothing. If posting succeeds but draft deletion fails,
`send-draft --json` emits the posted
message identity plus `cleanup_error`, exits nonzero, and leaves the draft. Check
the posted message before retrying; another send could duplicate it.

Sending and deleting require browser auth, just like creation and listing.
They use Slack's undocumented web-client `drafts.delete` endpoint, which may
change without notice. The CLI supplies a current `client_last_updated_ts` for
deletion; the draft's stored update timestamp causes `draft_has_conflict`.

**Browser auth only.** Slack apps cannot manage drafts; there is no public API
for it. The command uses an undocumented Slack web-client endpoint that may
change without notice. With a standard token the command fails with
`Draft creation requires browser authentication`.

The text is converted from Slack mrkdwn into `rich_text` blocks so the draft
opens in the composer already formatted. User, user group, channel and
broadcast tokens (`<@U…>`, `<!subteam^S…>`, `<#C…>`, `<!here>`) and links
(`<https://…|label>`) become real mentions and links; any other `<…>` text stays
literal. `--message-file` works here exactly as
it does on `messages send`, including `-` for standard input.

`--json` prints the draft's identity. A draft is unsent, so it has no message
timestamp and no permalink — the draft id is what a follow-up has to work with.
`thread_ts` is present only when the draft is a threaded reply.

```json
{
  "channel_id": "C1234567890",
  "draft_id": "1234567890.123456"
}
```

## `messages list-drafts`

```bash
# Human-readable list
slackcli messages list-drafts

# Stable structured output, capped at 25 active drafts
slackcli messages list-drafts --limit=25 --json
```

Lists the authenticated user's active drafts. The default `--limit` is `100`;
it must be a positive integer. Human output shows each draft's destination,
age, message preview, draft id, and any thread, file, or scheduled-send metadata.

**Browser auth only.** Slack apps cannot list drafts because Slack exposes no
public API for it. This command uses the undocumented web-client `drafts.list`
endpoint, which may change without notice. With a standard token it fails with
`Draft listing requires browser authentication`.

`--json` deliberately exposes a small, stable projection rather than Slack's
raw internal draft objects ([`--fields`](scripting.md#keeping-output-small---fields-and---limit)
trims each draft further, e.g. `--fields draft_id,text`):

```json
{
  "draft_count": 1,
  "drafts": [
    {
      "draft_id": "Dr1234567890",
      "channel_id": "C1234567890",
      "text": "Draft for later",
      "date_created": 1789734977,
      "file_ids": []
    }
  ]
}
```

`thread_ts` and `date_scheduled` are included only when present. Deleted and
already-sent entries are excluded, and an empty result is successful with
`{"draft_count":0,"drafts":[]}`.

## `messages schedule`

Hands a message to Slack to post at a future time. Slack delivers it, so the
script that scheduled it can exit and the machine can be off.

```bash
# At a local date and time (this machine's timezone)
slackcli messages schedule --recipient-id C0123456789 --message "Standup in 10 minutes" --at "2026-10-12 09:50"

# After a delay
slackcli messages schedule --recipient-id="#general" --message "Deploy window closed" --in 2h

# At an exact instant, as a thread reply, with the result as JSON
slackcli messages schedule --permalink "$LINK" --message-file ./notes.md --at 2026-10-12T09:50:00+02:00 --json
```

```
Scheduled for Mon 12 Oct 2026, 09:50 CEST
  Target: C0123456789
  ID:     Q0123ABCDEF
```

It takes the target and content options of [`messages send`](#messages-send)
(`--recipient-id`, `--thread-ts`, `--permalink`, `--message`, `--message-file`,
`--blocks`) except `--file`: Slack cannot attach a file to a scheduled message.
Like `send`, it does not ask for confirmation; use `--dry-run` to check the
target and the resolved time first.

**Standard app tokens only** (`xoxb` or `xoxp`, from `auth login`). Slack
refuses its scheduling API to browser session tokens, so with a browser profile
`schedule`, `list-scheduled` and `delete-scheduled` fail with
`unsupported_auth_type` before making any Slack call. Pick an app-token profile
with `--workspace`.

### When to post (`--at`, `--in`)

Exactly one of the two is required.

| Flag | Accepts | Example |
|---|---|---|
| `--at` | Unix seconds | `--at 1791791400` |
| `--at` | ISO 8601 with an offset or `Z` | `--at 2026-10-12T09:50:00+02:00`, `--at 2026-10-12T07:50:00Z` |
| `--at` | A local date and time, read in this machine's timezone (`T` or a space; seconds optional) | `--at "2026-10-12 09:50"` |
| `--in` | Minutes, hours and days, each at most once | `--in 45m`, `--in 2h`, `--in 3d`, `--in 1h30m` |

Nothing else is guessed at: a date without a time, `tomorrow`, or `9am` is
refused with `invalid_input`, and so is a date that does not exist
(`2026-02-30`). The resolved time is always echoed with its timezone, and
`post_at` in the JSON output is the same instant in Unix seconds, so a local
time can be checked before it matters.

Around a clock change a local time can be ambiguous. One that is skipped when
the clocks go forward (02:30 on that night) is refused; one that happens twice
when they go back is read as the first of the two. Write the offset
(`+02:00`) to be exact.

Slack's limits, each reported before or by the call:

- The time must be in the future and at most **120 days** ahead. SlackCLI
  checks this before calling Slack; Slack's own `time_in_past` and
  `time_too_far` are reported as `invalid_input` too.
- At most **30 scheduled messages per channel in any 5-minute window**
  (`restricted_too_many`, reported as `rate_limited`).

### JSON output (`--json`)

```json
{
  "channel_id": "C0123456789",
  "scheduled_message_id": "Q0123ABCDEF",
  "post_at": 1791791400
}
```

`thread_ts` is added for a reply in a thread. `channel_id` is the resolved
conversation, so for a user it is the DM's ID. Keep `scheduled_message_id` to
cancel the message later.

## `messages list-scheduled`

```bash
slackcli messages list-scheduled
slackcli messages list-scheduled --recipient-id C0123456789 --limit 25 --json
```

Lists the messages waiting to be posted, sorted by the time they will post.
`--recipient-id` keeps one conversation and accepts what `messages send` does;
a user is looked up as your DM with them, which opens that DM if it does not
exist yet. The default `--limit` is `100`; it must be a positive integer.

Slack returns only the messages scheduled **with the token in use**. A message
scheduled in the Slack app, or by another app, is not listed.

```json
{
  "scheduled_count": 1,
  "scheduled_messages": [
    {
      "scheduled_message_id": "Q0123ABCDEF",
      "channel_id": "C0123456789",
      "post_at": 1791791400,
      "date_created": 1791700000,
      "text": "Standup in 10 minutes"
    }
  ]
}
```

`post_at` and `date_created` are Unix seconds. Nothing pending is a success
with `{"scheduled_count":0,"scheduled_messages":[]}`.
[`--fields`](scripting.md#keeping-output-small---fields-and---limit) trims each
item, e.g. `--fields scheduled_message_id,post_at`.

## `messages delete-scheduled`

```bash
slackcli messages delete-scheduled Q0123ABCDEF
slackcli messages delete-scheduled Q0123ABCDEF --yes --json
```

Cancels a scheduled message before it is posted. It asks for confirmation in a
terminal; `--yes` skips the prompt, and without a terminal on stdin and without
`--yes` it refuses. `--dry-run` shows the message it would cancel.

Only the ID is needed: the command reads the pending list to find the
message's channel, which Slack's cancel call requires. An ID that is not in
that list (already posted, already cancelled, or scheduled with another token)
fails with `not_found`. Slack refuses to cancel a message in the **last 60
seconds** before it posts.

```json
{
  "scheduled_message_id": "Q0123ABCDEF",
  "channel_id": "C0123456789",
  "deleted": true
}
```

## Related

- [Slack links and timestamps](links-and-timestamps.md) — what `--permalink` accepts
- [Scripting and JSON output](scripting.md) — capturing timestamps in a script
