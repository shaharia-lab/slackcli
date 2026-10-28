import { Command } from 'commander';
import ora from 'ora';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { columnNamesOf, fetchListRecords, listCellWriteOf, listIdOf } from '../lib/lists.ts';
import { formatListRecords, success, warning, writeJson, writeText } from '../lib/formatter.ts';
import { applyFields, fieldsOption, FIELDS_DESCRIPTION, FIELDS_FLAG } from '../lib/json-fields.ts';
import { workspaceMismatchWarning, workspaceOf } from '../lib/slack-url-parser.ts';
import { LIST_WRITE_AUTH_MESSAGE, type SlackClient } from '../lib/slack-client.ts';
import { describeCommand, type CommandHelp } from '../lib/help.ts';
import { failCommand } from '../lib/command-errors.ts';
import { NotFoundError } from '../lib/cli-errors.ts';
import { buildPreview, DRY_RUN_DESCRIPTION, DRY_RUN_FLAG, emitDryRun } from '../lib/dry-run.ts';
import { confirmWrite } from './usergroups.ts';

// Both commands take the list the same way, so the note and the cell shape are written once.
const LIST_ARG_NOTE = '<list> accepts a list file ID (F...) or a Slack list URL (.../lists/<team>/<file>).';
const CELL_SHAPE = '{ column_id, key, value, text?, select?, user?, number?, date?, timestamp?, rich_text? }';
const WRITE_NOTE = 'Browser login only. A standard app token is refused before any request is sent.';

const HELP = {
  group: {
    summary: 'Read and change Slack lists and their records',
    description:
      'Read every record of a Slack list, or one record by its ID. Add a row, set one cell, or delete a row. ' +
      'A list is named by its file ID or by its list URL. Needs browser authentication.',
  },
  read: {
    summary: 'Read every record in a list',
    fields: 'each item of records',
    description:
      'Read every record of a Slack list, following each page. Text output prints one line per record. ' +
      'Columns show their column IDs, because lists read does not fetch the list schema. ' +
      'Use "lists record" for one record with its column names.',
    examples: [
      'slackcli lists read F0123456789',
      'slackcli lists read https://acme.slack.com/lists/T0123456789/F0123456789 --json --fields id,fields',
    ],
    json:
      '{ list_id, record_count, records: [{ id, list_id, fields: [' + CELL_SHAPE + '], ' +
      'date_created, updated_timestamp, ... }] }.',
    browserOnly: true,
    notes: [LIST_ARG_NOTE],
  },
  record: {
    summary: 'Read one record from a list',
    fields: 'the record',
    description:
      'Read one record of a Slack list by its record ID. Text output names the columns when Slack sends the schema. ' +
      'Get record IDs from "lists read".',
    examples: [
      'slackcli lists record F0123456789 Rec0123456789',
      'slackcli lists record https://acme.slack.com/lists/T0123456789/F0123456789 Rec0123456789 --json',
    ],
    json:
      '{ list_id, id, fields: [' + CELL_SHAPE + '], date_created, updated_timestamp, ... }, the record itself.',
    browserOnly: true,
    notes: [LIST_ARG_NOTE],
  },
  addRecord: {
    summary: 'Add an empty row to a list',
    description:
      'Add one empty row to a Slack list. The row has no cells until you set them with "lists edit-cell". ' +
      'Prints the new row ID when Slack returns it.',
    examples: [
      'slackcli lists add-record F0123456789',
      'slackcli lists add-record https://acme.slack.com/lists/T0123456789/F0123456789 --yes --json',
    ],
    json: '{ list_id, id }, where id is the new row ID or null when Slack does not return one.',
    browserOnly: true,
    confirms: true,
    dryRun: true,
    notes: [LIST_ARG_NOTE, WRITE_NOTE],
  },
  editCell: {
    summary: 'Set one cell of a list row',
    description:
      'Set one cell of a row in a Slack list. The column type comes from the list schema that Slack sends with the row, ' +
      'so you give only the value. text takes any string. checkbox takes true or false. user takes comma-separated user IDs ' +
      '(U... or W...). date takes YYYY-MM-DD. number takes a number. Other column types, such as created_by and select, ' +
      'are refused. Get the row ID from "lists read" and the column ID from the list.',
    examples: [
      'slackcli lists edit-cell F0123456789 Rec0123456789 Col0123456789 --value "Ship the release"',
      'slackcli lists edit-cell F0123456789 Rec0123456789 Col0123456789 --value true --yes',
      'slackcli lists edit-cell F0123456789 Rec0123456789 Col0123456789 --value U0123456789,U0987654321 --yes --json',
    ],
    json: '{ list_id, row_id, column_id, type }, the cell that was set and its column type from the schema.',
    browserOnly: true,
    confirms: true,
    dryRun: true,
    notes: [LIST_ARG_NOTE, WRITE_NOTE],
  },
  deleteRecord: {
    summary: 'Delete one row from a list',
    description:
      'Delete one row of a Slack list by its row ID. The row and its cells are removed. ' +
      'Get row IDs from "lists read".',
    examples: [
      'slackcli lists delete-record F0123456789 Rec0123456789',
      'slackcli lists delete-record F0123456789 Rec0123456789 --yes --json',
    ],
    json: '{ list_id, id, deleted }, with deleted set to true.',
    browserOnly: true,
    confirms: true,
    dryRun: true,
    notes: [LIST_ARG_NOTE, WRITE_NOTE],
  },
} satisfies Record<string, CommandHelp>;

