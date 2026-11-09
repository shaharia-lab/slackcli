import { describe, expect, it } from 'bun:test';
import {
  COMPLETE_UPDATE,
  addDueDate,
  addSavedItem,
  enrichSavedItems,
  removeSavedItem,
  removeSavedReminder,
  reopenUpdate,
  savedUpdateFromOptions,
  updateSavedItem,
} from './saved.ts';
import { InvalidInputError } from './cli-errors.ts';
import type { SlackClient } from './slack-client.ts';

// Minimal mock client that returns canned responses
function createMockClient(overrides: {
  listSavedItems?: (opts: any) => Promise<any>;
  listMessages?: (ids: any) => Promise<any>;
  getConversationInfo?: (ch: string) => Promise<any>;
  getUsersInfo?: (ids: string[]) => Promise<any>;
}): SlackClient {
  return {
    listSavedItems: overrides.listSavedItems ?? (() => Promise.resolve({ items: [] })),
    listMessages: overrides.listMessages ?? (() => Promise.resolve({ messages: {} })),
    getConversationInfo: overrides.getConversationInfo ?? (() => Promise.resolve({ channel: {} })),
    getUsersInfo: overrides.getUsersInfo ?? (() => Promise.resolve({ users: [] })),
  } as unknown as SlackClient;
}

