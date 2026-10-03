import chalk from 'chalk';
import { Command } from 'commander';
import ora from 'ora';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { formatChannelList, formatConversationHistory, formatUnreadChannels, warning, writeJson } from '../lib/formatter.ts';
import { CHANNEL_NAME_NOTE, describeCommand, USER_NAME_NOTE, type CommandHelp } from '../lib/help.ts';
import { fetchMessage } from '../lib/message.ts';
import { fetchUnreadChannels } from '../lib/unread.ts';
import { processReadPage, resolveSelfIdentity } from '../lib/poll.ts';
import { confirmWrite, splitUserRefs } from './usergroups.ts';
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
import { failCommand } from '../lib/command-errors.ts';
import { InvalidInputError, NotFoundError } from '../lib/cli-errors.ts';
import { resolveIdentifier, resolveUserList } from '../lib/name-resolver.ts';

// Help text shared by several commands below.
const CHANNEL_ARG_NOTE =
  '<channel> accepts a channel ID, a Slack channel link (/archives/<channel>) or a channel name.';
const USER_REFS_NOTE =
  '<users...> are user IDs, @handles or email addresses, comma- or space-separated; a leading @ on an ID is ignored.';
const TEAM_NOTE =
  '--team <workspace-id> (T0123456789) scopes the call to one workspace of an Enterprise Grid org.';

