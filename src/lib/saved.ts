import type { SlackClient } from './slack-client.ts';
import type { SavedItem, SlackUser } from '../types/index.ts';

export async function enrichSavedItems(
  client: SlackClient,
  options: {
    limit?: number;
    onProgress?: (message: string) => void;
  } = {},
): Promise<{ items: SavedItem[]; users: Map<string, SlackUser> }> {
  // Paginate through all saved items
  const rawItems: any[] = [];
  let isBrowserFormat = false;
  let cursor: string | undefined;
  const pageSize = 100;

  do {
    options.onProgress?.(`Fetching saved items${rawItems.length > 0 ? ` (${rawItems.length} so far)` : ''}...`);
    const response = await client.listSavedItems({ count: pageSize, cursor });

    isBrowserFormat = !!response.saved_items;
    const pageItems = isBrowserFormat ? response.saved_items : (response.items || []);
    rawItems.push(...pageItems);

    cursor = response.response_metadata?.next_cursor || undefined;

    if (options.limit && rawItems.length >= options.limit) {
      rawItems.length = options.limit;
      break;
    }
  } while (cursor);

  if (rawItems.length === 0) {
    return { items: [], users: new Map() };
  }

  const items: SavedItem[] = [];
  const userIds = new Set<string>();

  if (isBrowserFormat) {
    // Split into messages and non-messages
    const messageItems = rawItems.filter((item: any) => item.item_type === 'message');
    const otherItems = rawItems.filter((item: any) => item.item_type !== 'message');

    for (const item of otherItems) {
      items.push({ type: item.item_type, channel_id: item.item_id, date_saved: item.date_created } as SavedItem);
    }

    if (messageItems.length > 0) {
      // Group timestamps by channel for batch fetch
      const channelTimestamps = new Map<string, string[]>();
      for (const item of messageItems) {
        const existing = channelTimestamps.get(item.item_id);
        if (existing) {
          existing.push(item.ts);
        } else {
          channelTimestamps.set(item.item_id, [item.ts]);
        }
      }

      const messageIds = Array.from(channelTimestamps.entries()).map(
        ([channel, timestamps]) => ({ channel, timestamps }),
      );

      // Batch-fetch messages (chunk to avoid too_many_channels errors)
      // and channel info in parallel
      options.onProgress?.('Fetching message details...');
      const BATCH_SIZE = 10;
      const messageLookup = new Map<string, any>();

      const batches: Array<Array<{ channel: string; timestamps: string[] }>> = [];
      for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
        batches.push(messageIds.slice(i, i + BATCH_SIZE));
      }

      const [batchResponses, ...channelInfos] = await Promise.all([
        Promise.all(batches.map((batch) => client.listMessages(batch))),
        ...Array.from(channelTimestamps.keys()).map(
          (ch) => client.getConversationInfo(ch).catch(() => null),
        ),
      ]);

      // Build channel name lookup
      const channelNames = new Map<string, string>();
      const channelKeys = Array.from(channelTimestamps.keys());
      channelInfos.forEach((info, i) => {
        if (info?.channel?.name) {
          channelNames.set(channelKeys[i], info.channel.name);
        }
      });

      // Build message lookup from messages.list responses
      // Response format: { messages: { "CHANNEL_ID": [ msg, ... ] } }
      for (const batchResponse of batchResponses) {
        const messagesMap = batchResponse.messages || {};
        for (const [channelId, msgs] of Object.entries(messagesMap) as [string, any[]][]) {
          for (const msg of msgs) {
            messageLookup.set(`${channelId}:${msg.ts}`, msg);
          }
        }
      }

      // Map saved items to enriched items
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
    }
  } else {
    // Standard auth (stars.list) — items already have message content
    for (const item of rawItems) {
      if (item.type === 'message' && item.message?.user) {
        userIds.add(item.message.user);
      }
      items.push(item);
    }
  }

  // Fetch user info
  const users = new Map<string, SlackUser>();
  if (userIds.size > 0) {
    options.onProgress?.('Fetching user information...');
    const usersResponse = await client.getUsersInfo(Array.from(userIds));
    usersResponse.users?.forEach((user: SlackUser) => {
      users.set(user.id, user);
    });
  }

  return { items, users };
}
