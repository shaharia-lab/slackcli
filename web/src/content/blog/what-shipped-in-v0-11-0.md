---
title: What shipped in SlackCLI v0.11.0
description: The release where most of the code came from somebody else. Four new command groups, a shared rate limiter, and what it took to make outside contributions mergeable.
date: 2026-09-05
author: Shaharia Azam
tags: ['Release', 'Community']
---

[v0.11.0](https://github.com/shaharia-lab/slackcli/releases/tag/v0.11.0) is
sixteen merged pull requests, and the notable thing about it is not the feature
list. It is that most of the features were written by people who had never
touched the repository before.

Three first-time contributors and one returning one landed four new command
groups between them. Here is what they built, and then the part that interests
me more: what had to be true for that to work.

## Four new command groups

**`emoji`** ([Travis Mack](https://github.com/tmack8001), [#149](https://github.com/shaharia-lab/slackcli/pull/149)).
`emoji list` enumerates the workspace's custom emoji, `emoji get` resolves one
name to its image URL and follows aliases.

**`team`** ([Travis Mack](https://github.com/tmack8001), [#148](https://github.com/shaharia-lab/slackcli/pull/148)).
`team info` prints the workspace identity: id, domain, name, icon.

**`usergroups`** (same author, [#148](https://github.com/shaharia-lab/slackcli/pull/148)
and [#156](https://github.com/shaharia-lab/slackcli/pull/156)).
This one grew teeth. `list` and `read` are read-only, then `create`, `update`,
`add`, `remove`, `enable` and `disable` write. Every write goes through the same
confirmation gate: `--yes` proceeds, a terminal prompts, and a non-interactive
shell without `--yes` refuses rather than guessing. That rule was already
written down, so the pull request arrived with it implemented.

**`files`** ([Minh Duc](https://github.com/lelouvincx), [#161](https://github.com/shaharia-lab/slackcli/pull/161)).
`files info` inspects a file, `files read` streams a text file to stdout, and
`files download` saves it. All three accept a Slack file URL wherever they
accept an id.

## Two changes you will not see

The two most consequential commits in the release do not add a command.

**Every Slack call is now paced.** A process-wide rate limiter allows at most
two requests in flight, at least 200ms apart, for both authentication modes
([#151](https://github.com/shaharia-lab/slackcli/pull/151)). The bug it fixes is
worse than it sounds. Commands that resolve many names, like
`conversations unread` or `saved list`, fired one `users.info` per user and one
`conversations.info` per channel as fast as the network allowed. That pattern
trips Slack's `unexpected_api_call_volume` anomaly detection, and on Enterprise
Grid the consequence is that your browser session gets signed out. A tool that
logs you out of Slack for using it is not a tool. Large workspaces are slower
now, which is the correct trade.

**`--json` reaches further.** `conversations list` gained it
([Ajay Raho](https://github.com/ajayraho), [#153](https://github.com/shaharia-lab/slackcli/pull/153)),
and `messages send`, `edit` and `draft` gained both `--json` and `--message-file`
([Rafael Yure](https://github.com/rafael-yure), [#152](https://github.com/shaharia-lab/slackcli/pull/152)).
`--message-file` matters more than it looks: it is how you send a message
containing quotes, newlines or a code block without fighting your shell's
quoting rules, and how an agent sends one without building a command string.

There is also a fix worth singling out because of who it was blocking. Ajay
found that `findBrowser()` used the host's path separator when asked to simulate
another operating system ([#155](https://github.com/shaharia-lab/slackcli/pull/155)).
No user could ever hit it. What it broke was the test suite on Windows, which
meant the mandatory pre-commit hook failed, which meant nobody on Windows could
contribute at all. A bug in nothing but the contributor experience, found by a
contributor.

## The boring part that made it work

The same release cycle added a section to `CLAUDE.md` that reads like a
constitution: an issue before every pull request, a `ready-for-pr` label before
any code is written, issue and pull request templates, tests required including
edge cases, signed commits, no bypassing hooks, and documentation updated in the
same change as the code.

That is a lot of process for a small CLI, and the honest reason for it is that
most contributions now arrive with an AI agent somewhere in the loop, including
mine. An agent will follow a convention it can read and invent one it cannot.
Writing the rules down converted "please match the house style" from a review
comment into an input.

The result is visible in the diffs. The `usergroups` write commands shipped with
the confirmation gate already correct. The `files` commands accepted Slack URLs
without being asked. Every group came with `--json` and its own test file. None
of that was negotiated in review, because none of it was a surprise.

What the rules cost is real: a contributor has to open an issue and wait for a
label before writing code. What they buy is that the code, once written, gets
merged instead of rewritten.

## Get it

```bash
brew tap shaharia-lab/tap
brew install slackcli
slackcli update
```

Full notes are in the
[release](https://github.com/shaharia-lab/slackcli/releases/tag/v0.11.0) and the
[changelog](https://github.com/shaharia-lab/slackcli/blob/main/CHANGELOG.md).
The new commands are documented under
[emoji](/docs/user-guide/emoji/), [team](/docs/user-guide/team/),
[usergroups](/docs/user-guide/usergroups/) and
[files](/docs/user-guide/files/).

If you want to build the next one, the
[contributing guide](https://github.com/shaharia-lab/slackcli/blob/main/CONTRIBUTING.md)
starts with opening an issue. That is not a formality. It is the whole system.
