# Read a Slack Canvas as Markdown

`slackcli canvas` lists Slack canvases and reads them as Markdown, which makes
them usable in a terminal, a diff, or an AI agent's context.

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
| `--channel <id>` | — | Channel ID or URL whose shared canvases to list |
| `--workspace <id\|name>` | — | Workspace to use |
| `--json` | off | JSON output |

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

Canvas IDs are file IDs: `F` followed by alphanumerics. Either give one or use
`--channel`; a channel with no canvas is reported as such rather than failing.

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
