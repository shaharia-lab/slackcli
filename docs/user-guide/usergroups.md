# Slack user groups from the CLI

`slackcli usergroups` lists, reads, and manages **user groups** — Slack's own
name for a named, mentionable group of people (also called a "subteam", e.g.
`@platform-team`). This is the workspace's team-management surface.

```bash
slackcli usergroups list
slackcli usergroups list --include-disabled --json
slackcli usergroups read @platform-team
slackcli usergroups create "Platform Team" --handle=platform --description="Owns the platform" --yes
slackcli usergroups update @platform --description="Owns platform + infra" --yes
slackcli usergroups add @platform U0123ABC U0456DEF --yes
slackcli usergroups remove @platform U0123ABC --yes
slackcli usergroups disable @platform --yes
slackcli usergroups enable @platform --yes
```

## Referring to a group

Every subcommand except `list` and `create` takes a `<group>` argument. It
accepts any of:

- the group **ID** (`S03E2T070G7`),
- the **@handle** (`@platform` or `platform`), or
- the exact **name** (`"Platform Team"`, case-insensitive).

## Read commands

### `usergroups list`

Lists the workspace's user groups, sorted by name, with each group's handle,
member count, and enabled/disabled state.

| Option | Purpose |
|---|---|
| `--include-disabled` | Include disabled (archived) groups |
| `--team <workspace-id>` | Scope to one workspace (enterprise org) |
| `--workspace <id\|name>` | Workspace to use |
| `--json` | JSON output |

### `usergroups read <group>`

Shows one group and its members, resolving member IDs to names.

## Write commands and the `--yes` gate

The mutating subcommands (`create`, `update`, `add`, `remove`, `enable`,
`disable`) all confirm before acting:

- With **`--yes`** they proceed without prompting.
- In an **interactive terminal** without `--yes` they prompt `y/N`.
- When **stdin is not a terminal** (a pipe, a CI job, an agent) and `--yes` is
  absent, they **refuse with a clear message and a non-zero exit** rather than
  silently proceeding — so a script cannot mutate or disable a group unattended
  by accident. Pass `--yes` to opt into the non-interactive path deliberately.

### `usergroups create <name>`

Creates a group.

| Option | Purpose |
|---|---|
| `--handle <handle>` | Mention handle (without the `@`) |
| `--description <text>` | Description |
| `--channels <ids>` | Comma-separated default channel IDs |
| `--team <workspace-id>` | Target workspace T-id (**required on an enterprise org**) |
| `--yes` | Skip the confirmation prompt (required when stdin is not a TTY) |

### `usergroups update <group>`

Changes a group's `--name`, `--handle`, and/or `--description`. Pass at least
one; the command refuses a no-op.

### `usergroups add <group> <users...>` / `remove <group> <users...>`

Adds or removes members. User IDs may be space- or comma-separated, with or
without a leading `@`.

Slack's underlying `usergroups.users.update` replaces the group's **entire**
member list — there is no incremental add/remove endpoint. SlackCLI makes
`add`/`remove` safe by **reading the current membership, applying your change,
and writing the result back**, so concurrent members are never dropped. An
add/remove that would change nothing is reported as a no-op and skips the write.

Slack does not allow a user group with **zero** members, so `remove` refuses to
empty the last member — disable the group instead.

### `usergroups enable <group>` / `disable <group>`

Slack has no hard-delete for user groups. `disable` archives a group (it stops
being mentionable); `enable` restores it. `list --include-disabled` shows
archived groups.

## Enterprise orgs and `--team`

On a Slack **Enterprise Grid**, a user group belongs to a specific member
workspace, and write operations (`create`, `update`, `add`, `remove`, `enable`,
`disable`) must name that workspace with `--team <workspace-id>` (a `T…` ID).
Without it, Slack rejects the create with
`target_team_must_be_specified_in_org_context`. On a single-workspace install
`--team` is unnecessary. Note that a group created against a member workspace may
not appear in the org-level `usergroups list`; refer to it by its `S…` ID.

## Auth types

All of these go through Slack's `usergroups.*` methods, which work for both
standard (`xoxb`/`xoxp`) and browser (`xoxd`/`xoxc`) tokens. The write methods
require the `usergroups:write` scope; per Slack's
[scope reference](https://docs.slack.dev/reference/scopes/usergroups.write) that
scope is supported by Bot, User, and Legacy Bot tokens, so a bot token
(`xoxb`) carrying `usergroups:write` can create and manage groups. Writes are
further constrained by whatever the authenticated principal is allowed to do in
Slack; managing user groups typically requires the relevant workspace
permission.
