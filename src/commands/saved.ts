import { Command } from 'commander';
import ora from 'ora';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { formatSavedItems, writeJson, writeText } from '../lib/formatter.ts';
import { applyFields, fieldsOption, FIELDS_DESCRIPTION, FIELDS_FLAG } from '../lib/json-fields.ts';
import { enrichSavedItems } from '../lib/saved.ts';
import { describeCommand, type CommandHelp } from '../lib/help.ts';
import { failCommand } from '../lib/command-errors.ts';

// --help content, kept apart from the command chains below (#324).
const HELP = {
  group: {
    summary: 'View your saved-for-later items',
    description: 'Read your Slack "Later" (saved for later) list, with message text, channel and author resolved.',
  },
  list: {
    summary: 'List your saved-for-later items',
    fields: 'each item of items',
    description:
      'List your saved items, paging through the whole list (or up to --limit). ' +
      'Behaviour depends on the auth type, see Notes.',
    examples: [
      'slackcli saved list',
      'slackcli saved list --state to_do',
      'slackcli saved list --limit 50 --json',
    ],
    json:
      '{ item_count, items }. With no items nothing is written to stdout (exit 0).',
    notes: [
      'Browser auth reads saved.list (the Later list): items are { type, channel_id, channel_name, message, date_saved, todo_state }, ' +
        'with message text resolved; non-message items carry only type, channel_id and date_saved.',
      'App tokens (xoxb/xoxp) read stars.list (starred items) and return Slack\'s items as-is: ' +
        'no todo_state, so --state matches nothing.',
      '--limit caps the items fetched, before --state filters them.',
    ],
  },
} satisfies Record<string, CommandHelp>;

export function createSavedCommand(): Command {
  const saved = describeCommand(new Command('saved'), HELP.group);

  describeCommand(saved.command('list'), HELP.list)
    .option('--limit <number>', 'Maximum number of items to return')
    .option('--state <state>', 'Filter by state: saved, to_do, or completed (browser auth only)')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .option(FIELDS_FLAG, FIELDS_DESCRIPTION)
    .action(async (options) => {
      const spinner = ora('Fetching saved items...').start();

      try {
        const fields = fieldsOption(options);
        const client = await getAuthenticatedClient(options.workspace);

        let { items, users } = await enrichSavedItems(client, {
          limit: options.limit ? Number.parseInt(options.limit) : undefined,
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
          writeJson(applyFields('saved list', { item_count: items.length, items }, fields));
          return;
        }

        writeText('\n' + formatSavedItems(items, users));
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to fetch saved items' });
      }
    });

  return saved;
}
