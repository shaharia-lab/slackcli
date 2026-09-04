# Claude Code plugin

SlackCLI ships a [Claude Code](https://claude.com/claude-code) plugin with one
skill, `/slackcli`, so an agent can read, post, search, and manage a Slack
workspace on your behalf without you writing the commands.

## Install

Inside Claude Code:

```
/plugin marketplace add shaharia-lab/slackcli
/plugin install slackcli@slackcli
```

The plugin lives at [`plugins/slackcli/`](../../plugins/slackcli/) in this
repository. To try a local checkout instead of the published version:

```bash
claude --plugin-dir ./plugins/slackcli
```

## What the skill does

1. **Checks that `slackcli` is installed.** If it is missing, the skill asks
   before installing it, either through Homebrew or as a checksum-verified
   binary in `~/.local/bin`. It never uses `sudo`. On Windows it points you at
   the release page.
2. **Checks authentication.** It runs `slackcli auth list` and confirms the
   default workspace's token still works with `slackcli team info`. If nothing
   is stored, or the token has expired, it offers the login methods from
   [authentication](authentication.md) and waits for you to choose. For a
   stale browser session it tries `auth login-auto --headless` first.
3. **Runs your request.** It carries a condensed version of this user guide,
   prefers `--json`, resolves channel and people names to IDs with `search`,
   accepts pasted Slack links, and confirms with you before sending, editing,
   reacting, drafting, or changing a user group.

## Using it

```
/slackcli summarise the unread messages in #incidents
/slackcli find who mentioned "rate limit" this week and reply in that thread
/slackcli post the contents of ./release-notes.md to #releases
```

You can also just mention Slack in an ordinary request; the skill is loaded
automatically when the task involves Slack.

## Credentials

The skill never asks you to paste a token or a cURL command into the chat.
When you pick the app-token or cURL login method it asks you to run the login
command yourself, so the secret never passes through the model. Stored
credentials stay in `~/.config/slackcli/` exactly as described in
[workspaces and profiles](workspaces.md); the skill does not read that
directory.

Slack content the agent reads is treated as untrusted data: instructions found
inside a message, canvas, or file are summarised, not followed.
