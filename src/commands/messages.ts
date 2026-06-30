import { Command } from 'commander';
import ora from 'ora';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { success, error, formatMessage } from '../lib/formatter.ts';
import { runSlashCommand } from '../lib/slash-command-runner.ts';
import { resolveRecipientChannel } from '../lib/recipient.ts';
import type { SlackUser } from '../types/index.ts';

export function createMessagesCommand(): Command {
  const messages = new Command('messages')
    .description('Send and manage messages');

  // Send message
  messages
    .command('send')
    .description('Send a message to a channel or user')
    .requiredOption('--recipient-id <id>', 'Channel ID or User ID')
    .requiredOption('--message <text>', 'Message text content')
    .option('--thread-ts <timestamp>', 'Send as reply to thread')
    .option('--file <path>', 'Attach a file to the message')
    .option('--workspace <id|name>', 'Workspace to use')
    .action(async (options) => {
      const spinner = ora('Sending message...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);

        if (options.recipientId.startsWith('U')) spinner.text = 'Opening direct message...';
        const channelId = await resolveRecipientChannel(client, options.recipientId);

        spinner.text = 'Sending message...';
        if (options.file) {
          await client.uploadFileExternal(channelId, options.file, {
            initial_comment: options.message,
            thread_ts: options.threadTs,
          });

          spinner.succeed('Message sent successfully!');
          success('File uploaded successfully');
          return;
        }

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

  // Add reaction to message
  messages
    .command('react')
    .description('Add a reaction to a message')
    .requiredOption('--channel-id <id>', 'Channel ID where the message is')
    .requiredOption('--timestamp <ts>', 'Message timestamp')
    .requiredOption('--emoji <name>', 'Emoji name (e.g., thumbsup, heart, fire)')
    .option('--workspace <id|name>', 'Workspace to use')
    .action(async (options) => {
      const spinner = ora('Adding reaction...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);

        await client.addReaction(options.channelId, options.timestamp, options.emoji);

        spinner.succeed('Reaction added successfully!');
        success(`Added :${options.emoji}: to message ${options.timestamp}`);
      } catch (err: any) {
        spinner.fail('Failed to add reaction');
        error(err.message);
        process.exit(1);
      }
    });

  // Create draft message
  messages
    .command('draft')
    .description('Create a draft message in a channel or user. Note: Only works with Browser Session Tokens. Slack apps cannot create drafts.')
    .requiredOption('--recipient-id <id>', 'Channel ID or User ID')
    .requiredOption('--message <text>', 'Message text content')
    .option('--thread-ts <timestamp>', 'Create draft as reply to thread')
    .option('--workspace <id|name>', 'Workspace to use')
    .action(async (options) => {
      const spinner = ora('Creating draft...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);

        if (options.recipientId.startsWith('U')) spinner.text = 'Opening direct message...';
        const channelId = await resolveRecipientChannel(client, options.recipientId);

        spinner.text = 'Creating draft...';
        const response = await client.createDraft(channelId, options.message, {
          thread_ts: options.threadTs,
        });

        spinner.succeed('Draft created successfully!');
        success(`Draft ID: ${response.draft.id}`);
      } catch (err: any) {
        spinner.fail('Failed to create draft');
        error(err.message);
        process.exit(1);
      }
    });

  // Execute slash command and capture ephemeral reply
  messages
    .command('command')
    .description('Execute a slash command and capture the ephemeral reply (browser auth only)')
    .requiredOption('--recipient-id <id>', 'Channel ID or User ID where command is issued')
    .requiredOption('--command <slash>', 'Slash command including leading slash, e.g. /genie')
    .option('--text <text>', 'Argument text for the command', '')
    .option('--timeout <seconds>', 'Collection window: seconds to keep listening for ephemeral replies after the command is invoked', '15')
    .option('--max-events <n>', 'Optional early-exit cap. Stop after N ephemeral frames instead of waiting the full --timeout window.')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output captured events as JSON', false)
    .action(async (options) => {
      const spinner = ora('Preparing command...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);

        if (client.authType !== 'browser') {
          spinner.fail('Slash command execution requires browser authentication');
          error('Use `slackcli auth login-browser` to add a browser-auth workspace.');
          process.exit(1);
        }

        if (options.recipientId.startsWith('U')) spinner.text = 'Opening direct message...';
        const channelId = await resolveRecipientChannel(client, options.recipientId);

        const timeoutSeconds = parseInt(options.timeout, 10);
        if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1) {
          spinner.fail(`Invalid --timeout value: ${options.timeout}`);
          error('--timeout must be a positive integer (seconds).');
          process.exit(1);
        }

        let maxEvents: number | undefined;
        if (options.maxEvents !== undefined) {
          maxEvents = parseInt(options.maxEvents, 10);
          if (!Number.isFinite(maxEvents) || maxEvents < 1) {
            spinner.fail(`Invalid --max-events value: ${options.maxEvents}`);
            error('--max-events must be a positive integer.');
            process.exit(1);
          }
        }

        spinner.text = 'Connecting to Slack real-time gateway...';
        const { url, headers, self } = await client.rtmConnect();

        const clientToken = crypto.randomUUID();

        spinner.text = `Executing ${options.command}...`;
        const { messages: captured, timedOut } = await runSlashCommand({
          rtm: { url, headers, selfUserId: self?.id },
          channelId,
          clientToken,
          timeoutMs: timeoutSeconds * 1000,
          maxEvents,
          invokeCommand: () => client.executeSlashCommand(
            channelId,
            options.command,
            options.text || '',
            clientToken,
          ),
        });

        if (captured.length > 0) {
          spinner.succeed(`Captured ${captured.length} event(s) in ${timeoutSeconds}s window`);
        } else {
          spinner.succeed(`Timed out after ${timeoutSeconds}s — no ephemeral reply received`);
        }

        if (options.json) {
          console.log(JSON.stringify({
            channel_id: channelId,
            command: options.command,
            text: options.text || '',
            timed_out: timedOut,
            messages: captured,
          }, null, 2));
          return;
        }

        if (captured.length === 0) {
          error('No ephemeral reply captured. The command may reply asynchronously beyond the timeout window, or it may not respond ephemerally.');
          process.exit(2);
        }

        const userIds = [...new Set(captured.map(m => m.user).filter((u): u is string => !!u))];
        const users = new Map<string, SlackUser>();
        await Promise.allSettled(userIds.map(async (id) => {
          const resp = await client.getUserInfo(id);
          if (resp?.user) users.set(resp.user.id, resp.user);
        }));

        for (const msg of captured) {
          console.log(formatMessage(msg, users));
        }
      } catch (err: any) {
        spinner.fail('Failed to execute slash command');
        error(err.message);
        process.exit(1);
      }
    });

  return messages;
}