describe('enrichSavedItems', () => {
  it('returns empty result when no items exist', async () => {
    const client = createMockClient({
      listSavedItems: () => Promise.resolve({ items: [] }),
    });

    const result = await enrichSavedItems(client);
    expect(result.items).toEqual([]);
    expect(result.users.size).toBe(0);
  });

  it('paginates through all pages of saved items (browser auth)', async () => {
    let callCount = 0;
    const client = createMockClient({
      listSavedItems: () => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            saved_items: [
              { item_type: 'message', item_id: 'C1', ts: '1.1', date_created: '1700000000' },
            ],
            response_metadata: { next_cursor: 'page2' },
          });
        }
        return Promise.resolve({
          saved_items: [
            { item_type: 'message', item_id: 'C1', ts: '2.2', date_created: '1700000001' },
          ],
        });
      },
      listMessages: () => Promise.resolve({
        messages: {
          C1: [
            { ts: '1.1', text: 'First message', type: 'message', user: 'U1' },
            { ts: '2.2', text: 'Second message', type: 'message', user: 'U1' },
          ],
        },
      }),
      getConversationInfo: () => Promise.resolve({ channel: { name: 'general' } }),
      getUsersInfo: () => Promise.resolve({ users: [{ id: 'U1', name: 'alice', real_name: 'Alice' }] }),
    });

    const result = await enrichSavedItems(client);
    expect(callCount).toBe(2);
    expect(result.items).toHaveLength(2);
    expect(result.items[0].message!.text).toBe('First message');
    expect(result.items[1].message!.text).toBe('Second message');
  });

  it('respects the limit option and stops pagination early', async () => {
    let callCount = 0;
    const client = createMockClient({
      listSavedItems: () => {
        callCount++;
        return Promise.resolve({
          saved_items: [
            { item_type: 'message', item_id: 'C1', ts: `${callCount}.0`, date_created: '1700000000' },
            { item_type: 'message', item_id: 'C1', ts: `${callCount}.1`, date_created: '1700000001' },
          ],
          response_metadata: { next_cursor: 'more' },
        });
      },
      listMessages: (ids: any) => {
        const msgs: Record<string, any[]> = {};
        for (const group of ids) {
          msgs[group.channel] = group.timestamps.map((ts: string) => ({
            ts, text: `msg ${ts}`, type: 'message',
          }));
        }
        return Promise.resolve({ messages: msgs });
      },
      getConversationInfo: () => Promise.resolve({ channel: { name: 'general' } }),
      getUsersInfo: () => Promise.resolve({ users: [] }),
    });

    const result = await enrichSavedItems(client, { limit: 3 });
    expect(result.items).toHaveLength(3);
    // Should have stopped after 2 pages (2 items + 2 items, truncated to 3)
    expect(callCount).toBe(2);
  });

  it('resolves thread replies via messages.list (browser auth)', async () => {
    const client = createMockClient({
      listSavedItems: () => Promise.resolve({
        saved_items: [
          { item_type: 'message', item_id: 'C1', ts: '1.100', date_created: '1700000000' },
        ],
      }),
      listMessages: () => Promise.resolve({
        messages: {
          C1: [{ ts: '1.100', text: 'Thread reply', type: 'message', user: 'U1', thread_ts: '1.000' }],
        },
      }),
      getConversationInfo: () => Promise.resolve({ channel: { name: 'dev' } }),
      getUsersInfo: () => Promise.resolve({ users: [{ id: 'U1', name: 'bob', real_name: 'Bob' }] }),
    });

    const result = await enrichSavedItems(client);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].message!.text).toBe('Thread reply');
    expect(result.items[0].channel_name).toBe('dev');
    expect(result.users.get('U1')?.name).toBe('bob');
  });

  it('handles non-message saved items (browser auth)', async () => {
    const client = createMockClient({
      listSavedItems: () => Promise.resolve({
        saved_items: [
          { item_type: 'file', item_id: 'F1', date_created: '1700000000' },
          { item_type: 'channel', item_id: 'C1', date_created: '1700000001' },
        ],
      }),
      getUsersInfo: () => Promise.resolve({ users: [] }),
    });

    const result = await enrichSavedItems(client);
    expect(result.items).toHaveLength(2);
    expect(result.items[0].type).toBe('file');
    expect(result.items[1].type).toBe('channel');
  });

  it('preserves reminder IDs, rich-text descriptions, due dates and state without message lookups', async () => {
    const client = createMockClient({
      listSavedItems: async () => ({ saved_items: [{
        item_type: 'reminder', item_id: 'Sa0ABC123', date_created: 1700000000,
        date_due: 1700000060, todo_state: 'to_do',
        description: [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [
          { type: 'text', text: 'Read ' }, { type: 'link', text: 'the report', url: 'https://example.com' },
          { type: 'emoji', name: 'memo' },
        ] }] }],
      }] }),
      listMessages: async () => { throw new Error('A reminder has no backing message'); },
      getConversationInfo: async () => { throw new Error('A saved-item ID is not a channel'); },
      getUsersInfo: async () => { throw new Error('A reminder needs no author lookup'); },
    });

    const result = await enrichSavedItems(client);

    expect(result.items).toEqual([{
      type: 'reminder', item_id: 'Sa0ABC123', text: 'Read the report:memo:',
      date_saved: 1700000000, date_due: 1700000060, todo_state: 'to_do',
    }]);
    expect(result.items[0]).not.toHaveProperty('channel_id');
    expect(result.users.size).toBe(0);
  });

  it.each([
    ['Plain reminder', 'Plain reminder'],
    [undefined, ''],
    [null, ''],
    [{ unexpected: true }, ''],
  ])('handles reminder description %j without losing completion or a zero due date', async (description, text) => {
    const client = createMockClient({
      listSavedItems: async () => ({ saved_items: [{
        item_type: 'reminder', item_id: 'Sa0ABC123', description, todo_state: 'completed', date_due: 0,
      }] }),
    });

    const result = await enrichSavedItems(client);

    expect(result.items[0]).toMatchObject({ item_id: 'Sa0ABC123', text, todo_state: 'completed', date_due: 0 });
  });

  it('falls back to [message unavailable] when message not found', async () => {
    const client = createMockClient({
      listSavedItems: () => Promise.resolve({
        saved_items: [
          { item_type: 'message', item_id: 'C1', ts: '1.1', date_created: '1700000000' },
        ],
      }),
      listMessages: () => Promise.resolve({ messages: { C1: [] } }),
      getConversationInfo: () => Promise.resolve({ channel: { name: 'general' } }),
      getUsersInfo: () => Promise.resolve({ users: [] }),
    });

    const result = await enrichSavedItems(client);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].message!.text).toBe('[message unavailable]');
  });

  it('preserves todo_state from saved items (browser auth)', async () => {
    const client = createMockClient({
      listSavedItems: () => Promise.resolve({
        saved_items: [
          { item_type: 'message', item_id: 'C1', ts: '1.1', date_created: '1700000000', todo_state: 'to_do' },
          { item_type: 'message', item_id: 'C1', ts: '2.2', date_created: '1700000001', todo_state: 'completed' },
        ],
      }),
      listMessages: () => Promise.resolve({
        messages: {
          C1: [
            { ts: '1.1', text: 'Task 1', type: 'message' },
            { ts: '2.2', text: 'Task 2', type: 'message' },
          ],
        },
      }),
      getConversationInfo: () => Promise.resolve({ channel: { name: 'tasks' } }),
      getUsersInfo: () => Promise.resolve({ users: [] }),
    });

    const result = await enrichSavedItems(client);
    expect(result.items[0].todo_state).toBe('to_do');
    expect(result.items[1].todo_state).toBe('completed');
  });

  it('handles standard auth format (stars.list) with inline messages', async () => {
    const client = createMockClient({
      listSavedItems: () => Promise.resolve({
        items: [
          { type: 'message', message: { text: 'Starred msg', ts: '1.1', type: 'message', user: 'U1' } },
          { type: 'file', file: { name: 'doc.pdf' } },
        ],
      }),
      getUsersInfo: () => Promise.resolve({ users: [{ id: 'U1', name: 'alice', real_name: 'Alice' }] }),
    });

    const result = await enrichSavedItems(client);
    expect(result.items).toHaveLength(2);
    expect(result.items[0].type).toBe('message');
    expect(result.items[0].message!.text).toBe('Starred msg');
    expect(result.users.get('U1')?.real_name).toBe('Alice');
  });

  it('groups messages by channel and batches requests', async () => {
    const listMessagesCalls: any[] = [];
    const client = createMockClient({
      listSavedItems: () => Promise.resolve({
        saved_items: [
          { item_type: 'message', item_id: 'C1', ts: '1.1', date_created: '1700000000' },
          { item_type: 'message', item_id: 'C1', ts: '1.2', date_created: '1700000001' },
          { item_type: 'message', item_id: 'C2', ts: '2.1', date_created: '1700000002' },
        ],
      }),
      listMessages: (ids: any) => {
        listMessagesCalls.push(ids);
        const msgs: Record<string, any[]> = {};
        for (const group of ids) {
          msgs[group.channel] = group.timestamps.map((ts: string) => ({
            ts, text: `msg-${ts}`, type: 'message',
          }));
        }
        return Promise.resolve({ messages: msgs });
      },
      getConversationInfo: (ch: string) => Promise.resolve({ channel: { name: ch } }),
      getUsersInfo: () => Promise.resolve({ users: [] }),
    });

    const result = await enrichSavedItems(client);
    expect(result.items).toHaveLength(3);
    // Should batch into a single messages.list call (3 items across 2 channels, well under batch size of 10)
    expect(listMessagesCalls).toHaveLength(1);
    // The call should group timestamps by channel
    const batch = listMessagesCalls[0];
    expect(batch).toHaveLength(2); // 2 channels
    const c1Group = batch.find((g: any) => g.channel === 'C1');
    expect(c1Group.timestamps).toEqual(['1.1', '1.2']);
  });

  it('falls back to channel ID when conversation info fails', async () => {
    const client = createMockClient({
      listSavedItems: () => Promise.resolve({
        saved_items: [
          { item_type: 'message', item_id: 'C_PRIVATE', ts: '1.1', date_created: '1700000000' },
        ],
      }),
      listMessages: () => Promise.resolve({
        messages: { C_PRIVATE: [{ ts: '1.1', text: 'secret', type: 'message' }] },
      }),
      getConversationInfo: () => Promise.reject(new Error('channel_not_found')),
      getUsersInfo: () => Promise.resolve({ users: [] }),
    });

    const result = await enrichSavedItems(client);
    expect(result.items[0].channel_name).toBe('C_PRIVATE');
  });

  it('chunks channels into batches of 10 for messages.list (browser auth)', async () => {
    const batchSizes: number[] = [];
    const channels = Array.from({ length: 12 }, (_, i) => `C${i + 1}`);
    const client = createMockClient({
      listSavedItems: () => Promise.resolve({
        saved_items: channels.map((ch, i) => ({
          item_type: 'message', item_id: ch, ts: `${i}.1`, date_created: '1700000000',
        })),
      }),
      listMessages: (ids: any) => {
        batchSizes.push(ids.length);
        const msgs: Record<string, any[]> = {};
        for (const group of ids) {
          msgs[group.channel] = group.timestamps.map((ts: string) => ({
            ts, text: `msg-${group.channel}`, type: 'message',
          }));
        }
        return Promise.resolve({ messages: msgs });
      },
      getConversationInfo: (ch: string) => Promise.resolve({ channel: { name: `name-${ch}` } }),
      getUsersInfo: () => Promise.resolve({ users: [] }),
    });

    const result = await enrichSavedItems(client);
    // 12 channels -> two calls, capped at the batch size of 10
    expect(batchSizes).toEqual([10, 2]);
    expect(result.items).toHaveLength(12);
    // Every channel keeps its own name across the batch boundary
    for (const [i, ch] of channels.entries()) {
      expect(result.items[i].channel_name).toBe(`name-${ch}`);
      expect(result.items[i].message!.text).toBe(`msg-${ch}`);
    }
  });

  it('keeps channel names aligned when only some conversation lookups fail', async () => {
    const client = createMockClient({
      listSavedItems: () => Promise.resolve({
        saved_items: [
          { item_type: 'message', item_id: 'C1', ts: '1.1', date_created: '1700000000' },
          { item_type: 'message', item_id: 'C2', ts: '2.1', date_created: '1700000001' },
          { item_type: 'message', item_id: 'C3', ts: '3.1', date_created: '1700000002' },
        ],
      }),
      listMessages: (ids: any) => {
        const msgs: Record<string, any[]> = {};
        for (const group of ids) {
          msgs[group.channel] = group.timestamps.map((ts: string) => ({ ts, text: 'hi', type: 'message' }));
        }
        return Promise.resolve({ messages: msgs });
      },
      // The middle channel is unreadable; the other two must keep their own names
      getConversationInfo: (ch: string) => (ch === 'C2'
        ? Promise.reject(new Error('channel_not_found'))
        : Promise.resolve({ channel: { name: `name-${ch}` } })),
      getUsersInfo: () => Promise.resolve({ users: [] }),
    });

    const result = await enrichSavedItems(client);
    expect(result.items.map((i) => i.channel_name)).toEqual(['name-C1', 'C2', 'name-C3']);
  });

  it('skips the message-detail phase when no saved item is a message', async () => {
    let listMessagesCalls = 0;
    const progress: string[] = [];
    const client = createMockClient({
      listSavedItems: () => Promise.resolve({
        saved_items: [{ item_type: 'file', item_id: 'F1', date_created: '1700000000' }],
      }),
      listMessages: () => {
        listMessagesCalls++;
        return Promise.resolve({ messages: {} });
      },
      getUsersInfo: () => Promise.resolve({ users: [] }),
    });

    const result = await enrichSavedItems(client, { onProgress: (m) => progress.push(m) });
    expect(listMessagesCalls).toBe(0);
    expect(progress).not.toContain('Fetching message details...');
    expect(result.items).toHaveLength(1);
  });

  it('skips the user lookup when no item references a user', async () => {
    let getUsersInfoCalls = 0;
    const client = createMockClient({
      listSavedItems: () => Promise.resolve({
        items: [{ type: 'message', message: { text: 'no author', ts: '1.1', type: 'message' } }],
      }),
      getUsersInfo: () => {
        getUsersInfoCalls++;
        return Promise.resolve({ users: [] });
      },
    });

    const result = await enrichSavedItems(client);
    expect(getUsersInfoCalls).toBe(0);
    expect(result.users.size).toBe(0);
    expect(result.items).toHaveLength(1);
  });

  it('reports progress for each phase (browser auth)', async () => {
    const messages: string[] = [];
    const client = createMockClient({
      listSavedItems: () => Promise.resolve({
        saved_items: [
          { item_type: 'message', item_id: 'C1', ts: '1.1', date_created: '1700000000' },
        ],
      }),
      listMessages: () => Promise.resolve({
        messages: { C1: [{ ts: '1.1', text: 'hi', type: 'message', user: 'U1' }] },
      }),
      getConversationInfo: () => Promise.resolve({ channel: { name: 'general' } }),
      getUsersInfo: () => Promise.resolve({ users: [{ id: 'U1', name: 'alice' }] }),
    });

    await enrichSavedItems(client, { onProgress: (m) => messages.push(m) });
    expect(messages).toEqual([
      'Fetching saved items...',
      'Fetching message details...',
      'Fetching user information...',
    ]);
  });

  it('reports the running item count on every page after the first', async () => {
    const messages: string[] = [];
    let callCount = 0;
    const client = createMockClient({
      listSavedItems: () => {
        callCount++;
        const next = callCount < 3 ? { next_cursor: `page${callCount + 1}` } : {};
        return Promise.resolve({
          saved_items: [
            { item_type: 'channel', item_id: `C${callCount}`, date_created: '1700000000' },
            { item_type: 'channel', item_id: `C${callCount}x`, date_created: '1700000000' },
          ],
          response_metadata: next,
        });
      },
    });

    await enrichSavedItems(client, { onProgress: (m) => messages.push(m) });
    expect(messages).toEqual([
      'Fetching saved items...',
      'Fetching saved items (2 so far)...',
      'Fetching saved items (4 so far)...',
    ]);
  });
});

