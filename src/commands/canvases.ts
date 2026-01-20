import { Command } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { htmlToMarkdown } from '../lib/canvas-parser.ts';
import { error, formatConversationHistory } from '../lib/formatter.ts';
import type { SlackFile, SlackUser, SlackMessage } from '../types/index.ts';

export function createCanvasesCommand(): Command {
  const canvases = new Command('canvases')
    .description('Read and manage Slack canvases');

  // List canvases
  canvases
    .command('list')
    .description('List all canvases in the workspace')
    .option('--channel <channel>', 'Filter by channel ID or name')
    .option('--limit <number>', 'Number of canvases to return', '20')
    .option('--workspace <id|name>', 'Workspace to use')
    .action(async (options) => {
      const spinner = ora('Fetching canvases...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);

        let channelId: string | undefined;
        if (options.channel) {
          spinner.text = 'Resolving channel...';
          channelId = await client.resolveChannel(options.channel);
        }

        spinner.text = 'Fetching canvases...';
        const response = await client.listFiles({
          types: 'canvas',
          channel: channelId,
          count: parseInt(options.limit),
        });

        const files: SlackFile[] = response.files || [];

        spinner.succeed(`Found ${files.length} canvas(es)`);

        if (files.length === 0) {
          console.log(chalk.dim('\nNo canvases found.'));
          return;
        }

        console.log('');
        for (const file of files) {
          const title = file.title || file.name || 'Untitled';
          const created = file.created
            ? new Date(file.created * 1000).toLocaleDateString()
            : 'Unknown';

          console.log(
            chalk.cyan(file.id) +
            '  ' +
            chalk.white(title) +
            chalk.dim(` (created ${created})`)
          );
        }
        console.log('');
        console.log(chalk.dim(`Use "slackcli canvases read <canvas-id>" to view a canvas.`));
      } catch (err: any) {
        spinner.fail('Failed to fetch canvases');
        error(err.message);
        process.exit(1);
      }
    });

  // Read canvas content
  canvases
    .command('read')
    .description('Read canvas content')
    .argument('[canvas-id]', 'Canvas file ID (e.g., F0123456789)')
    .option('--channel <channel>', 'Read the channel canvas for this channel')
    .option('--raw', 'Output raw HTML instead of markdown', false)
    .option('--include-comments', 'Include comments from all shares', false)
    .option('--workspace <id|name>', 'Workspace to use')
    .action(async (canvasId, options) => {
      const spinner = ora('Fetching canvas...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);

        let fileId = canvasId;

        // If --channel is provided, get the channel canvas
        if (options.channel) {
          spinner.text = 'Resolving channel...';
          const channelId = await client.resolveChannel(options.channel);

          spinner.text = 'Fetching channel info...';
          const channelInfo = await client.getConversationInfo(channelId);

          const canvasInfo = channelInfo.channel?.properties?.canvas;
          if (!canvasInfo?.file_id) {
            throw new Error(`Channel "${options.channel}" does not have a canvas.`);
          }
          fileId = canvasInfo.file_id;
        }

        if (!fileId) {
          throw new Error('Either provide a canvas ID or use --channel to specify a channel canvas.');
        }

        // Get file info
        spinner.text = 'Fetching canvas info...';
        const fileInfo = await client.getFileInfo(fileId);
        const file: SlackFile = fileInfo.file;

        if (!file) {
          throw new Error(`Canvas not found: ${fileId}`);
        }

        const downloadUrl = file.url_private_download || file.url_private;
        if (!downloadUrl) {
          throw new Error('Canvas does not have a download URL.');
        }

        // Download canvas content
        spinner.text = 'Downloading canvas content...';
        const htmlContent = await client.downloadFile(downloadUrl);

        spinner.succeed(`Canvas: ${file.title || file.name || 'Untitled'}`);

        // Output content
        console.log('');
        if (options.raw) {
          console.log(htmlContent);
        } else {
          const markdown = htmlToMarkdown(htmlContent);
          console.log(markdown);
        }

        // Include comments if requested
        if (options.includeComments) {
          await fetchAndDisplayComments(client, file, spinner);
        }
      } catch (err: any) {
        spinner.fail('Failed to fetch canvas');
        error(err.message);
        process.exit(1);
      }
    });

  return canvases;
}

async function fetchAndDisplayComments(
  client: any,
  file: SlackFile,
  spinner: ReturnType<typeof ora>
): Promise<void> {
  const allShares: Array<{ channelId: string; channelName: string; share: any }> = [];

  // Collect shares from public and private channels
  if (file.shares?.public) {
    for (const [channelId, shares] of Object.entries(file.shares.public)) {
      for (const share of shares) {
        if (share.reply_count && share.reply_count > 0) {
          allShares.push({
            channelId,
            channelName: share.channel_name || channelId,
            share,
          });
        }
      }
    }
  }

  if (file.shares?.private) {
    for (const [channelId, shares] of Object.entries(file.shares.private)) {
      for (const share of shares) {
        if (share.reply_count && share.reply_count > 0) {
          allShares.push({
            channelId,
            channelName: share.channel_name || channelId,
            share,
          });
        }
      }
    }
  }

  if (allShares.length === 0) {
    console.log(chalk.dim('\n---\nNo comments on this canvas.'));
    return;
  }

  console.log(chalk.bold('\n---\nComments:\n'));

  for (const { channelId, channelName, share } of allShares) {
    spinner.start(`Fetching comments from #${channelName}...`);

    try {
      const repliesResponse = await client.getConversationReplies(channelId, share.ts, {
        limit: 100,
      });

      const messages: SlackMessage[] = repliesResponse.messages || [];

      // Skip the first message (it's the canvas share itself, not a comment)
      const comments = messages.slice(1);

      if (comments.length === 0) {
        spinner.info(`No comments in #${channelName}`);
        continue;
      }

      // Fetch user info for comments
      const userIds = new Set<string>();
      comments.forEach((msg) => {
        if (msg.user) userIds.add(msg.user);
      });

      const users = new Map<string, SlackUser>();
      if (userIds.size > 0) {
        const usersResponse = await client.getUsersInfo(Array.from(userIds));
        usersResponse.users?.forEach((user: SlackUser) => {
          users.set(user.id, user);
        });
      }

      spinner.succeed(`Comments from #${channelName}:`);

      // Display comments
      console.log(formatConversationHistory(`#${channelName}`, comments, users));
    } catch (err: any) {
      spinner.warn(`Could not fetch comments from #${channelName}: ${err.message}`);
    }
  }
}
