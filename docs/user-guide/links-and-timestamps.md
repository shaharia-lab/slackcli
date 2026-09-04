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
