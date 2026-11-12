import { Command } from 'commander';
import ora from 'ora';
import { getAuthenticatedClient } from '../lib/auth.ts';
import {
  error, formatSavedItems, formatScheduleTime, success, warning, writeJson, writeText,
} from '../lib/formatter.ts';
import { applyFields, fieldsOption, FIELDS_DESCRIPTION, FIELDS_FLAG } from '../lib/json-fields.ts';
import {
  addDueDate,
  addSavedItem,
  COMPLETE_UPDATE,
  enrichSavedItems,
  removeSavedItem,
  removeSavedReminder,
  reopenUpdate,
  savedUpdateFromOptions,
  type SavedWriteResult,
  updateSavedItem,
} from '../lib/saved.ts';
import { CHANNEL_NAME_NOTE, describeCommand, type CommandHelp } from '../lib/help.ts';
import { failCommand } from '../lib/command-errors.ts';
import { resolveMessageTarget, workspaceMismatchWarning } from '../lib/slack-url-parser.ts';
import { normalizeSavedReminderId, SAVED_WRITE_AUTH_MESSAGE, type SlackClient } from '../lib/slack-client.ts';
import { InvalidInputError } from '../lib/cli-errors.ts';
import { buildPreview, DRY_RUN_DESCRIPTION, DRY_RUN_FLAG, emitDryRun } from '../lib/dry-run.ts';
import { resolveIdentifier } from '../lib/name-resolver.ts';
import { confirmWrite } from './usergroups.ts';

// Help text shared by the write commands below.
const PERMALINK_MESSAGE_NOTE =
  '--permalink replaces --channel-id and --timestamp and must be a message link.';
const MESSAGE_TARGET_TEXT =
  'Name the message with --channel-id and --timestamp, or with a single --permalink.';
const MESSAGE_ID_FORMATS_NOTE =
  '--channel-id takes a channel ID, a Slack URL or a channel name; --timestamp takes 1712345678.123456 or p1712345678123456.';
const DUE_NOTE =
  '--due takes the --at formats of messages schedule: Unix seconds (1791791400), ISO 8601 with an offset ' +
  '(2026-10-12T09:50:00+02:00 or ...Z), or a local date and time ("2026-10-12 09:50").';
const NO_PROMPT_NOTE = 'Acts immediately, with no confirmation prompt.';
const WRITE_JSON =
  '{ channel_id, ts, todo_state, date_due }: the item after the change, as Slack reports it. ' +
  'date_due is Unix seconds, 0 when there is no due date.';

