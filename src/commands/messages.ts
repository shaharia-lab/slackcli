import { Command, Option } from 'commander';
import ora from 'ora';
import { readFile } from 'node:fs/promises';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { fetchDrafts, loadActiveDraft, parseDraftLimit, sendDraft, validateSendableDraft } from '../lib/drafts.ts';
import { error, formatDraftList, success, warning, writeJson } from '../lib/formatter.ts';
import {
  type ResolvedThreadTarget,
  resolveMessageTarget,
  resolveThreadTarget,
  workspaceMismatchWarning,
} from '../lib/slack-url-parser.ts';
import {
  checkUploadFile,
  DRAFT_CREATE_AUTH_MESSAGE,
  DRAFT_DELETE_AUTH_MESSAGE,
  type SlackClient,
} from '../lib/slack-client.ts';
import { buildPreview, DRY_RUN_DESCRIPTION, DRY_RUN_FLAG, emitDryRun } from '../lib/dry-run.ts';
import type { DryRunTarget } from '../types/index.ts';
import { CHANNEL_NAME_NOTE, describeCommand, USER_NAME_NOTE, type CommandHelp } from '../lib/help.ts';
import { confirmWrite } from './usergroups.ts';
import { failCommand } from '../lib/command-errors.ts';
import { InvalidInputError } from '../lib/cli-errors.ts';
import { resolveIdentifier } from '../lib/name-resolver.ts';
import { resolveMessageText } from '../lib/message-input.ts';

// Help text shared by several commands below.
const THREAD_TS_NOTE =
  '--thread-ts takes 1712345678.123456 or p1712345678123456.';
const PERMALINK_MESSAGE_NOTE =
  '--permalink replaces --channel-id and --timestamp and must be a message link.';
const MESSAGE_TARGET_TEXT =
  'Name the message with --channel-id and --timestamp, or with a single --permalink.';
const MESSAGE_TEXT_NOTE =
  'One of --message or --message-file is required; they are mutually exclusive.';
const STDIN_NOTE =
  '--message-file - reads the text from piped standard input (no shell quoting, no temp file); ' +
  'one trailing newline is dropped. A terminal on stdin, more than 1 MB, or a pipe not closed within 30 s is refused.';
const RECIPIENT_NOTE =
  '--recipient-id takes a channel ID (C...), a user ID (U..., opens a DM), a Slack URL, ' +
  'a channel name (#general) or a user (@alice, alice@example.com). A bare name must match ' +
  'only a channel or only a user; if both exist, add # or @.';
const MESSAGE_ID_FORMATS_NOTE =
  '--channel-id takes a channel ID, a Slack URL or a channel name; --timestamp takes 1712345678.123456 or p1712345678123456.';

