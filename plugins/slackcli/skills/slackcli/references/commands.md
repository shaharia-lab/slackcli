# slackcli command reference

Condensed from https://github.com/shaharia-lab/slackcli/tree/main/docs/user-guide.
`slackcli <group> <cmd> --help` is authoritative for the installed version.

## Everywhere

- `--json`: every read command, plus `messages send|edit|draft` and `usergroups`
  writes. JSON on stdout; spinners, warnings, errors on stderr. A failure with
  `--json` exits 1 and ends stderr with one line
  `{"error":{"code","message","hint"?,"retryable","slack_error"?}}`: branch on
  `code`, never on message text.
- `--fields a,b.c` (needs `--json`): on every read command below except
  `conversations members list`, `auth` and `logs`. Keeps only those fields of each
  item of the main list (or of the single record); dot paths keep nesting; counts,
  `next_cursor`, `next_oldest`, `has_more` and `users` are kept. Missing field: omitted,
  no error. Typical: `conversations read --fields ts,user,text`,
  `conversations list --fields id,name`, `search messages --fields ts,user,text,channel.name,permalink`,
  `users list --fields id,name,email`. Bad list or no `--json`: exit 1 `invalid_input`.
- `--workspace <id|name>`: every Slack command. Accepts profile key, `--profile`
  name, `T…` ID, or workspace name. Ambiguous name: command stops, pass the profile.
- IDs accept Slack URLs (channel, DM, user, canvas, file). Timestamps accept
  `p1234567890123456`, `1234567890123456`, `1234567890.123456`.
