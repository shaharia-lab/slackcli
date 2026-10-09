# User guide

## Quick start

```bash
# 1. Install (macOS / Linux)
brew tap shaharia-lab/tap && brew install slackcli

# 2. Sign in — a browser opens, you sign in once
slackcli auth login-auto

# 3. Use it
slackcli conversations list
slackcli messages send --recipient-id=C1234567890 --message="Hello from the terminal"
```

`slackcli --help` lists every command under its group, with how the workspace
is chosen, the `SLACKCLI_*` environment variables and `--json`.
`slackcli <group> <command> --help` prints that command's options, examples and
notes: accepted ID and URL formats, flags that replace each other, the `--json`
output shape, browser-only limits and the `--yes` rule. Help ships inside the
binary, so it always matches the version you have installed. A rejected command
line (an unknown option, a missing argument) ends with a pointer to the
command's `--help`.

Running `slackcli` on its own in a terminal shows a short welcome screen: the
logo and version, a pointer to `slackcli --help`, the repository link (a star
helps the project) and where to report a bug or request a feature. It prints only
when stdout is a terminal. From a script, a pipe, CI or an AI agent, bare
`slackcli` still prints the plain help to stderr and exits `1`, as before. The
screen uses colour unless `NO_COLOR` is set, and falls back to a plain title in
a terminal narrower than the logo (47 columns) and to `*` for the star emoji
where the terminal is not known to show Unicode.

## Command groups

| Group | What it does |
|---|---|
| `auth` | Sign in, check the active identity, list/select/remove workspaces, extract tokens |
| `conversations` | List channels and DMs, read history and threads, unreads, mark as read |
| `messages` | Send, reply, edit, react, create/list drafts, schedule for later, attach files, Block Kit |
| `search` | Search messages, channels, and people |
| `team` | Read the workspace's own name, domain, and ID |
| `usergroups` | List, read, and manage user groups ("subteams") |
| `users` | Look up a user by ID and list users by account status |
| `saved` | Read your "saved for later" list |
| `canvas` | List canvases and read them as Markdown |
| `files` | Inspect, read, and download Slack-hosted files |
| `emoji` | List a workspace's custom emoji and inspect one |
| `update` | Check for and install new versions |
| `logs` | Find, show (redacted) and delete the diagnostic log |

## Pages

1. [Installation](installation.md)
2. [Authentication](authentication.md)
3. [Workspaces and profiles](workspaces.md)
4. [Slack links and timestamps](links-and-timestamps.md)
5. [Conversations](conversations.md)
6. [Messages](messages.md)
7. [Search](search.md)
8. [Team](team.md)
9. [User groups](usergroups.md)
10. [Users](users.md)
11. [Saved items](saved.md)
12. [Canvas](canvas.md)
13. [Files](files.md)
14. [Emoji](emoji.md)
15. [Scripting and JSON output](scripting.md)
16. [Claude Code plugin](claude-code-plugin.md)
17. [Troubleshooting](troubleshooting.md)

## Two things that apply everywhere

**`--workspace <id|name>`** — every command that talks to Slack accepts it.
Without it, a command uses `SLACKCLI_WORKSPACE` if that is set, otherwise your
default workspace. See [workspaces and profiles](workspaces.md) and
[pin a workspace for one shell](workspaces.md#pin-a-workspace-for-one-shell).

**Paste Slack URLs instead of IDs** — anywhere a channel, user, message, canvas,
or file ID is expected. See
[Slack links and timestamps](links-and-timestamps.md).
