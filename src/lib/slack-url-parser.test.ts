import { describe, expect, it } from 'bun:test';
import {
  identifierKind,
  isSlackUrl,
  normalizeIdentifier,
  normalizeTimestamp,
  parsePermalink,
  parseSlackLink,
  resolveMessageTarget,
  resolveThreadTarget,
  SlackUrlParseError,
  threadParentOf,
  workspaceMismatchWarning,
  workspaceOf,
} from './slack-url-parser';

const CHANNEL = 'C0BHFPKJMC2';
const TEAM_URL = 'https://myteam.slack.com';
const ENTERPRISE_URL = 'https://myorg.enterprise.slack.com';

describe('isSlackUrl', () => {
  it('recognises standard and enterprise Slack hosts', () => {
    expect(isSlackUrl(`${TEAM_URL}/archives/${CHANNEL}`)).toBe(true);
    expect(isSlackUrl(`${ENTERPRISE_URL}/archives/${CHANNEL}`)).toBe(true);
    expect(isSlackUrl('http://myteam.slack.com/team/U012ABCDEFG')).toBe(true);
  });

  it('rejects bare IDs and non-Slack URLs', () => {
    expect(isSlackUrl(CHANNEL)).toBe(false);
    expect(isSlackUrl('https://example.com/archives/C0BHFPKJMC2')).toBe(false);
    expect(isSlackUrl('https://notslack.com')).toBe(false);
  });

  it('sees through angle brackets and whitespace as pasted out of Slack', () => {
    expect(isSlackUrl(`  <${TEAM_URL}/archives/${CHANNEL}>  `)).toBe(true);
  });
});

describe('identifierKind', () => {
  it('classifies Slack ID prefixes', () => {
    expect(identifierKind('C0BHFPKJMC2')).toBe('channel');
    expect(identifierKind('D048XXXXXXX')).toBe('channel');
    expect(identifierKind('G012ABCDEFG')).toBe('channel');
    expect(identifierKind('U012ABCDEFG')).toBe('user');
    expect(identifierKind('W012ABCDEFG')).toBe('user');
    expect(identifierKind('F0123ABCDEF')).toBe('file');
    expect(identifierKind('T012ABCDEFG')).toBe('team');
  });

  it('returns unknown for anything that does not look like a Slack ID', () => {
    expect(identifierKind('general')).toBe('unknown');
    expect(identifierKind('C123')).toBe('unknown'); // too short
    expect(identifierKind('c0bhfpkjmc2')).toBe('unknown'); // lowercase
    expect(identifierKind('')).toBe('unknown');
  });
});