// --help content, kept apart from the command chains below (#324).
const HELP = {
  group: {
    summary: 'Send, edit, react to and draft messages',
    description:
      'Send, edit and react to messages, and create, list, send or delete drafts. ' +
      'To read messages use "slackcli conversations"; to find them, "slackcli search".',
  },
  send: {
    summary: 'Send a message to a channel, DM or thread',
    description:
      'Post a message to a channel, a user (the DM is opened for you) or a thread, ' +
      'optionally with a file or Block Kit blocks. Works with both auth types. ' +
      'To leave an unsent message for a human to review, use "messages draft" instead.',
    examples: [
      'slackcli messages send --recipient-id C0123456789 --message "Deploy done"',
      'slackcli messages send --recipient-id="#general" --message "Deploy done"',
      'slackcli messages send --permalink https://acme.slack.com/archives/C0123456789/p1712345678123456 --message "Fixed"',
      'slackcli messages send --recipient-id U0123456789 --message-file ./note.md --json',
      'slackcli messages send --recipient-id C0123456789 --message "Deploy done" --dry-run',
    ],
    json:
      '{ channel_id, ts, permalink? } for a post; { channel_id, file_id } with --file. ' +
      'permalink is omitted when its lookup fails. channel_id is always the resolved ID.',
    notes: [
      RECIPIENT_NOTE,
      CHANNEL_NAME_NOTE,
      USER_NAME_NOTE,
      THREAD_TS_NOTE,
      '--permalink replaces --recipient-id and --thread-ts: a message link replies in its thread, ' +
        'a channel link posts to the channel.',
      'One of --message or --message-file is required; they are mutually exclusive. ' +
        'With --file the text becomes the file comment.',
      STDIN_NOTE,
      '--blocks cannot be combined with --file; the message text is the notification fallback.',
      'Sends immediately, with no confirmation prompt.',
      'A dry run to a user ID does not open the DM; it previews the user as the target.',
    ],
    dryRun: true,
  },
  react: {
    summary: 'Add an emoji reaction to a message',
    description:
      'Add an emoji reaction to one message as the authenticated user or app. ' +
      MESSAGE_TARGET_TEXT,
    examples: [
      'slackcli messages react --channel-id C0123456789 --timestamp 1712345678.123456 --emoji thumbsup',
      'slackcli messages react --permalink https://acme.slack.com/archives/C0123456789/p1712345678123456 --emoji eyes',
    ],
    notes: [
      MESSAGE_ID_FORMATS_NOTE,
      CHANNEL_NAME_NOTE,
      PERMALINK_MESSAGE_NOTE,
      '--emoji is the name without colons; custom workspace emoji work too.',
      'Acts immediately, with no confirmation prompt.',
    ],
    dryRun: true,
  },
  edit: {
    summary: 'Replace the text of a message you posted',
    description:
      'Replace the text of an existing message posted by the authenticated user or app. ' +
      MESSAGE_TARGET_TEXT,
    examples: [
      'slackcli messages edit --channel-id C0123456789 --timestamp 1712345678.123456 --message "Corrected text"',
      'slackcli messages edit --permalink https://acme.slack.com/archives/C0123456789/p1712345678123456 --message-file ./fixed.md --json',
    ],
    json: '{ channel_id, ts } of the edited message.',
    notes: [
      MESSAGE_ID_FORMATS_NOTE,
      CHANNEL_NAME_NOTE,
      PERMALINK_MESSAGE_NOTE,
      MESSAGE_TEXT_NOTE,
      STDIN_NOTE,
      'Edits immediately, with no confirmation prompt.',
    ],
    dryRun: true,
  },
  listDrafts: {
    summary: 'List your active (unsent) drafts',
    description:
      'List the authenticated user\'s active drafts, ' +
      'excluding deleted and already-sent ones. Use it to find the draft ID for send-draft or delete-draft.',
    examples: [
      'slackcli messages list-drafts',
      'slackcli messages list-drafts --limit 25 --json',
    ],
    json:
      '{ draft_count, drafts: [{ draft_id, channel_id, text, date_created, file_ids, thread_ts?, date_scheduled? }] }. ' +
      'No drafts gives { draft_count: 0, drafts: [] }.',
    browserOnly: true,
    notes: ['--limit must be a positive integer (default 100).'],
  },
  draft: {
    summary: 'Create an unsent draft for a human to review',
    description:
      'Create an unsent draft in a channel, DM or thread; it appears in the Slack composer for a human ' +
      'to review and send. Use "messages send" to post directly, or "messages send-draft" to post it later.',
    examples: [
      'slackcli messages draft --recipient-id C0123456789 --message "Release notes for review"',
      'slackcli messages draft --permalink https://acme.slack.com/archives/C0123456789/p1712345678123456 --message-file ./reply.md --json',
    ],
    json: '{ channel_id, draft_id, thread_ts? } (thread_ts only for a threaded draft).',
    browserOnly: true,
    notes: [
      RECIPIENT_NOTE,
      CHANNEL_NAME_NOTE,
      USER_NAME_NOTE,
      THREAD_TS_NOTE,
      '--permalink replaces --recipient-id and --thread-ts: a message link drafts a reply in its thread, ' +
        'a channel link drafts in the channel.',
      MESSAGE_TEXT_NOTE,
      STDIN_NOTE,
      'Creates the draft immediately, with no confirmation prompt.',
    ],
    dryRun: true,
  },
  sendDraft: {
    summary: 'Post an active draft, then delete the draft',
    description:
      'Post an active draft to its saved channel and thread with its original formatting, ' +
      'then delete the draft. Get the draft ID from "messages draft" or "messages list-drafts".',
    examples: [
      'slackcli messages send-draft Dr0123456789',
      'slackcli messages send-draft Dr0123456789 --yes --json',
    ],
    json:
      '{ channel_id, ts, permalink?, cleanup_error? }. cleanup_error means the message was posted ' +
      'but the draft was not deleted (exit 1): do not retry without checking.',
    browserOnly: true,
    confirms: true,
    dryRun: true,
    notes: [
      'Exception to the rule above: the draft is read (drafts.list) before the prompt, so a refusal ' +
        'still makes that one read call, but posts nothing.',
      'Scheduled drafts, drafts with files, empty drafts and drafts with several destinations are refused before posting.',
    ],
  },
  deleteDraft: {
    summary: 'Delete a draft without sending it',
    description:
      'Discard a draft without posting it. Get the draft ID from "messages draft" or "messages list-drafts"; ' +
      'use "messages send-draft" to post it instead.',
    examples: [
      'slackcli messages delete-draft Dr0123456789',
      'slackcli messages delete-draft Dr0123456789 --yes --json',
    ],
    json: '{ draft_id, deleted: true }.',
    browserOnly: true,
    confirms: true,
    dryRun: true,
  },
} satisfies Record<string, CommandHelp>;

