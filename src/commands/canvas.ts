import { Command } from 'commander';
import ora, { type Ora } from 'ora';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { error, formatCanvasList, formatCanvasContent, warning, writeJson } from '../lib/formatter.ts';
import { canvasHtmlToMarkdown } from '../lib/canvas-parser.ts';
import {
  applyCanvasMentions,
  CanvasReadError,
  fetchCanvasHtml,
  resolveCanvasId,
  resolveCanvasMentions,
} from '../lib/canvas-read.ts';
import { normalizeIdentifier, workspaceMismatchWarning, workspaceOf } from '../lib/slack-url-parser.ts';
import type { SlackClient } from '../lib/slack-client.ts';
import type { SlackCanvas } from '../types/index.ts';
import { describeCommand, type CommandHelp } from '../lib/help.ts';
import { failCommand } from '../lib/command-errors.ts';
import { InvalidInputError } from '../lib/cli-errors.ts';

// --help content, kept apart from the command chains below (#324).
const HELP = {
  group: {
    summary: 'List and read Slack canvases as Markdown',
    description:
      'List canvas documents in the workspace or a channel, and read one as Markdown, with ' +
      'user and channel mentions resolved to names.',
  },
  list: {
    summary: 'List canvas documents',
    description:
      'List canvases visible to you in the workspace, or only those shared in one channel with --channel. ' +
      'Use "canvas read" for a canvas\'s content.',
    examples: [
      'slackcli canvas list',
      'slackcli canvas list --channel C0123456789 --limit 50',
      'slackcli canvas list --json',
    ],
    json:
      '{ canvas_count, canvases: [{ id, title, created, edit_timestamp, user, editors, size, permalink }] }. ' +
      'With no canvases nothing is written to stdout (exit 0).',
    notes: [
      '--channel takes a channel ID or a Slack URL.',
      '--limit must be 1-1000 (default 20).',
    ],
  },
  read: {
    summary: 'Read a canvas as Markdown',
    description:
      'Download one canvas (up to 10 MB) and print it as Markdown, by canvas ID or URL, ' +
      'or the canvas attached to a channel or DM with --channel.',
    examples: [
      'slackcli canvas read F0123456789',
      'slackcli canvas read https://acme.slack.com/docs/T0123456789/F0123456789 --json',
      'slackcli canvas read --channel C0123456789',
    ],
    json:
      '{ id, title, created, edit_timestamp, user, editors, size, permalink, markdown }.',
    notes: [
      '[canvas-id] takes a canvas file ID (F...) or a Slack URL; --channel takes a channel ID or a Slack URL.',
      'Give [canvas-id] or --channel; when both are given the canvas ID wins.',
      '--raw prints the source HTML and takes precedence over --json (stdout is then HTML, not JSON).',
      'A channel without a canvas is reported on stderr with exit 0 and no stdout. An unknown canvas ID exits 1 with Slack\'s error.',
    ],
  },
} satisfies Record<string, CommandHelp>;

// Warn when a pasted link points at a different workspace than the one we will call,
// rather than letting Slack answer with a misleading not-found error.
function warnOnWorkspaceMismatch(client: SlackClient, linkWorkspace: string | undefined): void {
  const message = workspaceMismatchWarning(linkWorkspace, client.workspaceHost);
  if (message) warning(message);
}

// Expected failures keep their own exit code (some have always exited 0);
// anything else is an unexpected error and exits 1. Under --json, a failure
// that exits 1 is reported as an error object; an exit-0 one is not a failure.
function reportCanvasReadFailure(spinner: Ora, err: any, json: boolean): void {
  if (err instanceof CanvasReadError) {
    if (json && err.exitCode !== 0) {
      failCommand(err, { json, spinner, message: err.detail ? `${err.summary}. ${err.detail}` : err.summary });
      return;
    }
    spinner.fail(err.summary);
    if (err.detail) error(err.detail);
    if (err.exitCode !== 0) process.exit(err.exitCode);
    return;
  }
  failCommand(err, { json, spinner, context: 'Failed to read canvas' });
}

