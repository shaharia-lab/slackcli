import chalk from 'chalk';
import { Command } from 'commander';
import ora from 'ora';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { error, formatChannelList, formatConversationHistory, formatUnreadChannels, warning, writeJson } from '../lib/formatter.ts';
import { fetchMessage } from '../lib/message.ts';
import { fetchUnreadChannels } from '../lib/unread.ts';
import {
  normalizeTimestamp,
  parseSlackLink,
  isSlackUrl,
  resolveMessageTarget,
  resolveThreadTarget,
  workspaceMismatchWarning,
} from '../lib/slack-url-parser.ts';
import type { SlackClient } from '../lib/slack-client.ts';
import type { SlackChannel, SlackMessage, SlackUser } from '../types/index.ts';

// Warn when a pasted link points at a different workspace than the one we will call,
// rather than letting Slack answer with a misleading message_not_found.
function warnOnWorkspaceMismatch(client: SlackClient, linkWorkspace: string | undefined): void {
  const message = workspaceMismatchWarning(linkWorkspace, client.workspaceHost);
  if (message) warning(message);
}

// A channel argument is either a raw channel/conversation ID or a Slack link
// (/archives/<channel>) — reuse the existing permalink parser for the link form
// so `members list` accepts the same channel inputs as `read`/`get`.
function resolveChannelArg(input: string): { channelId: string; workspace: string | undefined } {
  if (isSlackUrl(input)) {
    const parsed = parseSlackLink(input);
    return { channelId: parsed.channelId, workspace: parsed.workspace };
  }
  return { channelId: input, workspace: undefined };
}

// True when a Slack error is the enterprise-grid member-enumeration block.
// conversations.members returns enterprise_is_restricted on a grid regardless of
// team scoping; the request wrapper prefixes it with "Slack API error:".
function isEnterpriseRestricted(err: any): boolean {
  return typeof err?.message === 'string' && err.message.includes('enterprise_is_restricted');
}

