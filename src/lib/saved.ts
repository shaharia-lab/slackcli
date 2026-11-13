import type { SavedListFilter, SlackClient } from './slack-client.ts';
import type { SavedItem, SavedItemUpdate, SlackUser } from '../types/index.ts';
import { InvalidInputError } from './cli-errors.ts';
import { parseDueTime } from './schedule-time.ts';

const PAGE_SIZE = 100;
// Chunk channel groups so a single messages.list call cannot trip too_many_channels
const BATCH_SIZE = 10;

type ProgressCallback = (message: string) => void;

type ChannelGroup = { channel: string; timestamps: string[] };

/** Items mapped out of one auth shape, plus the user IDs they reference. */
type MappedItems = { items: SavedItem[]; userIds: Set<string> };

/**
 * The saved.list views that together hold the items in `state`. With no
 * filter Slack returns only uncompleted items (saved and to-do), so completed
 * ones need a second view (#438). `undefined` means no filter.
 */
export function savedListViews(state?: string): (SavedListFilter | undefined)[] {
  if (state === 'completed') return ['completed'];
  if (state) return [undefined];
  return [undefined, 'completed'];
}

/**
 * Paginate through every saved item in the views `state` needs. The response
 * shape tells us which auth path served it: browser auth returns
 * `saved_items`, standard auth `items` (stars.list has no views, so one pass).
 */
async function fetchAllSavedItems(
  client: SlackClient,
  options: { limit?: number; state?: string; onProgress?: ProgressCallback },
): Promise<{ rawItems: any[]; isBrowserFormat: boolean }> {
  const rawItems: any[] = [];
  // An item completed between two views can show up in both.
  const seen = new Set<string>();
  let isBrowserFormat = false;

  for (const filter of savedListViews(options.state)) {
    let cursor: string | undefined;
    do {
      const soFar = rawItems.length > 0 ? ` (${rawItems.length} so far)` : '';
      options.onProgress?.(`Fetching saved items${soFar}...`);
      const response = await client.listSavedItems({ count: PAGE_SIZE, cursor, filter });

      isBrowserFormat = !!response.saved_items;
      const pageItems = isBrowserFormat ? response.saved_items : (response.items || []);
      for (const item of pageItems) {
        if (isBrowserFormat) {
          const key = `${item.item_id}:${item.ts}`;
          if (seen.has(key)) continue;
          seen.add(key);
        }
        rawItems.push(item);
      }

      cursor = response.response_metadata?.next_cursor || undefined;

      if (options.limit && rawItems.length >= options.limit) {
        rawItems.length = options.limit;
        return { rawItems, isBrowserFormat };
      }
    } while (cursor);

    if (!isBrowserFormat) break;
  }

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
    /** Fetch only the saved.list views holding this todo_state; callers still filter. */
    state?: string;
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

// --- Write actions: saved add / update / complete / reopen / remove ----------

// The item after a write, as Slack reports it. `date_due` is Unix seconds, 0
// when there is none; `todo_state` is saved, to_do or completed.
export interface SavedWriteResult {
  channel_id: string;
  ts: string;
  todo_state?: string;
  date_due: number;
}

export interface RemovedSavedItemResult {
  channel_id: string;
  ts: string;
  removed: true;
}

export const SAVED_STATES = ['saved', 'to_do'] as const;

export const COMPLETE_UPDATE: SavedItemUpdate = { mark: 'completed', todo_state: 'completed', date_due: 0 };

function nowSeconds(nowMs: number): number {
  return Math.floor(nowMs / 1000);
}

// `saved add --due`: the Slack web client sends the present moment when no
// due date is picked.
export function addDueDate(due: string | undefined, nowMs: number = Date.now()): number {
  return due === undefined ? nowSeconds(nowMs) : parseDueTime(due);
}

// A reopened item goes back to To-dos, due now, as in the Slack web client.
export function reopenUpdate(nowMs: number = Date.now()): SavedItemUpdate {
  return { mark: 'uncompleted', todo_state: 'to_do', date_due: nowSeconds(nowMs) };
}

/**
 * Turn `saved update` options into one saved.update change. `due` is what
 * Commander makes of `--due <time>` / `--no-due`: the time, false, or
 * undefined. Only the combinations the Slack web client sends are allowed.
 */
export function savedUpdateFromOptions(
  options: { state?: string; due?: string | false },
  nowMs: number = Date.now(),
): SavedItemUpdate {
  const { state, due } = options;
  if (state !== undefined && !(SAVED_STATES as readonly string[]).includes(state)) {
    throw new InvalidInputError(`--state must be one of: ${SAVED_STATES.join(' | ')}`);
  }
  if (state === 'saved') {
    if (due !== undefined) {
      throw new InvalidInputError('--state saved has no due date; drop --due/--no-due.');
    }
    return { todo_state: 'saved', date_due: 0 };
  }
  if (state === 'to_do') {
    if (due === false) {
      throw new InvalidInputError('--state to_do takes a due date; pass --due <time> or leave it out for now.');
    }
    return { todo_state: 'to_do', date_due: addDueDate(due, nowMs) };
  }
  if (due === false) return { date_due: 0 };
  if (due !== undefined) return { date_due: parseDueTime(due) };
  throw new InvalidInputError('Nothing to update — pass at least one of --state, --due, or --no-due.');
}

// Slack answers saved.add/saved.update with the item; fall back to what was
// sent if it does not.
function writeResult(
  response: any,
  channelId: string,
  timestamp: string,
  sent: { todo_state?: string; date_due: number },
): SavedWriteResult {
  const item = response?.item ?? {};
  return {
    channel_id: channelId,
    ts: timestamp,
    todo_state: item.todo_state ?? sent.todo_state,
    date_due: typeof item.date_due === 'number' ? item.date_due : sent.date_due,
  };
}

// Add a message to the Later list as a to-do.
export async function addSavedItem(
  client: Pick<SlackClient, 'addSavedItem'>,
  channelId: string,
  timestamp: string,
  dateDue: number,
): Promise<SavedWriteResult> {
  const response = await client.addSavedItem(channelId, timestamp, dateDue);
  return writeResult(response, channelId, timestamp, { todo_state: 'to_do', date_due: dateDue });
}

// Apply one change to a Later-list item (update, complete, reopen).
export async function updateSavedItem(
  client: Pick<SlackClient, 'updateSavedItem'>,
  channelId: string,
  timestamp: string,
  update: SavedItemUpdate,
): Promise<SavedWriteResult> {
  const response = await client.updateSavedItem(channelId, timestamp, update);
  const todoState = 'todo_state' in update ? update.todo_state : undefined;
  return writeResult(response, channelId, timestamp, { todo_state: todoState, date_due: update.date_due });
}

// Remove an item from the Later list. Not idempotent: Slack's answer for an
// item that is not on the list is not known, so every failure is rethrown.
export async function removeSavedItem(
  client: Pick<SlackClient, 'deleteSavedItem'>,
  channelId: string,
  timestamp: string,
): Promise<RemovedSavedItemResult> {
  await client.deleteSavedItem(channelId, timestamp);
  return { channel_id: channelId, ts: timestamp, removed: true };
}
