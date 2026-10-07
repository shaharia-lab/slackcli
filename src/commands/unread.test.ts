// `conversations unread` and the thread summary (#264), in process with the
// Slack client stubbed: what reaches stdout for each mix of unread
// conversations and unread threads, on both auth types.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as authLib from '../lib/auth.ts';
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

    it('stays "All caught up!" with nothing on stdout when no conversation and no thread is unread', async () => {
      await run('browser', { channels: [], threads: READ_THREADS }, ['--json']);

      expect(stdout).toBe('');
      expect(stderr).toContain('All caught up! No unread messages.');
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

    it('ignores a threads key on the response and stays "All caught up!"', async () => {
      await run('standard', { channels: [], threads: UNREAD_THREADS }, ['--json']);

      expect(stdout).toBe('');
      expect(stderr).toContain('All caught up! No unread messages.');
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
  });
});
