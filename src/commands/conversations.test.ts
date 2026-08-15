import { describe, expect, it } from 'bun:test';
import { createConversationsCommand } from './conversations.ts';

function subcommand(name: string) {
  return createConversationsCommand().commands.find((command) => command.name() === name);
}

function longOptions(name: string): string[] {
  return (subcommand(name)?.options ?? []).map((option) => option.long ?? '');
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
