import { describe, expect, it } from 'bun:test';
import { helpOf } from '../lib/help.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createMessagesCommand,
  parseBlocksInput,
  permalinkField,
} from './messages.ts';

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

  it('exposes a --file option on messages send', () => {
    expect(longOptions('send')).toContain('--file');
  });

  it('collects a repeated --file into an array (several attachments, one message)', async () => {
    const command = createMessagesCommand();
    const send = command.commands.find((candidate) => candidate.name() === 'send')!;
    let captured: string[] | undefined;
    // A no-op action lets parsing complete; the collected --file array is read
    // from the parsed options the action receives.
    send.exitOverride().configureOutput({ writeErr: () => {} })
      .action((options: { file?: string[] }) => { captured = options.file; });

    await command.parseAsync([
      'send',
      '--recipient-id=C123',
      '--message=hi',
      '--file', 'a.txt',
      '--file', 'b.txt',
      '--file', 'c.txt',
    ], { from: 'user' });

    expect(captured).toEqual(['a.txt', 'b.txt', 'c.txt']);
  });

  it('rejects --file with --blocks rather than silently dropping the blocks', async () => {
    const command = createMessagesCommand();
    command.commands.find((candidate) => candidate.name() === 'send')!
      .exitOverride()
      .configureOutput({ writeErr: () => {} });

    await expect(command.parseAsync([
      'send',
      '--recipient-id=C123',
      '--message=Fallback text',
      '--file', 'a.png',
      '--file', 'b.png',
      '--blocks=[]',
    ], { from: 'user' })).rejects.toThrow(/cannot be used with option/);
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
  it('leaves edit with no mandatory option so --permalink and --message-file can replace the rest', () => {
    expect(mandatoryOptions('edit')).toEqual([]);
  });

  it('leaves only --emoji mandatory on react so --permalink can replace the rest', () => {
    expect(mandatoryOptions('react')).toEqual(['--emoji']);
  });

  // --message is no longer Commander-mandatory on send/draft because
  // --message-file can supply the same value; "exactly one of the two" is
  // enforced by resolveMessageText instead (tested below). This mirrors what
  // --permalink already did to --channel-id / --timestamp on edit and react.
  it('leaves the writing subcommands with no mandatory option so --message-file can replace --message', () => {
    expect(mandatoryOptions('send')).toEqual([]);
    expect(mandatoryOptions('draft')).toEqual([]);
    expect(mandatoryOptions('edit')).toEqual([]);
  });

  it('offers --message-file on the writing subcommands but not on react', () => {
    expect(longOptions('send')).toContain('--message-file');
    expect(longOptions('draft')).toContain('--message-file');
    expect(longOptions('edit')).toContain('--message-file');
    expect(longOptions('react')).not.toContain('--message-file');
  });

  it('offers --json on the writing subcommands but not on react', () => {
    for (const name of ['send', 'edit', 'draft']) {
      expect(longOptions(name)).toContain('--json');
    }
    expect(longOptions('react')).not.toContain('--json');
  });

  it('rejects --message-file with --message rather than silently picking one', async () => {
    // '-' (stdin) is rejected exactly like a path, whichever flag comes first.
    const combos = [
      ['--message=inline', '--message-file=body.txt'],
      ['--message=inline', '--message-file=-'],
      ['--message-file', '-', '--message', 'inline'],
    ];
    for (const name of ['send', 'draft', 'edit']) {
      for (const flags of combos) {
        const command = createMessagesCommand();
        command.commands.find((candidate) => candidate.name() === name)!
          .exitOverride()
          .configureOutput({ writeErr: () => {} });

        const targetFlag = name === 'edit' ? '--channel-id=C123' : '--recipient-id=C123';
        await expect(command.parseAsync([name, targetFlag, ...flags], { from: 'user' })).rejects.toThrow(
          "option '--message-file <path>' cannot be used with option '--message <text>'"
        );
      }
    }
  });

  it('offers --permalink on every message-targeting subcommand', () => {
    for (const name of ['send', 'react', 'edit', 'draft']) {
      expect(longOptions(name)).toContain('--permalink');
    }
  });

  it('exposes list-drafts as a browser-only read command with limit, workspace, JSON and fields options', () => {
    const command = subcommand('list-drafts');
    expect(command).toBeDefined();
    expect(helpOf(command!)?.browserOnly).toBe(true);
    expect(longOptions('list-drafts')).toEqual([
      '--limit',
      '--workspace',
      '--json',
      '--fields',
    ]);
  });

  it('defaults list-drafts to a positive limit', () => {
    const limit = subcommand('list-drafts')?.options.find((option) => option.long === '--limit');
    expect(limit?.defaultValue).toBe('100');
  });

  it('keeps draft creation separate from the send and delete commands', () => {
    expect(longOptions('draft')).not.toContain('--yes');
    for (const name of ['send-draft', 'delete-draft']) {
      const command = subcommand(name);
      expect(command).toBeDefined();
      expect(helpOf(command!)?.browserOnly).toBe(true);
      expect(command?.registeredArguments[0]?.required).toBe(true);
      expect(longOptions(name)).toEqual(['--yes', '--workspace', '--json', '--dry-run']);
    }
  });

  it('requires an ID before entering either draft action', async () => {
    for (const name of ['send-draft', 'delete-draft']) {
      const command = createMessagesCommand();
      command.commands.find((candidate) => candidate.name() === name)!
        .exitOverride()
        .configureOutput({ writeErr: () => {} });
      await expect(command.parseAsync([name, '--yes'], { from: 'user' }))
        .rejects.toThrow('missing required argument');
    }
  });
});

describe('permalinkField', () => {
  it('spreads a permalink in when the lookup succeeds', async () => {
    const client = {
      getPermalink: async () => ({ ok: true, permalink: 'https://x.slack.com/archives/C1/p1' }),
    };

    expect(await permalinkField(client as any, 'C1', '1.2'))
      .toEqual({ permalink: 'https://x.slack.com/archives/C1/p1' });
  });

  // The message is already delivered when this runs, so a token without the
  // scope must not turn a successful send into a failure.
  it('omits the key rather than failing when the lookup errors or returns nothing', async () => {
    const throwing = { getPermalink: async () => { throw new Error('missing_scope'); } };
    expect(await permalinkField(throwing as any, 'C1', '1.2')).toEqual({});

    const empty = { getPermalink: async () => ({ ok: true }) };
    expect(await permalinkField(empty as any, 'C1', '1.2')).toEqual({});
  });

  it('passes the channel and ts through to chat.getPermalink', async () => {
    const calls: Array<[string, string]> = [];
    const client = {
      getPermalink: async (channel: string, ts: string) => {
        calls.push([channel, ts]);
        return { permalink: 'https://x.slack.com/archives/C9/p9' };
      },
    };

    await permalinkField(client as any, 'C9', '1700000000.000100');
    expect(calls).toEqual([['C9', '1700000000.000100']]);
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
