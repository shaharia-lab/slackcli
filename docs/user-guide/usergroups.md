# User groups

`slackcli usergroups` lists and reads **user groups** — Slack's own name for a
named, mentionable group of people (also called a "subteam", e.g.
`@platform-team`).

```bash
slackcli usergroups list
slackcli usergroups list --include-disabled --json
slackcli usergroups read @platform-team
```

> This PR adds the **read-only** surface (`list`, `read`). The write verbs
> (`create`, `update`, `add`, `remove`, `enable`, `disable`) land in a
> follow-up PR so the read side can be reviewed and merged on its own.

## Referring to a group

`read` takes a `<group>` argument that accepts any of:

- the group **ID** (`S03E2T070G7`),
- the **@handle** (`@platform` or `platform`), or
- the exact **name** (`"Platform Team"`, case-insensitive).

## `usergroups list`

Lists the workspace's user groups, sorted by name, with each group's handle,
member count, and enabled/disabled state.

| Option | Purpose |
|---|---|
| `--include-disabled` | Include disabled (archived) groups |
| `--team <workspace-id>` | Scope to one workspace (enterprise org) |
| `--workspace <id\|name>` | Workspace to use |
| `--json` | JSON output |

## `usergroups read <group>`

Shows one group and its members, resolving member IDs to names.

| Option | Purpose |
|---|---|
| `--team <workspace-id>` | Scope to one workspace (enterprise org) |
| `--workspace <id\|name>` | Workspace to use |
| `--json` | JSON output |

## Enterprise orgs and `--team`

On a Slack **Enterprise Grid** a user group belongs to a specific member
workspace. A group scoped to a member workspace may not appear in the
org-level `usergroups list`; refer to it by its `S…` ID, and pass
`--team <workspace-id>` (a `T…` ID) to scope the listing. On a single-workspace
install `--team` is unnecessary.

## Auth types

Both commands go through Slack's read `usergroups.list` / `usergroups.users.list`
methods, which work for standard (`xoxb`/`xoxp`) and browser (`xoxd`/`xoxc`)
tokens alike.
