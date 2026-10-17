# Read and edit Slack canvases

`slackcli canvas` lists Slack canvases and reads them as Markdown, which makes
them usable in a terminal, a diff, or an AI agent's context. `canvas sections`
finds the IDs of a canvas's sections by section type or text, and `canvas create`
and `canvas edit` write canvases from Markdown, so a script can keep a status
page or a checklist current: read it, find the section, edit it.

## `canvas list`

```bash
slackcli canvas list
slackcli canvas list --limit=50
slackcli canvas list --channel=C1234567890     # canvases shared in one channel
slackcli canvas list --json
```

| Option | Default | Purpose |
|---|---|---|
| `--limit <number>` | `20` | How many to return (1–1000) |
| `--channel <id>` | — | Channel ID, URL or name (`"#general"`) whose shared canvases to list |
| `--workspace <id\|name>` | — | Workspace to use |
| `--json` | off | JSON output |
| `--fields <list>` | all | With `--json`, only these comma-separated fields (dot paths allowed) |

With `--json`, an empty result writes nothing to stdout and exits 0.

## `canvas read`

```bash
# By canvas file ID
slackcli canvas read F1234567890

# From its Slack URL
slackcli canvas read https://myteam.slack.com/docs/T012AB/F1234567890

# The canvas attached to a channel or DM
slackcli canvas read --channel=C1234567890

# Raw HTML, no conversion
slackcli canvas read F1234567890 --raw

# JSON, with the Markdown in a `markdown` field
slackcli canvas read F1234567890 --json
```

| Option | Purpose |
|---|---|
| `--channel <id>` | Read the canvas attached to this channel or DM |
| `--raw` | Print the source HTML instead of Markdown |
| `--workspace <id\|name>` | Workspace to use |
| `--json` | JSON output including metadata and the Markdown |
| `--fields <list>` | With `--json`, only these comma-separated fields (dot paths allowed) |

`--raw` takes precedence over `--json`: with both, stdout carries the HTML, not
JSON. `--fields` then has nothing to select from and is ignored (it is still
validated).

Canvas IDs are file IDs: `F` followed by alphanumerics. Either give one or use
`--channel` (the canvas ID wins when both are given). A channel with no canvas
is reported on stderr with exit code 0 and nothing on stdout. An unknown canvas
ID exits 1 with Slack's error.

### What the conversion handles

Slack canvas exports are Quip-based HTML with custom elements. The converter is
dependency-free and covers headings, bold/italic/strike/code, links, ordered and
unordered and nested lists, task lists, blockquotes, fenced code blocks
(preserved verbatim, so inline tags inside them are not mangled), tables as GFM,
embedded files and links, and emoji.

`<@U…>` and `<#C…>` mentions are resolved to display names and channel names
after conversion, so you get `@Rafael` and `#engineering` rather than raw IDs.

### Limits and failure modes

- Downloads are capped at **10 MB**; a larger canvas is refused rather than
  buffered.
- If the download comes back as a Slack sign-in page — which is what an expired
  token produces — SlackCLI detects it and tells you to re-authenticate instead
  of printing HTML at you.
- Reading a canvas needs file-read permission: `files:read` for standard tokens.

## `canvas sections`

Look up the IDs of the sections in one canvas that match a section type (a
heading level, a list, a table, …), a piece of text, or both, through Slack's
`canvases.sections.lookup`. A section ID is what a canvas edit targets, so a
script can find "the `## Status` heading" instead of guessing an ID.

```bash
# Every level-2 heading
slackcli canvas sections F1234567890 --type h2

# Sections containing a piece of text
slackcli canvas sections F1234567890 --contains "Status"

# Both (a section must match both), by URL, as JSON
slackcli canvas sections https://myteam.slack.com/docs/T012AB/F1234567890 --type h1,h2 --contains Status --json
```

| Option | Purpose |
|---|---|
| `--type <list>` | Comma-separated section types (below); a section of any of them matches |
| `--contains <text>` | Only sections containing this text |
| `--workspace <id\|name>` | Workspace to use |
| `--json` | JSON output |
| `--fields <list>` | With `--json`, only these comma-separated fields (dot paths allowed) |

`--type` takes Slack's section types: `any_header`, `h1`, `h2`, `h3`,
`blockquote`, `callout`, `canvas_unfurl`, `chart`, `citation`, `file_unfurl`,
`flexbox`, `horizontal_line`, `list`, `message_unfurl`, `sfdc_record_mention`,
`sfdc_record_unfurl`, `table`, `user_mention`, `user_unfurl`.

Give `--type`, `--contains` or both; Slack's lookup needs a criterion, so a call
with neither fails with `invalid_input` before calling Slack, as does an unknown
`--type` value or a blank `--contains`.

