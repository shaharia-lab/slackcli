# slackcli command reference

Condensed from https://github.com/shaharia-lab/slackcli/tree/main/docs/user-guide.
`slackcli <group> <cmd> --help` is authoritative for the installed version.

## Everywhere

- `--json`: every read command, plus `messages send|edit|draft` and `usergroups`
  writes. JSON on stdout; spinners, warnings, errors on stderr.
- `--workspace <id|name>`: every Slack command. Accepts profile key, `--profile`
  name, `T…` ID, or workspace name. Ambiguous name: command stops, pass the profile.
- IDs accept Slack URLs (channel, DM, user, canvas, file). Timestamps accept
  `p1234567890123456`, `1234567890123456`, `1234567890.123456`.
- `--permalink <url>` replaces channel + timestamp on `messages send|react|edit|draft`,
  `conversations read|get`. A reply link targets the parent thread.
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
| `auth list` | Stored profiles, default marked. Exit 0 even when empty. |
| `auth set-default <ws>` / `auth remove <ws>` / `auth logout [--keep-browser-session]` | |

`xoxb` tokens cannot search messages. Drafts and `conversations get` on a
thread reply need browser auth.

## conversations

```
conversations list [--types=public_channel,private_channel,mpim,im] [--limit=100] [--exclude-archived] [--cursor=C] [--json]
conversations read <channel|url> [--limit=100] [--thread-ts=TS] [--exclude-replies] [--oldest=UNIX] [--latest=UNIX] [--json]
conversations read --permalink=URL [--json]        # that message's thread
conversations get <channel> <ts> | --permalink=URL [--json]
conversations unread [--types=channels|dms|groups] [--json]
```

JSON: `list` → `conversations[]`, `users[]`, `next_cursor` (null on last page).
`read` → `messages[]{ts,thread_ts,user,text,reply_count,reactions,blocks,attachments}`,
`users[]`; oldest first. `unread` → `unread_channels[]{…,mention_count}`.
Standard token: `get` resolves top-level messages only; use `read --thread-ts=<parent>`.

## messages

```
messages send --recipient-id=<C…|U…|url> (--message=T | --message-file=F) [--thread-ts=TS] [--file=PATH] [--blocks=JSON|@file] [--json]
messages send --permalink=URL --message=T          # reply in that thread
messages edit (--channel-id=C --timestamp=TS | --permalink=URL) (--message=T | --message-file=F) [--json]
messages react (--channel-id=C --timestamp=TS | --permalink=URL) --emoji=NAME
messages draft --recipient-id=C (--message=T | --message-file=F) [--json]    # browser auth only
```

`U…` recipient opens a DM. `--file` and `--blocks` are exclusive. `--emoji` without
colons. Only the authenticated identity's messages can be edited.
JSON: `send` → `{channel_id, ts, permalink?}` (`permalink` omitted if lookup fails);
with `--file` → `{channel_id, file_id}`. `edit` → `{channel_id, ts}`. `draft` → `{channel_id, draft_id}`.

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

## saved, canvas, files, emoji, update

```
saved list [--limit=N] [--state=saved|to_do|completed] [--json]
canvas list [--limit=20] [--channel=C] [--json]
canvas read <F…|url> | --channel=C [--raw] [--json]     # Markdown; --json has `markdown`
files info <F…|url> [--json]                            # --json has private URLs
files read <F…|url> [--raw] [--json]                    # text only, 10 MB cap; {id,name,title,mimetype,source,content}
files download <F…|url> --output PATH                   # refuses to overwrite
emoji list [--limit=N] [--no-aliases] [--json]   |   emoji get <name> [--json]
update check   |   update                               # refuses under Homebrew / from source
```

## Recipes

```bash
slackcli search channels "eng" --json | jq -r '.channels[] | "\(.id)\t\(.name)"'
slackcli conversations unread --json | jq '.unread_channels[] | select(.mention_count > 0)'
slackcli conversations read --permalink="$LINK" --json | jq -r '.messages[].text'
sent=$(slackcli messages send --recipient-id=C123 --message="Working…" --json); ts=$(jq -r .ts <<<"$sent")
slackcli messages edit --channel-id=C123 --timestamp="$ts" --message="Done"
slackcli canvas read F123 --json | jq -r .markdown > canvas.md
```

## Errors

| Message | Action |
|---|---|
| `No workspace configured` | Authenticate (phase 2) |
| `Workspace not found` / `matches multiple profiles` | `auth list`; pass the profile key |
| `invalid_auth` `not_authed` `token_revoked`, sign-in page on canvas read | Browser: `auth login-auto --headless`; standard: re-login |
| `not_allowed_token_type` on search | Needs `xoxp` or browser auth |
| `not_in_channel` / missing scope | Join the channel or add the scope |
| `Draft creation requires browser authentication` | Use a browser profile |
| `target_team_must_be_specified_in_org_context` | Add `--team=T…` |
| usergroups write refused | Confirm with user, add `--yes` |
