import { Command } from 'commander';
import ora from 'ora';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { failCommand } from '../lib/command-errors.ts';
import { describeCommand, type CommandHelp } from '../lib/help.ts';
import { formatReminders, success, writeJson, writeText } from '../lib/formatter.ts';
import { applyFields, fieldsOption, FIELDS_DESCRIPTION, FIELDS_FLAG } from '../lib/json-fields.ts';
import { buildPreview, DRY_RUN_DESCRIPTION, DRY_RUN_FLAG, emitDryRun } from '../lib/dry-run.ts';
import {
  createReminder, editReminder, fetchReminder, fetchReminders, finishReminder, reminderAddFromOptions,
  reminderId, reminderUpdateFromOptions, removeReminder, requireReminderTarget,
} from '../lib/reminders.ts';
import { confirmWrite } from './usergroups.ts';

const IDS_NOTE = 'Use the id returned by add or list. Sa… IDs are modern To-dos and require browser login; ' +
  'Rm… IDs use the legacy reminders API. IDs cannot be converted or replaced with message links.';
const AUTH_NOTE = 'User tokens (xoxp) or browser login (auth login-auto); bot tokens are refused. ' +
  'Browser login is recommended: legacy APIs cannot reliably find modern one-time reminders created with app tokens.';
const API_NOTE = 'Modern To-dos use the undocumented saved.* web-client methods; recurring legacy reminders use reminders.*.';

const HELP = {
  group: {
    summary: 'Create and manage your own Slack reminders',
    description: 'Create reminders for yourself, inspect them, change a To-do, mark it complete or delete it.',
    examples: ['slackcli reminders add --text "Take a break" --time "in 5 minutes"', 'slackcli reminders list --json'],
    notes: [AUTH_NOTE, API_NOTE],
  },
  add: {
    summary: 'Create a reminder for yourself',
    description: 'Create a self-reminder with reminders.add. With browser login, a one-time reminder returns its editable To-do ID.',
    examples: ['slackcli reminders add --text "Take a break" --time "in 5 minutes" --json',
      'slackcli reminders add --text "Weekly report" --time 1893492000 --recurrence \'{"frequency":"weekly","weekdays":["monday"]}\''],
    json: '{ id, source, text, recurring, time?, todo_state?, complete_ts?, reminder_id? }. Use id for later commands.',
    dryRun: true,
    notes: [AUTH_NOTE, '--time accepts Unix seconds or Slack natural language. --recurrence is a JSON object with frequency ' +
      'daily, weekly, monthly or yearly; weekly may specify weekdays (monday through sunday).',
      'A recurring reminder returns an Rm… ID; Slack does not allow completing recurring reminders. Creation has no confirmation prompt.',
      'If Slack creates a To-do but its ID cannot be resolved uniquely, the command fails with that reminder ID and advises against retrying add.'],
  },
  list: {
    summary: 'List your reminders and reminder To-dos',
    description: 'List modern reminder To-dos, including completed To-dos, and legacy reminders. App tokens read only the legacy list.',
    examples: ['slackcli reminders list', 'slackcli reminders list --json --fields id,text,time,todo_state'],
    json: '{ reminder_count, reminders[] }; an empty list is still one JSON object.',
    fields: 'each item of reminders', notes: [AUTH_NOTE, IDS_NOTE, API_NOTE],
  },
  info: {
    summary: 'Inspect one reminder or reminder To-do',
    description: 'Fetch a reminder by the ID returned by add or list.',
    examples: ['slackcli reminders info Sa0ABC123', 'slackcli reminders info Rm0ABC123 --json'],
    json: '{ id, source, text, recurring, time?, todo_state?, complete_ts? }.',
    fields: 'the reminder record', notes: [AUTH_NOTE, IDS_NOTE, API_NOTE],
  },
  update: {
    summary: 'Change a reminder To-do text or due date',
    description: 'Edit the text and/or due date of a modern To-do using saved.update. This does not edit recurring legacy reminders.',
    examples: ['slackcli reminders update Sa0ABC123 --text "Call the vendor again" --yes',
      'slackcli reminders update Sa0ABC123 --time 1893492000 --yes --json'],
    json: '{ id, updated: true, text?, time? }.', browserOnly: true, confirms: true, dryRun: true,
    notes: [IDS_NOTE, 'Pass --text and/or --time. For update, --time takes Unix seconds, ISO 8601 with an offset or Z, ' +
      'or a local "YYYY-MM-DD HH:MM"; natural-language parsing is available only on add.'],
  },
  complete: {
    summary: 'Mark a reminder as completed',
    description: 'Complete one reminder To-do or a non-recurring legacy reminder. Completing a To-do clears its due date.',
    examples: ['slackcli reminders complete Sa0ABC123 --yes', 'slackcli reminders complete Rm0ABC123 --yes --json'],
    json: '{ id, completed: true }.', confirms: true, dryRun: true,
    notes: [AUTH_NOTE, IDS_NOTE, 'Slack refuses completion of recurring legacy reminders.'],
  },
  delete: {
    summary: 'Delete a reminder or clear its To-do',
    description: 'Delete one legacy reminder or clear one modern reminder To-do from your list.',
    examples: ['slackcli reminders delete Sa0ABC123 --dry-run --json', 'slackcli reminders delete Rm0ABC123 --yes --json'],
    json: '{ id, deleted: true }.', confirms: true, dryRun: true,
    notes: [AUTH_NOTE, IDS_NOTE, API_NOTE, 'A missing or refused reminder is an error; the command never claims it deleted it.'],
  },
} satisfies Record<string, CommandHelp>;