// --help content, kept apart from the command chains below (#324).
const HELP = {
  group: {
    summary: 'Read and manage channels, DMs and group DMs',
    description:
      'Read and manage Slack conversations: channels, DMs and group DMs. List them, read history ' +
      'or one thread, fetch a single message, see what is unread, and manage membership.',
  },
  list: {
    summary: 'List the conversations you can see',
    description:
      'List channels, private channels, DMs and group DMs, one page at a time. Use it to find a ' +
      'channel ID; use "conversations unread" for only the ones with unread messages.',
    examples: [
      'slackcli conversations list',
      'slackcli conversations list --types im --exclude-archived',
      'slackcli conversations list --limit 200 --json',
      'slackcli conversations list --cursor "dXNlcjpVMDYxTkZUVDI=" --json',
    ],
    json:
      '{ conversation_count, conversations: [{ id, name, user, is_channel, is_group, is_im, is_mpim, ' +
      'is_private, is_archived, is_member, num_members, topic, purpose }], users: [{ id, name, real_name, ' +
      'email }], next_cursor } — users resolves the other person of each DM; next_cursor is null on the last page.',
    notes: [
      'One page per call. Pass next_cursor back as --cursor for the next page (the human output prints that command).',
      '--types values: public_channel, private_channel, mpim (group DM), im (DM).',
    ],
  },
  read: {
    summary: 'Read channel history or one thread',
    description:
      'Read the recent messages of a channel, DM or group DM, oldest first, or up to --limit messages ' +
      'of one thread (one page, parent included; has_more says when it was cut off). Use "conversations get" for a single message. Safe to poll: pass next_oldest back as --oldest.',
    examples: [
      'slackcli conversations read C0123456789 --limit 20',
      'slackcli conversations read general --limit 20 --json',
      'slackcli conversations read C0123456789 --thread-ts 1712345678.123456',
      'slackcli conversations read --permalink https://acme.slack.com/archives/C0123456789/p1712345678123456 --json',
      'slackcli conversations read C0123456789 --oldest 1712345678.123456 --exclude-self --json',
    ],
    json:
      '{ channel_id, message_count, next_oldest, has_more, messages: [{ ts, thread_ts, user, text, type, ' +
      'reply_count, reactions, bot_id, blocks, attachments, files? }], users: [{ id, name, real_name, email }] }.',
    notes: [
      'Give either <channel-id> (a channel ID, Slack URL or channel name), optionally with --thread-ts, or ' +
        '--permalink alone; combining --permalink with either is an error.',
      CHANNEL_NAME_NOTE,
      '--permalink with a channel link reads the channel; with a message link it reads that message\'s thread ' +
        '(the parent thread when the link points at a reply).',
      'Timestamps (--thread-ts, --oldest, --latest): 1712345678.123456, p1712345678123456, 1712345678123456, ' +
        'or epoch seconds for --oldest/--latest.',
      'Only messages strictly newer than --oldest are shown. next_oldest is the newest ts Slack returned ' +
        '(before --exclude-* filters); has_more means more messages exist in the range than --limit returned.',
    ],
  },
  get: {
    summary: 'Fetch one message by channel and timestamp',
    description:
      'Fetch a single message by its channel and timestamp, or from its Slack link. Use ' +
      '"conversations read" for a channel\'s history or a thread.',
    examples: [
      'slackcli conversations get C0123456789 1712345678.123456',
      'slackcli conversations get C0123456789 p1712345678123456 --json',
      'slackcli conversations get --permalink https://acme.slack.com/archives/C0123456789/p1712345678123456 --json',
    ],
    json:
      '{ channel_id, message: { ts, thread_ts, user, text, type, reply_count, reactions, bot_id, blocks, files? }, ' +
      'users: [{ id, name, real_name, email }] }.',
    notes: [
      'Give <channel-id> and <timestamp>, or --permalink alone; combining them is an error. ' +
        '<channel-id> accepts a channel ID, a Slack URL or a channel name.',
      CHANNEL_NAME_NOTE,
      'Browser auth finds top-level messages and thread replies. An app token (xoxb/xoxp) finds only top-level ' +
        'messages; for a reply, use "conversations read <channel> --thread-ts <parent>".',
      'Exits 1 with "Message not found" when nothing matches.',
    ],
  },
  unread: {
    summary: 'List conversations with unread messages',
    description:
      'List the conversations that have unread messages or mentions, mentions first, then by name. ' +
      'Use "conversations read" to read one of them.',
    examples: [
      'slackcli conversations unread',
      'slackcli conversations unread --types dms,groups',
      'slackcli conversations unread --json',
    ],
    json:
      '{ unread_channels: [{ id, name, mention_count, has_unreads, unread_count?, is_im, is_mpim, is_private }] } ' +
      '— unread_count only with an app token.',
    notes: [
      'Browser auth reads Slack\'s own unread state (client.counts), then looks up each channel\'s name: ' +
        'one or two calls per unread conversation (a DM also looks up the user), so many unreads can hit rate limits.',
      'An app token (xoxb/xoxp) reads the first 1000 conversations from conversations.list and keeps the ones ' +
        'you are a member of that Slack reports unread counts for; Slack often omits those counts, so results can be incomplete.',
      'When nothing is unread it prints "All caught up!" on stderr and writes nothing to stdout, even with --json.',
      '--types values: channels (public and private), dms, groups (group DMs).',
    ],
  },
  members: {
    summary: 'List, add and remove channel members',
    description:
      'Inspect and manage who is in a channel. "list" is read-only; "add" and "remove" change other ' +
      'people\'s membership. To change your own, use "conversations join" or "conversations leave".',
  },
  membersList: {
    summary: 'List the member IDs of a channel',
    description:
      'List the user IDs of the members of a channel or conversation. Use "users info" to turn an ID into a name.',
    examples: [
      'slackcli conversations members list C0123456789',
      'slackcli conversations members list https://acme.slack.com/archives/C0123456789 --limit 50 --json',
      'slackcli conversations members list C0123456789 --cursor "dXNlcjpVMDYxTkZUVDI=" --json',
    ],
    json:
      '{ channel_id, member_count, members: [user IDs], next_cursor? } — next_cursor is present only when more members remain.',
    notes: [
      CHANNEL_ARG_NOTE,
      CHANNEL_NAME_NOTE,
      '--limit counts members returned: it pages until it has that many or runs out. Pass next_cursor back as --cursor for more.',
      'On an Enterprise Grid org, Slack may block this with enterprise_is_restricted; the command exits 1.',
    ],
  },
  membersAdd: {
    summary: 'Add users or apps to a channel',
    description:
      'Add one or more users (or agents/apps) to a channel. All or nothing: if Slack cannot add any one ' +
      'of them, none are added and the command exits 1.',
    examples: [
      'slackcli conversations members add C0123456789 U0123456789',
      'slackcli conversations members add C0123456789 U0123456789,U0123456780 --yes',
      'slackcli conversations members add https://acme.slack.com/archives/C0123456789 U0123456789 --yes --json',
    ],
    json: '{ channel_id, added: [user IDs] }.',
    confirms: true,
    notes: [
      CHANNEL_ARG_NOTE,
      USER_REFS_NOTE,
      CHANNEL_NAME_NOTE,
      USER_NAME_NOTE,
      TEAM_NOTE,
    ],
  },
  membersRemove: {
    summary: 'Remove users from a channel',
    description:
      'Remove one or more users from a channel. Best effort: each ID is tried in turn; failures are listed, ' +
      'and --json lists the removed IDs too. Exits 1 if any removal failed.',
    examples: [
      'slackcli conversations members remove C0123456789 U0123456789',
      'slackcli conversations members remove C0123456789 U0123456789 U0123456780 --yes',
      'slackcli conversations members remove C0123456789 U0123456789 --yes --json',
    ],
    json: '{ channel_id, removed: [user IDs], failed: [{ user, error }] }.',
    confirms: true,
    notes: [
      CHANNEL_ARG_NOTE,
      USER_REFS_NOTE,
      CHANNEL_NAME_NOTE,
      USER_NAME_NOTE,
      TEAM_NOTE,
    ],
  },
  join: {
    summary: 'Join a public channel as yourself',
    description:
      'Join a public channel as the authenticated user (or bot). Use "conversations members add" to add someone else.',
    examples: [
      'slackcli conversations join C0123456789',
      'slackcli conversations join https://acme.slack.com/archives/C0123456789 --json',
    ],
    json: '{ channel_id, channel } — channel is Slack\'s channel object, or null.',
    notes: [
      'Acts immediately, with no confirmation prompt. Joining a channel you are already in is a no-op.',
      CHANNEL_ARG_NOTE,
      CHANNEL_NAME_NOTE,
    ],
  },
  leave: {
    summary: 'Leave a channel or conversation as yourself',
    description:
      'Leave a channel or conversation as the authenticated user (or bot). Use "conversations members remove" ' +
      'to remove someone else.',
    examples: [
      'slackcli conversations leave C0123456789',
      'slackcli conversations leave https://acme.slack.com/archives/C0123456789 --yes --json',
    ],
    json: '{ channel_id, left, not_in_channel } — not_in_channel is true (and left false) when you were not a member.',
    confirms: true,
    notes: [
      CHANNEL_ARG_NOTE,
      CHANNEL_NAME_NOTE,
      'Leaving a channel you are not in is reported as a no-op, not an error.',
    ],
  },
} satisfies Record<string, CommandHelp>;

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