describe('normalizeIdentifier', () => {
  describe('bare IDs pass through unchanged (backward compatibility)', () => {
    it('keeps a channel ID byte-for-byte', () => {
      expect(normalizeIdentifier(CHANNEL, 'channel', '--channel-id')).toBe(CHANNEL);
    });

    it('keeps a user ID byte-for-byte', () => {
      expect(normalizeIdentifier('U012ABCDEFG', 'user', '--recipient-id')).toBe('U012ABCDEFG');
    });

    it('passes through values it cannot classify rather than rejecting them', () => {
      expect(normalizeIdentifier('general', 'channel', '--channel-id')).toBe('general');
      expect(normalizeIdentifier('c0bhfpkjmc2', 'channel', '--channel-id')).toBe('c0bhfpkjmc2');
    });
  });

  describe('URL forms', () => {
    it('extracts a channel ID from an archives URL', () => {
      expect(normalizeIdentifier(`${TEAM_URL}/archives/${CHANNEL}`, 'channel', '--channel-id')).toBe(CHANNEL);
    });

    it('extracts a channel ID from a full message permalink', () => {
      expect(
        normalizeIdentifier(`${TEAM_URL}/archives/${CHANNEL}/p1786816800107789`, 'channel', '--channel-id')
      ).toBe(CHANNEL);
    });

    it('extracts a DM conversation ID', () => {
      expect(normalizeIdentifier(`${TEAM_URL}/archives/D048XXXXXXX`, 'channel', '--recipient-id')).toBe('D048XXXXXXX');
    });

    it('extracts a private group ID', () => {
      expect(normalizeIdentifier(`${TEAM_URL}/archives/G012ABCDEFG`, 'channel', '--channel-id')).toBe('G012ABCDEFG');
    });

    it('extracts a user ID from a profile URL', () => {
      expect(normalizeIdentifier(`${TEAM_URL}/team/U012ABCDEFG`, 'user', '--recipient-id')).toBe('U012ABCDEFG');
    });

    it('extracts a canvas file ID from a docs URL', () => {
      expect(normalizeIdentifier(`${TEAM_URL}/docs/T012AB/F0123ABCD`, 'file', '<canvas-id>')).toBe('F0123ABCD');
    });

    it('handles enterprise grid hosts', () => {
      expect(normalizeIdentifier(`${ENTERPRISE_URL}/archives/${CHANNEL}`, 'channel', '--channel-id')).toBe(CHANNEL);
    });

    it('ignores trailing query junk', () => {
      expect(
        normalizeIdentifier(`${TEAM_URL}/archives/${CHANNEL}?cid=${CHANNEL}&web=1`, 'channel', '--channel-id')
      ).toBe(CHANNEL);
    });

    it('strips angle brackets and surrounding whitespace', () => {
      expect(normalizeIdentifier(`  <${TEAM_URL}/archives/${CHANNEL}>  `, 'channel', '--channel-id')).toBe(CHANNEL);
    });
  });

  describe('type validation against the call site', () => {
    it('rejects a user URL where a channel is expected', () => {
      expect(() => normalizeIdentifier(`${TEAM_URL}/team/U012ABCDEFG`, 'channel', '--channel-id')).toThrow(
        /expects a channel ID, but got a user ID/
      );
    });

    it('rejects a bare user ID where a channel is expected', () => {
      expect(() => normalizeIdentifier('U012ABCDEFG', 'channel', '--channel-id')).toThrow(SlackUrlParseError);
    });

    it('accepts either a channel or a user for channel-or-user call sites', () => {
      expect(normalizeIdentifier(CHANNEL, 'channel-or-user', '--recipient-id')).toBe(CHANNEL);
      expect(normalizeIdentifier('U012ABCDEFG', 'channel-or-user', '--recipient-id')).toBe('U012ABCDEFG');
      expect(() => normalizeIdentifier('F0123ABCDEF', 'channel-or-user', '--recipient-id')).toThrow(
        /expects a channel or user ID/
      );
    });

    it('rejects a channel URL where a canvas file is expected', () => {
      expect(() => normalizeIdentifier(`${TEAM_URL}/archives/${CHANNEL}`, 'file', '<canvas-id>')).toThrow(
        /expects a file ID, but got a channel ID/
      );
    });
  });

  describe('malformed input', () => {
    it('rejects an empty value', () => {
      expect(() => normalizeIdentifier('   ', 'channel', '--channel-id')).toThrow(/requires a value/);
    });

    it('rejects a Slack URL with no recognised path', () => {
      expect(() => normalizeIdentifier(`${TEAM_URL}/customize/emoji`, 'channel', '--channel-id')).toThrow(
        /could not read an ID out of this Slack URL/
      );
    });

    it('rejects a Slack URL with no path at all', () => {
      expect(() => normalizeIdentifier(TEAM_URL, 'channel', '--channel-id')).toThrow(SlackUrlParseError);
    });

    it('treats a non-Slack host as a bare identifier rather than a URL', () => {
      expect(normalizeIdentifier('https://example.com/archives/C0BHFPKJMC2', 'channel', '--channel-id')).toBe(
        'https://example.com/archives/C0BHFPKJMC2'
      );
    });
  });
});

describe('normalizeTimestamp', () => {
  it('converts the permalink form', () => {
    expect(normalizeTimestamp('p1786816800107789', '--timestamp')).toBe('1786816800.107789');
  });

  it('converts a bare 16-digit timestamp', () => {
    expect(normalizeTimestamp('1786816800107789', '--timestamp')).toBe('1786816800.107789');
  });

  it('leaves an already-dotted API timestamp unchanged', () => {
    expect(normalizeTimestamp('1786816800.107789', '--timestamp')).toBe('1786816800.107789');
  });

  it('leaves plain epoch seconds unchanged for range bounds', () => {
    // --oldest / --latest legitimately take whole seconds; normalizing them would
    // silently move the range by ~six orders of magnitude.
    expect(normalizeTimestamp('1786816800', '--oldest')).toBe('1786816800');
  });

  it('strips angle brackets and whitespace', () => {
    expect(normalizeTimestamp('  p1786816800107789  ', '--timestamp')).toBe('1786816800.107789');
  });

  it('rejects an empty value', () => {
    expect(() => normalizeTimestamp('  ', '--timestamp')).toThrow(/requires a value/);
  });

  it('points at --permalink when handed a URL', () => {
    expect(() => normalizeTimestamp(`${TEAM_URL}/archives/${CHANNEL}/p1786816800107789`, '--timestamp')).toThrow(
      /Use --permalink/
    );
  });

  it('rejects a p-prefixed timestamp of the wrong length', () => {
    expect(() => normalizeTimestamp('p17868168001077', '--timestamp')).toThrow(/expected 16/);
  });

  it('rejects non-numeric input', () => {
    expect(() => normalizeTimestamp('not-a-timestamp', '--timestamp')).toThrow(/not a valid Slack timestamp/);
  });
});

