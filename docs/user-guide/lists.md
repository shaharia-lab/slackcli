# Lists

Read and change Slack lists and their records from the terminal. All of these commands need a browser login.

| Command | What it does |
|---|---|
| `slackcli lists read <list>` | Every record of a list, across all pages |
| `slackcli lists record <list> <record-id>` | One record, with its column names when Slack sends the list schema |
| `slackcli lists add-record <list>` | Add one empty row to a list |
| `slackcli lists edit-cell <list> <record-id> <column-id> --value <value>` | Set one cell of a row |
| `slackcli lists delete-record <list> <record-id>` | Delete one row from a list |

## Naming a list

`<list>` takes either form:

- The list file ID, which starts with `F`, for example `F0123456789`.
- The list's Slack URL, copied from Slack. It looks like `https://acme.slack.com/lists/T0123456789/F0123456789`. The CLI reads the file ID from it.

## Read every record

```bash
slackcli lists read F0123456789
slackcli lists read F0123456789 --json --fields id,fields
```

Text output prints one line per record. The line starts with the record ID, then each cell as `column: value`.

Columns show their column IDs in `lists read`, because that command does not fetch the list schema. Run `lists record` on one record to see column names.

## Read one record

```bash
slackcli lists record F0123456789 Rec0123456789
slackcli lists record F0123456789 Rec0123456789 --json
```

Get record IDs from `lists read`. Text output names each column from the list schema.

Select and person cells print the IDs that Slack sends. They do not print option labels or names yet.

## Add a row

```bash
slackcli lists add-record F0123456789
slackcli lists add-record F0123456789 --yes --json
```

The new row has no cells. Set them with `edit-cell`. The row ID prints when Slack returns one.

## Set one cell

```bash
slackcli lists edit-cell F0123456789 Rec0123456789 Col0123456789 --value "Ship the release"
slackcli lists edit-cell F0123456789 Rec0123456789 Col0123456789 --value true --yes
slackcli lists edit-cell F0123456789 Rec0123456789 Col0123456789 --value U0123456789,U0987654321 --yes
slackcli lists edit-cell F0123456789 Rec0123456789 Col0123456789 --value 2026-10-28 --yes
slackcli lists edit-cell F0123456789 Rec0123456789 Col0123456789 --value 7 --yes
```

There is no `--type` flag. The CLI reads the column's type from the list schema, with one `lists.records.info` call on the record, and shapes the cell from it. `--value` is read as that type says:

| Column type | `--value` |
|---|---|
| `text` | Any string, stored as one rich-text section |
| `checkbox`, `todo_completed` | `true` or `false` |
| `user`, `todo_assignee` | One or more user IDs (`U...` or `W...`), separated by commas |
| `date`, `todo_due_date` | A real date as `YYYY-MM-DD` |
| `number` | A finite number |

The `todo_*` types are the built-in columns of a to-do list. Any other column type is refused, and so is a column ID the schema does not list. Both fail before the write, and `--dry-run` shows the resolved type in its payload. Get the column ID from `lists read` (the cell's `column_id`) or from `lists record`.

## Delete a row

```bash
slackcli lists delete-record F0123456789 Rec0123456789
slackcli lists delete-record F0123456789 Rec0123456789 --yes --json
```

Deleting a row removes its cells too. Get row IDs from `lists read`.

## Confirm and preview the writes

The three write commands ask for confirmation (`y/N`) in a terminal. Pass `--yes` to skip the prompt. Without a terminal and without `--yes`, they refuse and exit 1 without changing anything.

`--dry-run` prints what would be sent and changes nothing. It never prompts and needs no `--yes`.

## JSON output

`lists read --json` returns `list_id`, `record_count`, and `records`. Each record carries its `id`, `list_id`, `fields`, and timestamps. Each cell carries `column_id`, `key`, `value`, and a typed value such as `text` or `select`.

`lists record --json` returns the record's own keys, with `list_id` added.

Both commands take `--fields` to keep only some keys. See [scripting and JSON output](scripting.md).

The write commands print their own small objects: `add-record` returns `{ list_id, id }`, `edit-cell` returns `{ list_id, row_id, column_id, type }`, and `delete-record` returns `{ list_id, id, deleted }`.

## Notes

- Browser login only. A standard app token is refused before any request is sent.
- `lists read` follows every page of records. It stops after 100 pages as a safety bound.
- A list that Slack cannot find returns the `not_found` error code. A record that Slack cannot find (`record_not_found`) is not mapped yet, so it reports the `unknown` code.
