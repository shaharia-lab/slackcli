import type { SlackClient } from './slack-client.ts';
import type { SavedItem, SlackUser } from '../types/index.ts';

export async function enrichSavedItems(
  client: SlackClient,
  options: {
    count?: number;
    onProgress?: (message: string) => void;
  } = {},
): Promise<{ items: SavedItem[]; users: Map<string, SlackUser> }> {
  const response = await client.listSavedItems({ count: options.count });

  const isBrowserFormat = !!response.saved_items;
  const rawItems = isBrowserFormat ? response.saved_items : (response.items || []);

  if (rawItems.length === 0) {
    return { items: [], users: new Map() };
  }

  const items: SavedItem[] = [];
  const userIds = new Set<string>();

  if (isBrowserFormat) {
    options.onProgress?.('Fetching message details...');

    // Fetch all messages in parallel
    // NOTE: may hit Slack rate limits with many saved items
    const messagePromises = rawItems.map(async (item: any) => {
      if (item.item_type !== 'message') {
        return { type: item.item_type, channel_id: item.item_id, date_saved: item.date_created } as SavedItem;
      }

      try {
        const [history, info] = await Promise.all([
          client.getConversationHistory(item.item_id, {
            latest: item.ts,
            oldest: item.ts,
            inclusive: true,
            limit: 1,
          }),
          client.getConversationInfo(item.item_id).catch(() => null),
        ]);

        const msg = history.messages?.[0];
        if (msg?.user) userIds.add(msg.user);

        return {
          type: 'message',
          channel_id: item.item_id,
          channel_name: info?.channel?.name || item.item_id,
          message: msg || { text: '[message unavailable]', ts: item.ts, type: 'message' },
          date_saved: item.date_created,
          todo_state: item.todo_state,
        } as SavedItem;
      } catch {
        return {
          type: 'message',
          channel_id: item.item_id,
          message: { text: '[message unavailable]', ts: item.ts, type: 'message' },
          date_saved: item.date_created,
          todo_state: item.todo_state,
        } as SavedItem;
      }
    });

    items.push(...await Promise.all(messagePromises));
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
