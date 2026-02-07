import { Command } from 'commander';
import ora from 'ora';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { error, formatSearchResults } from '../lib/formatter.ts';

export function createSearchCommand(): Command {
  const search = new Command('search')
    .description('Search messages and files across your workspace')
    .argument('<query>', 'Search query (supports Slack syntax: from:user, in:#channel, before:date, etc.)')
    .option('--sort <sort>', 'Sort by: score or timestamp', 'score')
    .option('--sort-dir <dir>', 'Sort direction: asc or desc', 'desc')
    .option('--count <number>', 'Results per page (max 100)', '20')
    .option('--page <number>', 'Page number', '1')
    .option('--json', 'Output in JSON format', false)
    .option('--workspace <id|name>', 'Workspace to use (overrides default)')
    .action(async (query, options) => {
      const spinner = ora('Searching...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);

        const response = await client.searchAll(query, {
          sort: options.sort,
          sort_dir: options.sortDir,
          count: parseInt(options.count),
          page: parseInt(options.page),
        });

        const msgTotal = response.messages?.paging?.total || 0;
        const fileTotal = response.files?.paging?.total || 0;

        spinner.succeed(`Found ${msgTotal} messages and ${fileTotal} files`);

        if (options.json) {
          console.log(JSON.stringify(response, null, 2));
        } else {
          console.log('\n' + formatSearchResults(response));
        }
      } catch (err: any) {
        spinner.fail('Search failed');
        error(err.message, 'Make sure your workspace is authenticated.');
        process.exit(1);
      }
    });

  return search;
}
