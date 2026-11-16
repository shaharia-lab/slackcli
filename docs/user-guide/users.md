# Users

`slackcli users` looks up people by ID, handle or email, lists workspace users with their
account status, and sets or clears your own profile status. Every subcommand accepts
`--workspace <id|name>` and `--json`. The lookup commands also take
[`--fields`](scripting.md#keeping-output-small---fields-and---limit)
(`users list --json --fields id,name,email`, `users info U012HH99H63 --json --fields id,profile.email`).

`search people` finds users by name or email; `users` is for looking one up by
ID and for enumerating the workspace with a status filter.

Looking up and listing users requires the `users:read` scope (plus
`users:read.email` for the `email` field) when you use standard authentication.
`--resolve-fields` additionally needs `users.profile:read`. Browser-session
authentication uses the existing browser cookie and token.

## `users info <user>`

```bash
slackcli users info U012HH99H63
slackcli users info U012HH99H63 --json
slackcli users info U012HH99H63 --resolve-fields
slackcli users info @alice
slackcli users info alice@example.com --json
```

Shows name, handle, ID, email, title, account status, timezone, and admin flag.
`<user>` is a user ID, an `@handle` (exact Slack handle) or an email address;
a handle or email is looked up first (an email needs `users:read.email` on an
app token). See [channel names and user handles](links-and-timestamps.md#channel-names-and-user-handles).

The **account status** comes from `deleted`, which is the one deactivation
signal Slack always returns. A deactivated user has `tz`, `tz_label`,
`tz_offset`, and `is_admin` stripped from the response, so the text output
shows `Admin: false` and `TZ: (none) (n/a, offset n/a)`, and with `--json`
those keys are absent.

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

`users info --json` is also how you read a profile status. The text is
`profile.status_text` and the emoji is `profile.status_emoji`. There is no
separate get command.

## `users set-status`

```bash
slackcli users set-status --text "Out of office" --emoji ":palm_tree:"
slackcli users set-status --text "Out of office" --emoji ":palm_tree:" --dry-run
slackcli users set-status --text "Out of office" --emoji ":palm_tree:" --yes --json
```

Sets the signed-in user's profile status, the text and emoji beside their name,
through Slack's `users.profile.set`. Both `--text` and `--emoji` are required.
Pass an empty string to clear one of them. Slack keeps a field you leave out,
so the command always sends both.

The text is at most 100 characters. The status does not expire. This command
does not take a user id, and it only changes your own status.

`--dry-run` prints the profile it would send and does not ask you to confirm.
Without `--dry-run`, a terminal asks `y/N`. Without a terminal, pass `--yes`
or the command refuses and changes nothing.

`--json` prints `{ status_text, status_emoji, status_expiration }` with
`status_expiration` set to `0`.

A user token (`xoxp`) or a browser session can set the status. A bot token
(`xoxb`) cannot. It fails with `unsupported_auth_type` before any Slack call.
Sign in with `slackcli auth login` (a user token) or `slackcli auth login-auto`.

`users list --status` is a different thing. It filters account state (`active`,
`deactivated`) and does not read or change this status.

## `users clear-status`

```bash
slackcli users clear-status
slackcli users clear-status --dry-run
slackcli users clear-status --yes --json
```

Clears your profile status. It sends empty text and an empty emoji, and it
does not leave an expiry. The same auth rule, confirmation, and `--dry-run`
behavior as `users set-status` apply. `--json` prints the same object with
both strings empty.