function warnOnWorkspaceMismatch(client: SlackClient, linkWorkspace: string | undefined): void {
  const message = workspaceMismatchWarning(linkWorkspace, client.workspaceHost);
  if (message) warning(message);
}

export function createListsCommand(): Command {
  const lists = describeCommand(new Command('lists'), HELP.group);

  describeCommand(lists.command('read'), HELP.read)
    .argument('<list>', 'List file ID or Slack list URL')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .option(FIELDS_FLAG, FIELDS_DESCRIPTION)
    .action(async (listArg, options) => {
      const spinner = ora('Fetching list records...').start();
      try {
        const fields = fieldsOption(options);
        const listId = listIdOf(listArg);
        const client = await getAuthenticatedClient(options.workspace);
        warnOnWorkspaceMismatch(client, workspaceOf(listArg));

        const records = await fetchListRecords(client, listId, {
          onProgress: (message) => { spinner.text = message; },
        });

        spinner.succeed(`Found ${records.length} records`);

        if (options.json) {
          writeJson(applyFields('lists read', { list_id: listId, record_count: records.length, records }, fields));
          return;                          // never process.exit() after writeJson
        }
        if (records.length > 0) writeText('\n' + formatListRecords(records));
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to read list' });
      }
    });

  describeCommand(lists.command('record'), HELP.record)
    .argument('<list>', 'List file ID or Slack list URL')
    .argument('<record-id>', 'Record ID from lists read')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .option(FIELDS_FLAG, FIELDS_DESCRIPTION)
    .action(async (listArg, recordId, options) => {
      const spinner = ora('Fetching list record...').start();
      try {
        const fields = fieldsOption(options);
        const listId = listIdOf(listArg);
        const client = await getAuthenticatedClient(options.workspace);
        warnOnWorkspaceMismatch(client, workspaceOf(listArg));

        const response = await client.getListRecord(listId, recordId);
        const record = response.record;
        if (!record) throw new NotFoundError(`No record ${recordId} in that list`);

        spinner.succeed('Found record');

        if (options.json) {
          writeJson(applyFields('lists record', { list_id: listId, ...record }, fields));
          return;                          // never process.exit() after writeJson
        }
        writeText('\n' + formatListRecords([record], columnNamesOf(response.list?.list_metadata?.schema)));
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to read list record' });
      }
    });

  describeCommand(lists.command('add-record'), HELP.addRecord)
    .argument('<list>', 'List file ID or Slack list URL')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--yes', 'Skip the confirmation prompt (required when stdin is not a TTY)', false)
    .option('--json', 'Output in JSON format', false)
    .option(DRY_RUN_FLAG, DRY_RUN_DESCRIPTION, false)
    .action(async (listArg, options) => {
      const spinner = ora('Adding list row...').start();
      try {
        const listId = listIdOf(listArg);
        const client = await getAuthenticatedClient(options.workspace);
        client.requireBrowserAuth(LIST_WRITE_AUTH_MESSAGE);
        warnOnWorkspaceMismatch(client, workspaceOf(listArg));
        spinner.stop();

        if (options.dryRun) {
          emitDryRun(await buildPreview(client, 'add list row', { kind: 'list', id: listId }), options.json);
          return;
        }
        if (!(await confirmWrite(`Add a row to list ${listId}?`, options.yes, options.json))) {
          // confirmWrite() set the exit code and, under --json, reported the refusal.
          return;
        }

        spinner.start('Adding list row...');
        const response = await client.createListRecord(listId);
        const id = response.record?.id ?? null;
        spinner.succeed('Added a row');

        if (options.json) {
          writeJson({ list_id: listId, id });
          return;                          // never process.exit() after writeJson
        }
        if (id) success(`Row ID: ${id}`);
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to add list row' });
      }
    });

  describeCommand(lists.command('edit-cell'), HELP.editCell)
    .argument('<list>', 'List file ID or Slack list URL')
    .argument('<record-id>', 'Row ID from lists read')
    .argument('<column-id>', 'Column ID from lists read or lists record')
    .requiredOption('--value <value>', 'The new value, read as the column type says')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--yes', 'Skip the confirmation prompt (required when stdin is not a TTY)', false)
    .option('--json', 'Output in JSON format', false)
    .option(DRY_RUN_FLAG, DRY_RUN_DESCRIPTION, false)
    .action(async (listArg, recordId, columnId, options) => {
      const spinner = ora('Setting list cell...').start();
      try {
        const listId = listIdOf(listArg);
        const client = await getAuthenticatedClient(options.workspace);
        client.requireBrowserAuth(LIST_WRITE_AUTH_MESSAGE);
        warnOnWorkspaceMismatch(client, workspaceOf(listArg));
        // Reads the schema before any preview or write, so the type shown is the one used.
        const { type, cell } = await listCellWriteOf(client, listId, recordId, columnId, options.value);
        spinner.stop();

        if (options.dryRun) {
          emitDryRun(
            await buildPreview(client, 'edit list cell', { kind: 'list', id: listId }, { type, cells: [cell] }),
            options.json,
          );
          return;
        }
        if (!(await confirmWrite(`Set column ${columnId} of row ${recordId} in list ${listId}?`, options.yes, options.json))) {
          // confirmWrite() set the exit code and, under --json, reported the refusal.
          return;
        }

        spinner.start('Setting list cell...');
        await client.updateListCells(listId, [cell]);
        spinner.succeed('Set list cell');

        if (options.json) {
          writeJson({ list_id: listId, row_id: recordId, column_id: columnId, type });
          return;                          // never process.exit() after writeJson
        }
        success(`Set column ${columnId} of row ${recordId}`);
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to set list cell' });
      }
    });

  describeCommand(lists.command('delete-record'), HELP.deleteRecord)
    .argument('<list>', 'List file ID or Slack list URL')
    .argument('<record-id>', 'Row ID from lists read')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--yes', 'Skip the confirmation prompt (required when stdin is not a TTY)', false)
    .option('--json', 'Output in JSON format', false)
    .option(DRY_RUN_FLAG, DRY_RUN_DESCRIPTION, false)
    .action(async (listArg, recordId, options) => {
      const spinner = ora('Deleting list row...').start();
      try {
        const listId = listIdOf(listArg);
        const client = await getAuthenticatedClient(options.workspace);
        client.requireBrowserAuth(LIST_WRITE_AUTH_MESSAGE);
        warnOnWorkspaceMismatch(client, workspaceOf(listArg));
        spinner.stop();

        if (options.dryRun) {
          emitDryRun(await buildPreview(client, 'delete list row', { kind: 'list', id: listId }, { id: recordId }), options.json);
          return;
        }
        if (!(await confirmWrite(`Delete row ${recordId} from list ${listId}?`, options.yes, options.json))) {
          // confirmWrite() set the exit code and, under --json, reported the refusal.
          return;
        }

        spinner.start('Deleting list row...');
        await client.deleteListRecord(listId, recordId);
        spinner.succeed('Deleted list row');

        if (options.json) {
          writeJson({ list_id: listId, id: recordId, deleted: true });
          return;                          // never process.exit() after writeJson
        }
        success(`Deleted row ${recordId}`);
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to delete list row' });
      }
    });

  return lists;
}