describe('parseSlackLink', () => {
  it('parses a standard message permalink', () => {
    const parsed = parseSlackLink(`${TEAM_URL}/archives/${CHANNEL}/p1786816800107789`);
    expect(parsed.channelId).toBe(CHANNEL);
    expect(parsed.timestamp).toBe('1786816800.107789');
    expect(parsed.threadTs).toBeUndefined();
    expect(parsed.workspace).toBe('myteam');
  });

  it('parses a bare channel link with no message', () => {
    const parsed = parseSlackLink(`${TEAM_URL}/archives/${CHANNEL}`);
    expect(parsed.channelId).toBe(CHANNEL);
    expect(parsed.timestamp).toBeUndefined();
  });

  it('parses a DM link', () => {
    const parsed = parseSlackLink(`${TEAM_URL}/archives/D048XXXXXXX/p1786816800107789`);
    expect(parsed.channelId).toBe('D048XXXXXXX');
  });

  it('parses an enterprise host and reports the org subdomain', () => {
    const parsed = parseSlackLink(`${ENTERPRISE_URL}/archives/${CHANNEL}/p1786816800107789`);
    expect(parsed.channelId).toBe(CHANNEL);
    expect(parsed.workspace).toBe('myorg');
  });

  it('reports the real subdomain for a mixed-case host', () => {
    expect(parseSlackLink('https://myteam.SLACK.COM/archives/C0BHFPKJMC2/p1786816800107789').workspace).toBe(
      'myteam'
    );
  });

  it('ignores extra query parameters', () => {
    const parsed = parseSlackLink(`${TEAM_URL}/archives/${CHANNEL}/p1786816800107789?cid=${CHANNEL}&web=1`);
    expect(parsed.timestamp).toBe('1786816800.107789');
    expect(parsed.threadTs).toBeUndefined();
  });

  it('strips angle brackets', () => {
    const parsed = parseSlackLink(`<${TEAM_URL}/archives/${CHANNEL}/p1786816800107789>`);
    expect(parsed.timestamp).toBe('1786816800.107789');
  });

  describe('threaded replies', () => {
    // The path holds the REPLY timestamp; ?thread_ts= holds the PARENT. Confusing the
    // two silently targets the wrong message.
    const REPLY_LINK = `${TEAM_URL}/archives/${CHANNEL}/p1786816999222333?thread_ts=1786816800.107789&cid=${CHANNEL}`;

    it('keeps the reply timestamp as the message timestamp', () => {
      expect(parseSlackLink(REPLY_LINK).timestamp).toBe('1786816999.222333');
    });

    it('reads the parent timestamp out of thread_ts', () => {
      expect(parseSlackLink(REPLY_LINK).threadTs).toBe('1786816800.107789');
    });

    it('resolves the thread parent to thread_ts for a reply', () => {
      expect(threadParentOf(parseSlackLink(REPLY_LINK))).toBe('1786816800.107789');
    });

    it('resolves the thread parent to the message itself for a top-level message', () => {
      expect(threadParentOf(parseSlackLink(`${TEAM_URL}/archives/${CHANNEL}/p1786816800107789`))).toBe(
        '1786816800.107789'
      );
    });

    it('normalizes a permalink-form thread_ts too', () => {
      const parsed = parseSlackLink(
        `${TEAM_URL}/archives/${CHANNEL}/p1786816999222333?thread_ts=1786816800107789`
      );
      expect(parsed.threadTs).toBe('1786816800.107789');
    });
  });

  describe('malformed input', () => {
    it('rejects a non-Slack URL', () => {
      expect(() => parseSlackLink('https://example.com/archives/C0BHFPKJMC2')).toThrow(/Not a Slack URL/);
    });

    it('rejects a Slack URL without an /archives/ segment', () => {
      expect(() => parseSlackLink(`${TEAM_URL}/team/U012ABCDEFG`)).toThrow(/Not a Slack message link/);
    });

    it('rejects a user ID in the channel position', () => {
      expect(() => parseSlackLink(`${TEAM_URL}/archives/U012ABCDEFG/p1786816800107789`)).toThrow(
        /names a user ID .* where a channel was expected/
      );
    });

    it('rejects a non-numeric message segment', () => {
      expect(() => parseSlackLink(`${TEAM_URL}/archives/${CHANNEL}/notamessage`)).toThrow(
        /unexpected message segment/
      );
    });
  });
});

