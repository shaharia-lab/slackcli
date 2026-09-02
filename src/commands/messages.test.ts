import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createMessagesCommand,
  parseBlocksInput,
  permalinkField,
  resolveMessageText,
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
    for (const name of ['send', 'draft', 'edit']) {
      const command = createMessagesCommand();
      command.commands.find((candidate) => candidate.name() === name)!
        .exitOverride()
        .configureOutput({ writeErr: () => {} });

      const targetFlag = name === 'edit' ? '--channel-id=C123' : '--recipient-id=C123';
      await expect(command.parseAsync([
        name,
        targetFlag,
        '--message=inline',
        '--message-file=body.txt',
      ], { from: 'user' })).rejects.toThrow(
        "option '--message-file <path>' cannot be used with option '--message <text>'"
      );
    }
  });

  it('offers --permalink on every message-targeting subcommand', () => {
    for (const name of ['send', 'react', 'edit', 'draft']) {
      expect(longOptions(name)).toContain('--permalink');
    }
  });
});

describe('resolveMessageText', () => {
  async function withTempFile(
    contents: string,
    run: (path: string) => Promise<void>,
  ): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'slackcli-message-'));
    const path = join(dir, 'body.txt');
    await Bun.write(path, contents);
    try {
      await run(path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('returns --message unchanged, including an intentionally empty one', async () => {
    expect(await resolveMessageText({ message: 'Deploy green' })).toBe('Deploy green');
    expect(await resolveMessageText({ message: '' })).toBe('');
  });

  it('reads the message from --message-file as UTF-8, preserving mrkdwn and newlines', async () => {
    const body = '*Release 1.2*\n\n- <https://example.com|runbook>\n- café ☕\n';
    await withTempFile(body, async (path) => {
      expect(await resolveMessageText({ messageFile: path })).toBe(body);
    });
  });

  it('rejects a file that is missing, empty, or only whitespace before sending', async () => {
    await expect(resolveMessageText({ messageFile: '' }))
      .rejects.toThrow('--message-file path cannot be empty');

    await expect(resolveMessageText({ messageFile: '/nonexistent/body.txt' }))
      .rejects.toThrow('Cannot read message file /nonexistent/body.txt');

    await withTempFile('', async (path) => {
      await expect(resolveMessageText({ messageFile: path })).rejects.toThrow('is empty');
    });
    await withTempFile('   \n\t\n', async (path) => {
      await expect(resolveMessageText({ messageFile: path })).rejects.toThrow('is empty');
    });
  });

  it('rejects an invocation supplying neither flag', async () => {
    await expect(resolveMessageText({}))
      .rejects.toThrow('Either --message or --message-file is required');
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