export async function parseBlocksInput(input: string): Promise<Array<Record<string, unknown>>> {
  let source = input;
  if (input.startsWith('@')) {
    const path = input.slice(1);
    if (!path) {
      throw new InvalidInputError('--blocks file path cannot be empty');
    }
    try {
      source = await readFile(path, 'utf8');
    } catch (err: any) {
      throw new InvalidInputError(`Cannot read blocks file ${path}: ${err.message}`);
    }
  }

  let blocks: unknown;
  try {
    blocks = JSON.parse(source);
  } catch (err: any) {
    // The parser's message quotes the input, so the --json report leaves it out.
    throw new InvalidInputError(
      `Invalid blocks JSON: ${err.message}`,
      undefined,
      'Invalid blocks JSON: --blocks is not valid JSON.',
    );
  }

  if (!Array.isArray(blocks)) {
    throw new InvalidInputError('--blocks must contain a JSON array of Block Kit blocks');
  }
  for (const [index, block] of blocks.entries()) {
    if (
      typeof block !== 'object'
      || block === null
      || Array.isArray(block)
      || typeof (block as Record<string, unknown>).type !== 'string'
      || !(block as Record<string, unknown>).type
    ) {
      throw new InvalidInputError(`Block at index ${index} must be an object with a non-empty string "type"`);
    }
  }

  return blocks as Array<Record<string, unknown>>;
}

// Look up the message's shareable link, for spreading into the --json payload.
//
// The message is already delivered by the time this runs, so a permalink
// lookup that fails (a token without the scope, a transient error) must not
// fail the command. The key is omitted rather than emitted as null, so a
// consumer can test for its presence.
export async function permalinkField(
  client: Pick<SlackClient, 'getPermalink'>,
  channelId: string,
  ts: string,
): Promise<{ permalink?: string }> {
  try {
    const response = await client.getPermalink(channelId, ts);
    return response?.permalink ? { permalink: response.permalink } : {};
  } catch {
    return {};
  }
}

// The dry-run target of a send or draft: a user ID is previewed as a DM to that
// user, because a dry run does not open the DM (conversations.open).
function recipientTarget(channelId: string, threadTs: string | undefined): DryRunTarget {
  return { kind: channelId.startsWith('U') ? 'user' : 'channel', id: channelId, thread_ts: threadTs };
}

// Warn when a pasted link points at a different workspace than the one we will call,
// rather than letting Slack answer with a misleading message_not_found.
function warnOnWorkspaceMismatch(client: SlackClient, linkWorkspace: string | undefined): void {
  const message = workspaceMismatchWarning(linkWorkspace, client.workspaceHost);
  if (message) warning(message);
}

// --recipient-id may be a channel name or a user handle/email, --channel-id a
// channel name; resolve either to an ID (no Slack call for an ID or a link).
function resolveTargetArg(
  client: SlackClient,
  raw: string | undefined,
  id: string,
  flag: '--recipient-id' | '--channel-id',
  spinner: ReturnType<typeof ora>,
): Promise<string> {
  const expected = flag === '--recipient-id' ? 'channel-or-user' : 'channel';
  return resolveIdentifier(client, raw, id, expected, flag, {
    onProgress: (text) => { spinner.text = text; },
  });
}

