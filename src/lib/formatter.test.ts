import { describe, expect, it } from 'bun:test';
import {
  formatSavedItems,
  formatSearchMessages,
  formatChannelSearchResults,
  formatPeopleSearchResults,
  formatUnreadChannels,
  formatPaginationHint,
  formatFileSize,
  formatMessage,
} from './formatter.ts';
import type {
  SavedItem,
  SearchMatch,
  ChannelSearchResult,
  PeopleSearchResult,
  UnreadChannel,
  SlackUser,
  SlackMessage,
} from '../types/index.ts';

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

  it('uses correct prefix for DMs and group DMs', () => {
    const channels: UnreadChannel[] = [
      { id: 'D1', name: 'Alice', mention_count: 0, has_unreads: true, is_im: true },
      { id: 'G1', name: 'Team Chat', mention_count: 0, has_unreads: true, is_mpim: true },
      { id: 'C1', name: 'secret', mention_count: 0, has_unreads: true, is_private: true },
    ];

    const output = formatUnreadChannels(channels);
    // DMs and group DMs should not use # prefix
    expect(output).not.toMatch(/#\s*Alice/);
    expect(output).not.toMatch(/#\s*Team Chat/);
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
