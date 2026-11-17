import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as authLib from '../lib/auth.ts';
import { createRemindersCommand } from './reminders.ts';
import { UnsupportedAuthTypeError } from '../lib/cli-errors.ts';

const ID = 'Sa0ABC123';
const LEGACY = 'Rm0ABC123';
const ROW = { item_id: ID, item_type: 'reminder', todo_state: 'to_do', date_due: 1893492000,
  description: [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [
    { type: 'text', text: 'Take a break' },
  ] }] }] };

function client(overrides: Record<string, any> = {}) {
  const calls: Array<[string, any[]]> = [];
  let created = false;
  const defaults: Record<string, (...args: any[]) => unknown> = {
    listReminderItems: () => ({ saved_items: created ? [ROW] : [] }),
    listReminders: () => ({ reminders: [] }),
    addReminder: () => { created = true; return { reminder: { id: LEGACY, text: 'Take a break', time: 1893492000, recurring: false } }; },
    getReminder: () => ({ reminder: { id: LEGACY, text: 'Weekly report', recurring: true } }),
    updateSavedReminder: () => ({ ok: true }), deleteSavedReminder: () => ({ ok: true }),
    completeReminder: () => ({ ok: true }), deleteReminder: () => ({ ok: true }),
  };
  const stub: any = {
    authType: 'browser', storedUserId: 'U0123456789',
    workspaceIdentity: { id: 'T0123456789', name: 'Acme', profile: 'acme' },
    requireReminderUserAuth: () => {},
    requireBrowserAuth: () => { if (stub.authType !== 'browser') throw new UnsupportedAuthTypeError('Browser login required'); },
  };
  for (const method of Object.keys(defaults)) {
    stub[method] = async (...args: any[]) => {
      calls.push([method, args]);
      return (overrides[method] ?? defaults[method])(...args);
    };
  }
  return { stub, calls };
}

