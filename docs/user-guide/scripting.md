# Scripting SlackCLI from shell scripts and AI agents

SlackCLI is built to be driven by scripts, cron jobs, and AI agents as much as by
hand.

## `--json`

Every read command supports `--json`: `conversations list`, `conversations read`,
`conversations get`, `conversations unread`, `conversations members list`,
`search messages`, `search channels`,
`search people`, `saved list`, `canvas list`, `canvas read`, `team info`,
`usergroups list`, `usergroups read`, `emoji list`, `emoji get`, `files info`,
`files read`, `users info`, `users list`, `messages list-drafts`, `auth whoami`,
`auth list`.

The writing commands support it too — `messages send`, `messages edit`,
`messages draft`, `messages send-draft`, `messages delete-draft`, the `usergroups` write verbs (`create`, `update`, `add`,
`remove`, `enable`, `disable`), and the `conversations` membership write/self
verbs (`members add`, `members remove`, `join`, `leave`) — where it returns the
identity of what was just written instead of the human success line.

JSON goes to **stdout**. Progress spinners, warnings, error messages, and the
update-available notice go to **stderr**, so a pipe normally carries only data:

```bash
slackcli conversations read C1234567890 --json | jq '.messages[].text'
```

### Shapes

```bash
# Conversations, with a resolved users array so DM ids are not opaque
slackcli conversations list --json | jq '.conversations[] | {id, name}'
slackcli conversations list --json | jq '.next_cursor'

# Messages, with a resolved users array so IDs are not opaque
slackcli conversations read C123 --json | jq '.messages[] | {ts, user, text}'
slackcli conversations read C123 --json | jq '.users[] | {id, real_name}'

# Just the thread replies to one message
slackcli conversations read --permalink="$LINK" --json | jq -r '.messages[].text'

# Search hits with their permalinks
slackcli search messages "deploy failed" --json | jq -r '.matches[] | "\(.channel.name)\t\(.permalink)"'

# Unread channels that have mentions
slackcli conversations unread --json | jq '.unread_channels[] | select(.mention_count > 0)'

# A canvas as Markdown
slackcli canvas read F123 --json | jq -r '.markdown' > canvas.md
```

`--json` output for messages includes `ts`, `thread_ts`, `user`, `text`, `type`,
`reply_count`, `reactions`, `bot_id`, `blocks`, `attachments`, and file metadata
when a message has attachments.

## Exit codes

`0` on success, `1` on failure. Without `--json`, a failure prints a message to
stderr; check the exit code rather than parsing that text.

```bash
if ! slackcli messages send --recipient-id="$CHANNEL" --message="$TEXT"; then
  echo "post failed" >&2
  exit 1
fi
```

## Errors under `--json`

With `--json`, a failing command writes **one single-line JSON object as the
last line of stderr**, writes nothing to stdout, and exits `1`. The spinner's
failure line is left out, so that last line parses on its own:

```json
{"error":{"code":"auth_failed","message":"Authentication failed for profile \"acme\" (Acme Corp, browser auth): invalid_auth","hint":"slackcli auth login-auto --workspace-url https://acme.slack.com","retryable":false,"slack_error":"invalid_auth"}}
```

| Field | Meaning |
|---|---|
| `code` | One of the codes below. React to this, never to `message`. |
| `message` | What went wrong, in words. Wording may change between releases. |
| `hint` | What to do next, when there is something specific: often a command to run. Optional. |
| `retryable` | `true` only for `rate_limited` and `network`: trying again unchanged can succeed. |
| `slack_error` | Slack's own error code, verbatim, when Slack returned one (`channel_not_found`, `missing_scope`, …). Optional. |

| `code` | When | What to do |
|---|---|---|
| `auth_failed` | Slack refused the stored credentials (`invalid_auth`, `token_expired`, `token_revoked`, `not_authed`, `account_inactive`), a download returned Slack's sign-in page, or no workspace is configured | Log in again; `hint` has the command |
| `not_found` | The channel, user, message, file, draft, user group, profile or log run does not exist (`channel_not_found`, `user_not_found`, …), or a channel name, `@handle` or email matched nothing | Fix the ID or name |
| `permission_denied` | The identity may not do this (`missing_scope`, `not_in_channel`, `restricted_action`, `enterprise_is_restricted`, …) | Join the channel, add the scope, or use another profile |
| `rate_limited` | Slack throttled the call (HTTP 429, `ratelimited`) | Wait, then retry |
| `invalid_input` | A flag, argument, link or file the command cannot use (`--limit 0`, an ambiguous `--workspace`, a channel name or handle that matches more than one ID, bad `--blocks` JSON, a missing `--file`, a draft `send-draft` cannot send, a non-text file for `files read`, `invalid_ts`, …) | Fix the input |
| `network` | Slack could not be reached, or answered with a 5xx | Retry |
| `confirmation_required` | A write needs `--yes` when stdin is not a terminal, or the prompt was declined | Pass `--yes` once the write is confirmed |
| `unsupported_auth_type` | The command needs the other auth type: drafts need browser auth; Slack's `not_allowed_token_type` | Use a profile of the other type |
| `unknown` | Anything else | Read `message` |

