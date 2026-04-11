import { Command } from 'commander';
import ora from 'ora';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { error, formatSavedItems } from '../lib/formatter.ts';
import { enrichSavedItems } from '../lib/saved.ts';

export function createSavedCommand(): Command {
  const saved = new Command('saved')
    .description('View saved for later items');

  saved
    .command('list')
    .description('List saved for later items')
    .option('--limit <number>', 'Maximum number of items to return')
    .option('--state <state>', 'Filter by state: saved, to_do, or completed')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (options) => {
      const spinner = ora('Fetching saved items...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);

        let { items, users } = await enrichSavedItems(client, {
          limit: options.limit ? parseInt(options.limit) : undefined,
          onProgress: (msg) => { spinner.text = msg; },
        });

        // Filter by state if specified
        if (options.state) {
          items = items.filter(item => item.todo_state === options.state);
        }

        if (items.length === 0) {
          spinner.succeed('No saved items found');
          return;
        }

        spinner.succeed(`Found ${items.length} saved items`);

        if (options.json) {
          console.log(JSON.stringify({ item_count: items.length, items }, null, 2));
          return;
        }

        console.log('\n' + formatSavedItems(items, users));
      } catch (err: any) {
        spinner.fail('Failed to fetch saved items');
        error(err.message);
        process.exit(1);
      }
    });

  return saved;
}
