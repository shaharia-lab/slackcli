---
title: Automating Slack without creating a Slack app
description: Most Slack tooling dies at the words "ask your workspace admin". SlackCLI takes a second route in, using the session your browser already holds, and this is how that works and what it costs.
date: 2026-08-14
author: Shaharia Azam
tags: ['Authentication', 'Design']
featured: true
---

Every guide to automating Slack opens the same way. Go to `api.slack.com/apps`.
Create an app. Pick your OAuth scopes. Install it to the workspace. Wait for an
admin to approve it.

That is a reasonable process for a product you are shipping to other people's
workspaces. It is an absurd amount of ceremony for wanting to read your own
unread channels from a terminal, and in most companies it is where the idea
dies: the admin is busy, the request looks like a security review, and nobody
follows up. The automation never gets built, not because it was hard, but
because step one required someone else's calendar.

SlackCLI has a second route in.

## Two kinds of credential

The Slack API accepts more than one kind of token, and the difference matters
more than the documentation suggests.

| Kind | Tokens | Where it comes from | Acts as |
|---|---|---|---|
| Standard | `xoxb-*`, `xoxp-*` | A Slack app you registered | The app, or you-via-the-app |
| Browser session | `xoxd-*` cookie plus `xoxc-*` token | The session your browser already holds | You |

The second row is not a loophole. It is the same pair of credentials the Slack
web client uses to make every request you have ever made in a browser tab. The
`xoxd` value is a cookie, the `xoxc` value is the token the web client mints for
your session, and together they authenticate a request exactly the way clicking
in the app does.

So the question SlackCLI asks is not "how do I get permission to act on this
workspace". It is "you are already signed in, can we reuse that". The answer is
yes, with one caveat that turns out to be the whole security model, and I will
come back to it.

## Getting the tokens without asking you to open DevTools

The first version of this made you do it by hand: open Slack in a browser, open
DevTools, find a request, copy it as cURL, paste it in. `slackcli auth
parse-curl` still exists and still works, because sometimes a locked-down
browser is all you have.

But asking somebody to open a network inspector as step one of a quickstart is
asking most of them to leave. So there is a better path:

```bash
slackcli auth login-auto
```

A browser opens on Slack, you sign in the way you always do, and SlackCLI
harvests both credentials over the Chrome DevTools Protocol. It enrols **every
workspace on that account**, not just the one you opened, which is the part
people are usually surprised by.

Three things about that are worth stating plainly, because they are the
questions everyone asks next.

**It drives the browser you already have.** Chrome, Edge, Chromium or Brave.
Nothing is downloaded, no headless runtime is bundled. That constraint is also
why there is a hand-rolled CDP client in the codebase instead of Playwright:
SlackCLI ships as a single compiled binary with a size budget, and a browser
automation framework blows through it for a job that amounts to opening a page
and reading two values.

**You sign in once, even though it is a fresh profile.** Since Chrome 136 the
browser refuses remote debugging against your default profile, so your everyday
session cannot be reused. SlackCLI runs against its own profile directory under
`~/.config/slackcli/browser-profile`. That profile persists, so only the first
run needs a human. After that, `slackcli auth login-auto --headless` refreshes
the tokens with no window and no prompt, which is what makes this usable from a
cron job.

**That profile directory is a credential store.** This is the caveat. While it
exists, anything that can read it can re-mint working tokens with no prompt, for
every workspace you signed into. It is protected by your user account and your
disk permissions, and nothing else. `slackcli auth logout` deletes it along with
`workspaces.json`, and `--keep-browser-session` is the opt-out if you know what
you are trading.

## One client, two transports

Having two kinds of credential would be miserable if every command had to know
which one it was holding. It does not. There is exactly one seam:

```
any command
     |
     v
 SlackClient          reads workspace.auth_type
     |
     +--> standardRequest()   @slack/web-api, xoxb / xoxp
     +--> browserRequest()    fetch with session headers, xoxd + xoxc
     |
     v
  Slack API
```

`WorkspaceConfig` is a discriminated union on `auth_type`, so the compiler makes
you handle both branches rather than letting a string comparison rot. Commands
above the seam parse arguments and print results; they never learn which
transport ran.

The interesting consequence is that the two are not equivalent, and pretending
otherwise would be the wrong call. A few things only a browser session can do,
because Slack exposes no public API for them at all:

- **Drafts.** `messages draft` writes a real Slack draft. No Slack app can.
- **Native unreads and saved items.** On a browser session these hit Slack's own
  endpoints; on a standard token they are approximated.
- **Fetching a thread reply by timestamp alone.**

And things a standard token does better: it survives a browser logout, it is
scoped to exactly what you granted, and it does not depend on a profile
directory sitting on somebody's laptop. That is the right credential for CI.

So SlackCLI does not pick for you. Both are first-class, they are stored per
workspace, and you can hold your own session for one workspace and a bot token
for another on the same machine. `--workspace <id|name>` chooses.

## What this is not

It is worth being direct about the boundary, because "reuses your browser
session" sets off alarms for good reasons.

This does not escalate anything. A browser session acts as **you**, with exactly
the permissions your Slack account already has. It cannot read a private channel
you are not in. It cannot post as someone else. Every request it makes is a
request you could have made by clicking, and it is attributed to you in exactly
the same way. If your workspace has audit logging, this shows up in it.

What it does do is remove the approval step for the case where approval was
never really the point: you, on your own machine, reading your own Slack from a
terminal instead of a tab.

The credentials are stored in `~/.config/slackcli/workspaces.json`, in a
directory created with mode `0700` and a file with mode `0600`. No token value
is ever printed back, not in output, not in errors, not in `--json`. Treat that
directory the way you treat `~/.ssh`, because it has the same weight.

## Try it

```bash
brew tap shaharia-lab/tap
brew install slackcli
slackcli auth login-auto
slackcli conversations unread
```

Four commands, no admin, no app. The
[authentication guide](/docs/user-guide/authentication/) covers all
four ways to sign in and which one to pick for which job.
