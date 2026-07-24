import { describe, expect, it } from 'bun:test';
import { createMessagesCommand } from './messages.ts';

describe('messages command', () => {
  it('exposes a file option on messages send', () => {
    const messages = createMessagesCommand();
    const send = messages.commands.find((command) => command.name() === 'send');

    expect(send?.options.some((option) => option.long === '--file')).toBe(true);
  });

  it('exposes an edit subcommand requiring channel, timestamp, and message', () => {
    const messages = createMessagesCommand();
    const edit = messages.commands.find((command) => command.name() === 'edit');

    expect(edit).toBeDefined();
    const required = edit?.options
      .filter((option) => option.mandatory)
      .map((option) => option.long)
      .sort();
    expect(required).toEqual(['--channel-id', '--message', '--timestamp']);
  });
});
