import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import chalk from 'chalk';
import {
  formatChannelList,
  formatSavedItems,
  warning,
  formatSearchMessages,
  formatChannelSearchResults,
  formatPeopleSearchResults,
  formatUnreadChannels,
  formatPaginationHint,
  formatFileSize,
  formatDraftList,
  formatMessage,
  formatTimestamp,
  writeJson,
  formatCanvasList,
  formatUsergroupList,
  formatEmojiList,
  formatUsergroup,
} from './formatter.ts';
import type {
  SavedItem,
  SearchMatch,
  ChannelSearchResult,
  PeopleSearchResult,
  UnreadChannel,
  SlackUser,
  SlackMessage,
  SlackChannel,
  DraftSummary,
  SlackCanvas,
  SlackUsergroup,
  UsergroupMember,
  CustomEmoji,
} from '../types/index.ts';

describe('formatDraftList', () => {
  it('renders destination, age, bounded text, thread, files, schedule, and draft id', () => {
    const drafts: DraftSummary[] = [{
      draft_id: 'Dr123',
      channel_id: 'C123',
      text: `Deploy\n${'x'.repeat(140)}`,
      date_created: 1700000000,
      file_ids: ['F1', 'F2'],
      thread_ts: '1699999999.000100',
      date_scheduled: 1700003600,
    }];

    const output = formatDraftList(drafts, 1700000600 * 1000);

    expect(output).toContain('Active Drafts (1)');
    expect(output).toContain('C123');
    expect(output).toContain('10m ago');
    expect(output).toContain('Deploy x');
    expect(output).toContain('...');
    expect(output).toContain('draft: Dr123');
    expect(output).toContain('thread: 1699999999.000100');
    expect(output).toContain('files: 2');
    expect(output).toContain('scheduled:');
  });

  it('uses a clear placeholder for an empty draft body', () => {
    const output = formatDraftList([{
      draft_id: 'DrEmpty',
      channel_id: 'D123',
      text: '',
      date_created: 1700000000,
      file_ids: [],
    }], 1700000000 * 1000);

    expect(output).toContain('just now');
    expect(output).toContain('[no text]');
  });
});

describe('formatSavedItems', () => {
  it('renders message items with user info', () => {
    const items: SavedItem[] = [{
      type: 'message',
      channel_id: 'C123',
      channel_name: 'general',
      message: { type: 'message', text: 'Hello world', ts: '1700000000.000100', user: 'U1' },
    }];
    const users = new Map<string, SlackUser>([
      ['U1', { id: 'U1', name: 'alice', real_name: 'Alice Smith' }],
    ]);

    const output = formatSavedItems(items, users);
    expect(output).toContain('Alice Smith');
    expect(output).toContain('#general');
    expect(output).toContain('Hello world');
  });

  it('renders file items', () => {
    const items: SavedItem[] = [{
      type: 'file',
      channel_id: 'C123',
      file: { name: 'report.pdf', title: 'Q4 Report' },
    }];

    const output = formatSavedItems(items, new Map());
    expect(output).toContain('report.pdf');
  });

  it('renders unknown item types gracefully', () => {
    const items: SavedItem[] = [{
      type: 'channel',
      channel_id: 'C123',
    }];

    const output = formatSavedItems(items, new Map());
    expect(output).toContain('[channel]');
  });

  it('falls back to bot_id when user not found', () => {
    const items: SavedItem[] = [{
      type: 'message',
      channel_id: 'C123',
      message: { type: 'message', text: 'bot msg', ts: '1700000000.000100', bot_id: 'B1' },
    }];

    const output = formatSavedItems(items, new Map());
    expect(output).toContain('B1');
  });

  it('shows todo state when present', () => {
    const items: SavedItem[] = [{
      type: 'message',
      channel_id: 'C123',
      channel_name: 'general',
      message: { type: 'message', text: 'task', ts: '1700000000.000100' },
      todo_state: 'completed',
    }];

    const output = formatSavedItems(items, new Map());
    expect(output).toContain('[completed]');
  });
});

