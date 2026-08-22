import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMessagesCommand, parseBlocksInput } from './messages.ts';

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

  it('exposes structured Block Kit input on messages send', () => {
    expect(longOptions('send')).toContain('--blocks');
  });

  it('rejects --blocks with --file rather than silently dropping the blocks', async () => {
    const command = createMessagesCommand();
    command.commands.find((candidate) => candidate.name() === 'send')!
      .exitOverride()
      .configureOutput({ writeErr: () => {} });

    await expect(command.parseAsync([
      'send',
      '--recipient-id=C123',
      '--message=Fallback text',
      '--file=report.txt',
      '--blocks=[]',
    ], { from: 'user' })).rejects.toThrow(
      "option '--blocks <json|@file>' cannot be used with option '--file <path>'"
    );
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

describe('parseBlocksInput', () => {
  const tableBlocks = [
    {
      type: 'table',
      rows: [[
        { type: 'raw_text', text: 'Project' },
        {
          type: 'rich_text',
          elements: [{
            type: 'rich_text_section',
            elements: [{ type: 'link', text: 'Slack', url: 'https://slack.com' }],
          }],
        },
      ]],
    },
  ];

  it('parses an inline table block with a rich-text link cell', async () => {
    expect(await parseBlocksInput(JSON.stringify(tableBlocks))).toEqual(tableBlocks);
  });

  it('parses an inline native markdown block without transforming its text', async () => {
    const markdownBlocks = [{
      type: 'markdown',
      text: '# Release notes\n\nSee the [runbook](https://example.com/runbook).',
    }];

    expect(await parseBlocksInput(JSON.stringify(markdownBlocks))).toEqual(markdownBlocks);
  });

  it('loads blocks from an @-prefixed JSON file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slackcli-blocks-'));
    const path = join(dir, 'blocks.json');
    await Bun.write(path, JSON.stringify(tableBlocks));

    try {
      expect(await parseBlocksInput(`@${path}`)).toEqual(tableBlocks);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid JSON and non-block values', async () => {
    await expect(parseBlocksInput('{')).rejects.toThrow('Invalid blocks JSON');
    await expect(parseBlocksInput('{"type":"table"}')).rejects.toThrow('JSON array');
    await expect(parseBlocksInput('[{"rows":[]}]')).rejects.toThrow('non-empty string "type"');
  });
});
