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

// Warn when a pasted link points at a different workspace than the one we will call,
// rather than letting Slack answer with a misleading not-found error.
function warnOnWorkspaceMismatch(client: SlackClient, linkWorkspace: string | undefined): void {
  const message = workspaceMismatchWarning(linkWorkspace, client.workspaceHost);
  if (message) warning(message);
}

// Expected failures keep their own exit code (some have always exited 0);
// anything else is an unexpected error and exits 1.
function reportCanvasReadFailure(spinner: Ora, err: any): void {
  if (err instanceof CanvasReadError) {
    spinner.fail(err.summary);
    if (err.detail) error(err.detail);
    if (err.exitCode !== 0) process.exit(err.exitCode);
    return;
  }
  spinner.fail('Failed to read canvas');
  error(err.message);
  process.exit(1);
}

export function createCanvasCommand(): Command {
  const canvas = new Command('canvas')
    .description('List and read Slack canvas documents');

  // List canvases
  canvas
    .command('list')
    .description('List canvas documents in the workspace')
    .option('--limit <number>', 'Number of canvases to return', '20')
    .option('--channel <id>', 'Channel ID or URL whose shared canvases to list')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (options) => {
      const spinner = ora('Fetching canvases...').start();

      try {
        const limit = Number.parseInt(options.limit);
        if (Number.isNaN(limit) || limit < 1 || limit > 1000) {
          spinner.fail('Invalid limit');
          error('Limit must be a number between 1 and 1000');
          process.exit(1);
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
        spinner.fail('Failed to fetch canvases');
        error(err.message);
        process.exit(1);
      }
    });

  // Read canvas content
  canvas
    .command('read')
    .description('Read canvas content as markdown')
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
        reportCanvasReadFailure(spinner, err);
      }
    });

  return canvas;
}