describe('reminders commands', () => {
  const realIsTTY = process.stdin.isTTY;
  let stdout: string;
  let stderr: string;
  let previousExitCode: typeof process.exitCode;

  beforeEach(() => {
    stdout = ''; stderr = ''; previousExitCode = process.exitCode; process.exitCode = 0;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => { stdout += chunk.toString(); return true; }) as typeof process.stdout.write);
    spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => { stderr += chunk.toString(); return true; }) as typeof process.stderr.write);
    spyOn(console, 'log').mockImplementation((...args: unknown[]) => { stdout += args.join(' ') + '\n'; });
    spyOn(console, 'error').mockImplementation((...args: unknown[]) => { stderr += args.join(' ') + '\n'; });
  });
  afterEach(() => {
    mock.restore(); process.exitCode = previousExitCode ?? 0;
    Object.defineProperty(process.stdin, 'isTTY', { value: realIsTTY, configurable: true });
  });
  async function run(stub: any, args: string[]) {
    spyOn(authLib, 'getAuthenticatedClient').mockResolvedValue(stub);
    await createRemindersCommand().parseAsync(args, { from: 'user' });
  }
  function lastError() { return JSON.parse(stderr.trimEnd().split('\n').at(-1)!).error; }

  it('creates for the logged-in user and prints one manageable ID, preserving natural language and recurrence', async () => {
    const { stub, calls } = client();
    await run(stub, ['add', '--text', 'Take a break', '--time', 'in 5 minutes', '--recurrence', '{"frequency":"daily"}', '--workspace', 'acme', '--json']);
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ id: ID, reminder_id: LEGACY, source: 'saved', text: 'Take a break' });
    expect(calls).toContainEqual(['addReminder', [{ text: 'Take a break', time: 'in 5 minutes', recurrence: { frequency: 'daily' } }]]);
    expect(authLib.getAuthenticatedClient).toHaveBeenCalledWith('acme');
  });

  it('prints one object even when there are no reminders', async () => {
    const { stub } = client();
    await run(stub, ['list', '--json']);
    expect(JSON.parse(stdout)).toEqual({ reminder_count: 0, reminders: [] });
  });

  it('lists and projects completed modern reminders without message lookups', async () => {
    const { stub } = client({ listReminderItems: () => ({ saved_items: [{ ...ROW, todo_state: 'completed' }] }) });
    await run(stub, ['list', '--json', '--fields', 'id,text,todo_state']);
    expect(JSON.parse(stdout)).toEqual({ reminder_count: 1, reminders: [{ id: ID, text: 'Take a break', todo_state: 'completed' }] });
  });

  it('reads a legacy reminder and projects the record', async () => {
    const { stub, calls } = client();
    await run(stub, ['info', LEGACY, '--json', '--fields', 'id,text']);
    expect(JSON.parse(stdout)).toEqual({ id: LEGACY, text: 'Weekly report' });
    expect(calls).toEqual([['getReminder', [LEGACY]]]);
  });

  it('updates modern text and time together and echoes the change', async () => {
    const { stub, calls } = client();
    await run(stub, ['update', ID, '--text', 'Edited', '--time', '1893492000', '--yes', '--json']);
    expect(JSON.parse(stdout)).toEqual({ id: ID, updated: true, text: 'Edited', time: 1893492000 });
    expect(calls).toEqual([['updateSavedReminder', [ID, { date_due: 1893492000, description: [
      { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'Edited' }] }] },
    ] }]]]);
  });

  it.each([
    ['complete', ID, 'updateSavedReminder', { id: ID, completed: true }],
    ['delete', ID, 'deleteSavedReminder', { id: ID, deleted: true }],
    ['complete', LEGACY, 'completeReminder', { id: LEGACY, completed: true }],
    ['delete', LEGACY, 'deleteReminder', { id: LEGACY, deleted: true }],
  ] as const)('%s routes %s to %s', async (name, id, method, output) => {
    const { stub, calls } = client();
    await run(stub, [name, id, '--yes', '--json']);
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual(output);
    expect(calls[0][0]).toBe(method);
  });

  it.each(['update', 'complete', 'delete'])('refuses unattended %s without --yes', async (name) => {
    const { stub, calls } = client();
    await run(stub, [name, ID, ...(name === 'update' ? ['--text', 'Edited'] : []), '--json']);
    expect(process.exitCode).toBe(1); expect(stdout).toBe(''); expect(calls).toEqual([]);
    expect(lastError()).toMatchObject({ code: 'confirmation_required', retryable: false });
  });

  it.each(['add', 'update', 'complete', 'delete'])('previews %s with no writes, reads or confirmation', async (name) => {
    const { stub, calls } = client();
    const args = name === 'add' ? ['--text', 'Task', '--time', 'in 5 minutes']
      : [ID, ...(name === 'update' ? ['--text', 'Edited'] : [])];
    await run(stub, [name, ...args, '--dry-run', '--json']);
    expect(process.exitCode).toBe(0); expect(calls).toEqual([]);
    expect(JSON.parse(stdout)).toMatchObject({ dry_run: true, action: `${name} reminder` });
    expect(stderr).not.toContain('[y/N]');
  });

  it.each([['add', '--time', 'in 5 minutes'], ['update', ID], ['delete', 'C123'],
    ['add', '--text', 'Task', '--time', 'in 5 minutes', '--recurrence', '{']].map((args) => [args]))
    ('reports invalid input before authentication: %j', async (args) => {
      const { stub, calls } = client();
      await run(stub, [...args, '--json']);
      expect(authLib.getAuthenticatedClient).not.toHaveBeenCalled(); expect(calls).toEqual([]);
      expect(process.exitCode).toBe(1); expect(stdout).toBe('');
      expect(lastError()).toMatchObject({ code: 'invalid_input', retryable: false });
    });

  it('refuses a modern dry run on standard auth', async () => {
    const { stub, calls } = client(); stub.authType = 'standard';
    await run(stub, ['delete', ID, '--dry-run', '--json']);
    expect(process.exitCode).toBe(1); expect(calls).toEqual([]);
    expect(lastError().code).toBe('unsupported_auth_type');
  });

  it.each([['ratelimited', 'rate_limited', true], ['cannot_complete_recurring', 'invalid_input', false], ['not_found', 'not_found', false]])
    ('keeps the last stderr line structured for %s', async (slackError, code, retryable) => {
      const { stub } = client({ completeReminder: () => { throw Object.assign(new Error(`Slack API error: ${slackError}`), { slackData: { error: slackError } }); } });
      await run(stub, ['complete', LEGACY, '--yes', '--json']);
      expect(process.exitCode).toBe(1); expect(stdout).toBe('');
      expect(lastError()).toMatchObject({ code, retryable, slack_error: slackError });
    });

  it('prints reminder content in text mode', async () => {
    const { stub } = client();
    await run(stub, ['info', LEGACY]);
    expect(stdout).toContain('Weekly report'); expect(stdout).toContain(LEGACY);
  });
});

describe('reminders usage errors through the CLI', () => {
  it.each([
    ['info', '--json'], ['delete', '--json'], ['add', '--time', '--json'], ['list', '--bogus', '--json'],
  ].map((args) => [args]))('ends stderr with structured JSON for %j', (args) => {
    const result = Bun.spawnSync([process.execPath, 'run', new URL('../index.ts', import.meta.url).pathname, 'reminders', ...args], {
      stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH, SLACKCLI_LOG_LEVEL: 'off' },
    });
    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stdout)).toBe('');
    const stderr = new TextDecoder().decode(result.stderr);
    expect(JSON.parse(stderr.trimEnd().split('\n').at(-1)!).error).toMatchObject({ code: 'invalid_input', retryable: false });
  });
});
