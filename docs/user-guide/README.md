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

`slackcli --help`, and `slackcli <group> --help`, print the authoritative option
list for the version you have installed.

## Command groups

| Group | What it does |
|---|---|
| `auth` | Sign in, list/select/remove workspaces, extract tokens |
| `conversations` | List channels and DMs, read history and threads, unreads |
| `messages` | Send, reply, edit, react, draft, attach files, Block Kit |
| `search` | Search messages, channels, and people |
| `team` | Read the workspace's own name, domain, and ID |
| `usergroups` | List, read, and manage user groups ("subteams") |
| `saved` | Read your "saved for later" list |
| `canvas` | List canvases and read them as Markdown |
| `update` | Check for and install new versions |

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
10. [Saved items](saved.md)
11. [Canvas](canvas.md)
12. [Scripting and JSON output](scripting.md)
13. [Troubleshooting](troubleshooting.md)

## Two things that apply everywhere

**`--workspace <id|name>`** — every command that talks to Slack accepts it, and
falls back to your default workspace when you omit it. See
[workspaces and profiles](workspaces.md).

**Paste Slack URLs instead of IDs** — anywhere a channel, user, message, or
canvas ID is expected. See
[Slack links and timestamps](links-and-timestamps.md).