// --help content, kept apart from the command chains below (#324).
const HELP = {
  group: {
    summary: 'View and change your saved-for-later items',
    description:
      'Read your Slack "Later" (saved for later) list, with message text, channel and author resolved, ' +
      'and add, update, complete, reopen or remove saved messages, or clear standalone reminder To-dos.',
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
        'with message text resolved. Reminder To-dos are { type, item_id, text, date_saved, date_due, todo_state }; ' +
        'other non-message items carry only type, channel_id and date_saved.',
      'App tokens (xoxb/xoxp) read stars.list (starred items) and return Slack\'s items as-is: ' +
        'no todo_state, so --state matches nothing.',
      '--limit caps the items fetched, before --state filters them.',
    ],
  },
  add: {
    summary: 'Add a message to Later as a to-do',
    description:
      'Add one message to your Later list as a to-do (saved.add), due now or at --due. ' +
      MESSAGE_TARGET_TEXT,
    examples: [
      'slackcli saved add --channel-id C0123456789 --timestamp 1712345678.123456',
      'slackcli saved add --permalink https://acme.slack.com/archives/C0123456789/p1712345678123456 --due "2026-10-12 09:50"',
      'slackcli saved add --channel-id C0123456789 --timestamp 1712345678.123456 --json',
    ],
    json: WRITE_JSON,
    browserOnly: true,
    dryRun: true,
    notes: [
      MESSAGE_ID_FORMATS_NOTE,
      CHANNEL_NAME_NOTE,
      PERMALINK_MESSAGE_NOTE,
      DUE_NOTE,
      'Without --due the to-do is due now, as when you add one in Slack without picking a date.',
      NO_PROMPT_NOTE,
    ],
  },
  update: {
    summary: 'Change the state or due date of a saved item',
    description:
      'Move a message on your Later list between Saved and To-dos, or change its due date (saved.update). ' +
      MESSAGE_TARGET_TEXT,
    examples: [
      'slackcli saved update --channel-id C0123456789 --timestamp 1712345678.123456 --due "2026-10-12 09:50"',
      'slackcli saved update --channel-id C0123456789 --timestamp 1712345678.123456 --no-due',
      'slackcli saved update --permalink https://acme.slack.com/archives/C0123456789/p1712345678123456 --state saved --json',
    ],
    json: WRITE_JSON,
    browserOnly: true,
    dryRun: true,
    notes: [
      MESSAGE_ID_FORMATS_NOTE,
      CHANNEL_NAME_NOTE,
      PERMALINK_MESSAGE_NOTE,
      DUE_NOTE,
      'Pass --state, --due or --no-due. --state saved clears the due date and takes neither; ' +
        '--state to_do is due now unless --due says otherwise, and does not take --no-due.',
      NO_PROMPT_NOTE,
    ],
  },
  complete: {
    summary: 'Mark a saved item as completed',
    description:
      'Mark a message on your Later list as completed (saved.update); its due date is cleared. ' +
      MESSAGE_TARGET_TEXT,
    examples: [
      'slackcli saved complete --channel-id C0123456789 --timestamp 1712345678.123456',
      'slackcli saved complete --permalink https://acme.slack.com/archives/C0123456789/p1712345678123456 --json',
    ],
    json: WRITE_JSON,
    browserOnly: true,
    dryRun: true,
    notes: [
      MESSAGE_ID_FORMATS_NOTE,
      CHANNEL_NAME_NOTE,
      PERMALINK_MESSAGE_NOTE,
      NO_PROMPT_NOTE,
    ],
  },
  reopen: {
    summary: 'Move a completed saved item back to To-dos',
    description:
      'Reopen a completed message on your Later list (saved.update): it goes back to To-dos, due now. ' +
      MESSAGE_TARGET_TEXT,
    examples: [
      'slackcli saved reopen --channel-id C0123456789 --timestamp 1712345678.123456',
      'slackcli saved reopen --permalink https://acme.slack.com/archives/C0123456789/p1712345678123456 --json',
    ],
    json: WRITE_JSON,
    browserOnly: true,
    dryRun: true,
    notes: [
      MESSAGE_ID_FORMATS_NOTE,
      CHANNEL_NAME_NOTE,
      PERMALINK_MESSAGE_NOTE,
      'To set another due date afterwards, use saved update --due.',
      NO_PROMPT_NOTE,
    ],
  },
  remove: {
    summary: 'Clear a saved message or reminder To-do',
    description:
      'Remove one saved message or standalone reminder To-do (saved.delete). The original message is not touched. ' +
      MESSAGE_TARGET_TEXT + ' For a standalone reminder, use --item-id from saved list.',
    examples: [
      'slackcli saved remove --channel-id C0123456789 --timestamp 1712345678.123456',
      'slackcli saved remove --permalink https://acme.slack.com/archives/C0123456789/p1712345678123456 --yes --json',
      'slackcli saved remove --item-id Sa0ABC123 --yes --json',
    ],
    json: '{ channel_id, ts, removed } for a message; { item_id, item_type: "reminder", removed } for a reminder.',
    browserOnly: true,
    confirms: true,
    dryRun: true,
    notes: [
      MESSAGE_ID_FORMATS_NOTE,
      CHANNEL_NAME_NOTE,
      PERMALINK_MESSAGE_NOTE,
      '--item-id takes a reminder To-do ID (Sa…) from saved list --json, not a reminders.add ID (Rm…). ' +
        'It cannot be combined with --channel-id, --timestamp or --permalink.',
      'Any failure exits 1 with the Slack code in slack_error.',
    ],
  },
} satisfies Record<string, CommandHelp>;

// Warn when a pasted link points at a different workspace than the one we will call,
// rather than letting Slack answer with a misleading not-found error.
function warnOnWorkspaceMismatch(client: SlackClient, linkWorkspace: string | undefined): void {
  const message = workspaceMismatchWarning(linkWorkspace, client.workspaceHost);
  if (message) warning(message);
}

