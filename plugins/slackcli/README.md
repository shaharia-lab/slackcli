# slackcli plugin for Claude Code

One skill, `/slackcli`, that lets Claude Code drive a Slack workspace through
the [slackcli](https://github.com/shaharia-lab/slackcli) binary.

Every invocation runs three phases:

1. **Install check.** Confirms `slackcli` is on `PATH`. If it is not, the skill
   asks before installing, via Homebrew or a checksum-verified binary in
   `~/.local/bin`. Nothing is installed silently and `sudo` is never used.
2. **Auth check.** Runs `slackcli auth list` and `slackcli team info`. If no
   workspace is stored, or the stored token is stale, it proposes a login
   method (browser sign-in, Slack app token, or cURL from DevTools) and waits
   for the user to choose. Tokens are never pasted into the conversation.
3. **The request.** Reads, sends, searches, and manages the workspace using
   the command reference in `skills/slackcli/references/commands.md`,
   preferring `--json` and confirming before anything that changes Slack.

## Install

From Claude Code:

```
/plugin marketplace add shaharia-lab/slackcli
/plugin install slackcli@slackcli
```

For local development from a checkout of this repository:

```bash
claude --plugin-dir ./plugins/slackcli
claude plugin validate ./plugins/slackcli --strict
```

## Use

Invoke it explicitly:

```
/slackcli what is unread in #engineering?
/slackcli reply to https://myteam.slack.com/archives/C123/p1234567890123456 saying "on it"
```

Or just mention Slack in a request; the skill is described so Claude loads it
on its own.

## Layout

```
plugins/slackcli/
├── .claude-plugin/plugin.json
├── README.md
└── skills/slackcli/
    ├── SKILL.md                 # the three phases and the working rules
    └── references/commands.md   # condensed command reference, loaded on demand
```

`references/commands.md` is condensed from `docs/user-guide/`. When a command
or option changes, update both.
