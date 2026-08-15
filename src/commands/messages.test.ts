import { describe, expect, it } from 'bun:test';
import { createMessagesCommand } from './messages.ts';

function subcommand(name: string) {
  return createMessagesCommand().commands.find((command) => command.name() === name);
}

function longOptions(name: string): string[] {
  return (subcommand(name)?.options ?? []).map((option) => option.long ?? '');
}

function mandatoryOptions(name: string): string[] {
  return (subcommand(name)?.options ?? [])
    .filter((option) => option.mandatory)
    .map((option) => option.long ?? '')
    .sort();
}

describe('messages command', () => {
  it('exposes a file option on messages send', () => {
    expect(longOptions('send')).toContain('--file');
  });

  it('exposes an edit subcommand taking channel, timestamp, and message', () => {
    expect(subcommand('edit')).toBeDefined();
    expect(longOptions('edit')).toContain('--channel-id');
    expect(longOptions('edit')).toContain('--timestamp');
    expect(longOptions('edit')).toContain('--message');
  });

  // --channel-id / --timestamp are no longer Commander-mandatory because --permalink
  // can supply both; the requirement is enforced in resolveMessageTarget instead
  // (see slack-url-parser.test.ts), which is what lets either form be used.
  it('leaves only --message mandatory on edit so --permalink can replace the rest', () => {
    expect(mandatoryOptions('edit')).toEqual(['--message']);
  });

  it('leaves only --emoji mandatory on react so --permalink can replace the rest', () => {
    expect(mandatoryOptions('react')).toEqual(['--emoji']);
  });

  it('keeps --message mandatory on send and draft', () => {
    expect(mandatoryOptions('send')).toEqual(['--message']);
    expect(mandatoryOptions('draft')).toEqual(['--message']);
  });

  it('offers --permalink on every message-targeting subcommand', () => {
    for (const name of ['send', 'react', 'edit', 'draft']) {
      expect(longOptions(name)).toContain('--permalink');
    }
  });
});
