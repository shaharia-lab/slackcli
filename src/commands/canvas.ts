import { Command } from 'commander';
import ora, { type Ora } from 'ora';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { error, formatCanvasList, formatCanvasContent, warning, writeJson, writeText } from '../lib/formatter.ts';
import { applyFields, fieldsOption, FIELDS_DESCRIPTION, FIELDS_FLAG } from '../lib/json-fields.ts';
import { canvasHtmlToMarkdown } from '../lib/canvas-parser.ts';
import { buildSectionCriteria, sectionsOf } from '../lib/canvas-sections.ts';
import {
  buildCanvasChange,
  checkEditOptions,
  isDestructiveOperation,
  parseEditOperation,
  readCanvasMarkdown,
  type CanvasEditOperation,
} from '../lib/canvas-write.ts';
import { buildPreview, DRY_RUN_DESCRIPTION, DRY_RUN_FLAG, emitDryRun } from '../lib/dry-run.ts';
import { confirmWrite } from './usergroups.ts';
import {
  applyCanvasMentions,
  CanvasReadError,
  fetchCanvasHtml,
  resolveCanvasId,
  resolveCanvasMentions,
} from '../lib/canvas-read.ts';
import { normalizeIdentifier, workspaceMismatchWarning, workspaceOf } from '../lib/slack-url-parser.ts';
import { CANVAS_AUTH_MESSAGE, type SlackClient } from '../lib/slack-client.ts';
import { resolveIdentifier } from '../lib/name-resolver.ts';
import type { SlackCanvas } from '../types/index.ts';
import { CHANNEL_NAME_NOTE, describeCommand, type CommandHelp } from '../lib/help.ts';
import { failCommand } from '../lib/command-errors.ts';
import { InvalidInputError } from '../lib/cli-errors.ts';

