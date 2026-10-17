# Read a Slack Canvas as Markdown

`slackcli canvas` lists Slack canvases and reads them as Markdown, which makes
them usable in a terminal, a diff, or an AI agent's context. `canvas sections`
finds the IDs of a canvas's sections by section type or text.

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
heading level, a list, a table, …), a piece of text, or both, through Slack's `canvases.sections.lookup`. A section ID is
what a canvas edit targets, so a script can find "the `## Status` heading"
instead of guessing an ID.

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
`sfdc_record_unfurl`, `table`, `user_mention`, `user_unfurl`. With both `--type`
and `--contains`, a section must match both.

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
