import { Command } from 'commander';
import ora from 'ora';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { success, error, warning } from '../lib/formatter.ts';
import {
  resolveMessageTarget,
  resolveThreadTarget,
  workspaceMismatchWarning,
} from '../lib/slack-url-parser.ts';
import type { SlackClient } from '../lib/slack-client.ts';

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
    .requiredOption('--message <text>', 'Message text content')
    .option('--thread-ts <timestamp>', 'Send as reply to thread')
    .option('--permalink <url>', 'Slack message link; replies in that message\'s thread (replaces --recipient-id and --thread-ts)')
    .option('--file <path>', 'Attach a file to the message')
    .option('--workspace <id|name>', 'Workspace to use')
    .action(async (options) => {
      const spinner = ora('Sending message...').start();

      try {
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
          await client.uploadFileExternal(channelId, options.file, {
            initial_comment: options.message,
            thread_ts: target.threadTs,
          });

          spinner.succeed('Message sent successfully!');
          success('File uploaded successfully');
          return;
        }

        const response = await client.postMessage(channelId, options.message, {
          thread_ts: target.threadTs,
        });

        spinner.succeed('Message sent successfully!');
        success(`Message timestamp: ${response.ts}`);
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
    .requiredOption('--message <text>', 'New message text content')
    .option('--workspace <id|name>', 'Workspace to use')
    .action(async (options) => {
      const spinner = ora('Updating message...').start();

      try {
        const target = resolveMessageTarget(
          { permalink: options.permalink, channelId: options.channelId, timestamp: options.timestamp },
          { channel: '--channel-id', timestamp: '--timestamp' }
        );

        const client = await getAuthenticatedClient(options.workspace);
        warnOnWorkspaceMismatch(client, target.workspace);

        const response = await client.updateMessage(
          target.channelId,
          target.timestamp,
          options.message,
        );

        spinner.succeed('Message updated successfully!');
        success(`Message timestamp: ${response.ts}`);
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
    .requiredOption('--message <text>', 'Message text content')
    .option('--thread-ts <timestamp>', 'Create draft as reply to thread')
    .option('--permalink <url>', 'Slack message link; drafts a reply in that message\'s thread (replaces --recipient-id and --thread-ts)')
    .option('--workspace <id|name>', 'Workspace to use')
    .action(async (options) => {
      const spinner = ora('Creating draft...').start();

      try {
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
        const response = await client.createDraft(channelId, options.message, {
          thread_ts: target.threadTs,
        });

        spinner.succeed('Draft created successfully!');
        success(`Draft ID: ${response.draft.id}`);
      } catch (err: any) {
        spinner.fail('Failed to create draft');
        error(err.message);
        process.exit(1);
      }
    });

  return messages;
}