// --help content, kept apart from the command chains below (#324).
const HELP = {
  group: {
    summary: 'List, read, create and edit Slack canvases',
    description:
      'List canvas documents in the workspace or a channel, read one as Markdown, with ' +
      'user and channel mentions resolved to names, look up the IDs of its sections, ' +
      'create a canvas from Markdown, and change one part of a canvas.',
  },
  list: {
    summary: 'List canvas documents',
    fields: 'each item of canvases',
    description:
      'List canvases visible to you in the workspace, or only those shared in one channel with --channel. ' +
      'Use "canvas read" for a canvas\'s content.',
    examples: [
      'slackcli canvas list',
      'slackcli canvas list --channel C0123456789 --limit 50',
      'slackcli canvas list --json',
    ],
    json:
      '{ canvas_count, canvases: [{ id, title, created, edit_timestamp, user, editors, size, permalink }] }. ' +
      'With no canvases nothing is written to stdout (exit 0).',
    notes: [
      '--channel takes a channel ID, a Slack URL or a channel name.',
      CHANNEL_NAME_NOTE,
      '--limit must be 1-1000 (default 20).',
    ],
  },
  read: {
    summary: 'Read a canvas as Markdown',
    fields: 'the canvas record',
    description:
      'Download one canvas (up to 10 MB) and print it as Markdown, by canvas ID or URL, ' +
      'or the canvas attached to a channel or DM with --channel.',
    examples: [
      'slackcli canvas read F0123456789',
      'slackcli canvas read https://acme.slack.com/docs/T0123456789/F0123456789 --json',
      'slackcli canvas read --channel C0123456789',
    ],
    json:
      '{ id, title, created, edit_timestamp, user, editors, size, permalink, markdown }.',
    notes: [
      '[canvas-id] takes a canvas file ID (F...) or a Slack URL; --channel takes a channel ID, a Slack URL or a channel name.',
      CHANNEL_NAME_NOTE,
      'Give [canvas-id] or --channel; when both are given the canvas ID wins.',
      '--raw prints the source HTML and takes precedence over --json (stdout is then HTML, not JSON).',
      'A channel without a canvas is reported on stderr with exit 0 and no stdout. An unknown canvas ID exits 1 with Slack\'s error.',
    ],
  },
  sections: {
    summary: 'Look up section IDs in a canvas',
    fields: 'each item of sections',
    standardOnly: true,
    description:
      'Find the sections of one canvas that match a section type, a piece of text, or both, and print ' +
      'their section IDs, one per line, so a script can target a section without guessing its ID.',
    examples: [
      'slackcli canvas sections F0123456789 --type h2',
      'slackcli canvas sections F0123456789 --contains "Status"',
      'slackcli canvas sections https://acme.slack.com/docs/T0123456789/F0123456789 --type h1,h2 --contains Status --json',
    ],
    json:
      '{ canvas_id, section_count, sections: [{ id }] }, in Slack\'s order. ' +
      'With no match, section_count is 0 and sections is empty.',
    notes: [
      '<canvas-id> takes a canvas file ID (F...) or a Slack URL.',
      'Give --type, --contains or both; with both, a section must match both. --type takes ' +
        'comma-separated section types: any_header, h1, h2, h3, or a block type such as list, ' +
        'table, callout or blockquote (several types match any of them).',
      'Without --json, a lookup with no match prints nothing on stdout (exit 0).',
      'Needs the canvases:read scope.',
    ],
  },
  create: {
    summary: 'Create a canvas from Markdown',
    standardOnly: true,
    dryRun: true,
    description:
      'Create a standalone canvas from a Markdown file or standard input, optionally added to a ' +
      'channel as a tab with --channel.',
    examples: [
      'slackcli canvas create --title "Release checklist" --markdown-file ./checklist.md',
      'slackcli canvas create --title "Status" --channel C0123456789 --markdown-file - < ./status.md',
      'slackcli canvas create --title "Notes" --markdown-file ./notes.md --json',
      'slackcli canvas create --title "Notes" --markdown-file ./notes.md --dry-run',
    ],
    json: '{ canvas_id, title?, channel_id? }.',
    notes: [
      'Give --title, --markdown-file or both. --markdown-file - reads the Markdown from piped standard input.',
      'The Markdown may be at most 1,048,576 characters (Slack\'s limit).',
      '--channel takes a channel ID, a Slack URL or a channel name; free Slack workspaces need it.',
      CHANNEL_NAME_NOTE,
      'Needs the canvases:write scope.',
    ],
  },
  edit: {
    summary: 'Change one part of a canvas',
    standardOnly: true,
    confirms: true,
    dryRun: true,
    description:
      'Apply one change to a canvas: insert Markdown at the start or end, or before or after a ' +
      'section; replace a section or the whole canvas; delete a section; or rename the canvas. ' +
      'Find section IDs with "canvas sections".',
    examples: [
      'slackcli canvas edit F0123456789 --operation insert_at_end --markdown-file ./update.md',
      'slackcli canvas edit F0123456789 --operation insert_after --section temp:C:abc123 --markdown-file - < ./item.md',
      'slackcli canvas edit F0123456789 --operation replace --section temp:C:abc123 --markdown-file ./status.md --yes --json',
      'slackcli canvas edit F0123456789 --operation delete --section temp:C:abc123 --dry-run',
      'slackcli canvas edit https://acme.slack.com/docs/T0123456789/F0123456789 --operation rename --title "Q3 plan"',
    ],
    json: '{ canvas_id, operation, section_id? }.',
    notes: [
      '<canvas-id> takes a canvas file ID (F...) or a Slack URL.',
      '--operation is one of insert_at_start, insert_at_end, insert_before, insert_after, replace, delete, rename. ' +
        'insert_before, insert_after and delete need --section; the inserts and replace need --markdown-file; ' +
        'rename needs --title and takes nothing else.',
      'replace without --section replaces the whole canvas.',
      'Only replace and delete ask for confirmation; the inserts and rename do not. With --markdown-file - ' +
        'stdin is not a terminal, so a replace needs --yes.',
      'The Markdown may be at most 1,048,576 characters (Slack\'s limit).',
      'Needs the canvases:write scope.',
    ],
  },
} satisfies Record<string, CommandHelp>;

// Warn when a pasted link points at a different workspace than the one we will call,
// rather than letting Slack answer with a misleading not-found error.
function warnOnWorkspaceMismatch(client: SlackClient, linkWorkspace: string | undefined): void {
  const message = workspaceMismatchWarning(linkWorkspace, client.workspaceHost);
  if (message) warning(message);
}

