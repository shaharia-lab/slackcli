import { describe, expect, it } from 'bun:test';
import { DEFAULT_BROWSER_USER_AGENT, browserUserAgent, sanitizeUserAgent } from './user-agent.ts';

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

describe('sanitizeUserAgent', () => {
  it('keeps a real browser User-Agent unchanged', () => {
    expect(sanitizeUserAgent(CHROME_UA)).toBe(CHROME_UA);
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeUserAgent(`  ${CHROME_UA}\n`)).toBe(CHROME_UA);
  });

  it('refuses non-strings', () => {
    for (const value of [undefined, null, 42, {}, ['x']]) {
      expect(sanitizeUserAgent(value)).toBeUndefined();
    }
  });

  it('refuses empty and whitespace-only values', () => {
    expect(sanitizeUserAgent('')).toBeUndefined();
    expect(sanitizeUserAgent('   ')).toBeUndefined();
  });

  it('refuses CR/LF inside the value, which would inject a header', () => {
    expect(sanitizeUserAgent('Mozilla/5.0\r\nX-Injected: 1')).toBeUndefined();
    expect(sanitizeUserAgent('Mozilla/5.0\nX-Injected: 1')).toBeUndefined();
  });

  it('refuses other control and non-ASCII characters', () => {
    expect(sanitizeUserAgent('Mozilla/5.0\tChrome')).toBeUndefined();
    expect(sanitizeUserAgent('Mozilla/5.0\u0000')).toBeUndefined();
    expect(sanitizeUserAgent('Mozilla/5.0 (Ünïcode)')).toBeUndefined();
  });

  it('accepts a value at the length limit and refuses one past it', () => {
    expect(sanitizeUserAgent('a'.repeat(1024))).toBe('a'.repeat(1024));
    expect(sanitizeUserAgent('a'.repeat(1025))).toBeUndefined();
  });
});

describe('browserUserAgent', () => {
  it('replays the stored User-Agent', () => {
    expect(browserUserAgent({ user_agent: CHROME_UA })).toBe(CHROME_UA);
  });

  it('falls back to the default when none is stored', () => {
    expect(browserUserAgent({})).toBe(DEFAULT_BROWSER_USER_AGENT);
  });

  it('falls back to the default when the stored value is unusable', () => {
    expect(browserUserAgent({ user_agent: 'bad\r\nvalue' })).toBe(DEFAULT_BROWSER_USER_AGENT);
    expect(browserUserAgent({ user_agent: '' })).toBe(DEFAULT_BROWSER_USER_AGENT);
  });

  it('keeps the historical default so existing workspaces send what they always did', () => {
    expect(DEFAULT_BROWSER_USER_AGENT).toBe('Mozilla/5.0 (compatible; SlackCLI/0.1.0)');
  });
});
