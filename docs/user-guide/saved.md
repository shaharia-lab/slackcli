# Work through Slack saved items

`slackcli saved list` reads your **Later** / "saved for later" list;
`add`, `update`, `complete`, `reopen` and `remove` change saved messages.
`list` also reads standalone reminder To-dos, and `remove --item-id` clears them.

## `saved list`

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
  todo_state}` for messages. Standalone reminder To-dos carry
  `{type: "reminder", item_id, text, date_saved, date_due, todo_state}`.
  `text` is extracted from Slack's rich-text description; `date_due` is Unix
  seconds, or `0` when no reminder date is set. A reminder's `item_id` is a
  saved-item ID (`Sa…`), not a channel ID. Other non-message items carry only
  `type`, `channel_id` and `date_saved`.
- **Standard auth** (app tokens) falls back to `stars.list`, which returns
  *starred* items with the message inline. They are passed through as Slack
  returns them, so the `--json` item shape is Slack's `stars.list` shape. Those
  items have no `todo_state`, so `--state` matches nothing.

`--json` emits `{item_count, items}`. When there are no items, nothing is
written to stdout and the command exits 0.

## `saved add`

Adds a message to your Later list as a **to-do**. **Browser authentication
only**: the Later list is changed through the `saved.add`, `saved.update` and
`saved.delete` endpoints of Slack's web client, which authenticate with a
browser session, so a standard app token is refused with `unsupported_auth_type`
(its `stars.*` list is a different list). Each write names one item; SlackCLI
never calls Slack's bulk Later methods, some of which act on the whole list.

```bash
slackcli saved add --channel-id=C1234567890 --timestamp=1234567890.123456
slackcli saved add --permalink="https://myteam.slack.com/archives/C1234567890/p1234567890123456" --due "2026-10-12 09:50" --json
```

Name the message as for `messages delete`: `--channel-id` (an ID, a Slack URL
or a channel name) and `--timestamp`, or a single `--permalink` to the message.
See [links and timestamps](links-and-timestamps.md).

Without `--due` the to-do is due now, as in Slack's web client when no date is
picked. `--due` takes the same formats as `messages schedule --at`: Unix seconds
(`1791791400`), ISO 8601 with an offset (`2026-10-12T09:50:00+02:00` or `...Z`),
or a local date and time (`"2026-10-12 09:50"`). Unlike `--at` it may be in the
past (an overdue to-do) and has no 120-day limit, but must be after the Unix
epoch: Slack reads `0` as a to-do with no due date.

| Option | Purpose |
|---|---|
| `--channel-id <id>` | Channel ID, URL or name where the message is |
| `--timestamp <ts>` | Message timestamp (`1234567890.123456` or `p1234567890123456`) |
| `--permalink <url>` | Slack message link (replaces `--channel-id` and `--timestamp`) |
| `--due <time>` | Due date and time |
| `--workspace <id\|name>` | Workspace to use |
| `--json` | JSON output: `{channel_id, ts, todo_state, date_due}` |
| `--dry-run` | Show what would be done without doing it |

With `--json`, `add`, `update`, `complete` and `reopen` print the item as Slack
reports it after the change (`date_due` in Unix seconds, `0` for none). A Slack
refusal exits 1 with the Slack code in `slack_error`.

Standalone reminder rows are not messages: the `add`, `update`, `complete` and
`reopen` commands still require a message target. Only `remove` accepts their
saved-item IDs.

## `saved update`

Moves an item between **Saved** and **To-dos**, or changes its due date.
**Browser authentication only.** Name the message as for `saved add`.

```bash
slackcli saved update --channel-id=C1234567890 --timestamp=1234567890.123456 --due 2026-10-12T09:50:00+02:00
slackcli saved update --channel-id=C1234567890 --timestamp=1234567890.123456 --no-due
slackcli saved update --permalink="https://myteam.slack.com/archives/C1234567890/p1234567890123456" --state saved
```

`--due` changes the due date and `--no-due` clears it; the item stays where it
is. `--state saved` moves the item to Saved and clears its due date, so it takes
no `--due` or `--no-due`. `--state to_do` moves it to To-dos, due at `--due` or
now, so it takes no `--no-due`. At least one of `--state`, `--due` or `--no-due`
is required.

| Option | Purpose |
|---|---|
| `--channel-id <id>` | Channel ID, URL or name where the message is |
| `--timestamp <ts>` | Message timestamp (`1234567890.123456` or `p1234567890123456`) |
| `--permalink <url>` | Slack message link (replaces `--channel-id` and `--timestamp`) |
| `--state <state>` | `saved` or `to_do` |
| `--due <time>` | Due date and time, in the `saved add` formats |
| `--no-due` | Clear the due date |
| `--workspace <id\|name>` | Workspace to use |
| `--json` | JSON output: `{channel_id, ts, todo_state, date_due}` |
| `--dry-run` | Show what would be done without doing it |

## `saved complete` and `saved reopen`

`complete` marks an item completed and clears its due date. `reopen` marks a
completed item not completed, which puts it back in To-dos, due now.
**Browser authentication only.** Both act immediately, with no confirmation
prompt.

```bash
slackcli saved complete --permalink="https://myteam.slack.com/archives/C1234567890/p1234567890123456"
slackcli saved reopen --channel-id=C1234567890 --timestamp=1234567890.123456 --json
```

| Option | Purpose |
|---|---|
| `--channel-id <id>` | Channel ID, URL or name where the message is |
| `--timestamp <ts>` | Message timestamp (`1234567890.123456` or `p1234567890123456`) |
| `--permalink <url>` | Slack message link (replaces `--channel-id` and `--timestamp`) |
| `--workspace <id\|name>` | Workspace to use |
| `--json` | JSON output: `{channel_id, ts, todo_state, date_due}` |
| `--dry-run` | Show what would be done without doing it |

## `saved remove`

Clears a saved message or standalone reminder To-do from your Later list;
an original message itself is not touched.
**Browser authentication only.** It asks for confirmation; pass `--yes` to skip
the prompt (required when stdin is not a terminal).

```bash
slackcli saved remove --channel-id=C1234567890 --timestamp=1234567890.123456
slackcli saved remove --permalink="https://myteam.slack.com/archives/C1234567890/p1234567890123456" --yes --json
slackcli saved remove --item-id=Sa0ABC123 --yes --json
```

| Option | Purpose |
|---|---|
| `--channel-id <id>` | Channel ID, URL or name where the message is |
| `--timestamp <ts>` | Message timestamp (`1234567890.123456` or `p1234567890123456`) |
| `--permalink <url>` | Slack message link (replaces `--channel-id` and `--timestamp`) |
| `--yes` | Remove without the confirmation prompt |
| `--workspace <id\|name>` | Workspace to use |
| `--item-id <id>` | Standalone reminder To-do ID (`Sa…`) from `saved list --json`; cannot be combined with message-target options |
| `--json` | Message: `{channel_id, ts, removed: true}`; reminder: `{item_id, item_type: "reminder", removed: true}` |
| `--dry-run` | Show what would be done without doing it |

For a standalone reminder, copy `item_id` from `saved list --json`. Do not use
the `Rm…` ID returned by `reminders.add`, and do not invent a message timestamp.
`--item-id` accepts one `Sa…` ID, not a message URL or a list of IDs. It cannot
be combined with `--channel-id`, `--timestamp` or `--permalink`.

A missing or refused item is a failure, not a claim that it was removed.
`--dry-run` previews a reminder target without writing or asking for confirmation.

Clearing the To-do removes it from the list. It is different from completing
it or clearing only its due date. Reminder removal uses Slack's undocumented
web-client `saved.delete` method with `item_type=reminder`, just as message
removal uses that endpoint with `item_type=message`. The documented
`reminders.*` APIs do not reliably list or delete modern one-time To-dos.