// A channel argument may also be a channel name (#general or general). Resolve
// it to an ID; an ID or a link makes no Slack call.
function resolveChannelName(
  client: SlackClient,
  raw: string | undefined,
  id: string,
  spinner: ReturnType<typeof ora>,
): Promise<string> {
  return resolveIdentifier(client, raw, id, 'channel', '<channel>', {
    onProgress: (text) => { spinner.text = text; },
  });
}

// Resolve the <channel> and <users...> of a membership write before its
// confirmation prompt, so the prompt and the call name the same IDs. A client
// is created here only when a name needs a lookup; otherwise the write path
// (and its no-auth confirmation refusal) is unchanged.
async function resolveMembershipTargets(
  channelArg: string,
  users: string[],
  options: { workspace?: string },
): Promise<{ channelId: string; workspace: string | undefined; ids: string[]; client?: SlackClient }> {
  const parsed = resolveChannelArg(channelArg);
  let client: SlackClient | undefined;
  const lazyClient = async (): Promise<SlackClient> => {
    client ??= await getAuthenticatedClient(options.workspace);
    return client;
  };
  const channelId = await resolveIdentifier(lazyClient, channelArg, parsed.channelId, 'channel', '<channel>');
  const ids = await resolveUserList(lazyClient, splitUserRefs(users), '<users...>');
  return { channelId, workspace: parsed.workspace, ids, client };
}