// Expected failures keep their own exit code (some have always exited 0);
// anything else is an unexpected error and exits 1. Under --json, a failure
// that exits 1 is reported as an error object; an exit-0 one is not a failure.
function reportCanvasReadFailure(spinner: Ora, err: any, json: boolean): void {
  if (err instanceof CanvasReadError) {
    if (json && err.exitCode !== 0) {
      failCommand(err, { json, spinner, message: err.detail ? `${err.summary}. ${err.detail}` : err.summary });
      return;
    }
    spinner.fail(err.summary);
    if (err.detail) error(err.detail);
    if (err.exitCode !== 0) process.exit(err.exitCode);
    return;
  }
  failCommand(err, { json, spinner, context: 'Failed to read canvas' });
}

// --channel takes a channel ID, a link or a channel name. `id` is what the
// URL/ID parser made of it; only a name is looked up.
async function resolveChannelOption(
  client: SlackClient,
  raw: string | undefined,
  id: string | undefined,
  spinner: Ora,
): Promise<string | undefined> {
  if (raw === undefined || id === undefined) return undefined;
  return resolveIdentifier(client, raw, id, 'channel', '--channel', {
    onProgress: (text) => { spinner.text = text; },
  });
}

// A --title that is given must say something.
function titleOption(title: string | undefined): string | undefined {
  if (title !== undefined && title.trim() === '') {
    throw new InvalidInputError('--title needs some text');
  }
  return title;
}

// The confirmation question for a change that removes content.
function confirmPrompt(canvasId: string, operation: CanvasEditOperation, section: string | undefined): string {
  if (operation === 'delete') return `Delete section ${section} from canvas ${canvasId}?`;
  return section === undefined
    ? `Replace the whole content of canvas ${canvasId}?`
    : `Replace section ${section} of canvas ${canvasId}?`;
}

// What a successful edit did, for the spinner's closing line.
function editSummary(canvasId: string, operation: CanvasEditOperation, section: string | undefined): string {
  if (operation === 'rename') return `Renamed canvas ${canvasId}`;
  if (operation === 'delete') return `Deleted section ${section} from canvas ${canvasId}`;
  if (operation === 'replace' && section === undefined) return `Replaced the content of canvas ${canvasId}`;
  return section === undefined
    ? `Applied ${operation} to canvas ${canvasId}`
    : `Applied ${operation} to section ${section} of canvas ${canvasId}`;
}