```bash
out=$(slackcli conversations read "$CHANNEL" --json 2>err.txt) || {
  err=$(tail -n 1 err.txt)
  case "$(jq -r '.error.code' <<<"$err")" in
    rate_limited|network) sleep 30 ;;                       # retry later
    auth_failed) slackcli auth login-auto --headless ;;     # browser profiles
    *) jq -r '.error.message' <<<"$err" >&2; exit 1 ;;
  esac
}
```

Only the last line is the error object: a spinner or a warning can come before
it. An error object never carries a token, a message's text, a file's content or
a search query. Usage errors that Commander raises before the command starts
(an unknown option, a missing argument) are still plain text, with exit code
`1`. Commands without `--json` (`auth login`, `files download`, `logs clear`, …)
are unchanged. Two commands report a partial result on stdout with exit code
`1` instead of an error object, because something did happen:
`conversations members remove` (`failed` lists the users that were not removed)
and `messages send-draft` (`cleanup_error` when the message posted but the draft
could not be deleted). `auth whoami --json` and `auth list --check --json`
likewise report a refused or unreachable profile as their own result on stdout.

An empty result is *not* a failure: a search with no hits, or an unread list with
nothing in it, exits `0`. Test the data, not the exit code:

```bash
count=$(slackcli search messages "$Q" --json | jq '.total')
[ "$count" -gt 0 ] || echo "nothing found"
```

## Patterns

**Post and keep the timestamp**, so you can edit or react later. `--json` gives
you the channel, the timestamp, and the permalink in one object:

```bash
sent=$(slackcli messages send --recipient-id=C123 --message="Working…" --json)
ts=$(jq -r '.ts' <<<"$sent")

slackcli messages react --channel-id=C123 --timestamp="$ts" --emoji=eyes
slackcli messages edit --channel-id=C123 --timestamp="$ts" --message="Done ✅"
```

The permalink is handy for handing the message to a human, or for feeding it
straight back into any command that takes `--permalink`:

```bash
link=$(jq -r '.permalink // empty' <<<"$sent")
slackcli messages send --permalink="$link" --message="…and here is the log"
```

`permalink` is looked up after delivery and is omitted if that lookup fails, so
use `// empty` (or test the key) rather than assuming it is always there.

**Send a reviewed draft** and capture the posted message identity:

```bash
sent=$(slackcli messages send-draft "$DRAFT_ID" --workspace=rafael --yes --json)
ts=$(jq -r '.ts' <<<"$sent")
```

`send-draft` removes the draft after posting. If that cleanup fails, the command
exits nonzero but still emits `channel_id`, `ts`, and `cleanup_error` in JSON.
Check the posted message before retrying, to avoid a duplicate. Use
`messages delete-draft "$DRAFT_ID" --yes --json` to discard an unneeded draft.

**Send a long or multi-line body from a file**, instead of fighting shell
quoting — useful when the text is generated by an earlier step:

```bash
generate-release-notes > /tmp/notes.md
slackcli messages send --recipient-id=C123 --message-file=/tmp/notes.md --json
```

`--message` and `--message-file` are mutually exclusive, and an empty or
unreadable file is rejected before anything is posted, so a failed generation
step cannot silently post an empty message.

**Reply into a thread from a link** — no ID juggling:

```bash
slackcli messages send --permalink="$SLACK_LINK" --message="On it"
```

**Pick an identity explicitly** in unattended jobs, rather than depending on
whichever workspace happens to be the default:

```bash
slackcli messages send --workspace=automation-bot --recipient-id=C123 --message="Nightly build green"
```

**Pin the identity for a whole script or job** with `SLACKCLI_WORKSPACE` instead
of repeating the flag. It applies only to that process environment, so it does
not change the default other terminals use, and `--workspace` still overrides
it:

```bash
export SLACKCLI_WORKSPACE=automation-bot
slackcli messages send --recipient-id=C123 --message="Nightly build green"
slackcli conversations read C123 --limit=5 --json
```