describe('formatSearchMessages', () => {
  it('renders search results with channel and user info', () => {
    const matches: SearchMatch[] = [{
      ts: '1700000000.000100',
      text: 'Found this relevant message',
      username: 'bob',
      channel: { id: 'C123', name: 'engineering' },
      permalink: 'https://slack.com/archives/C123/p1700000000000100',
    }];

    const output = formatSearchMessages('relevant', matches, 1);
    expect(output).toContain('relevant');
    expect(output).toContain('@bob');
    expect(output).toContain('#engineering');
    expect(output).toContain('Found this relevant message');
    expect(output).toContain('https://slack.com/archives/');
  });

  it('handles missing optional fields', () => {
    const matches: SearchMatch[] = [{
      ts: '1700000000.000100',
      text: 'minimal match',
    }];

    const output = formatSearchMessages('test', matches, 1);
    expect(output).toContain('minimal match');
    expect(output).toContain('Unknown');
  });
});

describe('formatChannelSearchResults', () => {
  it('renders channel results with member count and purpose', () => {
    const channels: ChannelSearchResult[] = [{
      id: 'C123',
      name: 'engineering',
      num_members: 42,
      is_member: true,
      purpose: { value: 'Engineering discussions' },
    }];

    const output = formatChannelSearchResults('eng', channels, 1);
    expect(output).toContain('#engineering');
    expect(output).toContain('42 members');
    expect(output).toContain('[joined]');
    expect(output).toContain('Engineering discussions');
  });

  it('uses member_count when num_members is absent', () => {
    const channels: ChannelSearchResult[] = [{
      id: 'C123',
      name: 'design',
      member_count: 10,
    }];

    const output = formatChannelSearchResults('design', channels, 1);
    expect(output).toContain('10 members');
  });
});

describe('formatPeopleSearchResults', () => {
  it('renders people with profile info', () => {
    const people: PeopleSearchResult[] = [{
      id: 'U1',
      name: 'alice',
      real_name: 'Alice Smith',
      profile: {
        display_name: 'alice',
        email: 'alice@example.com',
        title: 'Staff Engineer',
      },
    }];

    const output = formatPeopleSearchResults('alice', people, 1);
    expect(output).toContain('@alice');
    expect(output).toContain('Alice Smith');
    expect(output).toContain('alice@example.com');
    expect(output).toContain('Staff Engineer');
  });

  it('handles missing profile gracefully', () => {
    const people: PeopleSearchResult[] = [{
      id: 'U2',
      name: 'bob',
    }];

    const output = formatPeopleSearchResults('bob', people, 1);
    expect(output).toContain('U2');
  });
});

