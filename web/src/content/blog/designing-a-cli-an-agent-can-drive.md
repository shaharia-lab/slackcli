---
title: Designing a CLI an AI agent can actually drive
description: "--json on the read commands is the easy half. The rules that make a tool safe for something that cannot read a spinner are stricter than they look."
date: 2026-08-28
author: Shaharia Azam
tags: ['Design', 'Scripting']
---

"AI-agent friendly" is close to meaningless as a feature claim, so here is the
concrete version: an agent is a caller that cannot see your terminal, cannot
answer a prompt, cannot tell a spinner from an answer, and will believe whatever
it can parse. Everything below follows from taking that literally.

Most of it is just good CLI design that scripts have wanted since 1978. The
agent case only makes the cost of getting it wrong immediate, because a human
who sees a mangled JSON blob shrugs and reruns the command, and an agent
confidently summarises it.

## Rule 1: stdout is data, stderr is everything else

The split is old, and it is still the single most useful thing a tool can get
right.

Every progress spinner, every warning, every error message and the
update-available notice go to **stderr**. `--json` output goes to **stdout**, on
its own. That means this is always safe:

```bash
slackcli conversations read C1234567890 --json | jq '.messages[].text'
```

There is no `--quiet` to remember, no flag that suppresses the spinner. The pipe
carries data because the spinner was never on that channel. A tool that prints
"Fetching messages..." to stdout has made every one of its callers write a
filter, and half of them will get it wrong.

## Rule 2: exactly one object, and never a partial one

With `--json`, stdout carries one parseable object. Not one object plus a
trailing hint. Not JSON Lines unless that is documented. One object.

This one has a war story attached. All output went through a `writeJson()`
helper, which was correct, and then the command called `process.exit()` to set a
status code. On Linux, `process.stdout` is a non-blocking pipe: a write larger
than the buffer completes asynchronously, and `process.exit()` tears the process
down before the drain. The result was output that truncated at **64 KiB**.

The failure mode is what makes it worth telling. Small workspaces were fine.
Every test passed. The bug only appeared when somebody read a busy channel with
a lot of history, and what they got was not an error, it was valid-looking JSON
that stopped mid-object. A human notices. A pipeline hands it to `jq`, gets a
parse error somewhere unhelpful, and now you are debugging the wrong layer.

The fix is one line and is now a rule the project treats as non-negotiable:

> Never call `process.exit()` after writing JSON. Set `process.exitCode` and
> return, so the runtime flushes stdout before the process ends.

## Rule 3: the write commands answer too

This is the one that most tools skip, and it is the difference between a CLI you
can script and a CLI you can only run.

`--json` is not just for reads. `messages send`, `messages edit` and `messages
draft` all return the identity of what they just wrote: the channel, the
timestamp, and the permalink. That single decision is what lets a workflow have
more than one step.

```bash
sent=$(slackcli messages send --recipient-id=C123 --message="Deploying now" --json)
ts=$(jq -r '.ts' <<<"$sent")

slackcli messages react --channel-id=C123 --timestamp="$ts" --emoji=eyes
slackcli messages edit  --channel-id=C123 --timestamp="$ts" --message="Deployed"
```

Without that echo, the second and third commands are impossible. You posted a
message and the tool told you "OK", which is a fact you cannot do anything with.

The permalink in that object is looked up after delivery and is omitted if the
lookup fails, so the honest way to read it is `jq -r '.permalink // empty'`
rather than assuming the key. A field that is sometimes absent is much better
than a field that is sometimes a lie.

## Rule 4: an empty result is not an error

`0` on success, `1` on failure, and a search with no hits is a success.

It is tempting to exit non-zero on "nothing found", because it feels like a
negative outcome. It is not: the command did its job and the answer was zero.
Conflating the two means a caller cannot distinguish "your query matched nothing"
from "your token expired", which are opposite problems with opposite fixes.

So the guidance is to check the exit code for failure and the data for
emptiness:

```bash
count=$(slackcli search messages "$Q" --json | jq '.total')
[ "$count" -gt 0 ] || echo "nothing found"
```

## Rule 5: no prompt an unattended caller cannot answer

Destructive commands ask before they act. That is right for a person at a
keyboard and fatal for a cron job, which will hang forever on a `y/N` nothing is
there to type.

So the confirmation gate has three branches rather than two:

- `--yes` was passed: proceed.
- It is a TTY: prompt `y/N`.
- It is not a TTY and `--yes` was not passed: **refuse**, with a message saying
  which flag would have allowed it.

The third branch is the important one, and refusing is deliberately not the same
as proceeding. A tool that treats "no terminal" as implied consent is one
misplaced pipe away from doing something irreversible on somebody's behalf. The
caller has to say so, in the command, where it is reviewable.

`--yes` is never passed automatically by anything inside the tool.

## Rule 6: accept the identifier people actually have

Slack IDs like `C1234567890` are what the API wants. Nobody has one. What people
have is a permalink they copied out of the Slack app, because "Copy link" is
right there in the message menu.

So anywhere a command takes a channel, user, canvas or file ID, it takes the URL
instead:

```bash
slackcli messages send --permalink="$LINK" --message="On it"
slackcli conversations read --permalink="$LINK"
```

Bare IDs keep working exactly as before. This is a small thing that removes an
entire class of "how do I get the channel ID" from every workflow, and it
matters even more for an agent: a link is what appears in a ticket, an email or
a chat message, so it is what the agent has in its context. Making it translate
that to an ID first is asking it to do a lookup it will sometimes get wrong.

There is a related nicety: when the link belongs to a different workspace than
the one the command will use, it warns rather than silently doing the wrong
thing somewhere else.

## Rule 7: be boring under load

An agent will happily issue a hundred requests in a second, and Slack will
happily rate-limit all of them.

SlackCLI keeps at most two API calls in flight and paces them process-wide, in
one rate limiter that every call goes through. There is no way to make a Slack
request that bypasses it, which is the only version of that rule that survives
contact with a codebase: an opt-in throttle is a throttle somebody forgets.

The observable effect is that a burst of commands is a little slower and never
gets a workspace throttled. That is the right trade for a tool that might be
driven by something with no patience.

## The plugin, and the point

All of the above is what makes the last part possible. SlackCLI ships a Claude
Code plugin with a `/slackcli` skill, so an agent can catch up on a channel,
pull the thread behind an incident, and post a summary back, without anybody
writing the commands for it.

That plugin is thin, and that is the whole argument. It is not a translation
layer papering over an interface designed for humans. It works because the CLI
underneath it already answers in one object on stdout, already tells you what it
wrote, already refuses to guess when nobody is there to ask, and already takes
the link you have instead of the ID you do not.

Build the CLI that way and the agent integration is almost nothing. Build it the
other way and no amount of plugin will save it.

Full details in the
[scripting and JSON guide](/docs/user-guide/scripting/) and the
[Claude Code plugin](/docs/user-guide/claude-code-plugin/) page.