export function createCanvasCommand(): Command {
  const canvas = describeCommand(new Command('canvas'), HELP.group);

  // List canvases
  describeCommand(canvas.command('list'), HELP.list)
    .option('--limit <number>', 'Number of canvases to return', '20')
    .option('--channel <id>', 'Channel ID or URL whose shared canvases to list')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (options) => {
      const spinner = ora('Fetching canvases...').start();

      try {
        const limit = Number.parseInt(options.limit);
        if (Number.isNaN(limit) || limit < 1 || limit > 1000) {
          failCommand(new InvalidInputError('Limit must be a number between 1 and 1000'), {
            json: options.json,
            spinner,
            context: 'Invalid limit',
          });
          return;
        }

        const channel = options.channel
          ? normalizeIdentifier(options.channel, 'channel', '--channel')
          : undefined;

        const client = await getAuthenticatedClient(options.workspace);
        warnOnWorkspaceMismatch(client, workspaceOf(options.channel));

        const response = await client.listCanvases({
          limit,
          channel,
        });

        const files: SlackCanvas[] = response.files || [];

        if (files.length === 0) {
          spinner.succeed('No canvases found');
          return;
        }

        spinner.succeed(`Found ${files.length} canvases`);

        if (options.json) {
          writeJson({
            canvas_count: files.length,
            canvases: files.map(f => ({
              id: f.id,
              title: f.title || f.name,
              created: f.created,
              edit_timestamp: f.edit_timestamp,
              user: f.user,
              editors: f.editors,
              size: f.size,
              permalink: f.permalink,
            })),
          });
          return;
        }

        console.log('\n' + formatCanvasList(files));
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to fetch canvases' });
      }
    });

  // Read canvas content
  describeCommand(canvas.command('read'), HELP.read)
    .argument('[canvas-id]', 'Canvas file ID or URL (e.g., F1234567890)')
    .option('--channel <id>', 'Channel ID or URL whose canvas to read')
    .option('--raw', 'Output raw HTML instead of markdown', false)
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (canvasIdArg, options) => {
      const spinner = ora('Fetching canvas...').start();
      const onProgress = (message: string) => {
        spinner.text = message;
      };

      try {
        const canvasId = canvasIdArg
          ? normalizeIdentifier(canvasIdArg, 'file', '<canvas-id>')
          : undefined;
        const channel = options.channel
          ? normalizeIdentifier(options.channel, 'channel', '--channel')
          : undefined;

        const client = await getAuthenticatedClient(options.workspace);
        warnOnWorkspaceMismatch(client, workspaceOf(canvasIdArg) ?? workspaceOf(options.channel));

        const fileId = await resolveCanvasId(client, { canvasId, channel }, onProgress);
        const { file, html } = await fetchCanvasHtml(client, fileId, onProgress);
        const title = `Canvas: ${file.title || file.name || fileId}`;

        // Raw mode: output HTML directly
        if (options.raw) {
          spinner.succeed(title);
          console.log(html);
          return;
        }

        const rawMarkdown = canvasHtmlToMarkdown(html);
        const mentions = await resolveCanvasMentions(client, rawMarkdown, onProgress);
        const markdown = applyCanvasMentions(rawMarkdown, mentions);
        spinner.succeed(title);

        if (options.json) {
          writeJson({
            id: file.id,
            title: file.title || file.name,
            created: file.created,
            edit_timestamp: file.edit_timestamp,
            user: file.user,
            editors: file.editors,
            size: file.size,
            permalink: file.permalink,
            markdown,
          });
          return;
        }

        console.log('\n' + formatCanvasContent(file, markdown));
      } catch (err: any) {
        reportCanvasReadFailure(spinner, err, options.json);
      }
    });

  return canvas;
}