A value that matches no stored profile fails the command with
`Workspace not found: <value> (from SLACKCLI_WORKSPACE)` rather than falling back
to the default. See
[workspaces and profiles](workspaces.md#pin-a-workspace-for-one-shell).

**Check the identity before a write**, so a job stops on an expired session or
the wrong workspace instead of failing halfway. `auth whoami` exits `1` unless
Slack accepted the credentials, and its `--json` object says which profile and
user were used:

```bash
me=$(slackcli auth whoami --json) || {
  echo "slack identity check failed: $(jq -r '.status' <<<"$me")" >&2   # auth_failed | unreachable
  exit 1
}
[ "$(jq -r '.workspace_id' <<<"$me")" = "T1234567" ] || { echo "wrong workspace" >&2; exit 1; }
```

`status` is `auth_failed` when logging in again is needed (`.error.fix` holds the
command) and `unreachable` when Slack did not answer, which is worth a retry.
See [authentication](authentication.md#check-who-you-are-signed-in-as).

**Check every stored profile** at the start of a session with
`auth list --check --json`. It exits `1` unless every profile is `ok`, and each
entry's `check.status` says which ones to use and which need a new login:

```bash
slackcli auth list --check --json > profiles.json || true
jq -r '.workspaces[] | "\(.profile)\t\(.check.status)"' profiles.json
```

See [authentication](authentication.md#check-every-stored-profile).

**Paginate a search**:

```bash
page=1
while :; do
  out=$(slackcli search messages "$Q" --page="$page" --limit=100 --json)
  echo "$out" | jq -r '.matches[].permalink'
  [ "$page" -lt "$(echo "$out" | jq '.pages')" ] || break
  page=$((page + 1))
done
```

### Poll a channel or thread safely

Keep the `next_oldest` cursor between calls, and drop your own messages so a
reply you post does not wake you up again:

```bash
cursor=$(date +%s)   # start from now; or a saved cursor
while :; do
  out=$(slackcli conversations read C123 --thread-ts="$THREAD" \
          --oldest="$cursor" --exclude-self --limit=200 --json)
  jq -c '.messages[]' <<<"$out" | while read -r m; do handle "$m"; done
  cursor=$(jq -r '.next_oldest' <<<"$out")
  sleep 30
done
```

- Use the returned cursor, not a message count: counting never changes on a
  thread longer than `--limit`.
- Messages at or before `--oldest` are never returned, so the thread parent
  is not re-emitted on every poll.
- `next_oldest` still advances when every new message was your own.
- For channel history Slack returns the *newest* `--limit` messages in the
  range. If `has_more` is `true`, more arrived than you asked for: advancing
  the cursor would skip the older ones, so re-read with a larger `--limit`
  (or page back with `--latest`) before moving on.

## Notes for unattended use

- **Token freshness.** Browser tokens die with the browser session. Refresh them
  non-interactively with `slackcli auth login-auto --headless`, which works once
  the profile has been signed in once.
- **Names or IDs.** Channel and user arguments accept `#channel`, `@handle` or
  an email address as well as IDs ([details](links-and-timestamps.md#channel-names-and-user-handles)).
  A name costs a paged `conversations.list` / `users.list` lookup on every run;
  an ID costs nothing, and `--json` output reports the resolved ID, so a job that
  runs often can resolve once and keep the ID. Quote a `#` in scripts.
- **Throttling.** slackcli keeps at most 2 Slack API calls in flight and leaves
  at least 200ms between them, so it does not trip Slack's
  `unexpected_api_call_volume` anomaly detection. Commands that resolve many
  users or channels (`conversations unread`, `saved list` on a long list) make
  one API call per entity, so budget wall-clock time for them and set generous
  timeouts in a scheduled job.
- **Logs.** Every command except `slackcli logs …` appends to a log file (see
  [Troubleshooting](troubleshooting.md#logs)); nothing is written to stdout, and
  stderr gets log lines only with `-v`. Set `SLACKCLI_LOG_LEVEL=off` to skip the
  file, or `SLACKCLI_LOG_DIR` to move it, e.g. in a read-only container.
- **The update notice.** SlackCLI may append a one-line "update available" notice
  after a command that succeeded. It goes to stderr and never contaminates
  `--json` on stdout, and it is never printed after a failure, so a `--json`
  error object stays the last line of stderr.
  Set `SLACKCLI_NO_UPDATE_NOTIFIER=1` to turn it and its daily request to GitHub
  off; it is off automatically when `CI` is set (`CI=true`, `CI=1`). See
  [Updating](installation.md#updating).
- **`usergroups` writes need `--yes`.** `create`, `update`, `add`, `remove`,
  `enable`, and `disable` refuse to run with a non-zero exit when stdin is not a
  terminal and `--yes` is absent, so an unattended job must pass `--yes`
  explicitly. With `--json` the refusal is a `confirmation_required` error
  object. See [User groups](usergroups.md).
- **`files download` needs `--yes` to write outside the working directory.** An
  `--output` path that resolves inside the current directory is unaffected. One
  that escapes it (`../…`, an absolute path, or a symlinked directory) is
  refused with a non-zero exit when stdin is not a terminal and `--yes` is
  absent. `cd` into the target directory and use a relative path, or pass
  `--yes`. See [Files](files.md).
- **`auth migrate-secrets` needs `--yes`.** Same rule: refuses to run with a
  non-zero exit when stdin is not a terminal and `--yes` is absent. See
  [Authentication](authentication.md#where-credentials-are-stored).
- **`logs clear` needs `--yes`.** Same rule: refuses to delete the log files
  with a non-zero exit when stdin is not a terminal and `--yes` is absent. See
  [Troubleshooting](troubleshooting.md#the-logs-command).
- **Credentials.** `~/.config/slackcli/workspaces.json` holds live tokens at mode
  `0600`, unless a profile was moved to the macOS Keychain backend — give a CI
  job its own bot-token profile rather than copying a personal browser session
  around.
