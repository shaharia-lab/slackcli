import type { SlackClient } from './slack-client.ts';
import type { SavedItem, SlackUser } from '../types/index.ts';

const PAGE_SIZE = 100;
// Chunk channel groups so a single messages.list call cannot trip too_many_channels
const BATCH_SIZE = 10;

type ProgressCallback = (message: string) => void;

type ChannelGroup = { channel: string; timestamps: string[] };

/** Items mapped out of one auth shape, plus the user IDs they reference. */
type MappedItems = { items: SavedItem[]; userIds: Set<string> };

/**
 * Paginate through every saved item. The response shape tells us which auth
 * path served it: browser auth returns `saved_items`, standard auth `items`.
 */
async function fetchAllSavedItems(
  client: SlackClient,
  options: { limit?: number; onProgress?: ProgressCallback },
): Promise<{ rawItems: any[]; isBrowserFormat: boolean }> {
  const rawItems: any[] = [];
  let isBrowserFormat = false;
  let cursor: string | undefined;

  do {
    const soFar = rawItems.length > 0 ? ` (${rawItems.length} so far)` : '';
    options.onProgress?.(`Fetching saved items${soFar}...`);
    const response = await client.listSavedItems({ count: PAGE_SIZE, cursor });

    isBrowserFormat = !!response.saved_items;
    const pageItems = isBrowserFormat ? response.saved_items : (response.items || []);
    rawItems.push(...pageItems);

    cursor = response.response_metadata?.next_cursor || undefined;

    if (options.limit && rawItems.length >= options.limit) {
      rawItems.length = options.limit;
      break;
    }
  } while (cursor);

  return { rawItems, isBrowserFormat };
}

/** Group saved message timestamps by the channel they live in, preserving order. */
function groupTimestampsByChannel(messageItems: any[]): Map<string, string[]> {
  const channelTimestamps = new Map<string, string[]>();
  for (const item of messageItems) {
    const existing = channelTimestamps.get(item.item_id);
    if (existing) {
      existing.push(item.ts);
    } else {
      channelTimestamps.set(item.item_id, [item.ts]);
    }
  }
  return channelTimestamps;
}

/**
 * Flatten `messages.list` responses into a `channel:ts` → message lookup.
 * Response format: { messages: { "CHANNEL_ID": [ msg, ... ] } }
 */
function buildMessageLookup(batchResponses: any[]): Map<string, any> {
  const messageLookup = new Map<string, any>();
  for (const batchResponse of batchResponses) {
    const messagesMap = batchResponse.messages || {};
    for (const [channelId, msgs] of Object.entries(messagesMap) as [string, any[]][]) {
      for (const msg of msgs) {
        messageLookup.set(`${channelId}:${msg.ts}`, msg);
      }
    }
  }
  return messageLookup;
}

/**
 * Batch-fetch the saved messages and their channel names in parallel.
 * Each conversations.info result carries its own channel id back, so the two
 * halves cannot drift out of alignment the way index-paired arrays can.
 */
async function fetchMessagesAndChannels(
  client: SlackClient,
  channelTimestamps: Map<string, string[]>,
): Promise<{ messageLookup: Map<string, any>; channelNames: Map<string, string> }> {
  const messageIds: ChannelGroup[] = Array.from(channelTimestamps.entries()).map(
    ([channel, timestamps]) => ({ channel, timestamps }),
  );

  const batches: ChannelGroup[][] = [];
  for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
    batches.push(messageIds.slice(i, i + BATCH_SIZE));
  }

  // Both halves are issued before the first await, so they stay concurrent
  const [batchResponses, namedChannels] = await Promise.all([
    Promise.all(batches.map((batch) => client.listMessages(batch))),
    Promise.all(messageIds.map(async ({ channel }) => {
      const info = await client.getConversationInfo(channel).catch(() => null);
      return { channel, name: info?.channel?.name as string | undefined };
    })),
  ]);

  const channelNames = new Map<string, string>();
  for (const { channel, name } of namedChannels) {
    if (name) {
      channelNames.set(channel, name);
    }
  }

  return { messageLookup: buildMessageLookup(batchResponses), channelNames };
}

/**
 * Browser auth (`saved.list`) — items carry only channel + ts, so the message
 * bodies and channel names have to be resolved separately.
 */
async function enrichBrowserItems(
  client: SlackClient,
  rawItems: any[],
  onProgress?: ProgressCallback,
): Promise<MappedItems> {
  const items: SavedItem[] = [];
  const userIds = new Set<string>();

  // Split into messages and non-messages
  const messageItems = rawItems.filter((item: any) => item.item_type === 'message');
  const otherItems = rawItems.filter((item: any) => item.item_type !== 'message');

  for (const item of otherItems) {
    items.push({ type: item.item_type, channel_id: item.item_id, date_saved: item.date_created } as SavedItem);
  }

  if (messageItems.length === 0) {
    return { items, userIds };
  }

  onProgress?.('Fetching message details...');
  const { messageLookup, channelNames } = await fetchMessagesAndChannels(
    client,
    groupTimestampsByChannel(messageItems),
  );

  for (const item of messageItems) {
    const msg = messageLookup.get(`${item.item_id}:${item.ts}`);
    if (msg?.user) userIds.add(msg.user);

    items.push({
      type: 'message',
      channel_id: item.item_id,
      channel_name: channelNames.get(item.item_id) || item.item_id,
      message: msg || { text: '[message unavailable]', ts: item.ts, type: 'message' },
      date_saved: item.date_created,
      todo_state: item.todo_state,
    } as SavedItem);
  }

  return { items, userIds };
}

/** Standard auth (`stars.list`) — items already have message content inline. */
function enrichStandardItems(rawItems: any[]): MappedItems {
  const items: SavedItem[] = [];
  const userIds = new Set<string>();

  for (const item of rawItems) {
    if (item.type === 'message' && item.message?.user) {
      userIds.add(item.message.user);
    }
    items.push(item);
  }

  return { items, userIds };
}

/** Resolve the authors referenced by the saved items, if there are any. */
async function fetchUsers(
  client: SlackClient,
  userIds: Set<string>,
  onProgress?: ProgressCallback,
): Promise<Map<string, SlackUser>> {
  const users = new Map<string, SlackUser>();
  if (userIds.size === 0) {
    return users;
  }

  onProgress?.('Fetching user information...');
  const usersResponse = await client.getUsersInfo(Array.from(userIds));
  usersResponse.users?.forEach((user: SlackUser) => {
    users.set(user.id, user);
  });

  return users;
}

export async function enrichSavedItems(
  client: SlackClient,
  options: {
    limit?: number;
    onProgress?: (message: string) => void;
  } = {},
): Promise<{ items: SavedItem[]; users: Map<string, SlackUser> }> {
  const { rawItems, isBrowserFormat } = await fetchAllSavedItems(client, options);

  if (rawItems.length === 0) {
    return { items: [], users: new Map() };
  }

  const { items, userIds } = isBrowserFormat
    ? await enrichBrowserItems(client, rawItems, options.onProgress)
    : enrichStandardItems(rawItems);

  const users = await fetchUsers(client, userIds, options.onProgress);

  return { items, users };
}
