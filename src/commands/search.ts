import chalk from 'chalk';
import { Command } from 'commander';
import ora from 'ora';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { error, formatSearchResults } from '../lib/formatter.ts';
import type { SearchMessageMatch, SearchMessagesPagination } from '../lib/formatter.ts';

export function createSearchCommand(): Command {
  const search = new Command('search')
    .description('Search Slack workspace content');

  search
    .command('messages')
    .description('Search messages in the workspace (requires user token or browser session)')
    .requiredOption('--query <text>', 'Search query string (supports Slack search syntax, e.g. "from:@user in:#channel")')
    .option('--count <number>', 'Number of results per page (max 100)', '20')
    .option('--page <number>', 'Page number of results', '1')
    .option('--sort <type>', 'Sort order: score or timestamp', 'score')
    .option('--sort-dir <direction>', 'Sort direction: asc or desc', 'desc')
    .option('--workspace <id|name>', 'Workspace to use (overrides default)')
    .option('--json', 'Output raw JSON response', false)
    .action(async (options) => {
      const spinner = ora('Searching messages...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);

        const response = await client.searchMessages({
          query: options.query,
          count: parseInt(options.count),
          page: parseInt(options.page),
          sort: options.sort,
          sort_dir: options.sortDir,
        });

        const matches: SearchMessageMatch[] = response.messages?.matches || [];
        const pagination: SearchMessagesPagination = response.messages?.pagination || {
          page: 1,
          page_count: 1,
          total_count: 0,
          per_page: parseInt(options.count),
          first: 0,
          last: 0,
        };

        spinner.succeed(`Found ${pagination.total_count} messages (showing page ${pagination.page} of ${pagination.page_count})`);

        if (options.json) {
          console.log(JSON.stringify({
            query: options.query,
            total_count: pagination.total_count,
            page: pagination.page,
            page_count: pagination.page_count,
            matches: matches.map(m => ({
              text: m.text,
              user: m.user,
              username: m.username,
              ts: m.ts,
              channel_id: m.channel?.id,
              channel_name: m.channel?.name,
              permalink: m.permalink,
              team: m.team,
            })),
          }, null, 2));
        } else {
          if (matches.length === 0) {
            console.log(chalk.dim('\nNo messages found matching your query.'));
          } else {
            console.log('\n' + formatSearchResults(options.query, matches, pagination));
          }

          if (pagination.page < pagination.page_count) {
            const nextPage = pagination.page + 1;
            console.log(chalk.dim('\nMore results available. Next page:'));
            console.log(chalk.cyan(`  slackcli search messages --query "${options.query}" --page ${nextPage}\n`));
          }
        }
      } catch (err: any) {
        spinner.fail('Failed to search messages');
        error(err.message, 'Search requires a user token (xoxp) or browser session. Bot tokens (xoxb) do not support search.');
        process.exit(1);
      }
    });

  return search;
}