// The recipient of a send or draft: --recipient-id (an ID, link or name) or
// --permalink, resolved to a channel or user ID. A user's DM is not opened
// yet, so a dry run can stop here without opening it.
async function resolveRecipient(
  options: { permalink?: string; recipientId?: string; threadTs?: string; workspace?: string },
  spinner: ReturnType<typeof ora>,
): Promise<{ client: SlackClient; recipientId: string; target: ResolvedThreadTarget }> {
  const target = resolveThreadTarget(
    { permalink: options.permalink, channelId: options.recipientId, threadTs: options.threadTs },
    { channel: '--recipient-id', timestamp: '--thread-ts' },
    'channel-or-user'
  );

  const client = await getAuthenticatedClient(options.workspace);
  warnOnWorkspaceMismatch(client, target.workspace);

  const recipientId = await resolveTargetArg(client, options.recipientId, target.channelId, '--recipient-id', spinner);
  return { client, recipientId, target };
}

// The conversation to post in: a user ID (starts with U) needs its DM opened.
async function openRecipient(client: SlackClient, recipientId: string, spinner: ReturnType<typeof ora>): Promise<string> {
  if (!recipientId.startsWith('U')) return recipientId;
  spinner.text = 'Opening direct message...';
  const dmResponse = await client.openConversation(recipientId);
  return dmResponse.channel.id;
}