describe('parsePermalink', () => {
  it('returns a guaranteed timestamp for a message link', () => {
    expect(parsePermalink(`${TEAM_URL}/archives/${CHANNEL}/p1786816800107789`).timestamp).toBe('1786816800.107789');
  });

  it('rejects a link that names only a channel', () => {
    expect(() => parsePermalink(`${TEAM_URL}/archives/${CHANNEL}`)).toThrow(/does not point at a message/);
  });
});

describe('workspaceOf', () => {
  it('reports the subdomain of a Slack URL', () => {
    expect(workspaceOf(`${TEAM_URL}/archives/${CHANNEL}`)).toBe('myteam');
    expect(workspaceOf(`${ENTERPRISE_URL}/archives/${CHANNEL}`)).toBe('myorg');
  });

  it('reports the real subdomain even when the host is not all lowercase', () => {
    // The URL parser lowercases the host; a case-sensitive regex over the raw
    // string would fall back to the literal "workspace" and warn spuriously.
    expect(workspaceOf('https://myteam.SLACK.COM/archives/C0BHFPKJMC2')).toBe('myteam');
    expect(workspaceOf('HTTPS://MyTeam.Slack.Com/archives/C0BHFPKJMC2')).toBe('myteam');
  });

  it('reports nothing for a bare ID or a missing value', () => {
    expect(workspaceOf(CHANNEL)).toBeUndefined();
    expect(workspaceOf(undefined)).toBeUndefined();
  });
});

describe('workspaceMismatchWarning', () => {
  it('warns when the link belongs to another workspace', () => {
    expect(workspaceMismatchWarning('other', 'myteam')).toMatch(/"other".*"myteam"/);
  });

  it('stays silent when they match, ignoring case', () => {
    expect(workspaceMismatchWarning('MyTeam', 'myteam')).toBeNull();
  });

  it('stays silent when either side is unknown (standard auth has no subdomain)', () => {
    expect(workspaceMismatchWarning('myteam', undefined)).toBeNull();
    expect(workspaceMismatchWarning(undefined, 'myteam')).toBeNull();
  });
});