// True when a Slack error is the enterprise-grid member-enumeration block.
// conversations.members returns enterprise_is_restricted on a grid regardless of
// team scoping; the request wrapper prefixes it with "Slack API error:".
function isEnterpriseRestricted(err: any): boolean {
  return typeof err?.message === 'string' && err.message.includes('enterprise_is_restricted');
}

export function createConversationsCommand(): Command {
  const conversations = describeCommand(new Command('conversations'), HELP.group);

  // List conversations
  describeCommand(conversations.command('list'), HELP.list)
    .option('--types <types>', 'Conversation types (comma-separated: public_channel,private_channel,mpim,im)', 'public_channel,private_channel,mpim,im')
    .option('--limit <number>', 'Number of conversations to return', '100')
    .option('--exclude-archived', 'Exclude archived conversations', false)
    .option('--cursor <cursor>', 'Pagination cursor for next page of results')
    .option('--workspace <id|name>', 'Workspace to use (overrides default)')
    .option('--json', 'Output in JSON format', false)
    .action(async (options) => {
      const spinner = ora('Fetching conversations...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);

        const response = await client.listConversations({
          types: options.types,
          limit: Number.parseInt(options.limit),
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

        // Slack returns next_cursor as '' rather than omitting it when there is no
        // next page; normalize to null so JSON consumers get a real sentinel.
        const jsonNextCursor = nextCursor || null;

        if (options.json) {
          writeJson({
            conversation_count: channels.length,
            conversations: channels.map(ch => ({
              id: ch.id,
              name: ch.name,
              user: ch.user,
              is_channel: ch.is_channel,
              is_group: ch.is_group,
              is_im: ch.is_im,
              is_mpim: ch.is_mpim,
              is_private: ch.is_private,
              is_archived: ch.is_archived,
              is_member: ch.is_member,
              num_members: ch.num_members,
              topic: ch.topic?.value,
              purpose: ch.purpose?.value,
            })),
            users: Array.from(users.values()).map(u => ({
              id: u.id,
              name: u.name,
              real_name: u.real_name,
              email: u.profile?.email,
            })),
            next_cursor: jsonNextCursor,
          });
          return;
        }

        console.log('\n' + formatChannelList(channels, users));

        if (nextCursor) {
          console.log(chalk.dim('\nMore results available. Next page:'));
          console.log(chalk.cyan(`  slackcli conversations list --cursor "${nextCursor}"\n`));
        }
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to fetch conversations', hint: 'Run "slackcli auth list" to check your authentication.' });
      }
    });

  // Read conversation history
  describeCommand(conversations.command('read'), HELP.read)
    .argument('[channel-id]', 'Channel ID, Slack URL or channel name to read from')
    .option('--thread-ts <timestamp>', 'Read this thread (parent message timestamp) instead of the channel')
    .option('--permalink <url>', 'Slack link; reads that channel, or that message\'s thread (replaces <channel-id> and --thread-ts)')
    .option('--exclude-replies', 'Exclude threaded replies (only top-level messages)', false)
    .option('--exclude-self', 'Exclude messages sent by the authenticated user or bot', false)
    .option('--limit <number>', 'Number of messages to return', '100')
    .option('--oldest <timestamp>', 'Start of time range, exclusive (Slack timestamp or epoch seconds)')
    .option('--latest <timestamp>', 'End of time range (Slack timestamp or epoch seconds)')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format (includes timestamps for replies)', false)
    .action(async (channelIdArg, options) => {
      const spinner = ora('Fetching messages...').start();

      try {
        const target = resolveThreadTarget(
          { permalink: options.permalink, channelId: channelIdArg, threadTs: options.threadTs },
          { channel: '<channel-id>', timestamp: '--thread-ts' }
        );
        const oldest = options.oldest ? normalizeTimestamp(options.oldest, '--oldest') : undefined;
        const latest = options.latest ? normalizeTimestamp(options.latest, '--latest') : undefined;

        const client = await getAuthenticatedClient(options.workspace);
        warnOnWorkspaceMismatch(client, target.workspace);
        const channelId = await resolveChannelName(client, channelIdArg, target.channelId, spinner);

        let response: any;

        if (target.threadTs) {
          // Fetch thread replies
          spinner.text = 'Fetching thread replies...';
          response = await client.getConversationReplies(channelId, target.threadTs, {
            limit: Number.parseInt(options.limit),
            oldest,
            latest,
          });
        } else {
          // Fetch conversation history
          spinner.text = 'Fetching conversation history...';
          response = await client.getConversationHistory(channelId, {
            limit: Number.parseInt(options.limit),
            oldest,
            latest,
          });
        }

        // --exclude-self needs the authenticated identity (one auth.test call at
        // most, only when the flag is passed).
        const self = options.excludeSelf ? await resolveSelfIdentity(client) : undefined;
        const page = processReadPage(response, {
          oldest,
          excludeReplies: options.excludeReplies,
          isThread: Boolean(target.threadTs),
          self,
        });
        const messages: SlackMessage[] = page.messages;

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
            next_oldest: page.nextOldest,
            has_more: page.hasMore,
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
        failCommand(err, { json: options.json, spinner, context: 'Failed to fetch messages' });
      }
    });

  // Get a single message by channel + timestamp
  describeCommand(conversations.command('get'), HELP.get)
    .argument('[channel-id]', 'Channel ID, Slack URL or channel name')
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
        const client = await getAuthenticatedClient(options.workspace);
        warnOnWorkspaceMismatch(client, target.workspace);
        const channelId = await resolveChannelName(client, channelIdArg, target.channelId, spinner);

        const msg = await fetchMessage(client, channelId, target.timestamp);

        if (!msg) {
          failCommand(new NotFoundError('Message not found'), { json: options.json, spinner });
          return;
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
        failCommand(err, { json: options.json, spinner, context: 'Failed to fetch message' });
      }
    });

  // List unread conversations
  describeCommand(conversations.command('unread'), HELP.unread)
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
          const types = new Set<string>(options.types.split(',').map((t: string) => t.trim()));
          channels = channels.filter(ch => {
            if (types.has('channels') && !ch.is_im && !ch.is_mpim) return true;
            if (types.has('dms') && ch.is_im) return true;
            if (types.has('groups') && ch.is_mpim) return true;
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
        failCommand(err, { json: options.json, spinner, context: 'Failed to fetch unread conversations' });
      }
    });

  // Channel membership. `members list` is read-only; `members add`/`remove`
  // are the write operations, and `join`/`leave` (below, on the group) are the
  // self operations. Naming mirrors the Slack UI ("Members" / "Add people or
  // agents" / "Remove from channel") and the CLI's own `usergroups add/remove`.
  const members = describeCommand(conversations.command('members'), HELP.members);

  // List the members of a channel/conversation
  describeCommand(members.command('list'), HELP.membersList)
    .argument('<channel>', 'Channel ID, Slack link (/archives/<channel>) or channel name')
    .option('--limit <number>', 'Maximum number of members to return', '100')
    .option('--cursor <cursor>', 'Pagination cursor for next page of results')
    .option('--workspace <id|name>', 'Workspace to use (overrides default)')
    .option('--json', 'Output in JSON format', false)
    .action(async (channelArg, options) => {
      const limit = Number.parseInt(options.limit, 10);
      if (!Number.isFinite(limit) || limit <= 0) {
        failCommand(new InvalidInputError('--limit must be a positive integer'), { json: options.json });
        return;
      }

      const spinner = ora('Fetching members...').start();

      try {
        const parsed = resolveChannelArg(channelArg);

        const client = await getAuthenticatedClient(options.workspace);
        warnOnWorkspaceMismatch(client, parsed.workspace);
        const channelId = await resolveChannelName(client, channelArg, parsed.channelId, spinner);

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
          failCommand(err, {
            json: options.json,
            spinner,
            context: 'Member enumeration is restricted on this workspace',
            message: 'Slack returned enterprise_is_restricted: listing channel members is blocked by this Enterprise Grid\'s policy.',
            hint: 'This is an org-level restriction; scoping to a team does not lift it. Ask a workspace admin if you need member enumeration.',
          });
          return;
        }
        failCommand(err, { json: options.json, spinner, context: 'Failed to fetch members', hint: 'Run "slackcli auth list" to check your authentication.' });
      }
    });

  // Add one or more users to a channel/conversation (conversations.invite).
  // The API takes a comma-separated `users` list (up to 1000) and is atomic:
  // per Slack's docs, if ANY user in the batch cannot be invited the whole call
  // returns ok:false (with a per-user `errors[]` array) and NONE are added. Our
  // request wrapper throws on ok:false, so the catch below surfaces the failure
  // and we never falsely report a partial add. (Slack's `force=true` option would
  // invite the valid ids and skip invalid ones; not exposed here to keep the
  // write PR minimal — a follow-up can add it if users want best-effort invite.)
  describeCommand(members.command('add'), HELP.membersAdd)
    .argument('<channel>', 'Channel ID, Slack link (/archives/<channel>) or channel name')
    .argument('<users...>', 'User IDs, @handles or emails (comma- or space-separated); agent/app IDs work too')
    .option('--workspace <id|name>', 'Workspace to use (overrides default)')
    .option('--team <workspace-id>', 'Target workspace T-id (enterprise org scoping)')
    .option('--yes', 'Skip the confirmation prompt (required when stdin is not a TTY)', false)
    .option('--json', 'Output in JSON format', false)
    .action(async (channelArg, users, options) => {
      if (splitUserRefs(users).length === 0) {
        failCommand(new InvalidInputError('No user IDs given — pass at least one user ID to add.'), { json: options.json });
        return;
      }
      let targets: Awaited<ReturnType<typeof resolveMembershipTargets>>;
      try {
        targets = await resolveMembershipTargets(channelArg, users, options);
      } catch (err: any) {
        failCommand(err, { json: options.json, context: 'Failed to add members' });
        return;
      }
      const { channelId, workspace, ids } = targets;
      if (!(await confirmWrite(`Add ${ids.length} user(s) to ${channelId}?`, options.yes, options.json))) {
        return;
      }

      const spinner = ora('Adding members...').start();
      try {
        const client = targets.client ?? await getAuthenticatedClient(options.workspace);
        warnOnWorkspaceMismatch(client, workspace);

        await client.inviteToConversation(channelId, ids.join(','), { team: options.team });

        spinner.succeed(`Added ${ids.length} user(s) to ${channelId}`);

        if (options.json) {
          writeJson({ channel_id: channelId, added: ids });
        }
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to add members', hint: 'Run "slackcli auth list" to check your authentication.' });
      }
    });

  // Remove users from a channel/conversation (conversations.kick). The API
  // removes exactly ONE user per call, so we loop per id and report which
  // succeeded and which failed rather than aborting the whole batch on the
  // first error (a best-effort remove, since a later id may still be removable).
  describeCommand(members.command('remove'), HELP.membersRemove)
    .argument('<channel>', 'Channel ID, Slack link (/archives/<channel>) or channel name')
    .argument('<users...>', 'User IDs, @handles or emails (comma- or space-separated)')
    .option('--workspace <id|name>', 'Workspace to use (overrides default)')
    .option('--team <workspace-id>', 'Target workspace T-id (enterprise org scoping)')
    .option('--yes', 'Skip the confirmation prompt (required when stdin is not a TTY)', false)
    .option('--json', 'Output in JSON format', false)
    .action(async (channelArg, users, options) => {
      if (splitUserRefs(users).length === 0) {
        failCommand(new InvalidInputError('No user IDs given — pass at least one user ID to remove.'), { json: options.json });
        return;
      }
      let targets: Awaited<ReturnType<typeof resolveMembershipTargets>>;
      try {
        targets = await resolveMembershipTargets(channelArg, users, options);
      } catch (err: any) {
        failCommand(err, { json: options.json, context: 'Failed to remove members' });
        return;
      }
      const { channelId, workspace, ids } = targets;
      if (!(await confirmWrite(`Remove ${ids.length} user(s) from ${channelId}?`, options.yes, options.json))) {
        return;
      }

      const spinner = ora('Removing members...').start();
      try {
        const client = targets.client ?? await getAuthenticatedClient(options.workspace);
        warnOnWorkspaceMismatch(client, workspace);

        const removed: string[] = [];
        const failed: Array<{ user: string; error: string }> = [];
        for (const id of ids) {
          spinner.text = `Removing ${id}...`;
          try {
            await client.kickFromConversation(channelId, id, { team: options.team });
            removed.push(id);
          } catch (kickErr: any) {
            failed.push({ user: id, error: kickErr?.message ?? String(kickErr) });
          }
        }

        if (failed.length === 0) {
          spinner.succeed(`Removed ${removed.length} user(s) from ${channelId}`);
        } else if (removed.length === 0) {
          spinner.fail(`Failed to remove any of ${ids.length} user(s) from ${channelId}`);
        } else {
          spinner.warn(`Removed ${removed.length} of ${ids.length}; ${failed.length} failed`);
        }

        if (options.json) {
          writeJson({ channel_id: channelId, removed, failed });
        } else if (failed.length > 0) {
          failed.forEach((f) => console.error(chalk.red(`  ✗ ${f.user}: ${f.error}`)));
        }

        // Exit non-zero whenever ANY removal failed, so a script (piping --json
        // or not) sees a partial failure — not only when every removal failed.
        // Use exitCode + return, never process.exit() after writeJson(): the
        // async JSON pipe truncates at 64 KiB if the process exits under it (#73).
        if (failed.length > 0) {
          process.exitCode = 1;
          return;
        }
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to remove members', hint: 'Run "slackcli auth list" to check your authentication.' });
      }
    });

  // Join a public channel as the authenticated user (conversations.join). This
  // is a self-op — no target user, no confirmation gate (you are only changing
  // your own membership, and it is idempotent: joining a channel you are in
  // returns the channel with no error).
  describeCommand(conversations.command('join'), HELP.join)
    .argument('<channel>', 'Channel ID, Slack link (/archives/<channel>) or channel name')
    .option('--workspace <id|name>', 'Workspace to use (overrides default)')
    .option('--json', 'Output in JSON format', false)
    .action(async (channelArg, options) => {
      const spinner = ora('Joining channel...').start();
      try {
        const parsed = resolveChannelArg(channelArg);
        const client = await getAuthenticatedClient(options.workspace);
        warnOnWorkspaceMismatch(client, parsed.workspace);
        const channelId = await resolveChannelName(client, channelArg, parsed.channelId, spinner);

        const response = await client.joinConversation(channelId);

        spinner.succeed(`Joined ${channelId}`);

        if (options.json) {
          writeJson({ channel_id: channelId, channel: response.channel ?? null });
        }
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to join channel', hint: 'Run "slackcli auth list" to check your authentication.' });
      }
    });

  // Leave a conversation as the authenticated user (conversations.leave). Also
  // a self-op. Slack returns { not_in_channel: true } when you were already
  // out; that is a no-op success, not an error.
  describeCommand(conversations.command('leave'), HELP.leave)
    .argument('<channel>', 'Channel ID, Slack link (/archives/<channel>) or channel name')
    .option('--workspace <id|name>', 'Workspace to use (overrides default)')
    .option('--yes', 'Skip the confirmation prompt (required when stdin is not a TTY)', false)
    .option('--json', 'Output in JSON format', false)
    .action(async (channelArg, options) => {
      let targets: Awaited<ReturnType<typeof resolveMembershipTargets>>;
      try {
        targets = await resolveMembershipTargets(channelArg, [], options);
      } catch (err: any) {
        failCommand(err, { json: options.json, context: 'Failed to leave channel' });
        return;
      }
      const { channelId, workspace } = targets;
      if (!(await confirmWrite(`Leave ${channelId}?`, options.yes, options.json))) {
        return;
      }
      const spinner = ora('Leaving channel...').start();
      try {
        const client = targets.client ?? await getAuthenticatedClient(options.workspace);
        warnOnWorkspaceMismatch(client, workspace);

        const response = await client.leaveConversation(channelId);
        const alreadyOut = response.not_in_channel === true;

        spinner.succeed(alreadyOut ? `Already not a member of ${channelId}` : `Left ${channelId}`);

        if (options.json) {
          writeJson({ channel_id: channelId, left: !alreadyOut, not_in_channel: alreadyOut });
        }
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to leave channel', hint: 'Run "slackcli auth list" to check your authentication.' });
      }
    });

  return conversations;
}