// Saturday 10 October 2026, 12:00:00 UTC.
const NOW_MS = Date.UTC(2026, 9, 10, 12, 0, 0);
const NOW = NOW_MS / 1000;
const TS = '1712345678.000100';

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(InvalidInputError);
    return (err as Error).message;
  }
  throw new Error('expected an InvalidInputError');
}

describe('addDueDate', () => {
  it('is now when no --due is given', () => {
    expect(addDueDate(undefined, NOW_MS + 999)).toBe(NOW);
  });

  it('reads --due in the --at formats', () => {
    expect(addDueDate(String(NOW + 60), NOW_MS)).toBe(NOW + 60);
    expect(addDueDate('2026-10-12T09:50:00Z', NOW_MS)).toBe(Date.UTC(2026, 9, 12, 9, 50, 0) / 1000);
  });

  it('refuses a --due it cannot read', () => {
    expect(refusal(() => addDueDate('tomorrow', NOW_MS))).toContain('Cannot read --due "tomorrow"');
  });
});

describe('savedUpdateFromOptions', () => {
  it('moves an item to Saved with no due date', () => {
    expect(savedUpdateFromOptions({ state: 'saved' }, NOW_MS)).toEqual({ todo_state: 'saved', date_due: 0 });
  });

  it('moves an item to To-dos, due now or at --due', () => {
    expect(savedUpdateFromOptions({ state: 'to_do' }, NOW_MS)).toEqual({ todo_state: 'to_do', date_due: NOW });
    expect(savedUpdateFromOptions({ state: 'to_do', due: String(NOW + 60) }, NOW_MS))
      .toEqual({ todo_state: 'to_do', date_due: NOW + 60 });
  });

  it('changes or clears only the due date', () => {
    expect(savedUpdateFromOptions({ due: String(NOW + 60) }, NOW_MS)).toEqual({ date_due: NOW + 60 });
    expect(savedUpdateFromOptions({ due: false }, NOW_MS)).toEqual({ date_due: 0 });
  });

  it('refuses an unknown --state', () => {
    expect(refusal(() => savedUpdateFromOptions({ state: 'completed' }, NOW_MS)))
      .toBe('--state must be one of: saved | to_do');
  });

  it('refuses a due date on --state saved', () => {
    expect(refusal(() => savedUpdateFromOptions({ state: 'saved', due: String(NOW + 60) }, NOW_MS)))
      .toContain('--state saved has no due date');
    expect(refusal(() => savedUpdateFromOptions({ state: 'saved', due: false }, NOW_MS)))
      .toContain('--state saved has no due date');
  });

  it('refuses --state to_do with --no-due', () => {
    expect(refusal(() => savedUpdateFromOptions({ state: 'to_do', due: false }, NOW_MS)))
      .toContain('--state to_do takes a due date');
  });

  it('refuses a --due it cannot read', () => {
    expect(refusal(() => savedUpdateFromOptions({ due: 'tomorrow' }, NOW_MS))).toContain('Cannot read --due "tomorrow"');
  });

  it('refuses an update with nothing to change', () => {
    expect(refusal(() => savedUpdateFromOptions({}, NOW_MS))).toContain('Nothing to update');
  });
});

