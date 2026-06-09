import { describe, expect, it } from 'bun:test';
import { createMessagesCommand } from './messages.ts';

describe('messages command', () => {
  it('exposes a file option on messages send', () => {
    const messages = createMessagesCommand();
    const send = messages.commands.find((command) => command.name() === 'send');

    expect(send?.options.some((option) => option.long === '--file')).toBe(true);
  });

  it('exposes --message and --recipient-id on messages draft', () => {
    const messages = createMessagesCommand();
    const draft = messages.commands.find((command) => command.name() === 'draft');

    expect(draft?.options.some((option) => option.long === '--message')).toBe(true);
    expect(draft?.options.some((option) => option.long === '--recipient-id')).toBe(true);
  });
});
