// `saved add|update|complete|reopen|remove` end to end in process, with the
// Slack client stubbed: the exact change each command sends for the one item,
// the --json shape, the remove confirmation gate, and the app-token refusal.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as authLib from '../lib/auth.ts';
import { UnsupportedAuthTypeError } from '../lib/cli-errors.ts';
import { SAVED_WRITE_AUTH_MESSAGE } from '../lib/slack-client.ts';
import { createSavedCommand } from './saved.ts';

const TS = '1712345678.000100';
const TARGET = ['--channel-id', 'C0123456789', '--timestamp', TS];
const PERMALINK = 'https://acme.slack.com/archives/C0123456789/p1712345678000100';

// A browser-auth stub. Each write records its call and answers with the item
// as Slack does, built from what was sent.
function client(overrides: Record<string, (...args: any[]) => Promise<unknown>> = {}) {
  const calls: Array<[string, unknown[]]> = [];
  const record = (name: string, fn: (...a: any[]) => Promise<unknown>) =>
    (...args: unknown[]) => { calls.push([name, args]); return (overrides[name] ?? fn)(...args); };
  return {
    calls,
    stub: {
      authType: 'browser',
      workspaceHost: 'acme.slack.com',
      workspaceIdentity: { id: 'T0123456789', name: 'Acme', profile: 'acme' },
      requireBrowserAuth: () => {},
      addSavedItem: record('addSavedItem', async (channel: string, ts: string, dateDue: number) => ({
        ok: true, item: { item_id: channel, item_type: 'message', ts, todo_state: 'to_do', date_due: dateDue },
      })),
      updateSavedItem: record('updateSavedItem', async (channel: string, ts: string, update: any) => ({
        ok: true, item: { item_id: channel, item_type: 'message', ts, todo_state: update.todo_state ?? 'to_do', ...update },
      })),
      deleteSavedItem: record('deleteSavedItem', async () => ({ ok: true })),
      deleteSavedReminder: record('deleteSavedReminder', async () => ({ ok: true })),
      listSavedItems: record('listSavedItems', async () => ({ saved_items: [] })),
    },
  };
}