describe('resolveMessageTarget', () => {
  const flags = { channel: '--channel-id', timestamp: '--timestamp' };

  it('resolves explicit inputs, normalizing both', () => {
    const target = resolveMessageTarget(
      { channelId: `${TEAM_URL}/archives/${CHANNEL}`, timestamp: 'p1786816800107789' },
      flags
    );
    expect(target).toEqual({ channelId: CHANNEL, timestamp: '1786816800.107789', workspace: 'myteam' });
  });

  it('resolves a permalink into both inputs at once', () => {
    const target = resolveMessageTarget(
      { permalink: `${TEAM_URL}/archives/${CHANNEL}/p1786816800107789` },
      flags
    );
    expect(target).toEqual({ channelId: CHANNEL, timestamp: '1786816800.107789', workspace: 'myteam' });
  });

  it('targets the reply itself, not its parent, for a threaded-reply permalink', () => {
    const target = resolveMessageTarget(
      { permalink: `${TEAM_URL}/archives/${CHANNEL}/p1786816999222333?thread_ts=1786816800.107789` },
      flags
    );
    expect(target.timestamp).toBe('1786816999.222333');
  });

  it('reports no workspace when explicit inputs are bare IDs', () => {
    const target = resolveMessageTarget({ channelId: CHANNEL, timestamp: '1786816800.107789' }, flags);
    expect(target.workspace).toBeUndefined();
  });

  it('names only the input that actually collides with --permalink', () => {
    expect(() =>
      resolveMessageTarget(
        { permalink: `${TEAM_URL}/archives/${CHANNEL}/p1786816800107789`, channelId: CHANNEL },
        flags
      )
    ).toThrow(/--permalink already supplies --channel-id; pass one or the other, not both/);
    expect(() =>
      resolveMessageTarget(
        { permalink: `${TEAM_URL}/archives/${CHANNEL}/p1786816800107789`, timestamp: '1786816800.107789' },
        flags
      )
    ).toThrow(/--permalink already supplies --timestamp; pass one or the other, not both/);
  });

  it('names both inputs when both collide with --permalink', () => {
    expect(() =>
      resolveMessageTarget(
        {
          permalink: `${TEAM_URL}/archives/${CHANNEL}/p1786816800107789`,
          channelId: CHANNEL,
          timestamp: '1786816800.107789',
        },
        flags
      )
    ).toThrow(/already supplies --channel-id and --timestamp/);
  });

  it('names every missing input when neither form is complete', () => {
    expect(() => resolveMessageTarget({}, flags)).toThrow(/Missing --channel-id and --timestamp/);
    expect(() => resolveMessageTarget({ channelId: CHANNEL }, flags)).toThrow(/Missing --timestamp/);
  });

  it('rejects a channel-only link as a message target', () => {
    expect(() => resolveMessageTarget({ permalink: `${TEAM_URL}/archives/${CHANNEL}` }, flags)).toThrow(
      /does not point at a message/
    );
  });
});

describe('resolveThreadTarget', () => {
  const flags = { channel: '--recipient-id', timestamp: '--thread-ts' };

  it('resolves explicit inputs, normalizing both', () => {
    const target = resolveThreadTarget(
      { channelId: `${TEAM_URL}/archives/${CHANNEL}`, threadTs: 'p1786816800107789' },
      flags
    );
    expect(target).toEqual({ channelId: CHANNEL, threadTs: '1786816800.107789', workspace: 'myteam' });
  });

  it('leaves the thread unset when no thread timestamp is given', () => {
    const target = resolveThreadTarget({ channelId: CHANNEL }, flags);
    expect(target.threadTs).toBeUndefined();
  });

  it('resolves a top-level message permalink to that message as thread parent', () => {
    const target = resolveThreadTarget(
      { permalink: `${TEAM_URL}/archives/${CHANNEL}/p1786816800107789` },
      flags
    );
    expect(target).toEqual({ channelId: CHANNEL, threadTs: '1786816800.107789', workspace: 'myteam' });
  });

  it('resolves a threaded-reply permalink to the PARENT timestamp', () => {
    const target = resolveThreadTarget(
      { permalink: `${TEAM_URL}/archives/${CHANNEL}/p1786816999222333?thread_ts=1786816800.107789` },
      flags
    );
    expect(target.threadTs).toBe('1786816800.107789');
  });

  it('resolves a bare channel link to the channel with no thread', () => {
    const target = resolveThreadTarget({ permalink: `${TEAM_URL}/archives/${CHANNEL}` }, flags);
    expect(target).toEqual({ channelId: CHANNEL, threadTs: undefined, workspace: 'myteam' });
  });

  it('accepts a user profile URL for channel-or-user call sites', () => {
    const target = resolveThreadTarget(
      { channelId: `${TEAM_URL}/team/U012ABCDEFG` },
      flags,
      'channel-or-user'
    );
    expect(target.channelId).toBe('U012ABCDEFG');
  });

  it('rejects --permalink combined with an explicit input', () => {
    expect(() =>
      resolveThreadTarget(
        { permalink: `${TEAM_URL}/archives/${CHANNEL}`, channelId: CHANNEL },
        flags
      )
    ).toThrow(/--permalink already supplies --recipient-id; pass one or the other, not both/);
    expect(() =>
      resolveThreadTarget(
        { permalink: `${TEAM_URL}/archives/${CHANNEL}`, threadTs: '1786816800.107789' },
        flags
      )
    ).toThrow(/--permalink already supplies --thread-ts; pass one or the other, not both/);
  });

  it('requires a channel when no permalink is given', () => {
    expect(() => resolveThreadTarget({}, flags)).toThrow(/Missing --recipient-id/);
  });
});