describe('Later-list write actions', () => {
  const item = { item_id: 'C123', item_type: 'message', ts: TS, todo_state: 'to_do', date_due: NOW + 60 };

  it('adds an item and reports its state from Slack', async () => {
    const calls: unknown[] = [];
    const client = {
      addSavedItem: async (...args: unknown[]) => { calls.push(args); return { ok: true, item }; },
    };

    expect(await addSavedItem(client, 'C123', TS, NOW + 60))
      .toEqual({ channel_id: 'C123', ts: TS, todo_state: 'to_do', date_due: NOW + 60 });
    expect(calls).toEqual([['C123', TS, NOW + 60]]);
  });

  it('falls back to what it sent when Slack returns no item', async () => {
    const client = { addSavedItem: async () => ({ ok: true }) };

    expect(await addSavedItem(client, 'C123', TS, NOW))
      .toEqual({ channel_id: 'C123', ts: TS, todo_state: 'to_do', date_due: NOW });
  });

  it('completes and reopens an item with the web-client combinations', async () => {
    const calls: unknown[] = [];
    const client = {
      updateSavedItem: async (...args: unknown[]) => { calls.push(args); return { ok: true }; },
    };

    expect(await updateSavedItem(client, 'C123', TS, COMPLETE_UPDATE))
      .toEqual({ channel_id: 'C123', ts: TS, todo_state: 'completed', date_due: 0 });
    expect(await updateSavedItem(client, 'C123', TS, reopenUpdate(NOW_MS)))
      .toEqual({ channel_id: 'C123', ts: TS, todo_state: 'to_do', date_due: NOW });
    expect(calls).toEqual([
      ['C123', TS, { mark: 'completed', todo_state: 'completed', date_due: 0 }],
      ['C123', TS, { mark: 'uncompleted', todo_state: 'to_do', date_due: NOW }],
    ]);
  });

  it('takes the state from Slack on a due-date-only update', async () => {
    const client = { updateSavedItem: async () => ({ ok: true, item: { ...item, date_due: 0 } }) };

    expect(await updateSavedItem(client, 'C123', TS, { date_due: 0 }))
      .toEqual({ channel_id: 'C123', ts: TS, todo_state: 'to_do', date_due: 0 });
  });

  it('removes an item, and rethrows a failure', async () => {
    const client = { deleteSavedItem: async () => ({ ok: true }) };
    expect(await removeSavedItem(client, 'C123', TS)).toEqual({ channel_id: 'C123', ts: TS, removed: true });

    const failing = {
      deleteSavedItem: async () => { throw Object.assign(new Error('x'), { slackData: { error: 'message_not_found' } }); },
    };
    await expect(removeSavedItem(failing, 'C123', TS)).rejects.toThrow('x');
  });

  it('removes a standalone reminder by its saved-item ID and preserves failures', async () => {
    const ids: string[] = [];
    const client = { deleteSavedReminder: async (id: string) => { ids.push(id); return { ok: true }; } };

    expect(await removeSavedReminder(client, 'Sa0ABC123'))
      .toEqual({ item_id: 'Sa0ABC123', item_type: 'reminder', removed: true });
    expect(ids).toEqual(['Sa0ABC123']);
    await expect(removeSavedReminder({ deleteSavedReminder: async () => { throw new Error('refused'); } }, 'Sa0ABC123'))
      .rejects.toThrow('refused');
  });
});