describe('saved writes (command)', () => {
  const realIsTTY = process.stdin.isTTY;
  let stdout: string;
  let stderr: string;
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    stdout = '';
    stderr = '';
    savedExitCode = process.exitCode;
    process.exitCode = 0;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
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
    Object.defineProperty(process.stdin, 'isTTY', { value: realIsTTY, configurable: true });
    process.exitCode = savedExitCode ?? 0;
  });

  async function run(stub: unknown, argv: string[]) {
    spyOn(authLib, 'getAuthenticatedClient').mockResolvedValue(stub as any);
    await createSavedCommand().parseAsync(argv, { from: 'user' });
  }

  function lastError(): any {
    const lines = stderr.trimEnd().split('\n');
    return JSON.parse(lines[lines.length - 1]).error;
  }

  it('add sends a to-do due now and prints { channel_id, ts, todo_state, date_due }', async () => {
    const { stub, calls } = client();
    const before = Math.floor(Date.now() / 1000);

    await run(stub, ['add', ...TARGET, '--json']);

    const after = Math.floor(Date.now() / 1000);
    expect(process.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    const [method, [channel, ts, dateDue]] = calls[0] as [string, [string, string, number]];
    expect([method, channel, ts]).toEqual(['addSavedItem', 'C0123456789', TS]);
    expect(dateDue).toBeGreaterThanOrEqual(before);
    expect(dateDue).toBeLessThanOrEqual(after);
    expect(JSON.parse(stdout)).toEqual({ channel_id: 'C0123456789', ts: TS, todo_state: 'to_do', date_due: dateDue });
  });

  it('add takes --due and the message from --permalink', async () => {
    const { stub, calls } = client();

    await run(stub, ['add', '--permalink', PERMALINK, '--due', '2026-10-12T09:50:00Z', '--json']);

    expect(calls).toEqual([['addSavedItem', ['C0123456789', TS, Date.UTC(2026, 9, 12, 9, 50) / 1000]]]);
  });

  it('add says what it did in text mode', async () => {
    const { stub } = client();

    await run(stub, ['add', ...TARGET, '--due', '1791791400']);

    expect(process.exitCode).toBe(0);
    expect(stdout + stderr).toContain('Added to your Later list');
    expect(stdout + stderr).toContain(`Message ${TS}: to_do, due `);
  });

  it.each([
    [['--no-due'], { date_due: 0 }],
    [['--due', '1791791400'], { date_due: 1791791400 }],
    [['--state', 'saved'], { todo_state: 'saved', date_due: 0 }],
    [['--state', 'to_do', '--due', '1791791400'], { todo_state: 'to_do', date_due: 1791791400 }],
  ])('update %j sends %j', async (flags, update) => {
    const { stub, calls } = client();

    await run(stub, ['update', ...TARGET, ...flags, '--json']);

    expect(process.exitCode).toBe(0);
    expect(calls).toEqual([['updateSavedItem', ['C0123456789', TS, update]]]);
    expect(JSON.parse(stdout)).toMatchObject({ channel_id: 'C0123456789', ts: TS, date_due: update.date_due });
  });

  it('update refuses a change the Slack web client never makes, before any call', async () => {
    const { stub, calls } = client();

    await run(stub, ['update', ...TARGET, '--state', 'to_do', '--no-due', '--json']);

    expect(process.exitCode).toBe(1);
    expect(calls).toEqual([]);
    expect(lastError()).toMatchObject({ code: 'invalid_input' });
  });

  it('complete sends mark=completed and clears the due date', async () => {
    const { stub, calls } = client();

    await run(stub, ['complete', ...TARGET, '--json']);

    expect(calls).toEqual([['updateSavedItem', ['C0123456789', TS, { mark: 'completed', todo_state: 'completed', date_due: 0 }]]]);
    expect(JSON.parse(stdout)).toEqual({ channel_id: 'C0123456789', ts: TS, todo_state: 'completed', date_due: 0 });
  });

  it('reopen sends mark=uncompleted back to To-dos, due now', async () => {
    const { stub, calls } = client();
    const before = Math.floor(Date.now() / 1000);

    await run(stub, ['reopen', ...TARGET, '--json']);

    const [, [, , update]] = calls[0] as [string, [string, string, any]];
    expect(update).toMatchObject({ mark: 'uncompleted', todo_state: 'to_do' });
    expect(update.date_due).toBeGreaterThanOrEqual(before);
    expect(JSON.parse(stdout)).toMatchObject({ todo_state: 'to_do' });
  });

  it('remove with --yes removes the item and prints { channel_id, ts, removed: true }', async () => {
    const { stub, calls } = client();

    await run(stub, ['remove', ...TARGET, '--yes', '--json']);

    expect(process.exitCode).toBe(0);
    expect(calls).toEqual([['deleteSavedItem', ['C0123456789', TS]]]);
    expect(JSON.parse(stdout)).toEqual({ channel_id: 'C0123456789', ts: TS, removed: true });
  });

  it('remove refuses unattended without --yes and removes nothing', async () => {
    const { stub, calls } = client();

    await run(stub, ['remove', ...TARGET]);

    expect(process.exitCode).toBe(1);
    expect(calls).toEqual([]);
    expect(stderr).toContain('Saved item was not removed');
  });

  it('removes a reminder with --item-id and passes through the selected workspace', async () => {
    const { stub, calls } = client();

    await run(stub, ['remove', '--item-id', 'Sa0ABC123', '--workspace', 'acme', '--yes', '--json']);

    expect(authLib.getAuthenticatedClient).toHaveBeenCalledWith('acme');
    expect(calls).toEqual([['deleteSavedReminder', ['Sa0ABC123']]]);
    expect(JSON.parse(stdout)).toEqual({ item_id: 'Sa0ABC123', item_type: 'reminder', removed: true });
    expect(process.exitCode).toBe(0);
  });

  it('reports reminder removal in text mode', async () => {
    const { stub } = client();

    await run(stub, ['remove', '--item-id', 'Sa0ABC123', '--yes']);

    expect(stdout).toContain('Reminder item: Sa0ABC123');
  });

  it('refuses unattended reminder removal without --yes and keeps stdout empty', async () => {
    const { stub, calls } = client();

    await run(stub, ['remove', '--item-id', 'Sa0ABC123', '--json']);

    expect(process.exitCode).toBe(1);
    expect(calls).toEqual([]);
    expect(stdout).toBe('');
    expect(lastError()).toMatchObject({ code: 'confirmation_required', retryable: false });
  });

  it('previews a reminder removal without --yes, prompting, name lookups or writes', async () => {
    const { stub, calls } = client();

    await run(stub, ['remove', '--item-id', 'Sa0ABC123', '--dry-run', '--json']);

    expect(process.exitCode).toBe(0);
    expect(calls).toEqual([]);
    expect(JSON.parse(stdout)).toEqual({
      dry_run: true, action: 'remove saved item', workspace: stub.workspaceIdentity,
      target: { kind: 'reminder', id: 'Sa0ABC123' }, payload: {},
    });
    expect(stderr).not.toContain('[y/N]');
  });

  it.each([
    ['--channel-id', 'C0123456789'], ['--timestamp', TS], ['--permalink', PERMALINK],
  ])('rejects --item-id combined with %s before authentication', async (flag, value) => {
    const { stub, calls } = client();

    await run(stub, ['remove', '--item-id', 'Sa0ABC123', flag, value, '--yes', '--json']);

    expect(process.exitCode).toBe(1);
    expect(authLib.getAuthenticatedClient).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(stdout).toBe('');
    expect(lastError()).toMatchObject({ code: 'invalid_input' });
  });

  it.each(['', 'Rm0ABC123', 'C0123456789', 'Sa0ABC123,Sa0DEF456'])
    ('rejects reminder target %j even for a dry run', async (id) => {
      const { stub, calls } = client();

      await run(stub, ['remove', '--item-id', id, '--dry-run', '--json']);

      expect(process.exitCode).toBe(1);
      expect(authLib.getAuthenticatedClient).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
      expect(lastError()).toMatchObject({ code: 'invalid_input' });
    });

  it('refuses a reminder dry run on app tokens before any call', async () => {
    const { stub, calls } = client();
    stub.requireBrowserAuth = () => { throw new UnsupportedAuthTypeError(SAVED_WRITE_AUTH_MESSAGE); };

    await run(stub, ['remove', '--item-id', 'Sa0ABC123', '--dry-run', '--json']);

    expect(process.exitCode).toBe(1);
    expect(calls).toEqual([]);
    expect(lastError()).toMatchObject({ code: 'unsupported_auth_type' });
  });

  it('reports a missing reminder as not_found without claiming removal', async () => {
    const { stub } = client({ deleteSavedReminder: async () => {
      throw Object.assign(new Error('Slack API error: not_found'), { slackData: { error: 'not_found' } });
    } });

    await run(stub, ['remove', '--item-id', 'Sa0ABC123', '--yes', '--json']);

    expect(process.exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(lastError()).toMatchObject({ code: 'not_found', slack_error: 'not_found', retryable: false });
  });

  it('keeps an in-progress reminder in saved list --state to_do and supports --fields', async () => {
    const { stub } = client({ listSavedItems: async () => ({ saved_items: [{
      item_type: 'reminder', item_id: 'Sa0ABC123', date_created: 1700000000,
      date_due: 1700000060, todo_state: 'to_do', description: [{ type: 'rich_text', elements: [
        { type: 'rich_text_section', elements: [{ type: 'text', text: 'Call the vendor' }] },
      ] }],
    }] }) });

    await run(stub, ['list', '--state', 'to_do', '--json', '--fields', 'item_id,text,todo_state,date_due']);

    expect(process.exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ item_count: 1, items: [{
      item_id: 'Sa0ABC123', text: 'Call the vendor', todo_state: 'to_do', date_due: 1700000060,
    }] });
  });

  it('fails a Slack refusal with exit 1 and the Slack code', async () => {
    const { stub } = client({
      deleteSavedItem: async () => {
        throw Object.assign(new Error('Slack API error: channel_not_found'), { slackData: { ok: false, error: 'channel_not_found' } });
      },
    });

    await run(stub, ['remove', ...TARGET, '--yes', '--json']);

    expect(process.exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(lastError()).toMatchObject({ code: 'not_found', slack_error: 'channel_not_found' });
  });

  it('keeps the workspace-mismatch warning off stdout under --json', async () => {
    const { stub, calls } = client();

    await run(stub, ['complete', '--permalink', 'https://other.slack.com/archives/C0123456789/p1712345678000100', '--json']);

    expect(calls).toHaveLength(1);
    expect(stderr).toContain('belongs to the "other" workspace');
    expect(JSON.parse(stdout)).toMatchObject({ channel_id: 'C0123456789', todo_state: 'completed' });
  });

  it.each([
    ['add', []],
    ['update', ['--no-due']],
    ['complete', []],
    ['reopen', []],
    ['remove', ['--yes']],
  ] as Array<[string, string[]]>)(
    '%s on an app token fails as browser-only, before any call',
    async (command, flags) => {
      const { stub, calls } = client();
      const appToken = {
        ...stub,
        authType: 'standard',
        requireBrowserAuth: (message: string) => { throw new UnsupportedAuthTypeError(message); },
      };

      await run(appToken, [command, ...TARGET, ...flags, '--json']);

      expect(process.exitCode).toBe(1);
      expect(calls).toEqual([]);
      expect(lastError()).toMatchObject({ code: 'unsupported_auth_type', message: SAVED_WRITE_AUTH_MESSAGE });
    },
  );
});
