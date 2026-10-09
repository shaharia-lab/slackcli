// `conversations unread` and the thread summary (#264), in process with the
// Slack client stubbed: what reaches stdout for each mix of unread
// conversations and unread threads, on both auth types, including the empty
// `--json` result (#360).
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { resetSync, type LogRecord } from '@logtape/logtape';
import * as authLib from '../lib/auth.ts';
import { UnsupportedAuthTypeError } from '../lib/cli-errors.ts';
import { configureLogging } from '../lib/logger.ts';
import { createConversationsCommand } from './conversations.ts';

const UNREAD_CHANNEL = { id: 'C0123456789', has_unreads: true, mention_count: 2 };
const UNREAD_DM = { id: 'D0123456789', has_unreads: true, mention_count: 0 };
const UNREAD_THREADS = { has_unreads: true, mention_count: 1, vip_count: 0 };
const READ_THREADS = { has_unreads: false, mention_count: 0, vip_count: 0 };

const CHANNELS: Record<string, Record<string, unknown>> = {
  C0123456789: { id: 'C0123456789', name: 'general', is_private: false },
  D0123456789: { id: 'D0123456789', is_im: true, user: 'U0123456789' },
};

function stubClient(authType: 'browser' | 'standard', counts: Record<string, unknown>): unknown {
  return {
    authType,
    getUnreadCounts: async () => structuredClone({ ok: true, ...counts }),
    getConversationInfo: async (id: string) => ({ ok: true, channel: CHANNELS[id] }),
    getUserInfo: async () => ({ ok: true, user: { id: 'U0123456789', name: 'alice', real_name: 'Alice' } }),
  };
}

