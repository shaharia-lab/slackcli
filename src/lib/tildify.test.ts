import { describe, expect, it } from 'bun:test';
import { errorMessageForLog, tildify, tildifyText } from './tildify.ts';

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

describe('errorMessageForLog', () => {
  it('uses the message of an Error, with the home directory as ~', () => {
    expect(errorMessageForLog(new Error("ENOENT: open '/home/u/x'"), 'unknown error', '/home/u'))
      .toBe("ENOENT: open '~/x'");
  });

  it('stringifies a non-Error value', () => {
    expect(errorMessageForLog('plain /home/u/x', 'unknown error', '/home/u')).toBe('plain ~/x');
    expect(errorMessageForLog(42, 'unknown error', '/home/u')).toBe('42');
  });

  it('falls back for a missing value or an empty message', () => {
    expect(errorMessageForLog(undefined, 'send failed', '/home/u')).toBe('send failed');
    expect(errorMessageForLog(null, 'unknown error', '/home/u')).toBe('unknown error');
    expect(errorMessageForLog(new Error(''), 'unknown error', '/home/u')).toBe('unknown error');
  });

  it('falls back for a non-Error object instead of "[object Object]" or its contents', () => {
    expect(errorMessageForLog({ text: 'secret message' }, 'unknown error', '/home/u')).toBe('unknown error');
    expect(errorMessageForLog([1, 2], 'unknown error', '/home/u')).toBe('unknown error');
  });
});
