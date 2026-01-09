import { Command } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { error, formatTimestamp } from '../lib/formatter.ts';
import type { SlackSearchMatch } from '../types/index.ts';

export function createSearchCommand(): Command {
  const search = new Command('search')
    .description('Search Slack messages and files');

  // Search messages
  search
    .command('messages')
    .description('Search for messages matching a query')
    .argument('<query>', 'Search query (supports Slack search syntax: in:channel, from:@user, has:link, etc.)')
    .option('--count <number>', 'Number of results per page (max 100)', '20')
    .option('--page <number>', 'Page number', '1')
    .option('--sort <type>', 'Sort by: score or timestamp', 'score')
    .option('--sort-dir <dir>', 'Sort direction: asc or desc', 'desc')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (query, options) => {
      const spinner = ora('Searching messages...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);

        const response = await client.searchMessages(query, {
          count: parseInt(options.count),
          page: parseInt(options.page),
          sort: options.sort,
          sort_dir: options.sortDir,
        });

        const messages = response.messages;
        const matches: SlackSearchMatch[] = messages?.matches || [];
        const total = messages?.total || 0;
        const paging = messages?.paging || { page: 1, pages: 1 };

        spinner.succeed(`Found ${total} messages (showing page ${paging.page} of ${paging.pages})`);

        if (options.json) {
          console.log(JSON.stringify({
            query,
            total,
            page: paging.page,
            pages: paging.pages,
            matches: matches.map(m => ({
              channel_id: m.channel?.id,
              channel_name: m.channel?.name,
              user: m.user,
              username: m.username,
              ts: m.ts,
              text: m.text,
              permalink: m.permalink,
            })),
          }, null, 2));
        } else {
          console.log(formatSearchResults(matches, total, paging));
        }
      } catch (err: any) {
        spinner.fail('Search failed');
        error(err.message);
        process.exit(1);
      }
    });

  // Search files
  search
    .command('files')
    .description('Search for files matching a query')
    .argument('<query>', 'Search query')
    .option('--count <number>', 'Number of results per page (max 100)', '20')
    .option('--page <number>', 'Page number', '1')
    .option('--sort <type>', 'Sort by: score or timestamp', 'score')
    .option('--sort-dir <dir>', 'Sort direction: asc or desc', 'desc')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (query, options) => {
      const spinner = ora('Searching files...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);

        const response = await client.searchFiles(query, {
          count: parseInt(options.count),
          page: parseInt(options.page),
          sort: options.sort,
          sort_dir: options.sortDir,
        });

        const files = response.files;
        const matches = files?.matches || [];
        const total = files?.total || 0;
        const paging = files?.paging || { page: 1, pages: 1 };

        spinner.succeed(`Found ${total} files (showing page ${paging.page} of ${paging.pages})`);

        if (options.json) {
          console.log(JSON.stringify({
            query,
            total,
            page: paging.page,
            pages: paging.pages,
            matches,
          }, null, 2));
        } else {
          console.log(formatFileSearchResults(matches, total, paging));
        }
      } catch (err: any) {
        spinner.fail('Search failed');
        error(err.message);
        process.exit(1);
      }
    });

  return search;
}

// Format message search results
function formatSearchResults(
  matches: SlackSearchMatch[],
  total: number,
  paging: { page: number; pages: number }
): string {
  let output = chalk.bold(`\n🔍 Search Results (${total} total)\n\n`);

  if (matches.length === 0) {
    output += chalk.dim('  No messages found.\n');
    return output;
  }

  matches.forEach((match, idx) => {
    const channelName = match.channel?.name || match.channel?.id || 'unknown';
    const channelType = match.channel?.is_im ? '@' : '#';
    const timestamp = formatTimestamp(match.ts);
    const username = match.username || match.user || 'Unknown';

    output += `${chalk.dim(`${idx + 1}.`)} ${chalk.cyan(`${channelType}${channelName}`)} ${chalk.dim('|')} ${chalk.bold(`@${username}`)} ${chalk.dim(`[${timestamp}]`)}\n`;

    // Message text (truncate if too long)
    const text = match.text || '';
    const displayText = text.length > 300 ? text.substring(0, 300) + '...' : text;
    const textLines = displayText.split('\n');
    textLines.forEach(line => {
      output += `   ${line}\n`;
    });

    output += `   ${chalk.dim(`ts: ${match.ts}`)}\n`;
    if (match.permalink) {
      output += `   ${chalk.blue(match.permalink)}\n`;
    }
    output += '\n';
  });

  if (paging.pages > 1) {
    output += chalk.dim(`Page ${paging.page} of ${paging.pages}. Use --page to see more results.\n`);
  }

  return output;
}

// Format file search results
function formatFileSearchResults(
  matches: any[],
  total: number,
  paging: { page: number; pages: number }
): string {
  let output = chalk.bold(`\n📁 File Search Results (${total} total)\n\n`);

  if (matches.length === 0) {
    output += chalk.dim('  No files found.\n');
    return output;
  }

  const fileIcons: Record<string, string> = {
    'png': '🖼️', 'jpg': '🖼️', 'jpeg': '🖼️', 'gif': '🖼️', 'webp': '🖼️',
    'pdf': '📄', 'docx': '📝', 'doc': '📝',
    'xlsx': '📊', 'xls': '📊', 'csv': '📊',
    'mp4': '🎬', 'mov': '🎬', 'webm': '🎬',
    'mp3': '🎵', 'wav': '🎵',
    'zip': '📦', 'json': '📋', 'txt': '📄',
  };

  matches.forEach((file, idx) => {
    const icon = fileIcons[file.filetype] || '📎';
    const name = file.name || file.title || 'Untitled';
    const created = file.created
      ? new Date(file.created * 1000).toLocaleString()
      : 'Unknown date';

    output += `${chalk.dim(`${idx + 1}.`)} ${icon} ${chalk.bold(name)}\n`;
    output += `   ${chalk.dim(`ID: ${file.id}`)}\n`;
    output += `   ${chalk.dim(`Type: ${file.pretty_type || file.filetype || 'unknown'}`)}\n`;
    output += `   ${chalk.dim(`Created: ${created}`)}\n`;

    if (file.permalink) {
      output += `   ${chalk.blue(file.permalink)}\n`;
    }
    output += '\n';
  });

  if (paging.pages > 1) {
    output += chalk.dim(`Page ${paging.page} of ${paging.pages}. Use --page to see more results.\n`);
  }

  return output;
}