Without `--json` the section IDs are printed one per line, in Slack's order; no
match prints nothing on stdout and exits 0. With `--json`:

```json
{ "canvas_id": "F1234567890", "section_count": 2, "sections": [{ "id": "temp:C:abc123" }, { "id": "temp:C:def456" }] }
```

With no match, `section_count` is `0` and `sections` is empty.

**Standard app tokens only.** Slack answers `canvases.sections.lookup` with
`not_allowed_token_type` on a browser session (`xoxc`/`xoxd`), so with a browser
profile the command fails with `unsupported_auth_type` before calling Slack. The
token needs the `canvases:read` scope.

## `canvas create`

Create a standalone canvas from Markdown, through Slack's `canvases.create`,
optionally added to a channel as a tab.

```bash
slackcli canvas create --title "Release checklist" --markdown-file ./checklist.md
slackcli canvas create --title "Status" --channel C1234567890 --markdown-file - < ./status.md
slackcli canvas create --title "Notes" --markdown-file ./notes.md --json
slackcli canvas create --title "Notes" --markdown-file ./notes.md --dry-run
```

| Option | Purpose |
|---|---|
| `--title <title>` | Title of the new canvas |
| `--markdown-file <path>` | Markdown file for the content; `-` reads piped standard input |
| `--channel <id>` | Channel ID, URL or name (`"#general"`) to add the canvas to as a tab |
| `--workspace <id\|name>` | Workspace to use |
| `--json` | JSON output: `{ canvas_id, title?, channel_id? }` |
| `--dry-run` | Show what would be created without creating it |

Give `--title`, `--markdown-file` or both. Free Slack workspaces cannot create
standalone canvases, so there `--channel` is needed, and each channel can hold
only one canvas tab; Slack's refusal is reported as `permission_denied`. The new canvas
ID is in the success line on stderr and in `canvas_id` under `--json`.

## `canvas edit`

Apply one change to a canvas, through Slack's `canvases.edit` (it takes exactly
one change per call).

```bash
# Add to the end, or the start
slackcli canvas edit F1234567890 --operation insert_at_end --markdown-file ./update.md

# Insert after a section found with canvas sections
section=$(slackcli canvas sections F1234567890 --type h2 --contains Status --json | jq -r '.sections[0].id')
slackcli canvas edit F1234567890 --operation insert_after --section "$section" --markdown-file - < ./item.md

# Replace that section, or delete it (both ask for confirmation)
slackcli canvas edit F1234567890 --operation replace --section "$section" --markdown-file ./status.md --yes
slackcli canvas edit F1234567890 --operation delete --section "$section" --yes

# Rename the canvas
slackcli canvas edit F1234567890 --operation rename --title "Q3 plan"
```

| Option | Purpose |
|---|---|
| `--operation <operation>` | `insert_at_start`, `insert_at_end`, `insert_before`, `insert_after`, `replace`, `delete` or `rename` |
| `--section <section-id>` | The section to act on, from `canvas sections` |
| `--markdown-file <path>` | Markdown file for the content; `-` reads piped standard input |
| `--title <title>` | The new title, with `rename` |
| `--yes` | Confirm `replace` or `delete` without a prompt |
| `--workspace <id\|name>` | Workspace to use |
| `--json` | JSON output: `{ canvas_id, operation, section_id? }` |
| `--dry-run` | Show the change without making it |

What each operation needs:

| Operation | `--section` | `--markdown-file` | `--title` | Asks to confirm |
|---|---|---|---|---|
| `insert_at_start`, `insert_at_end` | no | required | no | no |
| `insert_before`, `insert_after` | required | required | no | no |
| `replace` | optional: without it the **whole canvas** is replaced | required | no | yes |
| `delete` | required | no | no | yes |
| `rename` | no | no | required | no |

A missing or extra option fails with `invalid_input` before calling Slack.
`replace` and `delete` ask y/N in a terminal; without a terminal on stdin (an
agent, a pipe, `--markdown-file -`) they need `--yes`, or they refuse with
`confirmation_required` and change nothing. `--dry-run` never asks.

Markdown Slack cannot apply comes back as `canvas_editing_failed`
(`invalid_input`); `canvas_editing_locked` means another edit is in progress, so
retry after a moment.

### Markdown input

`--markdown-file` takes a path, or `-` to read piped standard input (only `-`
itself; `./-` is a file). The text is sent as read. Empty Markdown is refused, and
so is Markdown longer than Slack's limit of 1,048,576 characters per create or
change. A terminal on stdin is refused rather than waiting for typing.

### Tokens and scopes

`canvas create` and `canvas edit` work with standard app tokens only and need
the `canvases:write` scope. Slack answers the canvases API with
`not_allowed_token_type` on a browser session, so a browser profile fails with
`unsupported_auth_type` before any call (a `--channel` name is not looked up
either).