// The message a Later-list write acts on: --channel-id and --timestamp, or
// --permalink. Refuses an app token before any name lookup, so a dry run
// fails the way the write would.
async function resolveSavedTarget(
  options: { permalink?: string; channelId?: string; timestamp?: string; workspace?: string },
  spinner: ReturnType<typeof ora>,
): Promise<{ client: SlackClient; channelId: string; timestamp: string }> {
  const target = resolveMessageTarget(
    { permalink: options.permalink, channelId: options.channelId, timestamp: options.timestamp },
    { channel: '--channel-id', timestamp: '--timestamp' }
  );

  const client = await getAuthenticatedClient(options.workspace);
  client.requireBrowserAuth(SAVED_WRITE_AUTH_MESSAGE);
  warnOnWorkspaceMismatch(client, target.workspace);
  const channelId = await resolveIdentifier(client, options.channelId, target.channelId, 'channel', '--channel-id', {
    onProgress: (text) => { spinner.text = text; },
  });
  return { client, channelId, timestamp: target.timestamp };
}

function reportSavedWrite(result: SavedWriteResult, json: boolean): void {
  if (json) {
    writeJson(result);
    return;
  }
  const due = result.date_due > 0 ? `due ${formatScheduleTime(result.date_due)}` : 'no due date';
  success(`Message ${result.ts}: ${result.todo_state ?? 'unknown state'}, ${due}`);
}

