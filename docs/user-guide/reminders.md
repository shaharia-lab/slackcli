# Create and manage your own reminders

Use browser login for the full reminder lifecycle:

```bash
slackcli auth login-auto
slackcli reminders add --text "Take a break" --time "in 2 minutes" --json
slackcli reminders list --json
slackcli reminders info Sa0ABC123 --json
slackcli reminders update Sa0ABC123 --text "Take a longer break" --time 1893492000 --yes --json
slackcli reminders complete Sa0ABC123 --yes --json
slackcli reminders delete Sa0ABC123 --yes --json
```

Replace the example ID with **`id` from `add` or `list`**. All commands accept
`--workspace <id|name>` and `--json`. `list` and `info` also accept `--fields`.
Every write accepts `--dry-run`; a dry run validates and previews without
writing or prompting. `update`, `complete` and `delete` require confirmation:
use `--yes` in scripts, or answer the terminal prompt. `add` acts immediately.
There is no option to target another user. Bot tokens are refused.

## Create

`add` requires `--text` and `--time`. Slack parses the time: a Unix timestamp,
relative seconds within 24 hours, or natural language such as `"in 5 minutes"`.
The reminder belongs to the logged-in user. Notification delivery also depends
on Slack and device notification preferences.

An optional `--recurrence` accepts a JSON object with `frequency` set to
`daily`, `weekly`, `monthly` or `yearly`. For `weekly`, `weekdays` may contain
lowercase names from `monday` through `sunday`:

```bash
slackcli reminders add --text "Weekly report" --time 1893492000 --recurrence '{"frequency":"weekly","weekdays":["monday"]}' --json
```

Slack controls which time/recurrence combinations it accepts. A refusal such
as `cannot_parse` is reported as `invalid_input` with the original `slack_error`.
Recurring reminders cannot be marked complete or edited in place; delete and
recreate them to change their recurrence.

## IDs and authentication

Slack has two reminder models:

| ID | Model | APIs used |
|---|---|---|
| `Sa…` | Modern one-time reminder To-do | `saved.list`, `saved.update`, `saved.delete` with `item_type=reminder` |
| `Rm…` | Legacy reminder, including recurring reminders | `reminders.list`, `reminders.info`, `reminders.complete`, `reminders.delete` |

Creation uses `reminders.add` for both. With browser login, a new one-time
reminder is resolved to its `Sa…` ID; the response also retains Slack's
original `Rm…` creation ID as `reminder_id`. Use **`id`**, not `reminder_id`,
for subsequent commands. The IDs are never converted by changing a prefix.
Message URLs are not reminder IDs.

The modern `saved.*` methods are undocumented web-client APIs and require
browser authentication. Standard user tokens (`xoxp`) use the documented
`reminders.*` methods only. Those APIs are degraded for modern one-time
reminders: creation can succeed while subsequent lookup/deletion returns
`not_found`. Use browser login for the full To-do lifecycle. `update` is
browser-only and accepts only a modern `Sa…` ID.

For browser creation, the CLI records existing To-do IDs before the write,
then matches the newly created item by text and due time. If it cannot resolve
exactly one ID, it reports an error naming the created reminder and advises
against retrying `add`. The reminder may already exist: use `reminders list`
to locate and clean it up. The CLI never retries creation to resolve an ID.

## Read and change

`list` returns modern reminder rows, including completed To-dos, and the legacy
reminder list. It does not fetch unrelated saved-message contents. An empty
JSON list is `{ "reminder_count": 0, "reminders": [] }`.

`info <id>` returns one reminder record. Both read commands support `--fields`:

```bash
slackcli reminders list --json --fields id,text,time,todo_state
slackcli reminders info Sa0ABC123 --json --fields id,text,time
```

`update <id>` accepts `--text`, `--time`, or both. For updates, time is parsed
locally as Unix seconds, ISO 8601 with an offset or `Z`, or local
`"YYYY-MM-DD HH:MM"`. Slack natural-language parsing is available on `add`
only. Text is sent as literal rich text. `complete` marks a modern To-do
completed and clears its due date; it leaves the completed item in the list.
`delete` clears the entire To-do or deletes a legacy reminder.

## JSON and errors

Successful JSON output is one object:

- `add` and `info`: `{ id, source, text, recurring, time?, complete_ts?, todo_state?, reminder_id? }`.
- `list`: `{ reminder_count, reminders[] }`.
- `update`: `{ id, updated: true, text?, time? }`.
- `complete`: `{ id, completed: true }`.
- `delete`: `{ id, deleted: true }`.

On failure, stdout is empty, exit status is 1, and the last stderr line is
`{"error":{code,message,hint?,retryable,slack_error?}}`. A missing or refused
reminder is an error; deletion never claims success merely because lookup
failed. See [scripting](scripting.md) for the error contract.
