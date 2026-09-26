import { describe, expect, it } from 'bun:test';
import { getJsonLinesFormatter } from '@logtape/logtape';
import type { LogRecord } from '@logtape/logtape';
import { SLACK_REDACTION_PATTERNS, redactFormatter } from './log-redaction.ts';

function record(message: string, properties: Record<string, unknown> = {}): LogRecord {
  return {
    category: ['slackcli', 'test'],
    level: 'info',
    message: [message],
    rawMessage: message,
    timestamp: Date.UTC(2026, 8, 26),
    properties,
  };
}

const format = redactFormatter(getJsonLinesFormatter());

// Realistic shapes: numeric segments and hex like real tokens, and an xoxd that
// has been URL-encoded for the Cookie header.
// Every fixture is assembled at runtime by `token()`: written as one literal,
// a realistic token matches GitHub push protection's Slack-token patterns and
// the push is rejected.
const token = (prefix: string, ...parts: string[]) => [prefix, ...parts].join('-');
const TOKENS = [
  token('xoxb', '1234567890', '1234567890123', 'AbCdEfGhIjKlMnOpQrStUvWx'),
  token('xoxp', '1234567890', '1234567890', '1234567890123', '0123456789abcdef0123456789abcdef'),
  token('xoxc', '1234567890', '1234567890', '1234567890123', '0123456789abcdef0123456789abcdef0123456789abcdef'),
  token('xoxd', 'AbCd%2FEfGh%2BIjKl%3D%3D'),
  token('xoxd', 'AbCd/EfGh+IjKl=='),
  token('xoxe', '1', 'My0xLTEyMzQ1Njc4OTAtMTIzNDU2Nzg5MC0xMjM0NTY3ODkwMTIz'),
  token('xoxe.xoxp', '1', 'Mi0yLTEyMzQ1Njc4OTAtMTIzNDU2Nzg5MC0xMjM0NTY3ODkwMTIz'),
  token('xoxa', '2', '1234567890', 'abcdef'),
];

// Every character after the prefix is secret; check the whole body and its
// tail, so a match that stops early (at `/`, `+`, `=`, …) is caught.
const secretParts = (token: string) => {
  const body = token.slice(token.indexOf('-') + 1);
  return [body, body.slice(-6)];
};

describe('redactFormatter', () => {
  for (const token of TOKENS) {
    it(`redacts ${token.slice(0, 10)}… in messages and properties`, () => {
      const line = format(record(`auth failed for ${token}`, { token, nested: { list: [token] } }));

      expect(line).not.toContain(token);
      for (const part of secretParts(token)) expect(line).not.toContain(part);
      expect(line).toContain('xox?-[REDACTED]');
      // Redaction must never break the JSON line.
      expect(() => JSON.parse(line)).not.toThrow();
    });
  }

  it('redacts a decoded xoxd with base64 characters completely', () => {
    const line = format(record('cookie', { value: 'xoxd-AbCd/EfGh+IjKl==', header: 'd=xoxd-Zz/Yy+Xx==' }));

    expect(line).not.toContain('EfGh');
    expect(line).not.toContain('IjKl');
    expect(line).not.toContain('Yy+Xx');
    expect(JSON.parse(line).properties.value).toBe('xox?-[REDACTED]');
  });

  it('redacts the d= cookie value, encoded or not', () => {
    const line = format(record('request', {
      headers: 'Cookie: d=AbCd%2FEfGh%3D%3D; d-s=1700000000; lc=1',
      raw: 'd=plainCookieValue123',
    }));

    expect(line).not.toContain('AbCd%2FEfGh');
    expect(line).not.toContain('plainCookieValue123');
    expect(line).toContain('d=[REDACTED]');
    // Other cookies and names ending in "d" stay readable.
    expect(line).toContain('d-s=1700000000');
    expect(JSON.parse(line).properties.headers).toContain('lc=1');
  });

  it('leaves ids and ordinary text untouched', () => {
    const line = format(record('xoxo, the channel_id=C123 and id=U456 look fine', { user: 'U456' }));
    const parsed = JSON.parse(line);

    expect(parsed.message).toBe('xoxo, the channel_id=C123 and id=U456 look fine');
    expect(parsed.properties.user).toBe('U456');
  });

  it('redacts tokens embedded in JSON strings and error messages', () => {
    const payload = JSON.stringify({ token: TOKENS[2], cookie: `d=${TOKENS[3]}` });
    const error = new Error(`Slack API error: invalid_auth for ${TOKENS[0]}`);
    const line = format(record('payload {payload}', { payload, error_message: error.message }));

    for (const part of [...secretParts(TOKENS[2]!), ...secretParts(TOKENS[0]!), ...secretParts(TOKENS[3]!)]) {
      expect(line).not.toContain(part);
    }
    expect(() => JSON.parse(line)).not.toThrow();
  });

  it('never swallows a JSON escape, so a quote after a cookie keeps the line valid', () => {
    const line = format(record('odd', { value: 'd=abc"tail', other: 'd=abc\\more' }));
    const parsed = JSON.parse(line);

    expect(parsed.properties.value).toBe('d=[REDACTED]"tail');
    expect(parsed.properties.other).toBe('d=[REDACTED]\\more');
  });

  it('redacts JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl';
    expect(format(record(jwt))).not.toContain('eyJzdWIiOiIxMjM0In0');
  });

  it('uses only global patterns, as redactByPattern requires', () => {
    for (const { pattern } of SLACK_REDACTION_PATTERNS) {
      expect(pattern.global).toBe(true);
    }
  });
});
