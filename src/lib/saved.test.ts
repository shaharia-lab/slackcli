import { describe, expect, it } from 'bun:test';
import { enrichSavedItems } from './saved.ts';
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
});