export function createMessagesCommand(): Command {
  const messages = describeCommand(new Command('messages'), HELP.group);

  // Send message
  describeCommand(messages.command('send'), HELP.send)
    .option('--recipient-id <id>', 'Channel/user ID, Slack URL, #channel, @handle or email')
    .option('--message <text>', 'Message text content')
    .addOption(
      new Option('--message-file <path>', 'Read the message text from a UTF-8 file, or stdin with -')
        .conflicts('message')
    )
    .option('--thread-ts <timestamp>', 'Thread to reply in (1234567890.123456 or p1234567890123456)')
    .option('--permalink <url>', 'Slack message link; replies in that message\'s thread (replaces --recipient-id and --thread-ts)')
    .option('--file <path>', 'Attach a file to the message')
    .addOption(
      new Option('--blocks <json|@file>', 'Block Kit JSON array, inline or loaded from @file')
        .conflicts('file')
    )
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output the delivered message as JSON', false)
    .option(DRY_RUN_FLAG, DRY_RUN_DESCRIPTION, false)
    .action(async (options) => {
      const spinner = ora('Sending message...').start();

      try {
        const message = await resolveMessageText(options);
        const blocks = options.blocks ? await parseBlocksInput(options.blocks) : undefined;
        const { client, recipientId, target } = await resolveRecipient(options, spinner);

        if (options.dryRun) {
          const file = options.file ? await checkUploadFile(options.file) : undefined;
          const payload = file
            ? { file: options.file, file_size: file.size, comment: message }
            : { text: message, blocks };
          spinner.stop();
          emitDryRun(
            await buildPreview(client, 'send message', recipientTarget(recipientId, target.threadTs), payload, { lookupName: true }),
            options.json,
          );
          return;
        }

        const channelId = await openRecipient(client, recipientId, spinner);

        spinner.text = 'Sending message...';
        if (options.file) {
          const upload = await client.uploadFileExternal(channelId, options.file, {
            initial_comment: message,
            thread_ts: target.threadTs,
          });

          spinner.succeed('Message sent successfully!');
          if (options.json) {
            // The upload flow returns the attached file, not a message ts, so
            // this branch cannot offer ts/permalink the way a post can.
            writeJson({
              channel_id: channelId,
              file_id: upload.files?.[0]?.id,
            });
          } else {
            success('File uploaded successfully');
          }
          return;
        }

        const response = await client.postMessage(channelId, message, {
          thread_ts: target.threadTs,
          blocks,
        });

        spinner.succeed('Message sent successfully!');
        if (options.json) {
          writeJson({
            channel_id: channelId,
            ts: response.ts,
            ...(await permalinkField(client, channelId, response.ts)),
          });
        } else {
          success(`Message timestamp: ${response.ts}`);
        }
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to send message' });
      }
    });

  // Add reaction to message
  describeCommand(messages.command('react'), HELP.react)
    .option('--channel-id <id>', 'Channel ID, URL or name where the message is')
    .option('--timestamp <ts>', 'Message timestamp (1234567890.123456 or p1234567890123456)')
    .option('--permalink <url>', 'Slack message link (replaces --channel-id and --timestamp)')
    .requiredOption('--emoji <name>', 'Emoji name (e.g., thumbsup, heart, fire)')
    .option('--workspace <id|name>', 'Workspace to use')
    .option(DRY_RUN_FLAG, DRY_RUN_DESCRIPTION, false)
    .action(async (options) => {
      const spinner = ora('Adding reaction...').start();

      try {
        const target = resolveMessageTarget(
          { permalink: options.permalink, channelId: options.channelId, timestamp: options.timestamp },
          { channel: '--channel-id', timestamp: '--timestamp' }
        );

        const client = await getAuthenticatedClient(options.workspace);
        warnOnWorkspaceMismatch(client, target.workspace);
        const channelId = await resolveTargetArg(client, options.channelId, target.channelId, '--channel-id', spinner);

        if (options.dryRun) {
          spinner.stop();
          emitDryRun(
            await buildPreview(
              client,
              'add reaction',
              { kind: 'message', id: channelId, ts: target.timestamp },
              { emoji: options.emoji },
              { lookupName: true },
            ),
            false,
          );
          return;
        }

        await client.addReaction(channelId, target.timestamp, options.emoji);

        spinner.succeed('Reaction added successfully!');
        success(`Added :${options.emoji}: to message ${target.timestamp}`);
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to add reaction' });
      }
    });

  // Edit an existing message
  describeCommand(messages.command('edit'), HELP.edit)
    .option('--channel-id <id>', 'Channel ID, URL or name where the message is')
    .option('--timestamp <ts>', 'Message timestamp (1234567890.123456 or p1234567890123456)')
    .option('--permalink <url>', 'Slack message link (replaces --channel-id and --timestamp)')
    .option('--message <text>', 'New message text content')
    .addOption(
      new Option('--message-file <path>', 'Read the new message text from a UTF-8 file, or stdin with -')
        .conflicts('message')
    )
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output the updated message as JSON', false)
    .option(DRY_RUN_FLAG, DRY_RUN_DESCRIPTION, false)
    .action(async (options) => {
      const spinner = ora('Updating message...').start();

      try {
        const message = await resolveMessageText(options);
        const target = resolveMessageTarget(
          { permalink: options.permalink, channelId: options.channelId, timestamp: options.timestamp },
          { channel: '--channel-id', timestamp: '--timestamp' }
        );

        const client = await getAuthenticatedClient(options.workspace);
        warnOnWorkspaceMismatch(client, target.workspace);
        const channelId = await resolveTargetArg(client, options.channelId, target.channelId, '--channel-id', spinner);

        if (options.dryRun) {
          spinner.stop();
          emitDryRun(
            await buildPreview(
              client,
              'edit message',
              { kind: 'message', id: channelId, ts: target.timestamp },
              { text: message },
              { lookupName: true },
            ),
            options.json,
          );
          return;
        }

        const response = await client.updateMessage(
          channelId,
          target.timestamp,
          message,
        );

        spinner.succeed('Message updated successfully!');
        if (options.json) {
          writeJson({ channel_id: channelId, ts: response.ts });
        } else {
          success(`Message timestamp: ${response.ts}`);
        }
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to update message' });
      }
    });

  // List active draft messages
  describeCommand(messages.command('list-drafts'), HELP.listDrafts)
    .option('--limit <number>', 'Maximum number of drafts to return', '100')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output drafts as JSON', false)
    .action(async (options) => {
      const spinner = ora('Fetching active drafts...').start();

      try {
        const limit = parseDraftLimit(options.limit);
        const client = await getAuthenticatedClient(options.workspace);
        const drafts = await fetchDrafts(client, {
          limit,
          onProgress: (message) => { spinner.text = message; },
        });

        if (drafts.length === 0) {
          spinner.succeed('No active drafts found');
        } else {
          spinner.succeed(`Found ${drafts.length} active drafts`);
        }

        if (options.json) {
          writeJson({ draft_count: drafts.length, drafts });
          return;
        }
        if (drafts.length > 0) {
          console.log('\n' + formatDraftList(drafts));
        }
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to list drafts' });
      }
    });

  // Create draft message
  describeCommand(messages.command('draft'), HELP.draft)
    .option('--recipient-id <id>', 'Channel/user ID, Slack URL, #channel, @handle or email')
    .option('--message <text>', 'Message text content')
    .addOption(
      new Option('--message-file <path>', 'Read the message text from a UTF-8 file, or stdin with -')
        .conflicts('message')
    )
    .option('--thread-ts <timestamp>', 'Thread to draft a reply in (1234567890.123456 or p1234567890123456)')
    .option('--permalink <url>', 'Slack message link; drafts a reply in that message\'s thread (replaces --recipient-id and --thread-ts)')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output the created draft as JSON', false)
    .option(DRY_RUN_FLAG, DRY_RUN_DESCRIPTION, false)
    .action(async (options) => {
      const spinner = ora('Creating draft...').start();

      try {
        const message = await resolveMessageText(options);
        const { client, recipientId, target } = await resolveRecipient(options, spinner);

        if (options.dryRun) {
          client.requireBrowserAuth(DRAFT_CREATE_AUTH_MESSAGE);
          spinner.stop();
          emitDryRun(
            await buildPreview(client, 'create draft', recipientTarget(recipientId, target.threadTs), { text: message }, { lookupName: true }),
            options.json,
          );
          return;
        }

        const channelId = await openRecipient(client, recipientId, spinner);

        spinner.text = 'Creating draft...';
        const response = await client.createDraft(channelId, message, {
          thread_ts: target.threadTs,
        });

        spinner.succeed('Draft created successfully!');
        if (options.json) {
          // A draft is unsent, so it has no message ts and no permalink. The
          // draft id is what a follow-up call has to work with.
          writeJson({
            channel_id: channelId,
            draft_id: response.draft.id,
            ...(target.threadTs ? { thread_ts: target.threadTs } : {}),
          });
        } else {
          success(`Draft ID: ${response.draft.id}`);
        }
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to create draft' });
      }
    });

  describeCommand(messages.command('send-draft'), HELP.sendDraft)
    .argument('<draft-id>', 'ID returned by messages draft or list-drafts')
    .option('--yes', 'Confirm sending without a prompt', false)
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output the posted message as JSON', false)
    .option(DRY_RUN_FLAG, DRY_RUN_DESCRIPTION, false)
    .action(async (draftId, options) => {
      const spinner = ora('Loading draft...').start();
      try {
        const client = await getAuthenticatedClient(options.workspace);
        const draft = await loadActiveDraft(client, draftId);
        const { channelId, threadTs, text, blocks } = validateSendableDraft(draft);
        spinner.stop();
        if (options.dryRun) {
          emitDryRun(
            await buildPreview(
              client,
              'send draft',
              { kind: 'channel', id: channelId, thread_ts: threadTs },
              { draft_id: draftId, text, blocks },
              { lookupName: true },
            ),
            options.json,
          );
          return;
        }
        if (!(await confirmWrite(`Send draft ${draftId} to ${channelId}?`, options.yes, options.json))) {
          // confirmWrite() set the exit code and, under --json, reported the refusal.
          if (!options.json) error('Draft was not sent');
          return;
        }
        spinner.start('Sending draft...');
        const result = await sendDraft(client, draftId, draft);
        if (result.cleanup_error) {
          spinner.fail('Draft posted, but cleanup failed');
          if (options.json) writeJson(result);
          error(`Posted message ${result.channel_id}/${result.ts}; draft ${draftId} remains: ${result.cleanup_error}. Do not retry send-draft without checking the posted message.`);
          process.exitCode = 1;
          return;
        }
        spinner.succeed('Draft sent and deleted');
        if (options.json) writeJson(result);
        else success(`Message timestamp: ${result.ts}`);
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to send draft' });
      }
    });

  describeCommand(messages.command('delete-draft'), HELP.deleteDraft)
    .argument('<draft-id>', 'ID returned by messages draft or list-drafts')
    .option('--yes', 'Confirm deletion without a prompt', false)
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output the deleted draft ID as JSON', false)
    .option(DRY_RUN_FLAG, DRY_RUN_DESCRIPTION, false)
    .action(async (draftId, options) => {
      const spinner = ora('Deleting draft...').start();
      try {
        if (!draftId.trim()) throw new InvalidInputError('Draft ID cannot be empty');
        const client = await getAuthenticatedClient(options.workspace);
        spinner.stop();
        if (options.dryRun) {
          client.requireBrowserAuth(DRAFT_DELETE_AUTH_MESSAGE);
          emitDryRun(await buildPreview(client, 'delete draft', { kind: 'draft', id: draftId }), options.json);
          return;
        }
        if (!(await confirmWrite(`Delete draft ${draftId}?`, options.yes, options.json))) {
          // confirmWrite() set the exit code and, under --json, reported the refusal.
          if (!options.json) error('Draft was not deleted');
          return;
        }
        spinner.start('Deleting draft...');
        await client.deleteDraft(draftId);
        spinner.succeed('Draft deleted');
        if (options.json) writeJson({ draft_id: draftId, deleted: true });
        else success(`Deleted draft ${draftId}`);
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to delete draft' });
      }
    });

  return messages;
}
