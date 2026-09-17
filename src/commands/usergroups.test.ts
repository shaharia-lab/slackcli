import { afterEach, describe, expect, it } from 'bun:test';
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
  afterEach(() => {
    // Restore whatever the runner's stdin was.
    Object.defineProperty(process.stdin, 'isTTY', { value: realIsTTY, configurable: true });
  });

  it('proceeds without prompting when --yes is set (even non-TTY)', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    expect(await confirmWrite('Do it?', true)).toBe(true);
  });

  it('refuses when stdin is not a TTY and --yes is absent', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    expect(await confirmWrite('Do it?', false)).toBe(false);
  });
});
