import { describe, expect, it } from 'bun:test';
import { normalizeSlackWorkspaceUrl } from './workspace-url.ts';

describe('normalizeSlackWorkspaceUrl', () => {
  it.each([
    ['https://example.slack.com', 'https://example.slack.com'],
    ['https://example.slack.com/', 'https://example.slack.com'],
    ['HTTPS://EXAMPLE.SLACK.COM', 'https://example.slack.com'],
    ['https://acme.enterprise.slack.com', 'https://acme.enterprise.slack.com'],
    ['https://slack.com', 'https://slack.com'],
  ])('accepts and normalizes %s', (input, expected) => {
    expect(normalizeSlackWorkspaceUrl(input)).toBe(expected);
  });

  it.each([
    'http://example.slack.com',
    'ftp://example.slack.com',
    'https://example.com',
    'https://slack.com.example.org',
    'https://evilslack.com',
    'https://example.slack.com.evil.org',
    'https://user@example.slack.com',
    'https://user:password@example.slack.com',
    'https://example.slack.com:8443',
    'https://example.slack.com:443',
    'https://example.slack.com/api/auth.test',
    'https://example.slack.com?next=https://evil.example',
    'https://example.slack.com#@evil.example',
    'https://example.slack.com/foo/..',
    'https://example.slack.com\\@evil.example',
    'https://example.slack.com.',
    'https://.slack.com',
    'not a URL',
    '',
  ])('rejects unsafe workspace URL %s', (input) => {
    expect(() => normalizeSlackWorkspaceUrl(input)).toThrow(
      'Invalid Slack workspace URL',
    );
  });

  it.each([null, undefined, 42, {}])(
    'rejects a non-string persisted URL: %p',
    (input) => {
      expect(() => normalizeSlackWorkspaceUrl(input as string)).toThrow(
        'Invalid Slack workspace URL',
      );
    },
  );

  it('accepts a hostname at the DNS length limit', () => {
    const label63 = 'a'.repeat(63);
    const hostname = `${label63}.${label63}.${label63}.${'a'.repeat(51)}.slack.com`;

    expect(hostname).toHaveLength(253);
    expect(normalizeSlackWorkspaceUrl(`https://${hostname}`)).toBe(
      `https://${hostname}`,
    );
  });

  it('rejects a hostname over the DNS length limit', () => {
    const label63 = 'a'.repeat(63);
    const hostname = `${label63}.${label63}.${label63}.${'a'.repeat(52)}.slack.com`;

    expect(hostname).toHaveLength(254);
    expect(() => normalizeSlackWorkspaceUrl(`https://${hostname}`)).toThrow(
      'Invalid Slack workspace URL',
    );
  });
});
