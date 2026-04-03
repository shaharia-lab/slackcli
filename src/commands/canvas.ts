import { Command } from 'commander';
import ora from 'ora';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { error, formatCanvasList, formatCanvasContent } from '../lib/formatter.ts';
import { canvasHtmlToMarkdown, isAuthPage } from '../lib/canvas-parser.ts';
import type { SlackCanvas, SlackUser } from '../types/index.ts';

const CANVAS_ID_PATTERN = /^F[A-Z0-9]+$/i;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export function createCanvasCommand(): Command {
  const canvas = new Command('canvas')
    .description('List and read Slack canvas documents');

  // List canvases
  canvas
    .command('list')
    .description('List canvas documents in the workspace')
    .option('--limit <number>', 'Number of canvases to return', '20')
    .option('--channel <id>', 'List canvases shared in a specific channel')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (options) => {
      const spinner = ora('Fetching canvases...').start();

      try {
        const limit = parseInt(options.limit);
        if (isNaN(limit) || limit < 1 || limit > 1000) {
          spinner.fail('Invalid limit');
          error('Limit must be a number between 1 and 1000');
          process.exit(1);
        }

        const client = await getAuthenticatedClient(options.workspace);

        const response = await client.listCanvases({
          limit,
          channel: options.channel,
        });

        const files: SlackCanvas[] = response.files || [];

        if (files.length === 0) {
          spinner.succeed('No canvases found');
          return;
        }

        spinner.succeed(`Found ${files.length} canvases`);

        if (options.json) {
          console.log(JSON.stringify({
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
          }, null, 2));
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
    .argument('[canvas-id]', 'Canvas file ID (e.g., F1234567890)')
    .option('--channel <id>', 'Read the canvas associated with a channel')
    .option('--raw', 'Output raw HTML instead of markdown', false)
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (canvasId, options) => {
      const spinner = ora('Fetching canvas...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);

        // Resolve canvas ID
        let fileId = canvasId;

        if (!fileId && options.channel) {
          spinner.text = 'Looking up channel canvas...';
          fileId = await client.getChannelCanvasId(options.channel);
          if (!fileId) {
            spinner.fail('No canvas found for this channel');
            return;
          }
        }

        if (!fileId) {
          spinner.fail('Missing canvas ID');
          error('Provide a canvas ID or use --channel to read a channel canvas.');
          process.exit(1);
        }

        if (!CANVAS_ID_PATTERN.test(fileId)) {
          spinner.fail('Invalid canvas ID');
          error('Canvas ID must start with F followed by alphanumeric characters (e.g., F1234567890).');
          process.exit(1);
        }

        // Get file info for download URL
        spinner.text = 'Fetching canvas metadata...';
        const fileInfo = await client.getFileInfo(fileId);
        const file = fileInfo.file;

        if (!file) {
          spinner.fail('Canvas not found');
          return;
        }

        const downloadUrl = file.url_private_download || file.url_private;
        if (!downloadUrl) {
          spinner.fail('No download URL available for this canvas');
          return;
        }

        // Download HTML content
        spinner.text = 'Downloading canvas content...';
        const html = await client.downloadFile(downloadUrl, MAX_FILE_SIZE);

        // Check for auth page (expired token)
        if (isAuthPage(html)) {
          spinner.fail('Authentication expired');
          error('The downloaded content is a Slack sign-in page. Your token may have expired.');
          process.exit(1);
        }

        // Raw mode: output HTML directly
        if (options.raw) {
          spinner.succeed(`Canvas: ${file.title || file.name || fileId}`);
          console.log(html);
          return;
        }

        // Convert to markdown
        let markdown = canvasHtmlToMarkdown(html);

        // Resolve user and channel mentions (same pattern as conversations read)
        const userIds = new Set<string>();
        const channelIds = new Set<string>();
        for (const match of markdown.matchAll(/<@(U[A-Z0-9]+)>/gi)) {
          userIds.add(match[1]);
        }
        for (const match of markdown.matchAll(/<#(C[A-Z0-9]+)>/gi)) {
          channelIds.add(match[1]);
        }

        if (userIds.size > 0 || channelIds.size > 0) {
          spinner.text = 'Resolving mentions...';
        } else {
          spinner.succeed(`Canvas: ${file.title || file.name || fileId}`);
        }

        const users = new Map<string, SlackUser>();
        if (userIds.size > 0) {
          const usersResponse = await client.getUsersInfo(Array.from(userIds));
          usersResponse.users?.forEach((user: SlackUser) => {
            users.set(user.id, user);
          });
          // Replace user mentions with display names
          for (const [id, user] of users) {
            const displayName = user.real_name || user.name || id;
            markdown = markdown.replace(
              new RegExp(`<@${id}>`, 'g'),
              `@${displayName}`,
            );
          }
        }

        if (channelIds.size > 0) {
          for (const channelId of channelIds) {
            try {
              const info = await client.getConversationInfo(channelId);
              if (info.channel?.name) {
                markdown = markdown.replace(
                  new RegExp(`<#${channelId}>`, 'g'),
                  `#${info.channel.name}`,
                );
              }
            } catch {
              // Skip channels we can't resolve
            }
          }
        }

        if (userIds.size > 0 || channelIds.size > 0) {
          spinner.succeed(`Canvas: ${file.title || file.name || fileId}`);
        }

        if (options.json) {
          console.log(JSON.stringify({
            id: file.id,
            title: file.title || file.name,
            created: file.created,
            edit_timestamp: file.edit_timestamp,
            user: file.user,
            editors: file.editors,
            size: file.size,
            permalink: file.permalink,
            markdown,
          }, null, 2));
          return;
        }

        console.log('\n' + formatCanvasContent(file, markdown));
      } catch (err: any) {
        spinner.fail('Failed to read canvas');
        error(err.message);
        process.exit(1);
      }
    });

  return canvas;
}
