import { Command } from 'commander';
import ora, { type Ora } from 'ora';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { error, formatChannelList, formatConversationHistory } from '../lib/formatter.ts';
import { parseVttToText } from '../lib/vtt-parser.ts';
import type { SlackChannel, SlackMessage, SlackUser } from '../types/index.ts';
import type { SlackClient } from '../lib/slack-client.ts';

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
    .option('--workspace <id|name>', 'Workspace to use (overrides default)')
    .action(async (options) => {
      const spinner = ora('Fetching conversations...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);

        const response = await client.listConversations({
          types: options.types,
          limit: parseInt(options.limit),
          exclude_archived: options.excludeArchived,
        });

        const channels: SlackChannel[] = response.channels || [];

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
      } catch (err: any) {
        spinner.fail('Failed to fetch conversations');
        error(err.message, 'Run "slackcli auth list" to check your authentication.');
        process.exit(1);
      }
    });

  // Read conversation history
  conversations
    .command('read')
    .description('Read conversation history or specific thread (shows newest messages first by default)')
    .argument('<channel-id>', 'Channel ID to read from')
    .option('--thread-ts <timestamp>', 'Thread timestamp to read specific thread')
    .option('--exclude-replies', 'Exclude threaded replies (only top-level messages)', false)
    .option('--limit <number>', 'Number of messages to return', '20')
    .option('--oldest-first', 'Return messages oldest-first (default is newest-first)', false)
    .option('--oldest <timestamp>', 'Start of time range')
    .option('--latest <timestamp>', 'End of time range')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format (includes timestamps for replies)', false)
    .option('--include-transcripts', 'Include video transcripts in output', true)
    .option('--no-include-transcripts', 'Exclude video transcripts from output')
    .option('--include-threads', 'Expand and include thread replies inline', false)
    .action(async (channelId, options) => {
      const spinner = ora('Fetching messages...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);

        let response: any;
        let messages: SlackMessage[];

        if (options.threadTs) {
          // Fetch thread replies
          spinner.text = 'Fetching thread replies...';
          response = await client.getConversationReplies(channelId, options.threadTs, {
            limit: parseInt(options.limit),
            oldest: options.oldest,
            latest: options.latest,
          });
          messages = response.messages || [];
        } else {
          // Fetch conversation history
          spinner.text = 'Fetching conversation history...';
          response = await client.getConversationHistory(channelId, {
            limit: parseInt(options.limit),
            oldest: options.oldest,
            latest: options.latest,
          });
          messages = response.messages || [];

          // Filter out replies if requested
          if (options.excludeReplies) {
            messages = messages.filter(msg => !msg.thread_ts || msg.thread_ts === msg.ts);
          }
        }

        // Reverse to show oldest first (only if --oldest-first flag is set)
        if (options.oldestFirst) {
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

        // Fetch video transcripts if enabled
        if (options.includeTranscripts) {
          await fetchTranscriptsForMessages(client, messages, spinner);
        }

        // Fetch thread replies if enabled
        if (options.includeThreads) {
          await fetchThreadRepliesForMessages(client, channelId, messages, users, spinner);
        }

        spinner.succeed(`Found ${messages.length} messages`);

        // Output in JSON format if requested
        if (options.json) {
          const formatMessageForJson = (msg: SlackMessage) => ({
            ts: msg.ts,
            thread_ts: msg.thread_ts,
            user: msg.user,
            text: msg.text,
            type: msg.type,
            reply_count: msg.reply_count,
            is_thread_parent: (msg.reply_count ?? 0) > 0,
            reactions: msg.reactions,
            bot_id: msg.bot_id,
            files: msg.files,
            transcript: msg.transcript,
            thread_replies: msg.thread_replies?.map(formatMessageForJson) ?? null,
          });

          console.log(JSON.stringify({
            channel_id: channelId,
            message_count: messages.length,
            messages: messages.map(formatMessageForJson),
            users: Array.from(users.values()).map(u => ({
              id: u.id,
              name: u.name,
              real_name: u.real_name,
              email: u.profile?.email,
            })),
          }, null, 2));
        } else {
          console.log('\n' + formatConversationHistory(channelId, messages, users, options.includeThreads));
        }
      } catch (err: any) {
        spinner.fail('Failed to fetch messages');
        error(err.message);
        process.exit(1);
      }
    });

  return conversations;
}

// Fetch VTT transcripts for messages containing video files (mutates messages in place)
async function fetchTranscriptsForMessages(
  client: SlackClient,
  messages: SlackMessage[],
  spinner: Ora
): Promise<void> {
  const videosToFetch = messages.filter(
    msg => msg.files?.some(f => f.transcription?.status === 'complete' && f.vtt)
  );

  if (videosToFetch.length === 0) return;

  spinner.text = `Fetching transcripts for ${videosToFetch.length} video(s)...`;

  for (const msg of videosToFetch) {
    const transcripts: string[] = [];

    for (const file of msg.files || []) {
      if (file.transcription?.status === 'complete' && file.vtt) {
        try {
          const vttContent = await client.fetchFileContent(file.vtt);
          const text = parseVttToText(vttContent);
          if (text) transcripts.push(text);
        } catch (error) {
          // Skip failed transcripts
          console.error(`Failed to fetch transcript for file ${file.id}`);
        }
      }
    }

    if (transcripts.length > 0) {
      msg.transcript = transcripts.join('\n\n');
    }
  }
}

// Fetch thread replies for messages with threads (mutates messages in place)
async function fetchThreadRepliesForMessages(
  client: SlackClient,
  channelId: string,
  messages: SlackMessage[],
  users: Map<string, SlackUser>,
  spinner: Ora
): Promise<void> {
  const threadParents = messages.filter(msg => (msg.reply_count ?? 0) > 0);

  if (threadParents.length === 0) return;

  spinner.text = `Fetching replies for ${threadParents.length} thread(s)...`;

  for (const msg of threadParents) {
    try {
      const response = await client.getConversationReplies(channelId, msg.ts, {});
      const replies: SlackMessage[] = response.messages || [];

      // First message is the parent, rest are replies
      const threadReplies = replies.slice(1);

      // Collect user IDs from replies
      for (const reply of threadReplies) {
        if (reply.user && !users.has(reply.user)) {
          try {
            const userResponse = await client.getUserInfo(reply.user);
            if (userResponse.ok && userResponse.user) {
              users.set(reply.user, userResponse.user);
            }
          } catch (error) {
            console.error(`Failed to fetch user ${reply.user}`);
          }
        }
      }

      msg.thread_replies = threadReplies;
    } catch (error) {
      console.error(`Failed to fetch thread replies for message ${msg.ts}`);
    }
  }
}

