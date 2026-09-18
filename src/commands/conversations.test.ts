import { describe, expect, it } from 'bun:test';
import { createConversationsCommand } from './conversations.ts';

function subcommand(name: string) {
  return createConversationsCommand().commands.find((command) => command.name() === name);
}

function membersSubcommand(name: string) {
  return subcommand('members')?.commands.find((command) => command.name() === name);
}

function longOptions(name: string): string[] {
  return (subcommand(name)?.options ?? []).map((option) => option.long ?? '');
}

function membersListOptions(): string[] {
  return (membersSubcommand('list')?.options ?? []).map((option) => option.long ?? '');
}

function argumentNames(name: string): Array<{ name: string; required: boolean }> {
  return (subcommand(name)?.registeredArguments ?? []).map((argument) => ({
    name: argument.name(),
    required: argument.required,
  }));
}

describe('conversations command', () => {
  // The positionals became optional so --permalink can supply them; the requirement
  // is enforced in resolveMessageTarget / resolveThreadTarget instead, which is what
  // produces the "Missing <channel-id>" error when neither form is given.
  it('makes read take an optional channel positional plus --permalink', () => {
    expect(argumentNames('read')).toEqual([{ name: 'channel-id', required: false }]);
    expect(longOptions('read')).toContain('--permalink');
  });

  it('makes get take optional channel and timestamp positionals plus --permalink', () => {
    expect(argumentNames('get')).toEqual([
      { name: 'channel-id', required: false },
      { name: 'timestamp', required: false },
    ]);
    expect(longOptions('get')).toContain('--permalink');
  });

  it('keeps the range-bound options on read', () => {
    expect(longOptions('read')).toContain('--oldest');
    expect(longOptions('read')).toContain('--latest');
    expect(longOptions('read')).toContain('--thread-ts');
  });

  it('exposes --json on list, defaulting to off', () => {
    const jsonOption = subcommand('list')?.options.find((option) => option.long === '--json');
    expect(jsonOption).toBeDefined();
    expect(jsonOption?.defaultValue).toBe(false);
  });
});

describe('conversations members (read-only)', () => {
  it('nests membership under the conversations group as `members list`', () => {
    expect(subcommand('members')).toBeDefined();
    expect(membersSubcommand('list')).toBeDefined();
  });

  it('requires a channel positional on `members list`', () => {
    const args = (membersSubcommand('list')?.registeredArguments ?? []).map((argument) => ({
      name: argument.name(),
      required: argument.required,
    }));
    expect(args).toEqual([{ name: 'channel', required: true }]);
  });

  it('exposes --limit, --cursor, --workspace, and --json on `members list`', () => {
    const opts = membersListOptions();
    expect(opts).toContain('--limit');
    expect(opts).toContain('--cursor');
    expect(opts).toContain('--workspace');
    expect(opts).toContain('--json');
  });

  it('defaults --limit to a valid positive integer the action accepts', () => {
    // The action rejects a non-positive/NaN --limit (Number.isFinite && > 0),
    // so the wired default must itself pass that guard.
    const limitOption = (membersSubcommand('list')?.options ?? []).find((o) => o.long === '--limit');
    const parsed = parseInt(String(limitOption?.defaultValue), 10);
    expect(Number.isFinite(parsed)).toBe(true);
    expect(parsed).toBeGreaterThan(0);
  });

  it('ships the read side under members list', () => {
    const memberSubcommandNames = (subcommand('members')?.commands ?? []).map((c) => c.name());
    expect(memberSubcommandNames).toContain('list');
  });
});

describe('conversations membership (write/self)', () => {
  it('nests the write ops under members as add/remove', () => {
    const memberSubcommandNames = (subcommand('members')?.commands ?? []).map((c) => c.name());
    expect(memberSubcommandNames).toContain('add');
    expect(memberSubcommandNames).toContain('remove');
  });

  it('exposes join/leave as self-ops on the conversations group', () => {
    const groupSubcommandNames = createConversationsCommand().commands.map((c) => c.name());
    expect(groupSubcommandNames).toContain('join');
    expect(groupSubcommandNames).toContain('leave');
  });

  it('takes a channel plus a variadic users list on members add/remove', () => {
    for (const verb of ['add', 'remove']) {
      const args = (membersSubcommand(verb)?.registeredArguments ?? []).map((a) => ({
        name: a.name(),
        required: a.required,
        variadic: a.variadic,
      }));
      expect(args).toEqual([
        { name: 'channel', required: true, variadic: false },
        { name: 'users', required: true, variadic: true },
      ]);
    }
  });

  it('exposes --yes on every mutating command (add/remove/leave), and NOT on the idempotent join', () => {
    const yesOn = (cmd: ReturnType<typeof membersSubcommand> | ReturnType<typeof subcommand>) =>
      (cmd?.options ?? []).some((o) => o.long === '--yes');
    expect(yesOn(membersSubcommand('add'))).toBe(true);
    expect(yesOn(membersSubcommand('remove'))).toBe(true);
    expect(yesOn(subcommand('leave'))).toBe(true);
    expect(yesOn(subcommand('join'))).toBe(false);
  });

  it('exposes --team on the write ops (enterprise scoping) but not on the self-ops', () => {
    expect((membersSubcommand('add')?.options ?? []).map((o) => o.long)).toContain('--team');
    expect((membersSubcommand('remove')?.options ?? []).map((o) => o.long)).toContain('--team');
    // join/leave are self-ops — they carry no --team.
    expect((subcommand('join')?.options ?? []).map((o) => o.long)).not.toContain('--team');
    expect((subcommand('leave')?.options ?? []).map((o) => o.long)).not.toContain('--team');
  });

  it('takes a single channel positional on join and leave', () => {
    for (const verb of ['join', 'leave']) {
      const args = (subcommand(verb)?.registeredArguments ?? []).map((a) => ({
        name: a.name(),
        required: a.required,
      }));
      expect(args).toEqual([{ name: 'channel', required: true }]);
    }
  });
});
