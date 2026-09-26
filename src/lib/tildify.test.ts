import { describe, expect, it } from 'bun:test';
import { tildify, tildifyText } from './tildify.ts';

describe('tildify', () => {
  it('replaces a leading home directory only', () => {
    expect(tildify('/home/u/.bun/bin/bun', '/home/u')).toBe('~/.bun/bin/bun');
    expect(tildify('/home/u', '/home/u')).toBe('~');
    expect(tildify('/home/user2/bin', '/home/u')).toBe('/home/user2/bin');
    expect(tildify('/usr/local/bin/slackcli', '/home/u')).toBe('/usr/local/bin/slackcli');
    expect(tildify('C:\\Users\\u\\bin\\slackcli.exe', 'C:\\Users\\u')).toBe('~\\bin\\slackcli.exe');
    expect(tildify('/x', '')).toBe('/x');
  });
});

describe('tildifyText', () => {
  it('replaces every home-directory path inside a message', () => {
    expect(tildifyText("EACCES: permission denied, open '/home/u/.config/x'", '/home/u'))
      .toBe("EACCES: permission denied, open '~/.config/x'");
    expect(tildifyText('at a (/home/u/a.ts:1:2)\n    at b (/home/u/b.ts:3:4)', '/home/u'))
      .toBe('at a (~/a.ts:1:2)\n    at b (~/b.ts:3:4)');
    expect(tildifyText('C:\\Users\\u\\x.exe failed', 'C:\\Users\\u')).toBe('~\\x.exe failed');
  });

  it('leaves a sibling home and empty home alone', () => {
    expect(tildifyText('/home/user2/x', '/home/u')).toBe('/home/user2/x');
    expect(tildifyText('/home/u/x', '')).toBe('/home/u/x');
  });
});