// Drop keys whose value is undefined, so --json shows only what is there.
function definedOnly(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

export function createCanvasCommand(): Command {
  const canvas = describeCommand(new Command('canvas'), HELP.group);

  // List canvases
  describeCommand(canvas.command('list'), HELP.list)
    .option('--limit <number>', 'Number of canvases to return', '20')
    .option('--channel <id>', 'Channel ID, URL or name whose shared canvases to list')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .option(FIELDS_FLAG, FIELDS_DESCRIPTION)
    .action(async (options) => {
      const spinner = ora('Fetching canvases...').start();

      try {
        const fields = fieldsOption(options);
        const limit = Number.parseInt(options.limit);
        if (Number.isNaN(limit) || limit < 1 || limit > 1000) {
          failCommand(new InvalidInputError('Limit must be a number between 1 and 1000'), {
            json: options.json,
            spinner,
            context: 'Invalid limit',
          });
          return;
        }

        const channelInput = options.channel
          ? normalizeIdentifier(options.channel, 'channel', '--channel')
          : undefined;

        const client = await getAuthenticatedClient(options.workspace);
        warnOnWorkspaceMismatch(client, workspaceOf(options.channel));
        const channel = await resolveChannelOption(client, options.channel, channelInput, spinner);

        const response = await client.listCanvases({
          limit,
          channel,
        });

        const files: SlackCanvas[] = response.files || [];

        if (files.length === 0) {
          spinner.succeed('No canvases found');
          return;
        }

        spinner.succeed(`Found ${files.length} canvases`);

        if (options.json) {
          writeJson(applyFields('canvas list', {
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
          }, fields));
          return;
        }

        writeText('\n' + formatCanvasList(files));
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to fetch canvases' });
      }
    });

  // Read canvas content
  describeCommand(canvas.command('read'), HELP.read)
    .argument('[canvas-id]', 'Canvas file ID or URL (e.g., F1234567890)')
    .option('--channel <id>', 'Channel ID, URL or name whose canvas to read')
    .option('--raw', 'Output raw HTML instead of markdown', false)
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .option(FIELDS_FLAG, FIELDS_DESCRIPTION)
    .action(async (canvasIdArg, options) => {
      const spinner = ora('Fetching canvas...').start();
      const onProgress = (message: string) => {
        spinner.text = message;
      };

      try {
        const fields = fieldsOption(options);
        const canvasId = canvasIdArg
          ? normalizeIdentifier(canvasIdArg, 'file', '<canvas-id>')
          : undefined;
        const channelInput = options.channel
          ? normalizeIdentifier(options.channel, 'channel', '--channel')
          : undefined;

        const client = await getAuthenticatedClient(options.workspace);
        warnOnWorkspaceMismatch(client, workspaceOf(canvasIdArg) ?? workspaceOf(options.channel));
        const channel = await resolveChannelOption(client, options.channel, channelInput, spinner);

        const fileId = await resolveCanvasId(client, { canvasId, channel }, onProgress);
        const { file, html } = await fetchCanvasHtml(client, fileId, onProgress);
        const title = `Canvas: ${file.title || file.name || fileId}`;

        // Raw mode: output HTML directly
        if (options.raw) {
          spinner.succeed(title);
          writeText(html);
          return;
        }

        const rawMarkdown = canvasHtmlToMarkdown(html);
        const mentions = await resolveCanvasMentions(client, rawMarkdown, onProgress);
        const markdown = applyCanvasMentions(rawMarkdown, mentions);
        spinner.succeed(title);

        if (options.json) {
          writeJson(applyFields('canvas read', {
            id: file.id,
            title: file.title || file.name,
            created: file.created,
            edit_timestamp: file.edit_timestamp,
            user: file.user,
            editors: file.editors,
            size: file.size,
            permalink: file.permalink,
            markdown,
          }, fields));
          return;
        }

        writeText('\n' + formatCanvasContent(file, markdown));
      } catch (err: any) {
        reportCanvasReadFailure(spinner, err, options.json);
      }
    });

  // Look up section IDs
  describeCommand(canvas.command('sections'), HELP.sections)
    .argument('<canvas-id>', 'Canvas file ID or URL (e.g., F1234567890)')
    .option('--type <list>', 'Comma-separated section types, e.g. h1,h2 or any_header')
    .option('--contains <text>', 'Only sections containing this text')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .option(FIELDS_FLAG, FIELDS_DESCRIPTION)
    .action(async (canvasIdArg, options) => {
      const spinner = ora('Looking up canvas sections...').start();

      try {
        const fields = fieldsOption(options);
        const canvasId = normalizeIdentifier(canvasIdArg, 'file', '<canvas-id>');
        const criteria = buildSectionCriteria({ type: options.type, contains: options.contains });

        const client = await getAuthenticatedClient(options.workspace);
        warnOnWorkspaceMismatch(client, workspaceOf(canvasIdArg));
        const sections = sectionsOf(await client.lookupCanvasSections(canvasId, criteria));

        spinner.succeed(sections.length === 0 ? 'No matching sections' : `Found ${sections.length} sections`);

        if (options.json) {
          writeJson(applyFields('canvas sections', {
            canvas_id: canvasId,
            section_count: sections.length,
            sections,
          }, fields));
          return;
        }

        if (sections.length > 0) writeText(sections.map((section) => section.id).join('\n'));
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to look up canvas sections' });
      }
    });

  // Create a canvas
  describeCommand(canvas.command('create'), HELP.create)
    .option('--title <title>', 'Title of the new canvas')
    .option('--markdown-file <path>', 'Markdown file for the content, or - for standard input')
    .option('--channel <id>', 'Channel ID, URL or name to add the canvas to as a tab')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .option(DRY_RUN_FLAG, DRY_RUN_DESCRIPTION, false)
    .action(async (options) => {
      const spinner = ora('Creating canvas...').start();

      try {
        const title = titleOption(options.title);
        if (title === undefined && options.markdownFile === undefined) {
          throw new InvalidInputError('Give --title, --markdown-file or both');
        }
        const channelInput = options.channel
          ? normalizeIdentifier(options.channel, 'channel', '--channel')
          : undefined;
        const markdown = options.markdownFile === undefined
          ? undefined
          : await readCanvasMarkdown(options.markdownFile);

        const client = await getAuthenticatedClient(options.workspace);
        warnOnWorkspaceMismatch(client, workspaceOf(options.channel));
        // Before the channel lookup, so a browser profile makes no Slack call.
        client.requireStandardAuth(CANVAS_AUTH_MESSAGE);
        const channelId = await resolveChannelOption(client, options.channel, channelInput, spinner);

        if (options.dryRun) {
          spinner.stop();
          emitDryRun(
            await buildPreview(client, 'create canvas', { kind: 'canvas', name: title }, { title, channel_id: channelId, markdown }),
            options.json,
          );
          return;
        }

        spinner.text = 'Creating canvas...';
        const canvasId = await client.createCanvas({ title, markdown, channelId });
        spinner.succeed(`Created canvas ${canvasId}`);

        if (options.json) {
          writeJson(definedOnly({ canvas_id: canvasId, title, channel_id: channelId }));
        }
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to create canvas' });
      }
    });

  // Edit a canvas
  describeCommand(canvas.command('edit'), HELP.edit)
    .argument('<canvas-id>', 'Canvas file ID or URL (e.g., F1234567890)')
    .option('--operation <operation>', 'insert_at_start, insert_at_end, insert_before, insert_after, replace, delete or rename')
    .option('--section <section-id>', 'Section ID to act on (from "canvas sections")')
    .option('--markdown-file <path>', 'Markdown file for the content, or - for standard input')
    .option('--title <title>', 'New title, with --operation rename')
    .option('--yes', 'Confirm replace or delete without a prompt', false)
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .option(DRY_RUN_FLAG, DRY_RUN_DESCRIPTION, false)
    .action(async (canvasIdArg, options) => {
      const spinner = ora('Editing canvas...').start();

      try {
        const canvasId = normalizeIdentifier(canvasIdArg, 'file', '<canvas-id>');
        if (options.operation === undefined) {
          throw new InvalidInputError('Give --operation (insert_at_start, insert_at_end, insert_before, insert_after, replace, delete or rename)');
        }
        const operation = parseEditOperation(options.operation);
        const section: string | undefined = options.section?.trim();
        // Check the combination before reading Markdown, which may wait on a pipe.
        checkEditOptions({ operation, section: options.section, hasMarkdown: options.markdownFile !== undefined, title: options.title });
        const markdown = options.markdownFile === undefined
          ? undefined
          : await readCanvasMarkdown(options.markdownFile);
        const change = buildCanvasChange({ operation, section: options.section, markdown, title: options.title });

        const client = await getAuthenticatedClient(options.workspace);
        warnOnWorkspaceMismatch(client, workspaceOf(canvasIdArg));
        client.requireStandardAuth(CANVAS_AUTH_MESSAGE);
        spinner.stop();

        if (options.dryRun) {
          emitDryRun(
            await buildPreview(
              client,
              'edit canvas',
              { kind: 'canvas', id: canvasId },
              { operation, section_id: section, markdown, title: options.title },
            ),
            options.json,
          );
          return;
        }

        if (isDestructiveOperation(operation)
          && !(await confirmWrite(confirmPrompt(canvasId, operation, section), options.yes, options.json))) {
          // confirmWrite() set the exit code and, under --json, reported the refusal.
          if (!options.json) error(`Canvas ${canvasId} was not changed`);
          return;
        }

        spinner.start('Editing canvas...');
        await client.editCanvas(canvasId, change);
        spinner.succeed(editSummary(canvasId, operation, section));

        if (options.json) {
          writeJson(definedOnly({ canvas_id: canvasId, operation, section_id: section }));
        }
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to edit canvas' });
      }
    });

  return canvas;
}