export function createConversationsCommand(): Command {
  const conversations = new Command('conversations')
    .description('Manage Slack conversations (channels, DMs, groups)');

  // List conversations
  conversations
    .command('list')
    .description('List all conversations')
    .option('--types <types>', 'Conversation types (comma-separated: public_channel,private_channel,mpim,im)', 'public_channel,private_channel,mpim,im')
    .option('--limit <number>', 'Number of conversations to return', '100')
    .option('--exclude-archived', 'Exclude archived conversations', false)
    .option('--cursor <cursor>', 'Pagination cursor for next page of results')
    .option('--workspace <id|name>', 'Workspace to use (overrides default)')
    .action(async (options) => {
      const spinner = ora('Fetching conversations...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);

        const response = await client.listConversations({
          types: options.types,
          limit: parseInt(options.limit),
          exclude_archived: options.excludeArchived,
          ...(options.cursor ? { cursor: options.cursor } : {}),
        });

        const channels: SlackChannel[] = response.channels || [];
        const nextCursor = response.response_metadata?.next_cursor;

        // Fetch user info for DMs
        const userIds = new Set<string>();
        channels.forEach(ch => {
          if (ch.is_im && ch.user) {
            userIds.add(ch.user);
          }
        });

        const users = new Map<string, SlackUser>();
        if (userIds.size > 0) {
          spinner.text = 'Fetching user information...';
          const usersResponse = await client.getUsersInfo(Array.from(userIds));
          usersResponse.users?.forEach((user: SlackUser) => {
            users.set(user.id, user);
          });
        }

        spinner.succeed(`Found ${channels.length} conversations`);

        console.log('\n' + formatChannelList(channels, users));

        if (nextCursor) {
          console.log(chalk.dim('\nMore results available. Next page:'));
          console.log(chalk.cyan(`  slackcli conversations list --cursor "${nextCursor}"\n`));
        }
      } catch (err: any) {
        spinner.fail('Failed to fetch conversations');
        error(err.message, 'Run "slackcli auth list" to check your authentication.');
        process.exit(1);
      }
    });

  // Read conversation history
  conversations
    .command('read')
    .description('Read conversation history or specific thread')
    .argument('[channel-id]', 'Channel ID or Slack URL to read from')
    .option('--thread-ts <timestamp>', 'Thread timestamp to read specific thread')
    .option('--permalink <url>', 'Slack link; reads that channel, or that message\'s thread (replaces <channel-id> and --thread-ts)')
    .option('--exclude-replies', 'Exclude threaded replies (only top-level messages)', false)
    .option('--limit <number>', 'Number of messages to return', '100')
    .option('--oldest <timestamp>', 'Start of time range')
    .option('--latest <timestamp>', 'End of time range')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format (includes timestamps for replies)', false)
    .action(async (channelIdArg, options) => {
      const spinner = ora('Fetching messages...').start();

      try {
        const target = resolveThreadTarget(
          { permalink: options.permalink, channelId: channelIdArg, threadTs: options.threadTs },
          { channel: '<channel-id>', timestamp: '--thread-ts' }
        );
        const channelId = target.channelId;
        const oldest = options.oldest ? normalizeTimestamp(options.oldest, '--oldest') : undefined;
        const latest = options.latest ? normalizeTimestamp(options.latest, '--latest') : undefined;

        const client = await getAuthenticatedClient(options.workspace);
        warnOnWorkspaceMismatch(client, target.workspace);

        let response: any;
        let messages: SlackMessage[];

        if (target.threadTs) {
          // Fetch thread replies
          spinner.text = 'Fetching thread replies...';
          response = await client.getConversationReplies(channelId, target.threadTs, {
            limit: parseInt(options.limit),
            oldest,
            latest,
          });
          messages = response.messages || [];
        } else {
          // Fetch conversation history
          spinner.text = 'Fetching conversation history...';
          response = await client.getConversationHistory(channelId, {
            limit: parseInt(options.limit),
            oldest,
            latest,
          });
          messages = response.messages || [];

          // Filter out replies if requested
          if (options.excludeReplies) {
            messages = messages.filter(msg => !msg.thread_ts || msg.thread_ts === msg.ts);
          }
        }

        // Channel history returns newest first, so reverse to show oldest first.
        // Thread replies already come in chronological order.
        if (!target.threadTs) {
          messages.reverse();
        }

        // Fetch user info for messages
        const userIds = new Set<string>();
        messages.forEach(msg => {
          if (msg.user) {
            userIds.add(msg.user);
          }
        });

        const users = new Map<string, SlackUser>();
        if (userIds.size > 0) {
          spinner.text = 'Fetching user information...';
          const usersResponse = await client.getUsersInfo(Array.from(userIds));
          usersResponse.users?.forEach((user: SlackUser) => {
            users.set(user.id, user);
          });
        }

        spinner.succeed(`Found ${messages.length} messages`);

        // Output in JSON format if requested
        if (options.json) {
          writeJson({
            channel_id: channelId,
            message_count: messages.length,
            messages: messages.map(msg => ({
              ts: msg.ts,
              thread_ts: msg.thread_ts,
              user: msg.user,
              text: msg.text,
              type: msg.type,
              reply_count: msg.reply_count,
              reactions: msg.reactions,
              bot_id: msg.bot_id,
              blocks: msg.blocks,
              attachments: msg.attachments,
              ...(msg.files?.length ? { files: msg.files.map(f => ({
                id: f.id,
                name: f.name,
                title: f.title,
                mimetype: f.mimetype,
                filetype: f.filetype,
                size: f.size,
                url_private: f.url_private,
                permalink: f.permalink,
                mode: f.mode,
              })) } : {}),
            })),
            users: Array.from(users.values()).map(u => ({
              id: u.id,
              name: u.name,
              real_name: u.real_name,
              email: u.profile?.email,
            })),
          });
        } else {
          console.log('\n' + formatConversationHistory(channelId, messages, users));
        }
      } catch (err: any) {
        spinner.fail('Failed to fetch messages');
        error(err.message);
        process.exit(1);
      }
    });

  // Get a single message by channel + timestamp
  conversations
    .command('get')
    .description('Get a specific message by channel ID and timestamp')
    .argument('[channel-id]', 'Channel ID or Slack URL')
    .argument('[timestamp]', 'Message timestamp (1234567890.123456 or p1234567890123456)')
    .option('--permalink <url>', 'Slack message link (replaces <channel-id> and <timestamp>)')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (channelIdArg, timestampArg, options) => {
      const spinner = ora('Fetching message...').start();

      try {
        const target = resolveMessageTarget(
          { permalink: options.permalink, channelId: channelIdArg, timestamp: timestampArg },
          { channel: '<channel-id>', timestamp: '<timestamp>' }
        );
        const channelId = target.channelId;

        const client = await getAuthenticatedClient(options.workspace);
        warnOnWorkspaceMismatch(client, target.workspace);

        const msg = await fetchMessage(client, channelId, target.timestamp);

        if (!msg) {
          spinner.fail('Message not found');
          process.exit(1);
        }

        // Fetch user info
        const users = new Map<string, SlackUser>();
        if (msg.user) {
          spinner.text = 'Fetching user information...';
          try {
            const userResponse = await client.getUserInfo(msg.user);
            if (userResponse.user) {
              users.set(userResponse.user.id, userResponse.user);
            }
          } catch {
            // Continue without user info
          }
        }

        spinner.succeed('Message found');

        if (options.json) {
          writeJson({
            channel_id: channelId,
            message: {
              ts: msg.ts,
              thread_ts: msg.thread_ts,
              user: msg.user,
              text: msg.text,
              type: msg.type,
              reply_count: msg.reply_count,
              reactions: msg.reactions,
              bot_id: msg.bot_id,
              blocks: msg.blocks,
              ...(msg.files?.length ? { files: msg.files.map(f => ({
                id: f.id,
                name: f.name,
                title: f.title,
                mimetype: f.mimetype,
                filetype: f.filetype,
                size: f.size,
                url_private: f.url_private,
                permalink: f.permalink,
                mode: f.mode,
              })) } : {}),
            },
            users: Array.from(users.values()).map(u => ({
              id: u.id,
              name: u.name,
              real_name: u.real_name,
              email: u.profile?.email,
            })),
          });
        } else {
          console.log('\n' + formatConversationHistory(channelId, [msg], users));
        }
      } catch (err: any) {
        spinner.fail('Failed to fetch message');
        error(err.message);
        process.exit(1);
      }
    });

  // List unread conversations
  conversations
    .command('unread')
    .description('List conversations with unread messages')
    .option('--types <types>', 'Filter by type (comma-separated: channels,dms,groups)')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (options) => {
      const spinner = ora('Fetching unread counts...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);

        let channels = await fetchUnreadChannels(client, {
          onProgress: (msg) => { spinner.text = msg; },
        });

        // Apply type filter if specified
        if (options.types) {
          const types = options.types.split(',').map((t: string) => t.trim());
          channels = channels.filter(ch => {
            if (types.includes('channels') && !ch.is_im && !ch.is_mpim) return true;
            if (types.includes('dms') && ch.is_im) return true;
            if (types.includes('groups') && ch.is_mpim) return true;
            return false;
          });
        }

        if (channels.length === 0) {
          spinner.succeed('All caught up! No unread messages.');
          return;
        }

        spinner.succeed(`${channels.length} conversations with unread messages`);

        if (options.json) {
          writeJson({ unread_channels: channels });
          return;
        }

        console.log('\n' + formatUnreadChannels(channels));
      } catch (err: any) {
        spinner.fail('Failed to fetch unread conversations');
        error(err.message);
        process.exit(1);
      }
    });

  // Channel membership (read-only). The write/self operations
  // (members add/remove, join/leave) are a separate follow-up PR.
  const members = conversations
    .command('members')
    .description('Inspect channel membership');

  // List the members of a channel/conversation
  members
    .command('list')
    .description('List the members of a channel or conversation')
    .argument('<channel>', 'Channel ID or Slack link (/archives/<channel>)')
    .option('--limit <number>', 'Maximum number of members to return', '100')
    .option('--cursor <cursor>', 'Pagination cursor for next page of results')
    .option('--workspace <id|name>', 'Workspace to use (overrides default)')
    .option('--json', 'Output in JSON format', false)
    .action(async (channelArg, options) => {
      const spinner = ora('Fetching members...').start();

      try {
        const { channelId, workspace } = resolveChannelArg(channelArg);
        const limit = parseInt(options.limit);

        const client = await getAuthenticatedClient(options.workspace);
        warnOnWorkspaceMismatch(client, workspace);

        // Page until we have `limit` members or run out of pages, so --limit
        // reflects members RETURNED (consistent with the CLI's other --limit flags).
        const memberIds: string[] = [];
        let cursor: string | undefined = options.cursor;

        while (memberIds.length < limit) {
          const response: any = await client.getConversationMembers(channelId, {
            limit: Math.min(limit - memberIds.length, 1000),
            ...(cursor ? { cursor } : {}),
          });
          const page: string[] = response.members || [];
          memberIds.push(...page);
          cursor = response.response_metadata?.next_cursor || undefined;
          if (!cursor) break;
        }

        const trimmed = memberIds.slice(0, limit);
        // If Slack handed back a cursor on the last page, more members remain.
        const nextCursor = cursor;

        spinner.succeed(`Found ${trimmed.length} members`);

        if (options.json) {
          writeJson({
            channel_id: channelId,
            member_count: trimmed.length,
            members: trimmed,
            ...(nextCursor ? { next_cursor: nextCursor } : {}),
          });
          return;
        }

        console.log('');
        console.log(chalk.bold(`👥 Members of ${channelId} (${trimmed.length})`));
        trimmed.forEach((id) => console.log(`  ${id}`));

        if (nextCursor) {
          console.log(chalk.dim('\nMore results available. Next page:'));
          console.log(chalk.cyan(`  slackcli conversations members list ${channelId} --cursor "${nextCursor}"\n`));
        }
      } catch (err: any) {
        // Honest degradation: on an enterprise grid, conversations.members is
        // enterprise-policy-blocked (and --team does NOT lift it). Surface it
        // clearly with a non-zero exit rather than hiding the command or faking success.
        if (isEnterpriseRestricted(err)) {
          spinner.fail('Member enumeration is restricted on this workspace');
          error(
            'Slack returned enterprise_is_restricted: listing channel members is blocked by this Enterprise Grid\'s policy.',
            'This is an org-level restriction; scoping to a team does not lift it. Ask a workspace admin if you need member enumeration.',
          );
          process.exit(1);
        }
        spinner.fail('Failed to fetch members');
        error(err.message, 'Run "slackcli auth list" to check your authentication.');
        process.exit(1);
      }
    });

  return conversations;
}
