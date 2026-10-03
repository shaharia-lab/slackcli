import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as readline from 'node:readline';
import { confirmWrite, createUsergroupsCommand, parseUserIds } from './usergroups.ts';

function subcommand(name: string) {
  return createUsergroupsCommand().commands.find((command) => command.name() === name);
}

function longOptions(name: string): string[] {
  return (subcommand(name)?.options ?? []).map((option) => option.long ?? '');
}

describe('usergroups command', () => {
  it('exposes the read and write subcommands', () => {
    const names = createUsergroupsCommand().commands.map((command) => command.name());
    expect(names).toEqual(
      expect.arrayContaining(['list', 'read', 'create', 'update', 'add', 'remove', 'enable', 'disable']),
    );
  });

  it('puts --yes on every write subcommand', () => {
    for (const name of ['create', 'update', 'add', 'remove', 'enable', 'disable']) {
      expect(longOptions(name)).toContain('--yes');
    }
  });

  it('does not add --yes to the read-only subcommands', () => {
    expect(longOptions('list')).not.toContain('--yes');
    expect(longOptions('read')).not.toContain('--yes');
  });
});

describe('parseUserIds', () => {
  it('splits on commas and whitespace', () => {
    expect(parseUserIds(['U1,U2 U3', 'U4'])).toEqual(['U1', 'U2', 'U3', 'U4']);
  });
  it('strips a leading @ and drops empties', () => {
    expect(parseUserIds(['@U1', '', ' , ', 'U2'])).toEqual(['U1', 'U2']);
  });
  it('returns an empty array for no ids', () => {
    expect(parseUserIds([''])).toEqual([]);
  });
});

describe('confirmWrite', () => {
  const realIsTTY = process.stdin.isTTY;
  let savedExitCode: typeof process.exitCode;
  beforeEach(() => {
    savedExitCode = process.exitCode;
  });
  afterEach(() => {
    // Restore whatever the runner's stdin was.
    Object.defineProperty(process.stdin, 'isTTY', { value: realIsTTY, configurable: true });
    // A refusal sets exit code 1; do not let it become the test run's own.
    process.exitCode = savedExitCode ?? 0;
    mock.restore();
  });

  it('proceeds without prompting when --yes is set (even non-TTY)', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    expect(await confirmWrite('Do it?', true)).toBe(true);
  });

  it('refuses when stdin is not a TTY and --yes is absent', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    expect(await confirmWrite('Do it?', false)).toBe(false);
  });

  it('sets exit code 1 and prints the text refusal on a non-TTY refusal', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    const lines: string[] = [];
    spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
    const written = spyOn(process.stderr, 'write').mockImplementation((() => true) as typeof process.stderr.write);
    process.exitCode = 0;
    expect(await confirmWrite('Do it?', false)).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(lines.join('\n')).toContain('Refusing to run this write unattended.');
    expect(written).not.toHaveBeenCalled();
  });

  it.each([
    [false, ''],
    [true, 'The write was not confirmed.'],
  ])('sets exit code 1 when the prompt is declined (json %p)', async (json, message) => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    spyOn(readline, 'createInterface').mockReturnValue({
      question: (_query: string, answer: (text: string) => void) => answer('n'),
      close: () => {},
    } as unknown as readline.Interface);
    let stderr = '';
    spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    }) as typeof process.stderr.write);
    process.exitCode = 0;
    expect(await confirmWrite('Do it?', false, json)).toBe(false);
    expect(process.exitCode).toBe(1);
    if (json) {
      expect(JSON.parse(stderr).error).toEqual({ code: 'confirmation_required', message, retryable: false });
    } else {
      // Declining is silent in text mode, as it always was.
      expect(stderr).toBe('');
    }
  });

  it('reports a non-TTY refusal as a confirmation_required object under --json', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    const printed = spyOn(console, 'error').mockImplementation(() => {});
    let stderr = '';
    spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    }) as typeof process.stderr.write);
    process.exitCode = 0;
    expect(await confirmWrite('Do it?', false, true)).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(printed).not.toHaveBeenCalled();
    expect(JSON.parse(stderr).error).toMatchObject({
      code: 'confirmation_required',
      hint: 'Re-run with --yes to confirm the write.',
      retryable: false,
    });
  });
});
