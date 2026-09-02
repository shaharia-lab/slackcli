import { Command, Option } from 'commander';
import ora from 'ora';
import { readFile } from 'node:fs/promises';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { success, error, warning, writeJson } from '../lib/formatter.ts';
import {
  resolveMessageTarget,
  resolveThreadTarget,
  workspaceMismatchWarning,
} from '../lib/slack-url-parser.ts';
import type { SlackClient } from '../lib/slack-client.ts';

export async function parseBlocksInput(input: string): Promise<Array<Record<string, unknown>>> {
  let source = input;
  if (input.startsWith('@')) {
    const path = input.slice(1);
    if (!path) {
      throw new Error('--blocks file path cannot be empty');
    }
    try {
      source = await readFile(path, 'utf8');
    } catch (err: any) {
      throw new Error(`Cannot read blocks file ${path}: ${err.message}`);
    }
  }

  let blocks: unknown;
  try {
    blocks = JSON.parse(source);
  } catch (err: any) {
    throw new Error(`Invalid blocks JSON: ${err.message}`);
  }

  if (!Array.isArray(blocks)) {
    throw new Error('--blocks must contain a JSON array of Block Kit blocks');
  }
  for (const [index, block] of blocks.entries()) {
    if (
      typeof block !== 'object'
      || block === null
      || Array.isArray(block)
      || typeof (block as Record<string, unknown>).type !== 'string'
      || !(block as Record<string, unknown>).type
    ) {
      throw new Error(`Block at index ${index} must be an object with a non-empty string "type"`);
    }
  }

  return blocks as Array<Record<string, unknown>>;
}