describe('formatUnreadChannels', () => {
  it('returns caught-up message for empty list', () => {
    const output = formatUnreadChannels([]);
    expect(output).toContain('All caught up');
  });

  it('renders channels with mention counts', () => {
    const channels: UnreadChannel[] = [
      { id: 'C1', name: 'general', mention_count: 3, unread_count: 10, has_unreads: true },
      { id: 'C2', name: 'random', mention_count: 0, unread_count: 2, has_unreads: true },
    ];

    const output = formatUnreadChannels(channels);
    expect(output).toContain('general');
    expect(output).toContain('@3');
    expect(output).toContain('random');
    expect(output).toContain('10 unread');
  });

  it('uses the correct prefix for each conversation type', () => {
    const channels: UnreadChannel[] = [
      { id: 'D1', name: 'Alice', mention_count: 0, has_unreads: true, is_im: true },
      { id: 'G1', name: 'Team Chat', mention_count: 0, has_unreads: true, is_mpim: true },
      { id: 'C1', name: 'secret', mention_count: 0, has_unreads: true, is_private: true },
      { id: 'C2', name: 'general', mention_count: 0, has_unreads: true },
    ];

    const output = formatUnreadChannels(channels);
    expect(output).toMatch(/1\.\S* 👤 \S*Alice/);
    expect(output).toMatch(/2\.\S* 👥 \S*Team Chat/);
    expect(output).toMatch(/3\.\S* 🔒 \S*secret/);
    expect(output).toMatch(/4\.\S* # \S*general/);
  });

  it('applies prefix precedence when several type flags are set', () => {
    const channels: UnreadChannel[] = [
      { id: 'D1', name: 'dm', mention_count: 0, has_unreads: true, is_im: true, is_mpim: true, is_private: true },
      { id: 'G1', name: 'mpdm', mention_count: 0, has_unreads: true, is_mpim: true, is_private: true },
    ];

    const output = formatUnreadChannels(channels);
    expect(output).toMatch(/1\.\S* 👤 \S*dm/);
    expect(output).toMatch(/2\.\S* 👥 \S*mpdm/);
  });
});

describe('formatPaginationHint', () => {
  it('shows hint when more pages exist', () => {
    const output = formatPaginationHint(1, 5);
    expect(output).toContain('Page 1 of 5');
    expect(output).toContain('--page 2');
  });

  it('returns empty string on last page', () => {
    const output = formatPaginationHint(3, 3);
    expect(output).toBe('');
  });
});

describe('formatMessage file display', () => {
  const users = new Map<string, SlackUser>([
    ['U1', { id: 'U1', name: 'alice', real_name: 'Alice' }],
  ]);

  it('displays single file with all metadata', () => {
    const msg: SlackMessage = {
      type: 'message', user: 'U1', text: 'Here is the doc', ts: '1700000000.000100',
      files: [{
        id: 'F1', name: 'doc.pdf', size: 1258291, mimetype: 'application/pdf',
        url_private: 'https://files.slack.com/doc.pdf',
      }],
    };
    const output = formatMessage(msg, users);
    expect(output).toContain('doc.pdf');
    expect(output).toContain('1.2 MB');
    expect(output).toContain('application/pdf');
    expect(output).toContain('https://files.slack.com/doc.pdf');
  });

  it('displays multiple files in order', () => {
    const msg: SlackMessage = {
      type: 'message', user: 'U1', text: 'Two files', ts: '1700000000.000100',
      files: [
        { id: 'F1', name: 'a.txt', size: 100, url_private: 'https://a.txt' },
        { id: 'F2', name: 'b.txt', size: 200, url_private: 'https://b.txt' },
      ],
    };
    const output = formatMessage(msg, users);
    const posA = output.indexOf('a.txt');
    const posB = output.indexOf('b.txt');
    expect(posA).toBeGreaterThan(-1);
    expect(posB).toBeGreaterThan(posA);
  });

  it('renders nothing when files is undefined', () => {
    const msg: SlackMessage = {
      type: 'message', user: 'U1', text: 'No files', ts: '1700000000.000100',
    };
    const output = formatMessage(msg, users);
    expect(output).not.toContain('📎');
  });

  it('renders nothing when files is empty array', () => {
    const msg: SlackMessage = {
      type: 'message', user: 'U1', text: 'Empty', ts: '1700000000.000100',
      files: [],
    };
    const output = formatMessage(msg, users);
    expect(output).not.toContain('📎');
  });

  it('shows "(unnamed file)" when name is missing', () => {
    const msg: SlackMessage = {
      type: 'message', user: 'U1', text: 'test', ts: '1700000000.000100',
      files: [{ id: 'F1', size: 100 }],
    };
    const output = formatMessage(msg, users);
    expect(output).toContain('(unnamed file)');
  });

  it('omits size when undefined', () => {
    const msg: SlackMessage = {
      type: 'message', user: 'U1', text: 'test', ts: '1700000000.000100',
      files: [{ id: 'F1', name: 'a.txt', mimetype: 'text/plain' }],
    };
    const output = formatMessage(msg, users);
    expect(output).toContain('a.txt');
    expect(output).toContain('text/plain');
    expect(output).not.toMatch(/\d+\s*B/);
  });

  it('shows "0 B" when size is 0', () => {
    const msg: SlackMessage = {
      type: 'message', user: 'U1', text: 'test', ts: '1700000000.000100',
      files: [{ id: 'F1', name: 'empty.txt', size: 0 }],
    };
    const output = formatMessage(msg, users);
    expect(output).toContain('0 B');
  });

  it('omits mimetype when missing', () => {
    const msg: SlackMessage = {
      type: 'message', user: 'U1', text: 'test', ts: '1700000000.000100',
      files: [{ id: 'F1', name: 'a.bin', size: 500 }],
    };
    const output = formatMessage(msg, users);
    expect(output).toContain('a.bin');
    expect(output).toContain('500 B');
    expect(output).not.toContain('undefined');
  });

  it('omits parentheses when both size and mimetype missing', () => {
    const msg: SlackMessage = {
      type: 'message', user: 'U1', text: 'test', ts: '1700000000.000100',
      files: [{ id: 'F1', name: 'a.bin' }],
    };
    const output = formatMessage(msg, users);
    expect(output).toContain('a.bin');
    expect(output).not.toContain('(');
  });

  it('omits URL line when no URL available', () => {
    const msg: SlackMessage = {
      type: 'message', user: 'U1', text: 'test', ts: '1700000000.000100',
      files: [{ id: 'F1', name: 'a.txt' }],
    };
    const output = formatMessage(msg, users);
    expect(output).toContain('a.txt');
    expect(output).not.toContain('https://');
  });

  it('falls back to permalink when url_private is missing', () => {
    const msg: SlackMessage = {
      type: 'message', user: 'U1', text: 'test', ts: '1700000000.000100',
      files: [{ id: 'F1', name: 'a.txt', permalink: 'https://team.slack.com/files/a.txt' }],
    };
    const output = formatMessage(msg, users);
    expect(output).toContain('https://team.slack.com/files/a.txt');
  });

  it('displays tombstone as deleted file', () => {
    const msg: SlackMessage = {
      type: 'message', user: 'U1', text: 'test', ts: '1700000000.000100',
      files: [{ id: 'F1', mode: 'tombstone' }],
    };
    const output = formatMessage(msg, users);
    expect(output).toContain('(deleted file)');
    expect(output).not.toContain('https://');
  });
});

describe('formatFileSize', () => {
  it('formats 0 bytes', () => {
    expect(formatFileSize(0)).toBe('0 B');
  });

  it('formats bytes under 1 KB', () => {
    expect(formatFileSize(500)).toBe('500 B');
  });

  it('formats exact 1 KB', () => {
    expect(formatFileSize(1024)).toBe('1.0 KB');
  });

  it('formats fractional KB', () => {
    expect(formatFileSize(1536)).toBe('1.5 KB');
  });

  it('formats exact 1 MB', () => {
    expect(formatFileSize(1048576)).toBe('1.0 MB');
  });

  it('formats fractional MB', () => {
    expect(formatFileSize(1258291)).toBe('1.2 MB');
  });

  it('formats exact 1 GB', () => {
    expect(formatFileSize(1073741824)).toBe('1.0 GB');
  });

  it('handles negative values', () => {
    expect(formatFileSize(-1)).toBe('0 B');
  });

  it('handles NaN', () => {
    expect(formatFileSize(NaN)).toBe('0 B');
  });

  it('handles Infinity', () => {
    expect(formatFileSize(Infinity)).toBe('0 B');
  });

  it('formats 1023 bytes (boundary before KB)', () => {
    expect(formatFileSize(1023)).toBe('1023 B');
  });
});

describe('warning', () => {
  // Warnings are diagnostics: they must reach stderr, never stdout, so that
  // `... --json | jq` still receives exactly one parseable object even when a
  // pre-send warning (e.g. workspace mismatch) fires.
  it('writes to stderr, keeping stdout clean for --json output', () => {
    const out: unknown[][] = [];
    const err: unknown[][] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: unknown[]) => { out.push(args); };
    console.error = (...args: unknown[]) => { err.push(args); };
    try {
      warning('workspace mismatch');
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    expect(out).toHaveLength(0);
    expect(err).toHaveLength(1);
    expect(err[0]!.join(' ')).toContain('workspace mismatch');
  });
});

describe('writeJson', () => {
  it('writes 2-space indented JSON with a trailing newline', () => {
    const chunks: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((chunk: string) => { chunks.push(chunk); return true; }) as typeof process.stdout.write;
    try {
      writeJson({ a: 1, b: ['x'] });
    } finally {
      process.stdout.write = original;
    }
    expect(chunks.join('')).toBe(JSON.stringify({ a: 1, b: ['x'] }, null, 2) + '\n');
  });

  // Regression for #73. The truncation only manifests when stdout is a pipe
  // and ora has already materialised process.stdout, so this has to run in a
  // real child process with piped stdout; an in-process stub cannot catch it.
  it('does not truncate output larger than the 64 KiB pipe buffer', async () => {
    const buildPayload = "{ items: Array.from({ length: 4000 }, (_, i) => ({ i, text: 'x'.repeat(200) })) }";
    const script = `
      import ora from 'ora';
      import { writeJson } from ${JSON.stringify(import.meta.dir + '/formatter.ts')};
      ora('working').start().succeed('done');
      writeJson(${buildPayload});
    `;
    const proc = Bun.spawn(['bun', '-e', script], { stdout: 'pipe', stderr: 'ignore' });
    const out = await new Response(proc.stdout).text();
    await proc.exited;

    // Compare byte-exactly against the same payload built here. A
    // greater-than check would pass on a truncated build, since a draining
    // reader lets a nondeterministic amount past the 64 KiB buffer.
    const expected = JSON.stringify(
      { items: Array.from({ length: 4000 }, (_, i) => ({ i, text: 'x'.repeat(200) })) },
      null,
      2,
    ) + '\n';
    expect(expected.length).toBeGreaterThan(65536); // guards the fixture stays big enough to regress
    expect(out.length).toBe(expected.length);
    expect(out).toBe(expected);
  }, 30000);
});

// Byte-exact output with ANSI colour forced on (#205, #206). The rest of this file
// runs with chalk's non-TTY default (no escape codes), so it only guards the
// plain text; these tests pin every styled segment of the formatters whose
// template literals were un-nested. The expected strings are built from raw
// SGR codes rather than chalk, so a change in which segment is styled fails.
describe('formatter output with colour enabled', () => {
  let savedLevel: typeof chalk.level;
  beforeEach(() => {
    savedLevel = chalk.level;
    chalk.level = 3;
  });
  afterEach(() => {
    chalk.level = savedLevel;
  });

  // Mirrors chalk: a styled string that spans lines is closed and reopened
  // around each line break.
  const sgr = (open: number, close: number) => (s: string) =>
    s.split('\n').map((line) => '\u001b[' + open + 'm' + line + '\u001b[' + close + 'm').join('\n');
  const bold = sgr(1, 22);
  const dim = sgr(2, 22);
  const cyan = sgr(36, 39);
  const yellow = sgr(33, 39);
  const magenta = sgr(35, 39);
  const blue = sgr(34, 39);
  const gray = sgr(90, 39);
  const green = sgr(32, 39);
  const red = sgr(31, 39);

  const users = new Map<string, SlackUser>([
    ['U1', { id: 'U1', name: 'alice', real_name: 'Alice' }],
    ['U2', { id: 'U2', name: 'bob' }],
  ]);
  const ts = '1700000000.000100';
  const when = formatTimestamp(ts);

  describe('formatChannelList', () => {
    it('renders public, private, group DM and DM rows, with archived suffixes', () => {
      const channels: SlackChannel[] = [
        { id: 'C1', name: 'general', topic: { value: 'Company news' } },
        { id: 'C2', name: 'old-news', is_archived: true },
        { id: 'G1', name: 'secret', is_private: true },
        { id: 'G2', name: 'old-secret', is_private: true, is_archived: true },
        { id: 'M1', name: 'mpdm-a--b', is_mpim: true },
        { id: 'M2', is_mpim: true },
        { id: 'D1', is_im: true, user: 'U1' },
        { id: 'D2', is_im: true, user: 'U2' },
        { id: 'D3', is_im: true, user: 'U404' },
        { id: 'D4', is_im: true },
      ];

      expect(formatChannelList(channels, users)).toBe(
        bold('📋 Conversations (10)\n')
        + cyan('\nPublic Channels:\n')
        + '  1. #general ' + dim('(C1)') + '\n'
        + '     ' + dim('Company news') + '\n'
        + '  2. #old-news ' + dim('(C2)') + gray(' [archived]') + '\n'
        + yellow('\nPrivate Channels:\n')
        + '  1. 🔒 secret ' + dim('(G1)') + '\n'
        + '  2. 🔒 old-secret ' + dim('(G2)') + gray(' [archived]') + '\n'
        + magenta('\nGroup Messages:\n')
        + '  1. 👥 mpdm-a--b ' + dim('(M1)') + '\n'
        + '  2. 👥 Group ' + dim('(M2)') + '\n'
        + blue('\nDirect Messages:\n')
        + '  1. 👤 @Alice ' + dim('(D1)') + '\n'
        + '  2. 👤 @bob ' + dim('(D2)') + '\n'
        + '  3. 👤 @Unknown User ' + dim('(D3)') + '\n'
        + '  4. 👤 @Unknown User ' + dim('(D4)') + '\n',
      );
    });

    it('renders only the header when there are no conversations', () => {
      expect(formatChannelList([], users)).toBe(bold('📋 Conversations (0)\n'));
    });

    it('omits sections that have no conversations', () => {
      const output = formatChannelList([{ id: 'D1', is_im: true, user: 'U1' }], users);
      expect(output).toBe(
        bold('📋 Conversations (1)\n')
        + blue('\nDirect Messages:\n')
        + '  1. 👤 @Alice ' + dim('(D1)') + '\n',
      );
    });
  });

  describe('formatMessage', () => {
    it('renders the header, ts line and reply count of a thread parent', () => {
      const msg: SlackMessage = { type: 'message', user: 'U1', text: 'line one\nline two', ts, reply_count: 3 };

      expect(formatMessage(msg, users, 2)).toBe(
        '  ' + dim('[' + when + ']') + ' ' + bold('@Alice') + '\n'
        + '    line one\n'
        + '    line two\n'
        + '    ' + dim('ts: ' + ts) + '\n'
        + '    ' + cyan('💬 3 replies') + '\n',
      );
    });

    it('renders a reply with its thread indicator and thread_ts', () => {
      const msg: SlackMessage = {
        type: 'message', bot_id: 'B1', text: 'reply', ts, thread_ts: '1699999999.000001', reply_count: 1,
      };

      expect(formatMessage(msg, users)).toBe(
        dim('[' + when + ']') + ' ' + bold('@B1') + dim(' (in thread)') + '\n'
        + '  reply\n'
        + '  ' + dim('ts: ' + ts) + dim(' | thread_ts: 1699999999.000001') + '\n',
      );
    });

    it('renders file metadata, a file without metadata, and a deleted file', () => {
      const msg: SlackMessage = {
        type: 'message', user: 'U404', text: 'files', ts,
        files: [
          { id: 'F1', name: 'doc.pdf', size: 2048, mimetype: 'application/pdf', permalink: 'https://x.slack.com/F1' },
          { id: 'F2', mimetype: 'text/plain' },
          { id: 'F3' },
          { id: 'F4', mode: 'tombstone' },
        ],
      };

      expect(formatMessage(msg, users)).toBe(
        dim('[' + when + ']') + ' ' + bold('@Unknown') + '\n'
        + '  files\n'
        + '  ' + dim('ts: ' + ts) + '\n'
        + '  ' + yellow('📎') + ' ' + yellow('doc.pdf') + ' ' + dim('(2.0 KB, application/pdf)') + '\n'
        + '     ' + dim('https://x.slack.com/F1') + '\n'
        + '  ' + yellow('📎') + ' ' + yellow('(unnamed file)') + ' ' + dim('(text/plain)') + '\n'
        + '  ' + yellow('📎') + ' ' + yellow('(unnamed file)') + '\n'
        + '  ' + yellow('📎') + ' ' + dim('(deleted file)') + '\n',
      );
    });
  });

  describe('formatSavedItems', () => {
    it('renders message, file and unknown items', () => {
      const items: SavedItem[] = [
        {
          type: 'message', channel_id: 'C1', channel_name: 'general', todo_state: 'completed',
          message: { type: 'message', user: 'U1', text: 'saved text', ts },
        },
        { type: 'message', channel_id: 'C2', message: { type: 'message', text: 'no user', ts } },
        { type: 'file', channel_id: 'C1', file: { title: 'Spec' } },
        { type: 'file', channel_id: 'C1', file: {} },
        { type: 'channel', channel_id: 'C3' },
      ];

      expect(formatSavedItems(items, users)).toBe(
        bold('📌 Saved Items (5)\n\n')
        + '  ' + dim('1.') + ' ' + bold('@Alice') + ' in ' + cyan('#general') + ' ' + dim('[' + when + ']') + dim(' [completed]') + '\n'
        + '     saved text\n'
        + '     ' + dim('channel: C1  ts: ' + ts) + '\n\n'
        + '  ' + dim('2.') + ' ' + bold('@Unknown') + ' in ' + cyan('#C2') + ' ' + dim('[' + when + ']') + '\n'
        + '     no user\n'
        + '     ' + dim('channel: C2  ts: ' + ts) + '\n\n'
        + '  ' + dim('3.') + ' ' + yellow('File:') + ' ' + bold('Spec') + '\n\n'
        + '  ' + dim('4.') + ' ' + yellow('File:') + ' ' + bold('Untitled') + '\n\n'
        + '  ' + dim('5.') + ' ' + dim('[channel]') + '\n\n',
      );
    });
  });

  describe('formatSearchMessages', () => {
    it('renders matches with and without a permalink', () => {
      const matches: SearchMatch[] = [
        {
          ts, text: 'hit', username: 'bob', channel: { id: 'C1', name: 'eng' },
          permalink: 'https://x.slack.com/p1',
        },
        { ts, text: 'bare', user: 'U9', channel: { id: 'C2', name: '' } },
        { ts, text: 'nothing' },
      ];

      expect(formatSearchMessages('q', matches, 7)).toBe(
        bold('🔍 Search Results for "q" (7 total)\n\n')
        + '  ' + dim('1.') + ' ' + bold('@bob') + ' in ' + cyan('#eng') + ' ' + dim('[' + when + ']') + '\n'
        + '     hit\n'
        + '     ' + dim('https://x.slack.com/p1') + '\n'
        + '\n'
        + '  ' + dim('2.') + ' ' + bold('@U9') + ' in ' + cyan('#C2') + ' ' + dim('[' + when + ']') + '\n'
        + '     bare\n'
        + '\n'
        + '  ' + dim('3.') + ' ' + bold('@Unknown') + ' in ' + cyan('#unknown') + ' ' + dim('[' + when + ']') + '\n'
        + '     nothing\n'
        + '\n',
      );
    });
  });

  describe('formatChannelSearchResults', () => {
    it('renders member counts, the joined badge and purpose', () => {
      const channels: ChannelSearchResult[] = [
        { id: 'C1', name: 'eng', num_members: 42, is_member: true, purpose: { value: 'Engineering' } },
        { id: 'C2', name: 'quiet' },
      ];

      expect(formatChannelSearchResults('e', channels, 2)).toBe(
        bold('📋 Channels matching "e" (2 total)\n\n')
        + '  ' + dim('1.') + ' #' + bold('eng') + ' ' + dim('(C1)') + ' ' + dim('42 members') + green(' [joined]') + '\n'
        + '     ' + dim('Engineering') + '\n'
        + '\n'
        + '  ' + dim('2.') + ' #' + bold('quiet') + ' ' + dim('(C2)') + ' \n'
        + '\n',
      );
    });
  });

  describe('formatPeopleSearchResults', () => {
    it('renders real name, email and title when present, and keeps the spacing when absent', () => {
      const people: PeopleSearchResult[] = [
        {
          id: 'U1', name: 'alice',
          profile: { display_name: 'ali', real_name: 'Alice Doe', email: 'a@x.io', title: 'Engineer' },
        },
        { id: 'U2', name: 'bob' },
      ];

      expect(formatPeopleSearchResults('a', people, 2)).toBe(
        bold('👥 People matching "a" (2 total)\n\n')
        + '  ' + dim('1.') + ' ' + bold('@ali') + ' (Alice Doe) ' + dim('(U1)') + ' ' + dim('<a@x.io>') + '\n'
        + '     ' + dim('- Engineer') + '\n'
        + '\n'
        + '  ' + dim('2.') + ' ' + bold('@bob') + '  ' + dim('(U2)') + ' \n'
        + '\n',
      );
    });
  });

  describe('formatUnreadChannels', () => {
    it('renders mention and unread badges only when non-zero', () => {
      const channels: UnreadChannel[] = [
        { id: 'C1', name: 'eng', mention_count: 2, unread_count: 5, has_unreads: true },
        { id: 'D1', mention_count: 0, has_unreads: true, is_im: true },
      ];

      expect(formatUnreadChannels(channels)).toBe(
        bold('💬 Unread Channels (2)\n\n')
        + '  ' + dim('1.') + ' # ' + bold('eng') + ' ' + dim('(C1)') + red(' @2') + yellow(' (5 unread)') + '\n'
        + '  ' + dim('2.') + ' 👤 ' + bold('D1') + ' ' + dim('(D1)') + '\n'
        + '\n',
      );
    });
  });

  describe('formatCanvasList', () => {
    it('renders size, created date and permalink when present', () => {
      const canvases: SlackCanvas[] = [
        { id: 'F1', title: 'Roadmap', size: 3072, created: 1700000000, permalink: 'https://x.slack.com/F1' },
        { id: 'F2', name: 'notes' },
        { id: 'F3' },
      ];

      expect(formatCanvasList(canvases)).toBe(
        bold('📄 Canvases (3)\n\n')
        + '  ' + dim('1.') + ' ' + bold('Roadmap') + ' ' + dim('(F1)') + ' ' + dim('3KB') + '\n'
        + '     ' + dim(formatTimestamp('1700000000')) + '\n'
        + '     ' + dim('https://x.slack.com/F1') + '\n'
        + '\n'
        + '  ' + dim('2.') + ' ' + bold('notes') + ' ' + dim('(F2)') + ' \n'
        + '\n'
        + '  ' + dim('3.') + ' ' + bold('Untitled') + ' ' + dim('(F3)') + ' \n'
        + '\n',
      );
    });
  });

  describe('formatUsergroupList', () => {
    it('renders handle, member count, disabled badge and description', () => {
      const groups: SlackUsergroup[] = [
        { id: 'S1', name: 'Eng', handle: 'eng', user_count: 4, description: 'Engineers' },
        { id: 'S2', name: 'Old', date_delete: 1700000000, user_count: 0 },
        { id: 'S3', name: 'Bare' },
      ];

      expect(formatUsergroupList(groups)).toBe(
        bold('👥 User Groups (3)\n\n')
        + '  ' + dim('1.') + ' ' + bold('Eng') + ' ' + cyan('@eng') + ' ' + dim('(S1)') + ' ' + dim('4 members') + '\n'
        + '     ' + dim('Engineers') + '\n'
        + '\n'
        + '  ' + dim('2.') + ' ' + bold('Old') + ' ' + dim('(no handle)') + ' ' + dim('(S2)') + ' ' + dim('0 members') + yellow(' [disabled]') + '\n'
        + '\n'
        + '  ' + dim('3.') + ' ' + bold('Bare') + ' ' + dim('(no handle)') + ' ' + dim('(S3)') + ' \n'
        + '\n',
      );
    });

    it('renders the empty message when there are no groups', () => {
      expect(formatUsergroupList([])).toBe(dim('No user groups found.\n'));
    });
  });

  describe('formatEmojiList', () => {
    it('renders alias rows, URL rows and rows without a URL', () => {
      const emoji: CustomEmoji[] = [
        { name: 'parrot', url: 'https://emoji.slack-edge.com/parrot.gif', is_alias: false },
        { name: 'bird', is_alias: true, alias_for: 'parrot' },
        { name: 'nourl', is_alias: false },
      ];

      expect(formatEmojiList(emoji)).toBe(
        bold('😀 Custom emoji (3 — 2 original, 1 alias)\n\n')
        + '  ' + cyan(':parrot:') + ' ' + dim('https://emoji.slack-edge.com/parrot.gif') + '\n'
        + '  ' + cyan(':bird:') + ' ' + dim('→ :parrot:') + '\n'
        + '  ' + cyan(':nourl:') + '\n',
      );
    });
  });

  describe('formatUsergroup', () => {
    it('renders the header, details and members with bot and deactivated markers', () => {
      const group: SlackUsergroup = { id: 'S1', name: 'Eng', handle: 'eng', description: 'Engineers' };
      const members: UsergroupMember[] = [
        { id: 'U1', name: 'alice', display_name: 'ali', real_name: 'Alice Doe' },
        { id: 'U2', name: 'bot', real_name: 'bot', is_bot: true },
        { id: 'U3', deleted: true, is_bot: true },
      ];

      expect(formatUsergroup(group, members)).toBe(
        bold('👥 Eng') + ' ' + cyan('@eng') + green(' [enabled]') + '\n\n'
        + '  ' + dim('ID:') + '      S1\n'
        + '  ' + dim('About:') + '   Engineers\n'
        + '  ' + dim('Members:') + ' 3\n'
        + '\n'
        + '  ' + dim('1.') + ' ' + bold('@ali') + dim(' (Alice Doe)') + ' ' + dim('(U1)') + '\n'
        + '  ' + dim('2.') + ' ' + bold('@bot') + ' ' + dim('(U2)') + dim(' [bot]') + '\n'
        + '  ' + dim('3.') + ' ' + bold('@U3') + ' ' + dim('(U3)') + dim(' [bot]') + dim(' [deactivated]') + '\n',
      );
    });

    it('renders a disabled group with no handle, description or members', () => {
      const group: SlackUsergroup = { id: 'S2', name: 'Old', date_delete: 1700000000 };

      expect(formatUsergroup(group, [])).toBe(
        bold('👥 Old') + ' ' + dim('(no handle)') + yellow(' [disabled]') + '\n\n'
        + '  ' + dim('ID:') + '      S2\n'
        + '  ' + dim('Members:') + ' 0\n',
      );
    });
  });
});