export function createRemindersCommand(): Command {
  const reminders = describeCommand(new Command('reminders'), HELP.group);

  describeCommand(reminders.command('add'), HELP.add)
    .option('--text <text>', 'Reminder text')
    .option('--time <time>', 'Unix seconds or Slack natural-language time')
    .option('--recurrence <json>', 'Recurrence JSON: frequency and optional weekly weekdays')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .option(DRY_RUN_FLAG, DRY_RUN_DESCRIPTION, false)
    .action(async (options) => {
      const spinner = ora('Creating reminder...').start();
      try {
        const input = reminderAddFromOptions(options);
        const client = await getAuthenticatedClient(options.workspace);
        client.requireReminderUserAuth();
        if (options.dryRun) {
          spinner.stop();
          emitDryRun(await buildPreview(client, 'add reminder', { kind: 'user', id: client.storedUserId }, { ...input }), options.json);
          return;
        }
        const reminder = await createReminder(client, input);
        spinner.succeed('Reminder created');
        if (options.json) writeJson(reminder);
        else writeText(formatReminders([reminder]));
      } catch (err) { failCommand(err, { json: options.json, spinner, context: 'Failed to create reminder' }); }
    });

  describeCommand(reminders.command('list'), HELP.list)
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .option(FIELDS_FLAG, FIELDS_DESCRIPTION)
    .action(async (options) => {
      const spinner = ora('Fetching reminders...').start();
      try {
        const fields = fieldsOption(options);
        const client = await getAuthenticatedClient(options.workspace);
        const items = await fetchReminders(client);
        spinner.succeed(`Found ${items.length} reminders`);
        if (options.json) writeJson(applyFields('reminders list', { reminder_count: items.length, reminders: items }, fields));
        else writeText(formatReminders(items));
      } catch (err) { failCommand(err, { json: options.json, spinner, context: 'Failed to fetch reminders' }); }
    });

  describeCommand(reminders.command('info'), HELP.info)
    .argument('<id>', 'Reminder ID (Sa… or Rm…) from add or list')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .option(FIELDS_FLAG, FIELDS_DESCRIPTION)
    .action(async (rawId, options) => {
      const spinner = ora('Fetching reminder...').start();
      try {
        const fields = fieldsOption(options);
        const id = reminderId(rawId);
        const client = await getAuthenticatedClient(options.workspace);
        const reminder = await fetchReminder(client, id);
        spinner.stop();
        if (options.json) writeJson(applyFields('reminders info', reminder, fields));
        else writeText(formatReminders([reminder]));
      } catch (err) { failCommand(err, { json: options.json, spinner, context: 'Failed to fetch reminder' }); }
    });

  for (const name of ['update', 'complete', 'delete'] as const) {
    const command = describeCommand(reminders.command(name), HELP[name])
      .argument('<id>', 'Reminder ID (Sa… or Rm…) from add or list')
      .option('--yes', 'Confirm the change without a prompt', false)
      .option('--workspace <id|name>', 'Workspace to use')
      .option('--json', 'Output in JSON format', false)
      .option(DRY_RUN_FLAG, DRY_RUN_DESCRIPTION, false);
    if (name === 'update') {
      command.option('--text <text>', 'New reminder text')
        .option('--time <time>', 'New Unix seconds, ISO 8601 or local date and time');
    }
    command.action(async (rawId, options) => {
      const spinner = ora('Resolving reminder...').start();
      try {
        const id = reminderId(rawId);
        const update = name === 'update' ? reminderUpdateFromOptions(options) : {};
        const client = await getAuthenticatedClient(options.workspace);
        requireReminderTarget(client, id, name === 'update');
        spinner.stop();
        if (options.dryRun) {
          emitDryRun(await buildPreview(client, `${name} reminder`, { kind: 'reminder', id }, { ...update }), options.json);
          return;
        }
        if (!(await confirmWrite(`${name} reminder ${id}?`, options.yes, options.json))) return;
        spinner.start('Changing reminder...');
        if (name === 'update') await editReminder(client, id, update);
        else if (name === 'complete') await finishReminder(client, id);
        else await removeReminder(client, id);
        spinner.succeed('Reminder changed');
        if (options.json) {
          writeJson({ id, [name === 'delete' ? 'deleted' : name === 'complete' ? 'completed' : 'updated']: true,
            ...(name === 'update' ? { text: options.text, time: update.date_due } : {}) });
        } else success(`Reminder ${id}: ${name === 'delete' ? 'deleted' : name === 'complete' ? 'completed' : 'updated'}`);
      } catch (err) { failCommand(err, { json: options.json, spinner, context: 'Failed to change reminder' }); }
    });
  }
  return reminders;
}
