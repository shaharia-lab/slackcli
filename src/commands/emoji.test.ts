import { describe, expect, it } from 'bun:test';
import { createEmojiCommand } from './emoji.ts';

function subcommand(name: string) {
  return createEmojiCommand().commands.find((command) => command.name() === name);
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

describe('emoji command', () => {
  it('exposes the list and get subcommands', () => {
    const names = createEmojiCommand().commands.map((command) => command.name());
    expect(names).toContain('list');
    expect(names).toContain('get');
  });

  it('gives list the --limit, --no-aliases, --workspace and --json options', () => {
    const opts = longOptions('list');
    expect(opts).toContain('--limit');
    expect(opts).toContain('--no-aliases');
    expect(opts).toContain('--workspace');
    expect(opts).toContain('--json');
  });

  it('makes get take a required name positional plus --workspace and --json', () => {
    expect(argumentNames('get')).toEqual([{ name: 'name', required: true }]);
    const opts = longOptions('get');
    expect(opts).toContain('--workspace');
    expect(opts).toContain('--json');
  });
});
