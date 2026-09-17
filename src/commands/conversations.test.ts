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

  it('ships ONLY the read side — no write/self membership subcommands', () => {
    const memberSubcommandNames = (subcommand('members')?.commands ?? []).map((c) => c.name());
    expect(memberSubcommandNames).toEqual(['list']);
    // Guard against the follow-up write PR's verbs leaking into this read PR.
    for (const write of ['add', 'remove', 'invite', 'kick', 'join', 'leave']) {
      expect(memberSubcommandNames).not.toContain(write);
    }
    // No join/leave leaked onto the conversations group either.
    const groupSubcommandNames = createConversationsCommand().commands.map((c) => c.name());
    for (const write of ['join', 'leave']) {
      expect(groupSubcommandNames).not.toContain(write);
    }
  });
});