- `--permalink <url>` replaces channel + timestamp on `messages send|react|edit|draft`,
  `conversations read|get|mark-read`. A reply link targets the parent thread
  (`get` and `mark-read` use the linked message's own timestamp).
- `--dry-run` on every Slack write (`messages send|edit|react|draft|send-draft|delete-draft`,
  `conversations members add|remove`, `join`, `leave`, `mark-read`, every `usergroups` write):
  resolves and validates, writes nothing, never prompts or needs `--yes`, exits 0.
  With `--json`: `{dry_run: true, action, workspace: {name,id,profile}, target: {kind,id?,name?,ts?,thread_ts?}, payload}`.
- Exit `0` success (empty result is success), `1` failure.
- Text is Slack mrkdwn: `*bold*` `_italic_` `~strike~` `` `code` `` ```blocks```
  `<https://url|label>`. Standard Markdown only via `--blocks` with a `markdown` block.

## auth

| Command | Notes |
|---|---|
| `auth login-auto [--workspace-url U] [--timeout S] [--headless]` | Browser capture, enrols every signed-in workspace. `--headless` only after one interactive run. |
| `auth login --token=xox[bp]-… --workspace-name=N [--profile=P]` | App token, validated before saving. |
| `auth login-browser --xoxd=… --xoxc=… --workspace-url=https://t.slack.com [--profile=P]` | Browser tokens by hand. |
| `auth parse-curl [--login] [--from-clipboard] [cmd]` | Tokens from DevTools "Copy as cURL"; accepts a pipe. |
| `auth whoami [--workspace W] [--json]` | Active profile + user, verified with one `auth.test`. Exit 1 on `status` `auth_failed` / `unreachable`. |
| `auth list [--check] [--json]` | Stored profiles, default marked; local config only. Exit 0 even when empty. `--check`: one `auth.test` per profile, `check.status` `ok` / `auth_failed` / `unreachable`; exit 1 unless all `ok`. |
| `auth set-default <ws>` / `auth remove <ws>` / `auth logout [--keep-browser-session]` | |

`xoxb` tokens cannot search messages. Drafts and `conversations get` on a
thread reply need browser auth.

## conversations

```
conversations list [--types=public_channel,private_channel,mpim,im] [--limit=100] [--exclude-archived] [--cursor=C] [--json]
conversations read <channel|#name|url> [--limit=100] [--thread-ts=TS] [--exclude-replies] [--oldest=UNIX] [--latest=UNIX] [--json]
conversations read --permalink=URL [--json]        # that message's thread
conversations get <channel> <ts> | --permalink=URL [--json]
conversations unread [--types=channels|dms|groups] [--messages [--max-conversations=10] [--limit=20]] [--json]
conversations mark-read <channel|#name|url> --ts=TS | --permalink=URL [--yes] [--dry-run] [--json]
```

JSON: `list` → `conversations[]`, `users[]`, `next_cursor` (null on last page).
`read` → `messages[]{ts,thread_ts,user,text,reply_count,reactions,blocks,attachments}`,
`users[]`; oldest first. `unread` → `unread_channels[]{…,mention_count}`, plus
`threads{has_unreads,mention_count}` (browser auth only: followed threads, workspace-wide).
`unread --messages` (browser auth only; app token → `unsupported_auth_type`) adds the content in one
call: `unread_channels[]{…,last_read,latest,messages[],has_more?}` (messages newer than `last_read`,
oldest first; no `messages` key past `--max-conversations`), `threads.items[]{channel_id,thread_ts,
root,unread_replies[],has_more?}` (no `items` key if Slack's thread view failed), and `users[]`.
Standard token: `get` resolves top-level messages only; use `read --thread-ts=<parent>`.
`mark-read` → `{channel_id,ts,previous_last_read}`; moves the read cursor to that message (never threads).
Undo: mark again with `--ts=<previous_last_read>` (null when Slack reports none). Needs `--yes` unattended.

## messages

```
messages send --recipient-id=<C…|U…|url|"#name"|@handle|email> (--message=T | --message-file=F|-) [--thread-ts=TS] [--file=PATH]… [--blocks=JSON|@file] [--json]
messages send --permalink=URL --message=T          # reply in that thread
messages edit (--channel-id=C --timestamp=TS | --permalink=URL) (--message=T | --message-file=F|-) [--json]
messages react (--channel-id=C --timestamp=TS | --permalink=URL) --emoji=NAME
messages draft --recipient-id=C (--message=T | --message-file=F|-) [--json]    # browser auth only
messages send-draft Dr… [--yes] [--json]                                     # post, then delete draft
messages delete-draft Dr… [--yes] [--json]                                   # discard draft
messages list-drafts [--limit=100] [--json]                                  # browser auth only
```

`U…`, `@handle` or email recipient opens a DM. Any channel or user argument takes
`"#name"` / `name` / `@handle` / email (exact match; quote `#`); a bare name that is
both a channel and a user is refused. `--file` is repeatable (one per attachment; several files
share one message, all-or-nothing) and is exclusive with `--blocks`. `--emoji` without
colons. Only the authenticated identity's messages can be edited.
JSON: `send` → `{channel_id, ts, permalink?}` (`permalink` omitted if lookup fails);
with `--file` → `{channel_id, file_id, file_ids}` (`file_id` is the first of `file_ids`). `edit` → `{channel_id, ts}`. `draft` → `{channel_id, draft_id}`.
`list-drafts` → `{draft_count, drafts[]{draft_id,channel_id,text,date_created,file_ids,thread_ts?,date_scheduled?}}`.
`send-draft` → `{channel_id,ts,permalink?}`; on cleanup failure it also returns
`cleanup_error` and exits nonzero. `delete-draft` → `{draft_id,deleted:true}`.

## search

```
search messages "q" [--in=chan] [--from=user] [--limit=20] [--page=1] [--sort=timestamp|score] [--sort-dir=desc|asc] [--json]
search channels "q" [--limit=N] [--json]
search people "q" [--limit=N] [--json]
```

Slack operators work in `q`: `in: from: before: after: on: during: has: is: with:`.
JSON: `messages` → `{total, page, pages, matches[]{permalink, channel.name, …}}`;
`channels` → `{total, channels[]{id,name,…}}`; `people` → `{total, people[]{id,…}}`.
Standard auth filters up to 1000 entries locally for channels/people.

## team, usergroups

```
team info [--team=T…] [--json]
usergroups list [--include-disabled] [--team=T…] [--json]
usergroups read <S…|@handle|"Name"> [--json]
usergroups create "Name" --handle=h [--description=D] [--channels=C1,C2] [--team=T…] --yes
usergroups update <group> [--name=N] [--handle=H] [--description=D] --yes
usergroups add <group> U1 U2 --yes   |   usergroups remove <group> U1 --yes
usergroups enable <group> --yes      |   usergroups disable <group> --yes
```

Writes refuse without `--yes` when stdin is not a TTY (always, for an agent).
`add`/`remove` read-modify-write the full member list; a group cannot be emptied,
disable it instead. Enterprise Grid writes need `--team=T…`.

## saved, canvas, files, emoji, update, logs

```
saved list [--limit=N] [--state=saved|to_do|completed] [--json]
canvas list [--limit=20] [--channel=C] [--json]
canvas read <F…|url> | --channel=C [--raw] [--json]     # Markdown; --json has `markdown`
files info <F…|url> [--json]                            # --json has private URLs
files read <F…|url> [--raw] [--json]                    # text only, 10 MB cap; {id,name,title,mimetype,source,content}
files download <F…|url> --output PATH                   # refuses to overwrite
emoji list [--filter=SUBSTR] [--limit=N] [--no-aliases] [--json]   |   emoji get <name> [--json]
update check   |   update                               # refuses under Homebrew / from source
logs path [--json]   |   logs show [--last=N | --run=ID] [--json]   |   logs clear [--yes]   # log is redacted
```

## Recipes

```bash
slackcli search channels "eng" --json | jq -r '.channels[] | "\(.id)\t\(.name)"'
slackcli conversations unread --json | jq '.unread_channels[] | select(.mention_count > 0)'
slackcli conversations unread --messages --json --fields id,name,messages.user,messages.text   # catch up in one call (browser auth)
slackcli conversations read --permalink="$LINK" --json | jq -r '.messages[].text'
sent=$(slackcli messages send --recipient-id=C123 --message="Working…" --json); ts=$(jq -r .ts <<<"$sent")
slackcli messages edit --channel-id=C123 --timestamp="$ts" --message="Done"
slackcli canvas read F123 --json | jq -r .markdown > canvas.md
```

## Errors

`error.code` with `--json` (`retryable` is true only for `rate_limited` and `network`):

| `code` | Typical cause | Action |
|---|---|---|
| `auth_failed` | `No workspace configured`; `invalid_auth` `not_authed` `token_revoked`; sign-in page on canvas read | No workspace: authenticate (phase 2). Browser: `auth login-auto --headless`; standard: re-login. `hint` has the command |
| `not_found` | `Workspace not found`, `channel_not_found`, unknown user group | `auth list` / fix the ID |
| `invalid_input` | `matches multiple profiles`, bad flag value or link | `auth list` and pass the profile key / fix the input |
| `unsupported_auth_type` | `not_allowed_token_type` on search; drafts on an app token | Needs `xoxp` or browser auth |
| `permission_denied` | `not_in_channel`, `missing_scope` | Join the channel or add the scope |
| `confirmation_required` | a write without `--yes` | Confirm with user, add `--yes` |
| `rate_limited` / `network` | throttled / Slack unreachable | Wait and retry |
| `unknown` | anything else, e.g. `target_team_must_be_specified_in_org_context` (`slack_error`) | Read `message`; for that one add `--team=T…` |
