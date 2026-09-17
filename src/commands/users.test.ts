import { describe, expect, it } from 'bun:test';
import { createUsersCommand } from './users.ts';
import { createSearchCommand } from './search.ts';

function usersSub(name: string) {
  return createUsersCommand().commands.find((c) => c.name() === name);
}
function searchSub(name: string) {
  return createSearchCommand().commands.find((c) => c.name() === name);
}
function longs(cmd: any): string[] {
  return (cmd?.options ?? []).map((o: any) => o.long ?? '');
}

describe('users command wiring', () => {
  it('exposes info and list subcommands', () => {
    const names = createUsersCommand().commands.map((c) => c.name());
    expect(names).toContain('info');
    expect(names).toContain('list');
  });

  it('users info carries --resolve-fields, --workspace and --json', () => {
    expect(longs(usersSub('info'))).toEqual(
      expect.arrayContaining(['--resolve-fields', '--workspace', '--json']),
    );
  });

  it('users list carries --limit, --status, --resolve-fields, --workspace and --json', () => {
    expect(longs(usersSub('list'))).toEqual(
      expect.arrayContaining(['--limit', '--status', '--resolve-fields', '--workspace', '--json']),
    );
  });
});

describe('search people wiring', () => {
  // Decision 2: --resolve-fields must ship on search people in the SAME PR, using
  // the shared resolver, so the flag is consistent across all three surfaces.
  it('search people carries --resolve-fields', () => {
    expect(longs(searchSub('people'))).toContain('--resolve-fields');
  });
});
