# Slack links and timestamps

Anywhere the CLI takes a channel, user, canvas, or file ID, you can paste the
Slack URL instead — the form "Copy link" actually gives you. Bare IDs keep
working exactly as before.

```bash
# Equivalent
slackcli conversations read C1234567890
slackcli conversations read https://myteam.slack.com/archives/C1234567890
```

| Pasted value | Understood as |
|---|---|
| `https://myteam.slack.com/archives/C1234567890` | channel `C1234567890` |
| `https://myteam.slack.com/archives/D0987654321` | DM `D0987654321` |
| `https://myteam.slack.com/team/U9876543210` | user `U9876543210` |
| `https://myteam.slack.com/docs/T012AB/F1234567890` | canvas `F1234567890` |
| `https://myteam.slack.com/files/U9876543210/F1234567890/report.txt` | file `F1234567890` |
| `https://files.slack.com/files-pri/T012AB-F1234567890/download/report.txt` | file `F1234567890` |

## Channel names and user handles

Channel and user arguments also take a name. SlackCLI looks it up and uses the
ID, so you do not need a `search channels` call first:

```bash
slackcli messages send --recipient-id="#general" --message "Deploy done"
slackcli conversations read general --limit 20 --json
slackcli messages send --recipient-id=@alice --message "ping"
slackcli users info alice@example.com --json
```

| Value | Understood as |
|---|---|
| `#general` or `general` | the channel named `general` (on a channel argument) |
| `@alice` or `alice` | the user whose Slack handle is `alice` (on a user argument) |
| `alice@example.com` | the user with that email address |
| `C1234567890`, `@U9876543210`, a Slack URL | used as given — no lookup |

Where it works: `messages send` and `messages draft` (`--recipient-id`),
`messages edit` and `messages react` (`--channel-id`), `conversations read`,
`get`, `mark-read`, `members list`, `members add`, `members remove`, `join` and `leave`
(`<channel>`, and `<users...>` for add/remove), `canvas list` and `canvas read`
(`--channel`), `users info`, and the `<users...>` of `usergroups add` and
`usergroups remove`. (`<group>` in `usergroups` already took a handle or name.)

Rules worth knowing:

- **Quote the `#`.** In a shell, `--recipient-id #general` is a comment: the
  shell drops everything from the `#`. Write `--recipient-id "#general"` or
  `--recipient-id=#general`.
- **Exact matches only**, case-insensitive. Channels match on the channel name
  among public and private, non-archived channels the identity can see; users
  match on the Slack handle, not the display or real name. There is no partial
  or fuzzy matching. An all-upper-case value of 7+ characters (`GENERAL`) has
  the shape of a Slack ID and is used as one, not looked up; names are
  lower-case in Slack, so write `general`.
- **Never a guess.** A name that matches nothing exits 1 with `not_found` and a
  hint to run `slackcli search channels <query>` or `search people <query>`. A
  name that matches more than one thing exits 1 with `invalid_input` and lists
  the candidate IDs. Nothing is sent or changed in either case. A handle still
  held by a deactivated account loses to the active account with the same handle.
- **`--recipient-id` takes both.** A bare name there is looked up as a channel
  and as a user. If both exist, the command refuses; write `#name` or `@name`.
- **Email needs a scope.** `users.lookupByEmail` needs `users:read.email` on an
  app token; without it the command exits 1 with `permission_denied`. Pass the
  user ID or `@handle` instead.
- **Names cost calls; IDs do not.** A channel name pages through
  `conversations.list`, a handle through `users.list` (1000 per page, paced by
  the rate limiter), so it can take a while on a large workspace. An ID or a
  Slack URL makes no extra call. With `--json` the resolved ID is in the output
  (`channel_id`, `added`, …), so a script can reuse it.

## Timestamps

Timestamps work the same way — the permalink form is accepted wherever the
dotted API form is:

| Pasted value | Understood as |
|---|---|
| `p1234567890123456` | `1234567890.123456` |
| `1234567890123456` | `1234567890.123456` |
| `1234567890.123456` | unchanged |

## `--permalink`

For commands that target one specific message, `--permalink` replaces the
channel and the timestamp in one go:

```bash
# Instead of this
slackcli messages react --channel-id=C1234567890 --timestamp=1234567890.123456 --emoji=heart

# Just paste the link
slackcli messages react --permalink="https://myteam.slack.com/archives/C1234567890/p1234567890123456" --emoji=heart
```

Available on `messages send`, `messages react`, `messages edit`,
`messages draft`, `conversations read`, and `conversations get`.

Rules worth knowing:

- Pass either `--permalink` **or** the explicit inputs, not both.
- When the link points at a threaded reply, commands that take a `--thread-ts`
  correctly use the **parent** message, so a reply link makes you reply in the
  right thread rather than starting a new one.
- If the pasted link's workspace subdomain does not match the workspace the
  command will actually call, SlackCLI warns you up front instead of letting
  Slack answer with a confusing `message_not_found`. (This check only applies to
  browser-authenticated workspaces, which are the ones that store a URL.)