describe('conversations unread, in process', () => {
  let stdout: string;
  let stderr: string;
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    stdout = '';
    stderr = '';
    savedExitCode = process.exitCode;
    process.exitCode = 0;
    spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    }) as typeof process.stdout.write);
    spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    }) as typeof process.stderr.write);
    spyOn(console, 'log').mockImplementation((...args: unknown[]) => { stdout += `${args.join(' ')}\n`; });
    spyOn(console, 'error').mockImplementation((...args: unknown[]) => { stderr += `${args.join(' ')}\n`; });
  });

  afterEach(() => {
    mock.restore();
    process.exitCode = savedExitCode ?? 0;
  });

  async function run(authType: 'browser' | 'standard', counts: Record<string, unknown>, args: string[] = []): Promise<void> {
    spyOn(authLib, 'getAuthenticatedClient').mockResolvedValue(stubClient(authType, counts) as any);
    await createConversationsCommand().parseAsync(['unread', ...args], { from: 'user' });
    expect(process.exitCode).toBe(0);
  }

  describe('--json with browser auth', () => {
    it('adds threads next to unread_channels', async () => {
      await run('browser', { channels: [UNREAD_CHANNEL], threads: UNREAD_THREADS }, ['--json']);

      expect(JSON.parse(stdout)).toEqual({
        unread_channels: [{ id: 'C0123456789', mention_count: 2, has_unreads: true, is_private: false, name: 'general' }],
        threads: { has_unreads: true, mention_count: 1 },
      });
    });

    it('prints an empty unread_channels with threads when only threads are unread', async () => {
      await run('browser', { channels: [], threads: UNREAD_THREADS }, ['--json']);

      expect(JSON.parse(stdout)).toEqual({ unread_channels: [], threads: { has_unreads: true, mention_count: 1 } });
      expect(stderr).not.toContain('All caught up');
    });

    it('counts a thread mention as unread even when has_unreads is false', async () => {
      await run('browser', { threads: { has_unreads: false, mention_count: 3 } }, ['--json']);

      expect(JSON.parse(stdout)).toEqual({ unread_channels: [], threads: { has_unreads: false, mention_count: 3 } });
    });

    it('reports read threads as such when a conversation is unread', async () => {
      await run('browser', { channels: [UNREAD_CHANNEL], threads: READ_THREADS }, ['--json']);

      expect(JSON.parse(stdout).threads).toEqual({ has_unreads: false, mention_count: 0 });
    });

    it('leaves threads out when Slack sent no threads block', async () => {
      await run('browser', { channels: [UNREAD_CHANNEL] }, ['--json']);

      const out = JSON.parse(stdout);
      expect(Object.keys(out)).toEqual(['unread_channels']);
      expect(out.unread_channels).toHaveLength(1);
    });

    it('prints an empty unread_channels with read threads when no conversation and no thread is unread', async () => {
      await run('browser', { channels: [], threads: READ_THREADS }, ['--json']);

      expect(JSON.parse(stdout)).toEqual({ unread_channels: [], threads: { has_unreads: false, mention_count: 0 } });
      expect(stderr).toContain('All caught up! No unread messages.');
    });

    it('prints an empty unread_channels with no threads key when Slack sent no threads block', async () => {
      await run('browser', { channels: [] }, ['--json']);

      expect(JSON.parse(stdout)).toEqual({ unread_channels: [] });
      expect(stderr).toContain('All caught up! No unread messages.');
    });

    it('prints an empty unread_channels when --types filters every conversation out and threads are read', async () => {
      await run('browser', { channels: [UNREAD_CHANNEL], threads: READ_THREADS }, ['--json', '--types', 'groups']);

      expect(JSON.parse(stdout)).toEqual({ unread_channels: [], threads: { has_unreads: false, mention_count: 0 } });
      expect(stderr).toContain('All caught up! No unread messages.');
    });

    it('prints an empty unread_channels under --fields when nothing is unread', async () => {
      await run('browser', { channels: [], threads: READ_THREADS }, ['--json', '--fields', 'id']);

      expect(JSON.parse(stdout)).toEqual({ unread_channels: [], threads: { has_unreads: false, mention_count: 0 } });
    });

    it('reports threads whatever --types says', async () => {
      await run('browser', { channels: [UNREAD_CHANNEL], ims: [UNREAD_DM], threads: UNREAD_THREADS }, ['--json', '--types', 'dms']);

      const out = JSON.parse(stdout);
      expect(out.unread_channels.map((channel: { id: string }) => channel.id)).toEqual(['D0123456789']);
      expect(out.threads).toEqual({ has_unreads: true, mention_count: 1 });
    });

    it('still reports unread threads when --types filters every conversation out', async () => {
      await run('browser', { channels: [UNREAD_CHANNEL], threads: UNREAD_THREADS }, ['--json', '--types', 'groups']);

      expect(JSON.parse(stdout)).toEqual({ unread_channels: [], threads: { has_unreads: true, mention_count: 1 } });
    });

    it('keeps threads whole under --fields, which projects only unread_channels', async () => {
      await run('browser', { channels: [UNREAD_CHANNEL], threads: UNREAD_THREADS }, ['--json', '--fields', 'id']);

      expect(JSON.parse(stdout)).toEqual({
        unread_channels: [{ id: 'C0123456789' }],
        threads: { has_unreads: true, mention_count: 1 },
      });
    });
  });

  describe('--json with an app token', () => {
    const LIST = {
      channels: [{ id: 'C0123456789', name: 'general', is_member: true, unread_count: 4, unread_count_display: 4, mention_count_display: 1 }],
    };

    it('prints unread_channels only, with no threads key', async () => {
      await run('standard', LIST, ['--json']);

      const out = JSON.parse(stdout);
      expect(Object.keys(out)).toEqual(['unread_channels']);
      expect(out.unread_channels).toEqual([{ id: 'C0123456789', name: 'general', mention_count: 1, unread_count: 4, has_unreads: true }]);
    });

    it('ignores a threads key on the response and prints an empty unread_channels when nothing is unread', async () => {
      await run('standard', { channels: [], threads: UNREAD_THREADS }, ['--json']);

      expect(JSON.parse(stdout)).toEqual({ unread_channels: [] });
      expect(stderr).toContain('All caught up! No unread messages.');
    });

    it('prints an empty unread_channels when --types filters every conversation out', async () => {
      await run('standard', LIST, ['--json', '--types', 'groups']);

      expect(JSON.parse(stdout)).toEqual({ unread_channels: [] });
      expect(stderr).toContain('All caught up! No unread messages.');
    });

    it('prints an empty unread_channels under --fields when nothing is unread', async () => {
      await run('standard', { channels: [] }, ['--json', '--fields', 'id']);

      expect(JSON.parse(stdout)).toEqual({ unread_channels: [] });
    });
  });

  describe('text output', () => {
    it('adds a Threads line under the conversation list', async () => {
      await run('browser', { channels: [UNREAD_CHANNEL], threads: UNREAD_THREADS });

      expect(stderr).toContain('1 conversations with unread messages');
      expect(stdout).toContain('Unread Channels (1)');
      expect(stdout).toContain('general');
      expect(stdout).toContain('🧵 Threads: unread replies, 1 mention\n');
      expect(stdout.indexOf('Threads:')).toBeGreaterThan(stdout.indexOf('general'));
    });

    it('prints only the Threads line when no conversation is unread', async () => {
      await run('browser', { channels: [], threads: UNREAD_THREADS });

      expect(stderr).not.toContain('All caught up');
      expect(stderr).toContain('No unread conversations, but unread thread activity');
      expect(stdout).toBe('\n🧵 Threads: unread replies, 1 mention\n\n');
    });

    it('prints no Threads line when threads are read', async () => {
      await run('browser', { channels: [UNREAD_CHANNEL], threads: READ_THREADS });

      expect(stdout).toContain('Unread Channels (1)');
      expect(stdout).not.toContain('Threads');
    });

    it('prints no Threads line with an app token', async () => {
      await run('standard', {
        channels: [{ id: 'C0123456789', name: 'general', is_member: true, unread_count: 4 }],
        threads: UNREAD_THREADS,
      });

      expect(stdout).toContain('Unread Channels (1)');
      expect(stdout).not.toContain('Threads');
    });

    it('stays "All caught up!" when nothing is unread', async () => {
      await run('browser', { channels: [], threads: READ_THREADS });

      expect(stdout).toBe('');
      expect(stderr).toContain('All caught up! No unread messages.');
    });

    it('stays "All caught up!" with an app token, and when --types filters every conversation out', async () => {
      await run('standard', { channels: [] });
      expect(stdout).toBe('');
      expect(stderr).toContain('All caught up! No unread messages.');

      stderr = '';
      await run('browser', { channels: [UNREAD_CHANNEL], threads: READ_THREADS }, ['--types', 'groups']);
      expect(stdout).toBe('');
      expect(stderr).toContain('All caught up! No unread messages.');
    });
  });

  // `--messages` (#361): the unread messages and unread thread replies, read
  // through a stub that records every call it gets.
  describe('--messages', () => {
    const msg = (ts: string, text: string, extra: Record<string, unknown> = {}) => ({ type: 'message', user: 'U0123456789', text, ts, ...extra });
    const FIVE = ['C0000000001', 'C0000000002', 'C0000000003', 'C0000000004', 'C0000000005'];
    const THREAD_VIEW = {
      ok: true,
      has_more: false,
      threads: [{
        root_msg: { ...msg('1700000100.000000', 'root question'), thread_ts: '1700000100.000000', channel: 'C0123456789', latest_reply: '1700000102.000000', reply_count: 2 },
        unread_replies: [
          msg('1700000101.000000', 'first reply', { thread_ts: '1700000100.000000', user: 'U0987654321' }),
          msg('1700000102.000000', 'second reply', { thread_ts: '1700000100.000000' }),
        ],
      }],
    };

    interface Scenario {
      counts: Record<string, unknown>;
      history?: Record<string, { messages: unknown[]; has_more?: boolean }>;
      view?: unknown | Error;
    }

    let calls: Array<{ method: string; args: unknown[] }>;

    function messagesClient(authType: 'browser' | 'standard', scenario: Scenario): unknown {
      const record = (method: string, ...args: unknown[]) => { calls.push({ method, args }); };
      return {
        authType,
        requireBrowserAuth: (message: string) => {
          if (authType === 'standard') throw new UnsupportedAuthTypeError(message);
        },
        getUnreadCounts: async () => { record('getUnreadCounts'); return structuredClone({ ok: true, ...scenario.counts }); },
        getConversationInfo: async (id: string) => ({ ok: true, channel: CHANNELS[id] ?? { id, name: `chan-${id.slice(-1)}` } }),
        getUserInfo: async () => ({ ok: true, user: { id: 'U0123456789', name: 'alice', real_name: 'Alice' } }),
        getConversationHistory: async (id: string, options: unknown) => {
          record('getConversationHistory', id, options);
          return structuredClone({ ok: true, messages: [], ...scenario.history?.[id] });
        },
        getUnreadThreadView: async (options: unknown) => {
          record('getUnreadThreadView', options);
          if (scenario.view instanceof Error) throw scenario.view;
          return structuredClone(scenario.view ?? { ok: true, threads: [], has_more: false });
        },
        getUsersInfo: async (ids: string[]) => {
          record('getUsersInfo', ids);
          return { ok: true, users: ids.map((id) => ({ id, name: id === 'U0123456789' ? 'alice' : 'bob', real_name: id === 'U0123456789' ? 'Alice' : 'Bob', profile: { email: `${id.toLowerCase()}@acme.test` } })) };
        },
      };
    }

    async function runMessages(authType: 'browser' | 'standard', scenario: Scenario, args: string[], exitCode = 0): Promise<void> {
      calls = [];
      spyOn(authLib, 'getAuthenticatedClient').mockResolvedValue(messagesClient(authType, scenario) as any);
      await createConversationsCommand().parseAsync(['unread', ...args], { from: 'user' });
      expect(process.exitCode).toBe(exitCode);
    }

    const historyCalls = () => calls.filter((call) => call.method === 'getConversationHistory');
    const lastError = () => JSON.parse(stderr.trim().split('\n').at(-1) as string).error;

    const ONE: Scenario = {
      counts: {
        channels: [{ ...UNREAD_CHANNEL, last_read: '1700000001.000000', latest: '1700000003.000000' }],
        threads: UNREAD_THREADS,
      },
      // Slack answers newest first, and may include the message at the cursor.
      history: { C0123456789: { messages: [msg('1700000003.000000', 'third'), msg('1700000002.000000', 'second'), msg('1700000001.000000', 'already read')] } },
      view: THREAD_VIEW,
    };

    it('adds the unread messages, the unread threads and their authors to --json', async () => {
      await runMessages('browser', ONE, ['--messages', '--json']);

      expect(JSON.parse(stdout)).toEqual({
        unread_channels: [{
          id: 'C0123456789',
          mention_count: 2,
          has_unreads: true,
          is_private: false,
          name: 'general',
          last_read: '1700000001.000000',
          latest: '1700000003.000000',
          messages: [msg('1700000002.000000', 'second'), msg('1700000003.000000', 'third')].map(({ ts, user, text, type }) => ({ ts, user, text, type })),
        }],
        threads: {
          has_unreads: true,
          mention_count: 1,
          items: [{
            channel_id: 'C0123456789',
            thread_ts: '1700000100.000000',
            root: { ts: '1700000100.000000', thread_ts: '1700000100.000000', user: 'U0123456789', text: 'root question', type: 'message', reply_count: 2 },
            unread_replies: [
              { ts: '1700000101.000000', thread_ts: '1700000100.000000', user: 'U0987654321', text: 'first reply', type: 'message' },
              { ts: '1700000102.000000', thread_ts: '1700000100.000000', user: 'U0123456789', text: 'second reply', type: 'message' },
            ],
          }],
        },
        users: [
          { id: 'U0123456789', name: 'alice', real_name: 'Alice', email: 'u0123456789@acme.test' },
          { id: 'U0987654321', name: 'bob', real_name: 'Bob', email: 'u0987654321@acme.test' },
        ],
      });
      expect(historyCalls().map((call) => call.args)).toEqual([['C0123456789', { oldest: '1700000001.000000', limit: 20 }]]);
    });

    it('holds only messages newer than last_read, each list capped by --limit', async () => {
      const scenario: Scenario = {
        counts: { channels: [{ ...UNREAD_CHANNEL, last_read: '1700000001.000000' }], threads: READ_THREADS },
        history: { C0123456789: { messages: ['5', '4', '3', '2', '1'].map((n) => msg(`170000000${n}.000000`, `m${n}`)) } },
      };

      await runMessages('browser', scenario, ['--messages', '--limit', '2', '--json']);

      const [item] = JSON.parse(stdout).unread_channels;
      expect(item.messages.map((m: { ts: string }) => m.ts)).toEqual(['1700000002.000000', '1700000003.000000']);
      expect(item.has_more).toBe(true);
      expect(historyCalls()[0].args[1]).toEqual({ oldest: '1700000001.000000', limit: 2 });
    });

    it('reads --max-conversations conversations, mentions first, and reports the rest without messages', async () => {
      const scenario: Scenario = {
        counts: {
          channels: FIVE.map((id, index) => ({ id, has_unreads: true, mention_count: index === 3 ? 4 : 0, last_read: '1700000000.000000' })),
          threads: READ_THREADS,
        },
      };

      await runMessages('browser', scenario, ['--messages', '--max-conversations', '2', '--json']);

      // Exactly two reads: the mentioned conversation, then the first by name.
      expect(historyCalls().map((call) => call.args[0])).toEqual(['C0000000004', 'C0000000001']);
      const items = JSON.parse(stdout).unread_channels;
      expect(items.map((item: { id: string }) => item.id)).toEqual(['C0000000004', 'C0000000001', 'C0000000002', 'C0000000003', 'C0000000005']);
      expect(items.map((item: object) => 'messages' in item)).toEqual([true, true, false, false, false]);
      expect(items[4].last_read).toBe('1700000000.000000');
    });

    it('reads 10 conversations by default', async () => {
      const ids = Array.from({ length: 12 }, (_, index) => `C00000000${String(index).padStart(2, '0')}`);
      await runMessages('browser', { counts: { channels: ids.map((id) => ({ id, has_unreads: true, mention_count: 0 })), threads: READ_THREADS } }, ['--messages', '--json']);

      expect(historyCalls()).toHaveLength(10);
      expect(historyCalls()[0].args[1]).toEqual({ oldest: undefined, limit: 20 });
    });

    it('applies --types before choosing which conversations to read', async () => {
      const scenario: Scenario = {
        counts: { channels: [{ ...UNREAD_CHANNEL, last_read: '1700000001.000000' }], ims: [{ ...UNREAD_DM, last_read: '1700000001.000000' }], threads: READ_THREADS },
      };

      await runMessages('browser', scenario, ['--messages', '--types', 'dms', '--max-conversations', '1', '--json']);

      expect(historyCalls().map((call) => call.args[0])).toEqual(['D0123456789']);
      expect(JSON.parse(stdout).unread_channels.map((item: { id: string }) => item.id)).toEqual(['D0123456789']);
    });

    describe('when the thread view is unavailable', () => {
      it.each([
        ['fails', new Error('Slack API error: unknown_method')],
        ['returns an unexpected shape', { ok: true, view: 'changed' }],
      ])('still exits 0 with the thread summary only when it %s', async (_label, view) => {
        await runMessages('browser', { ...ONE, view }, ['--messages', '--json']);

        const out = JSON.parse(stdout);
        expect(out.threads).toEqual({ has_unreads: true, mention_count: 1 });
        expect(out.unread_channels[0].messages).toHaveLength(2);
        expect(stderr).toContain('Could not read the unread threads');
      });

      it('prints the summary line in the text output', async () => {
        await runMessages('browser', { ...ONE, view: new Error('Slack API error: unknown_method') }, ['--messages']);

        expect(stdout).toContain('🧵 Threads: unread replies, 1 mention\n');
        expect(stdout).not.toContain('Unread Threads');
        expect(stdout).toContain('second');
      });
    });

    it('skips the thread view and prints items: [] when no thread is unread', async () => {
      await runMessages('browser', { ...ONE, counts: { ...ONE.counts, threads: READ_THREADS } }, ['--messages', '--json']);

      expect(calls.some((call) => call.method === 'getUnreadThreadView')).toBe(false);
      expect(JSON.parse(stdout).threads).toEqual({ has_unreads: false, mention_count: 0, items: [] });
    });

    it('prints the usual empty object, with items and users, when nothing is unread', async () => {
      await runMessages('browser', { counts: { channels: [], threads: READ_THREADS } }, ['--messages', '--json']);

      expect(JSON.parse(stdout)).toEqual({ unread_channels: [], threads: { has_unreads: false, mention_count: 0, items: [] }, users: [] });
      expect(stderr).toContain('All caught up! No unread messages.');
      expect(calls.map((call) => call.method)).toEqual(['getUnreadCounts']);
    });

    it('lists unread threads when no conversation is unread', async () => {
      await runMessages('browser', { counts: { channels: [], threads: UNREAD_THREADS }, view: THREAD_VIEW }, ['--messages', '--json']);

      const out = JSON.parse(stdout);
      expect(out.unread_channels).toEqual([]);
      expect(out.threads.items).toHaveLength(1);
      expect(stderr).toContain('No unread conversations, but unread thread activity');
    });

    it('projects the new keys with --fields and keeps threads and users whole', async () => {
      await runMessages('browser', ONE, ['--messages', '--json', '--fields', 'id,messages.ts,messages.text']);

      const out = JSON.parse(stdout);
      expect(out.unread_channels).toEqual([{
        id: 'C0123456789',
        messages: [{ ts: '1700000002.000000', text: 'second' }, { ts: '1700000003.000000', text: 'third' }],
      }]);
      expect(out.threads.items).toHaveLength(1);
      expect(out.users).toHaveLength(2);
    });

    it('prints each conversation with its messages, then the unread threads', async () => {
      await runMessages('browser', ONE, ['--messages']);

      expect(stdout).toContain('Unread Channels (1)');
      expect(stdout).toContain('@Alice');
      expect(stdout).toContain('second');
      expect(stdout).toContain('third');
      expect(stdout).not.toContain('already read');
      expect(stdout.indexOf('second')).toBeGreaterThan(stdout.indexOf('general'));
      expect(stdout.indexOf('third')).toBeGreaterThan(stdout.indexOf('second'));
      expect(stdout).toContain('🧵 Unread Threads (1)');
      expect(stdout).toContain('general (C0123456789, thread 1700000100.000000)');
      expect(stdout.indexOf('root question')).toBeGreaterThan(stdout.indexOf('Unread Threads'));
      expect(stdout.indexOf('first reply')).toBeGreaterThan(stdout.indexOf('root question'));
      expect(stdout).toContain('@Bob');
      expect(stdout).not.toContain('🧵 Threads:');
    });

    it('says in the text output which conversations were not read and which were cut', async () => {
      const scenario: Scenario = {
        counts: { channels: FIVE.map((id) => ({ id, has_unreads: true, mention_count: 0, last_read: '1700000000.000000' })), threads: READ_THREADS },
        history: { C0000000001: { messages: [msg('1700000002.000000', 'two'), msg('1700000001.000000', 'one')] } },
      };

      await runMessages('browser', scenario, ['--messages', '--max-conversations', '2', '--limit', '1']);

      expect(stdout).toContain('one');
      expect(stdout).not.toContain('two');
      expect(stdout).toContain('… more messages not shown; raise --limit');
      expect(stdout).toContain('(no new top-level messages)');
      expect(stdout).toContain('3 conversations not read; raise --max-conversations to include them.');
    });

    describe('with an app token', () => {
      it('fails with unsupported_auth_type and makes no Slack call', async () => {
        await runMessages('standard', { counts: { channels: [] } }, ['--messages', '--json'], 1);

        expect(stdout).toBe('');
        expect(lastError()).toMatchObject({ code: 'unsupported_auth_type', retryable: false });
        expect(lastError().message).toContain('--messages');
        expect(calls).toEqual([]);
      });

      it('says so in the text output too', async () => {
        await runMessages('standard', { counts: { channels: [] } }, ['--messages'], 1);

        expect(stdout).toBe('');
        expect(stderr).toContain('requires browser authentication');
        expect(calls).toEqual([]);
      });
    });

    describe('flag validation', () => {
      it.each([
        [['--max-conversations', '3', '--json'], '--max-conversations only applies with --messages'],
        [['--limit', '3', '--json'], '--limit only applies with --messages'],
        [['--messages', '--max-conversations', '0', '--json'], '--max-conversations must be a positive integer'],
        [['--messages', '--limit', '-2', '--json'], '--limit must be an integer from 1 to 999'],
        [['--messages', '--limit', 'ten', '--json'], '--limit must be an integer from 1 to 999'],
        [['--messages', '--limit', '1000', '--json'], '--limit must be an integer from 1 to 999'],
      ])('refuses %j with invalid_input before any Slack call', async (args, expected) => {
        const getClient = spyOn(authLib, 'getAuthenticatedClient');
        await runMessages('browser', ONE, args, 1);

        expect(stdout).toBe('');
        expect(lastError()).toMatchObject({ code: 'invalid_input' });
        expect(lastError().message).toContain(expected);
        expect(calls).toEqual([]);
        expect(getClient).not.toHaveBeenCalled();
      });
    });

    it('fails the command when a conversation cannot be read', async () => {
      spyOn(authLib, 'getAuthenticatedClient').mockResolvedValue({
        ...(messagesClient('browser', ONE) as object),
        getConversationHistory: async () => {
          throw Object.assign(new Error('Slack API error: channel_not_found'), { slackData: { ok: false, error: 'channel_not_found' } });
        },
      } as any);
      calls = [];
      await createConversationsCommand().parseAsync(['unread', '--messages', '--json'], { from: 'user' });

      expect(process.exitCode).toBe(1);
      expect(stdout).toBe('');
      expect(lastError().slack_error).toBe('channel_not_found');
    });

    describe('logging', () => {
      afterEach(() => resetSync());

      it('writes no message text to any log record', async () => {
        const records: LogRecord[] = [];
        configureLogging({ level: 'trace', verbose: false, sinks: { capture: (r) => records.push(r) } });

        await runMessages('browser', ONE, ['--messages', '--json']);

        // The text reached stdout, so it did pass through the code that logs.
        for (const text of ['second', 'third', 'root question', 'first reply', 'second reply']) {
          expect(stdout).toContain(text);
        }
        const unreadRecords = records.filter((r) => r.category.join('.') === 'slackcli.unread');
        expect(unreadRecords.length).toBeGreaterThanOrEqual(2);
        const logged = JSON.stringify(records.map((r) => [r.rawMessage, r.message, r.properties]));
        for (const text of ['second', 'third', 'already read', 'root question', 'first reply', 'Alice', 'acme.test']) {
          expect(logged).not.toContain(text);
        }
      });
    });
  });
});