// Resolve the message text from either --message or --message-file.
//
// Commander enforces the mutual exclusion, so this only has to cover the cases
// it cannot: neither flag given (--message can no longer be a requiredOption
// once --message-file can supply the same value), and a file that exists but
// carries nothing worth sending. Both must fail before any Slack call, so a
// bad invocation never half-posts.
export async function resolveMessageText(options: {
  message?: string;
  messageFile?: string;
}): Promise<string> {
  if (options.messageFile !== undefined) {
    const path = options.messageFile;
    if (!path) {
      throw new Error('--message-file path cannot be empty');
    }

    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (err: any) {
      throw new Error(`Cannot read message file ${path}: ${err.message}`);
    }

    if (!text.trim()) {
      throw new Error(`Message file ${path} is empty`);
    }
    return text;
  }

  if (options.message === undefined) {
    throw new Error('Either --message or --message-file is required');
  }
  return options.message;
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

// Warn when a pasted link points at a different workspace than the one we will call,
// rather than letting Slack answer with a misleading message_not_found.
function warnOnWorkspaceMismatch(client: SlackClient, linkWorkspace: string | undefined): void {
  const message = workspaceMismatchWarning(linkWorkspace, client.workspaceHost);
  if (message) warning(message);
}

export function createMessagesCommand(): Command {
  const messages = new Command('messages')
    .description('Send and manage messages');

  // Send message
  messages
    .command('send')
    .description('Send a message to a channel or user')
    .option('--recipient-id <id>', 'Channel ID, User ID, or Slack URL')
    .option('--message <text>', 'Message text content')
    .addOption(
      new Option('--message-file <path>', 'Read the message text from a UTF-8 file')
        .conflicts('message')
    )
    .option('--thread-ts <timestamp>', 'Send as reply to thread')
    .option('--permalink <url>', 'Slack message link; replies in that message\'s thread (replaces --recipient-id and --thread-ts)')
    .option('--file <path>', 'Attach a file to the message')
    .addOption(
      new Option('--blocks <json|@file>', 'Block Kit JSON array, inline or loaded from @file')
        .conflicts('file')
    )
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output the delivered message as JSON', false)
    .action(async (options) => {
      const spinner = ora('Sending message...').start();

      try {
        const message = await resolveMessageText(options);
        const target = resolveThreadTarget(
          { permalink: options.permalink, channelId: options.recipientId, threadTs: options.threadTs },
          { channel: '--recipient-id', timestamp: '--thread-ts' },
          'channel-or-user'
        );

        const client = await getAuthenticatedClient(options.workspace);
        warnOnWorkspaceMismatch(client, target.workspace);

        // Check if recipient is a user ID (starts with U) and needs DM opened
        let channelId = target.channelId;
        if (channelId.startsWith('U')) {
          spinner.text = 'Opening direct message...';
          const dmResponse = await client.openConversation(channelId);
          channelId = dmResponse.channel.id;
        }

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

        const blocks = options.blocks ? await parseBlocksInput(options.blocks) : undefined;
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
        spinner.fail('Failed to send message');
        error(err.message);
        process.exit(1);
      }
    });

  // Add reaction to message
  messages
    .command('react')
    .description('Add a reaction to a message')
    .option('--channel-id <id>', 'Channel ID or URL where the message is')
    .option('--timestamp <ts>', 'Message timestamp (1234567890.123456 or p1234567890123456)')
    .option('--permalink <url>', 'Slack message link (replaces --channel-id and --timestamp)')
    .requiredOption('--emoji <name>', 'Emoji name (e.g., thumbsup, heart, fire)')
    .option('--workspace <id|name>', 'Workspace to use')
    .action(async (options) => {
      const spinner = ora('Adding reaction...').start();

      try {
        const target = resolveMessageTarget(
          { permalink: options.permalink, channelId: options.channelId, timestamp: options.timestamp },
          { channel: '--channel-id', timestamp: '--timestamp' }
        );

        const client = await getAuthenticatedClient(options.workspace);
        warnOnWorkspaceMismatch(client, target.workspace);

        await client.addReaction(target.channelId, target.timestamp, options.emoji);

        spinner.succeed('Reaction added successfully!');
        success(`Added :${options.emoji}: to message ${target.timestamp}`);
      } catch (err: any) {
        spinner.fail('Failed to add reaction');
        error(err.message);
        process.exit(1);
      }
    });

  // Edit an existing message
  messages
    .command('edit')
    .description('Update the text of an existing message you posted')
    .option('--channel-id <id>', 'Channel ID or URL where the message is')
    .option('--timestamp <ts>', 'Message timestamp (1234567890.123456 or p1234567890123456)')
    .option('--permalink <url>', 'Slack message link (replaces --channel-id and --timestamp)')
    .option('--message <text>', 'New message text content')
    .addOption(
      new Option('--message-file <path>', 'Read the new message text from a UTF-8 file')
        .conflicts('message')
    )
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output the updated message as JSON', false)
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

        const response = await client.updateMessage(
          target.channelId,
          target.timestamp,
          message,
        );

        spinner.succeed('Message updated successfully!');
        if (options.json) {
          writeJson({ channel_id: target.channelId, ts: response.ts });
        } else {
          success(`Message timestamp: ${response.ts}`);
        }
      } catch (err: any) {
        spinner.fail('Failed to update message');
        error(err.message);
        process.exit(1);
      }
    });

  // Create draft message
  messages
    .command('draft')
    .description('Create a draft message in a channel or user. Note: Only works with Browser Session Tokens. Slack apps cannot create drafts.')
    .option('--recipient-id <id>', 'Channel ID, User ID, or Slack URL')
    .option('--message <text>', 'Message text content')
    .addOption(
      new Option('--message-file <path>', 'Read the message text from a UTF-8 file')
        .conflicts('message')
    )
    .option('--thread-ts <timestamp>', 'Create draft as reply to thread')
    .option('--permalink <url>', 'Slack message link; drafts a reply in that message\'s thread (replaces --recipient-id and --thread-ts)')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output the created draft as JSON', false)
    .action(async (options) => {
      const spinner = ora('Creating draft...').start();

      try {
        const message = await resolveMessageText(options);
        const target = resolveThreadTarget(
          { permalink: options.permalink, channelId: options.recipientId, threadTs: options.threadTs },
          { channel: '--recipient-id', timestamp: '--thread-ts' },
          'channel-or-user'
        );

        const client = await getAuthenticatedClient(options.workspace);
        warnOnWorkspaceMismatch(client, target.workspace);

        let channelId = target.channelId;
        if (channelId.startsWith('U')) {
          spinner.text = 'Opening direct message...';
          const dmResponse = await client.openConversation(channelId);
          channelId = dmResponse.channel.id;
        }

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
        spinner.fail('Failed to create draft');
        error(err.message);
        process.exit(1);
      }
    });

  return messages;
}
