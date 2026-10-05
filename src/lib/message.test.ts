import { describe, expect, it } from 'bun:test';
import { deleteMessage, fetchMessage } from './message.ts';
import type { SlackClient } from './slack-client.ts';

function createMockClient(
  authType: 'browser' | 'standard',
  overrides: {
    listMessages?: (ids: any) => Promise<any>;
    getConversationHistory?: (channel: string, opts: any) => Promise<any>;
  } = {},
): SlackClient {
  return {
    authType,
    listMessages: overrides.listMessages ?? (() => Promise.resolve({ messages: {} })),
    getConversationHistory: overrides.getConversationHistory ?? (() => Promise.resolve({ messages: [] })),
  } as unknown as SlackClient;
}

describe('fetchMessage', () => {
  describe('browser auth', () => {
    it('fetches a top-level message via messages.list', async () => {
      const client = createMockClient('browser', {
        listMessages: () => Promise.resolve({
          messages: {
            C123: [{ ts: '1.1', text: 'Hello', type: 'message', user: 'U1' }],
          },
        }),
      });

      const msg = await fetchMessage(client, 'C123', '1.1');
      expect(msg).toBeDefined();
      expect(msg!.text).toBe('Hello');
      expect(msg!.ts).toBe('1.1');
    });

    it('fetches a thread reply via messages.list', async () => {
      const client = createMockClient('browser', {
        listMessages: () => Promise.resolve({
          messages: {
            C123: [{ ts: '1.2', text: 'Reply', type: 'message', user: 'U1', thread_ts: '1.1' }],
          },
        }),
      });

      const msg = await fetchMessage(client, 'C123', '1.2');
      expect(msg).toBeDefined();
      expect(msg!.text).toBe('Reply');
      expect(msg!.thread_ts).toBe('1.1');
    });

    it('returns undefined when message not found', async () => {
      const client = createMockClient('browser', {
        listMessages: () => Promise.resolve({ messages: { C123: [] } }),
      });

      const msg = await fetchMessage(client, 'C123', '9.9');
      expect(msg).toBeUndefined();
    });

    it('returns undefined when channel not in response', async () => {
      const client = createMockClient('browser', {
        listMessages: () => Promise.resolve({ messages: {} }),
      });

      const msg = await fetchMessage(client, 'C_MISSING', '1.1');
      expect(msg).toBeUndefined();
    });
  });

  describe('standard auth', () => {
    it('fetches a top-level message via conversations.history', async () => {
      const client = createMockClient('standard', {
        getConversationHistory: () => Promise.resolve({
          messages: [{ ts: '1.1', text: 'Hello', type: 'message', user: 'U1' }],
        }),
      });

      const msg = await fetchMessage(client, 'C123', '1.1');
      expect(msg).toBeDefined();
      expect(msg!.text).toBe('Hello');
    });

    it('passes correct timestamp range to conversations.history', async () => {
      let capturedOpts: any;
      const client = createMockClient('standard', {
        getConversationHistory: (_channel: string, opts: any) => {
          capturedOpts = opts;
          return Promise.resolve({ messages: [] });
        },
      });

      await fetchMessage(client, 'C123', '1744346513.339549');
      expect(capturedOpts.latest).toBe('1744346513.339549');
      expect(capturedOpts.oldest).toBe('1744346513.339549');
      expect(capturedOpts.inclusive).toBe(true);
      expect(capturedOpts.limit).toBe(1);
    });

    it('returns undefined for thread replies (known limitation)', async () => {
      const client = createMockClient('standard', {
        getConversationHistory: () => Promise.resolve({ messages: [] }),
      });

      // Thread replies don't appear in conversations.history, and we can't
      // call conversations.replies without the parent thread_ts
      const msg = await fetchMessage(client, 'C123', '1.2');
      expect(msg).toBeUndefined();
    });

    it('returns undefined when no messages match', async () => {
      const client = createMockClient('standard', {
        getConversationHistory: () => Promise.resolve({ messages: [] }),
      });

      const msg = await fetchMessage(client, 'C123', '9.9');
      expect(msg).toBeUndefined();
    });
  });

  it('uses messages.list for browser auth, not conversations.history', async () => {
    let listMessagesCalled = false;
    let historyCalled = false;

    const client = createMockClient('browser', {
      listMessages: () => {
        listMessagesCalled = true;
        return Promise.resolve({ messages: {} });
      },
      getConversationHistory: () => {
        historyCalled = true;
        return Promise.resolve({ messages: [] });
      },
    });

    await fetchMessage(client, 'C123', '1.1');
    expect(listMessagesCalled).toBe(true);
    expect(historyCalled).toBe(false);
  });

  it('uses conversations.history for standard auth, not messages.list', async () => {
    let listMessagesCalled = false;
    let historyCalled = false;

    const client = createMockClient('standard', {
      listMessages: () => {
        listMessagesCalled = true;
        return Promise.resolve({ messages: {} });
      },
      getConversationHistory: () => {
        historyCalled = true;
        return Promise.resolve({ messages: [] });
      },
    });

    await fetchMessage(client, 'C123', '1.1');
    expect(listMessagesCalled).toBe(false);
    expect(historyCalled).toBe(true);
  });
});

function slackRefusal(code: string): Error {
  return Object.assign(new Error(`Slack API error: ${code}`), { slackData: { ok: false, error: code } });
}

describe('deleteMessage', () => {
  it('deletes the message and reports it was not already gone', async () => {
    const calls: Array<[string, string]> = [];
    const client = {
      deleteMessage: (channel: string, ts: string) => {
        calls.push([channel, ts]);
        return Promise.resolve({ ok: true, channel, ts });
      },
    };

    const result = await deleteMessage(client, 'C123', '1.1');

    expect(calls).toEqual([['C123', '1.1']]);
    expect(result).toEqual({ channel_id: 'C123', ts: '1.1', deleted: true, already_deleted: false });
  });

  it('treats message_not_found as already deleted, so a retry succeeds', async () => {
    const client = { deleteMessage: () => Promise.reject(slackRefusal('message_not_found')) };

    const result = await deleteMessage(client, 'C123', '1.1');

    expect(result).toEqual({ channel_id: 'C123', ts: '1.1', deleted: false, already_deleted: true });
  });

  it.each(['cant_delete_message', 'channel_not_found', 'not_in_channel', 'missing_scope'])(
    'rethrows %s unchanged',
    async (code) => {
      const refusal = slackRefusal(code);
      const client = { deleteMessage: () => Promise.reject(refusal) };

      await expect(deleteMessage(client, 'C123', '1.1')).rejects.toBe(refusal);
    },
  );

  it('rethrows a failure that carries no Slack answer', async () => {
    const network = new Error('socket hang up');
    const client = { deleteMessage: () => Promise.reject(network) };

    await expect(deleteMessage(client, 'C123', '1.1')).rejects.toBe(network);
  });

  it('does not mistake message_not_found in the text alone for the Slack code', async () => {
    const lookalike = new Error('Slack API error: message_not_found');
    const client = { deleteMessage: () => Promise.reject(lookalike) };

    await expect(deleteMessage(client, 'C123', '1.1')).rejects.toBe(lookalike);
  });
});
