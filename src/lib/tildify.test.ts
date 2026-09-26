import { describe, expect, it } from 'bun:test';
import { tildify } from './tildify.ts';

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
