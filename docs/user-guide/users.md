# Users

`slackcli users` looks up people by ID and lists workspace users with their
account status. Every subcommand accepts `--workspace <id|name>` and `--json`.

`search people` finds users by name or email; `users` is for looking one up by
ID and for enumerating the workspace with a status filter.

## `users info <id>`

```bash
slackcli users info U012HH99H63
slackcli users info U012HH99H63 --json
slackcli users info U012HH99H63 --resolve-fields
```

Shows name, handle, ID, email, title, account status, timezone, and admin flag.

The **account status** comes from `deleted`, which is the one deactivation
signal Slack always returns. A deactivated user has `tz`, `tz_label`,
`tz_offset`, and `is_admin` stripped from the response, so those show as `n/a`
for deactivated accounts.

## `users list`

```bash
slackcli users list
slackcli users list --status active --limit 50
slackcli users list --status deactivated --json
slackcli users list --resolve-fields --json
```

| Option | Default | Purpose |
|---|---|---|
| `--limit <number>` | `200` | Max **matching** users to return |
| `--status <status>` | `all` | `all`, `active`, or `deactivated` |
| `--resolve-fields` | off | Label custom profile fields (see below) |

`--limit` is the **number of matching users returned**, not how many are
scanned. `users list --status active --limit 50` pages `users.list` internally
until it has collected 50 active users (or the workspace runs out). This matches
`--limit` everywhere else in the CLI.

`--status` filters on the deactivation axis: `active` is everyone not
deactivated, `deactivated` is `deleted:true` accounts, `all` is both. Bots count
as `active` (they are not deactivated); the per-user `status` field still
reports `bot`, `guest`, or `active` so you can tell them apart.

## `--resolve-fields`

Slack stores custom profile fields under opaque IDs like `Xf012ABC`.
`--resolve-fields` makes one `team.profile.get` call, builds an ID→label map,
and shows each field under its human label (`Department`, `Cost Center`) instead
of its ID. Available on `users info`, `users list`, and
[`search people`](search.md#search-people), all backed by the same shared
resolver, so the flag behaves identically wherever it appears.

**Labels only.** `--resolve-fields` resolves field *names*. It does not resolve
field *values* that are themselves users — a `Manager` or `Direct Reports` field
holds Slack user IDs (`U…`), and those are shown as IDs, not names. Resolving
those IDs to names would be a second, per-referenced-user lookup; it is tracked
separately and is intentionally out of scope here.

## JSON output

`--json` is stable and scriptable:

```bash
# Count active users
slackcli users list --status active --limit 10000 --json | jq '.total'

# Emails of the first 50 active users
slackcli users list --status active --limit 50 --json | jq -r '.users[].email'
```

`users info --json` emits the raw user object (plus a `resolved_fields` object
when `--resolve-fields` is set). `users list --json` emits
`{ total, status, users: [...] }`.