async function resolveRemovalTarget(
  options: { itemId?: string; permalink?: string; channelId?: string; timestamp?: string; workspace?: string },
  spinner: ReturnType<typeof ora>,
) {
  if (options.itemId === undefined) return resolveSavedTarget(options, spinner);
  if ([options.permalink, options.channelId, options.timestamp].some((value) => value !== undefined)) {
    throw new InvalidInputError('--item-id cannot be combined with --channel-id, --timestamp or --permalink.');
  }
  const itemId = normalizeSavedReminderId(options.itemId);
  const client = await getAuthenticatedClient(options.workspace);
  client.requireBrowserAuth(SAVED_WRITE_AUTH_MESSAGE);
  return { client, itemId };
}

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

  describeCommand(saved.command('add'), HELP.add)
    .option('--channel-id <id>', 'Channel ID, URL or name where the message is')
    .option('--timestamp <ts>', 'Message timestamp (1234567890.123456 or p1234567890123456)')
    .option('--permalink <url>', 'Slack message link (replaces --channel-id and --timestamp)')
    .option('--due <time>', 'Due date and time (default: now)')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output the saved item as JSON', false)
    .option(DRY_RUN_FLAG, DRY_RUN_DESCRIPTION, false)
    .action(async (options) => {
      const spinner = ora('Adding to your Later list...').start();

      try {
        const dateDue = addDueDate(options.due);
        const { client, channelId, timestamp } = await resolveSavedTarget(options, spinner);
        spinner.stop();

        if (options.dryRun) {
          emitDryRun(
            await buildPreview(
              client,
              'add saved item',
              { kind: 'message', id: channelId, ts: timestamp },
              { todo_state: 'to_do', date_due: dateDue },
              { lookupName: true },
            ),
            options.json,
          );
          return;
        }

        spinner.start('Adding to your Later list...');
        const result = await addSavedItem(client, channelId, timestamp, dateDue);
        spinner.succeed('Added to your Later list');
        reportSavedWrite(result, options.json);
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to add saved item' });
      }
    });

  describeCommand(saved.command('update'), HELP.update)
    .option('--channel-id <id>', 'Channel ID, URL or name where the message is')
    .option('--timestamp <ts>', 'Message timestamp (1234567890.123456 or p1234567890123456)')
    .option('--permalink <url>', 'Slack message link (replaces --channel-id and --timestamp)')
    .option('--state <state>', 'Move the item: saved or to_do')
    .option('--due <time>', 'New due date and time')
    .option('--no-due', 'Clear the due date')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output the saved item as JSON', false)
    .option(DRY_RUN_FLAG, DRY_RUN_DESCRIPTION, false)
    .action(async (options) => {
      const spinner = ora('Updating saved item...').start();

      try {
        const update = savedUpdateFromOptions({ state: options.state, due: options.due });
        const { client, channelId, timestamp } = await resolveSavedTarget(options, spinner);
        spinner.stop();

        if (options.dryRun) {
          emitDryRun(
            await buildPreview(
              client,
              'update saved item',
              { kind: 'message', id: channelId, ts: timestamp },
              update,
              { lookupName: true },
            ),
            options.json,
          );
          return;
        }

        spinner.start('Updating saved item...');
        const result = await updateSavedItem(client, channelId, timestamp, update);
        spinner.succeed('Saved item updated');
        reportSavedWrite(result, options.json);
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to update saved item' });
      }
    });

  describeCommand(saved.command('complete'), HELP.complete)
    .option('--channel-id <id>', 'Channel ID, URL or name where the message is')
    .option('--timestamp <ts>', 'Message timestamp (1234567890.123456 or p1234567890123456)')
    .option('--permalink <url>', 'Slack message link (replaces --channel-id and --timestamp)')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output the saved item as JSON', false)
    .option(DRY_RUN_FLAG, DRY_RUN_DESCRIPTION, false)
    .action(async (options) => {
      const spinner = ora('Completing saved item...').start();

      try {
        const { client, channelId, timestamp } = await resolveSavedTarget(options, spinner);
        spinner.stop();

        if (options.dryRun) {
          emitDryRun(
            await buildPreview(
              client,
              'complete saved item',
              { kind: 'message', id: channelId, ts: timestamp },
              COMPLETE_UPDATE,
              { lookupName: true },
            ),
            options.json,
          );
          return;
        }

        spinner.start('Completing saved item...');
        const result = await updateSavedItem(client, channelId, timestamp, COMPLETE_UPDATE);
        spinner.succeed('Saved item completed');
        reportSavedWrite(result, options.json);
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to complete saved item' });
      }
    });

  describeCommand(saved.command('reopen'), HELP.reopen)
    .option('--channel-id <id>', 'Channel ID, URL or name where the message is')
    .option('--timestamp <ts>', 'Message timestamp (1234567890.123456 or p1234567890123456)')
    .option('--permalink <url>', 'Slack message link (replaces --channel-id and --timestamp)')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output the saved item as JSON', false)
    .option(DRY_RUN_FLAG, DRY_RUN_DESCRIPTION, false)
    .action(async (options) => {
      const spinner = ora('Reopening saved item...').start();

      try {
        const { client, channelId, timestamp } = await resolveSavedTarget(options, spinner);
        spinner.stop();
        const update = reopenUpdate();

        if (options.dryRun) {
          emitDryRun(
            await buildPreview(
              client,
              'reopen saved item',
              { kind: 'message', id: channelId, ts: timestamp },
              update,
              { lookupName: true },
            ),
            options.json,
          );
          return;
        }

        spinner.start('Reopening saved item...');
        const result = await updateSavedItem(client, channelId, timestamp, update);
        spinner.succeed('Saved item reopened');
        reportSavedWrite(result, options.json);
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to reopen saved item' });
      }
    });

  describeCommand(saved.command('remove'), HELP.remove)
    .option('--item-id <id>', 'Standalone reminder To-do ID (Sa…) from saved list')
    .option('--channel-id <id>', 'Channel ID, URL or name where the message is')
    .option('--timestamp <ts>', 'Message timestamp (1234567890.123456 or p1234567890123456)')
    .option('--permalink <url>', 'Slack message link (replaces --channel-id and --timestamp)')
    .option('--yes', 'Confirm removal without a prompt', false)
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output the result as JSON', false)
    .option(DRY_RUN_FLAG, DRY_RUN_DESCRIPTION, false)
    .action(async (options) => {
      const spinner = ora('Removing saved item...').start();

      try {
        const target = await resolveRemovalTarget(options, spinner);
        const { client } = target;
        const reminder = 'itemId' in target;
        spinner.stop();

        if (options.dryRun) {
          emitDryRun(
            await buildPreview(
              client,
              'remove saved item',
              reminder
                ? { kind: 'reminder', id: target.itemId }
                : { kind: 'message', id: target.channelId, ts: target.timestamp },
              undefined,
              { lookupName: !reminder },
            ),
            options.json,
          );
          return;
        }
        const prompt = reminder
          ? `Clear reminder To-do ${target.itemId}?`
          : `Remove message ${target.timestamp} in ${target.channelId} from your Later list?`;
        if (!(await confirmWrite(prompt, options.yes, options.json))) {
          // confirmWrite() set the exit code and, under --json, reported the refusal.
          if (!options.json) error('Saved item was not removed');
          return;
        }

        spinner.start('Removing saved item...');
        const result = reminder
          ? await removeSavedReminder(client, target.itemId)
          : await removeSavedItem(client, target.channelId, target.timestamp);
        spinner.succeed('Removed from your Later list');
        if (options.json) {
          writeJson(result);
        } else {
          success('item_id' in result ? `Reminder item: ${result.item_id}` : `Message timestamp: ${result.ts}`);
        }
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to remove saved item' });
      }
    });

  return saved;
}
