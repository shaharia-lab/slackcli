import { Command } from 'commander';
import ora from 'ora';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { success, error } from '../lib/formatter.ts';

export function createMessagesCommand(): Command {
  const messages = new Command('messages')
    .description('Send and manage messages');

  // Send message
  messages
    .command('send')
    .description('Send a message to a channel or user')
    .requiredOption('--recipient-id <id>', 'Channel ID/name (C024BE91L, general, #general) or User ID (U...)')
    .requiredOption('--message <text>', 'Message text content')
    .option('--thread-ts <timestamp>', 'Send as reply to thread')
    .option('--workspace <id|name>', 'Workspace to use')
    .action(async (options) => {
      const spinner = ora('Sending message...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);

        let channelId = options.recipientId;

        // Check if recipient is a user ID (starts with U) and needs DM opened
        if (options.recipientId.startsWith('U')) {
          spinner.text = 'Opening direct message...';
          const dmResponse = await client.openConversation(options.recipientId);
          channelId = dmResponse.channel.id;
        } else {
          // Resolve channel name to ID if needed
          spinner.text = 'Resolving channel...';
          channelId = await client.resolveChannel(options.recipientId);
        }

        spinner.text = 'Sending message...';
        const response = await client.postMessage(channelId, options.message, {
          thread_ts: options.threadTs,
        });

        spinner.succeed('Message sent successfully!');
        success(`Message timestamp: ${response.ts}`);
      } catch (err: any) {
        spinner.fail('Failed to send message');
        error(err.message);
        process.exit(1);
      }
    });

  return messages;
}

