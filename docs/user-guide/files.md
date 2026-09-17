# Inspect, read and download Slack files

`slackcli files` inspects metadata, prints textual content, and downloads
Slack-hosted files. Every command accepts a file ID or Slack file URL.

Reading files requires the `files:read` scope when you use standard
authentication. Browser-session authentication uses the existing browser cookie
and token.

## `files info`

```bash
slackcli files info F1234567890
slackcli files info https://myteam.slack.com/files/U123/F1234567890/report.txt
slackcli files info F1234567890 --json
```

Human-readable output includes the file ID, name, type, size, owner, creation
time, and permalink when Slack provides them. It does not print private download
URLs.

`--json` returns the complete file object from Slack. This can include
`url_private` and `url_private_download`, so treat the output as private.

## `files read`

```bash
# Print textual content
slackcli files read F1234567890

# Read Slack's plain-text extraction from an email file
slackcli files read F1234567890

# Read the original textual file instead of Slack's extraction
slackcli files read F1234567890 --raw

# Return the content and its source as JSON
slackcli files read F1234567890 --json
```

Slack email files can include a `plain_text` field in their metadata. The
command uses that field by default. Otherwise, it downloads the original when
the MIME type identifies a textual file.

`--raw` always reads the original textual file. Text reads are capped at 10 MB.
The command refuses to print binary files; use `files download` for those.

JSON output has this shape:

```json
{
  "id": "F1234567890",
  "name": "message.eml",
  "title": "Message",
  "mimetype": "message/rfc822",
  "source": "plain_text",
  "content": "From: sender@example.com\n..."
}
```

`source` is `plain_text` or `original`.

## `files download`

```bash
slackcli files download F1234567890 --output ./report.pdf
slackcli files download "$FILE_URL" --output ./message.eml
```

The command streams the original bytes to the output path. It does not convert
binary data to text or hold the complete download in memory.

The output path is required. The command refuses to overwrite an existing file.
Choose another path or remove the existing file before you retry.

## File URLs and workspaces

Supported URLs include normal Slack file permalinks, Canvas document URLs, and
private Slack file URLs. When a permalink names a different workspace from the
selected browser-authenticated workspace, SlackCLI warns before making the API
request. Use `--workspace <id|name>` to select the matching workspace.

Private `files.slack.com` URLs do not identify their workspace, so SlackCLI
cannot provide a workspace-mismatch warning for those URLs.
