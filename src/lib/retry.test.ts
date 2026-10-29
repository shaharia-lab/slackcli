import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_RETRY_OPTIONS,
  READ_METHODS,
  decideRetry,
  isReadMethod,
  parseRetryAfter,
  resolveRetryOptions,
} from './retry.ts';
import type { AttemptFailure, RetryOptions } from './retry.ts';

const options = (overrides: Partial<RetryOptions> = {}): RetryOptions =>
  ({ ...DEFAULT_RETRY_OPTIONS, random: () => 0.5, ...overrides });

const failure = (overrides: Partial<AttemptFailure>): AttemptFailure => ({
  method: 'users.info',
  networkError: false,
  attempt: 1,
  waitedMs: 0,
  ...overrides,
});

describe('parseRetryAfter', () => {
  it.each([
    ['0', 0],
    ['1', 1000],
    ['30', 30_000],
    [' 5 ', 5000],
  ])('parses %p as %p ms', (header, expected) => {
    expect(parseRetryAfter(header)).toBe(expected);
  });

  it.each([
    [null],
    [undefined],
    [''],
    ['-1'],
    ['1.5'],
    ['abc'],
    ['Wed, 21 Oct 2015 07:28:00 GMT'],
    ['99999999999999999999'],
  ])('returns undefined for %p', (header) => {
    expect(parseRetryAfter(header)).toBeUndefined();
  });
});

describe('isReadMethod', () => {
  it('knows the read methods the client calls', () => {
    for (const method of ['conversations.history', 'users.info', 'search.messages', 'auth.test', 'subscriptions.thread.getView', 'chat.scheduledMessages.list']) {
      expect(isReadMethod(method)).toBe(true);
    }
  });

  it('treats writes and unknown methods as writes', () => {
    for (const method of [
      'chat.postMessage',
      'chat.update',
      'chat.scheduleMessage',
      'chat.deleteScheduledMessage',
      'drafts.create',
      'drafts.delete',
      'reactions.add',
      'conversations.open',
      'conversations.join',
      'files.getUploadURLExternal',
      'files.completeUploadExternal',
      'usergroups.users.update',
      'some.future.method',
      '',
    ]) {
      expect(isReadMethod(method)).toBe(false);
    }
  });

  it('holds no method that changes state', () => {
    const writeVerbs = /\.(post|update|create|delete|add|remove|invite|kick|join|leave|open|enable|disable|complete|getUpload)/i;
    expect([...READ_METHODS].filter((m) => writeVerbs.test(m))).toEqual([]);
  });
});

describe('decideRetry', () => {
  it('retries a 429 for a write, using Retry-After', () => {
    expect(decideRetry(failure({ method: 'chat.postMessage', status: 429, retryAfterMs: 4000 }), options()))
      .toEqual({ retry: true, waitMs: 4000 });
  });

  it('retries a 429 for a read', () => {
    expect(decideRetry(failure({ status: 429, retryAfterMs: 1000 }), options())).toEqual({ retry: true, waitMs: 1000 });
  });

  it('backs off exponentially on a 429 without Retry-After, or with Retry-After: 0', () => {
    const waits = [1, 2, 3].map((attempt) =>
      decideRetry(failure({ status: 429, attempt, retryAfterMs: attempt === 2 ? 0 : undefined }), options()));
    expect(waits).toEqual([
      { retry: true, waitMs: 750 },
      { retry: true, waitMs: 1500 },
      { retry: true, waitMs: 3000 },
    ]);
  });

  it('keeps jittered backoff within [50%, 100%] of the exponential delay and above 0', () => {
    for (const value of [0, 0.25, 0.999999]) {
      const decision = decideRetry(failure({ status: 503, attempt: 2 }), options({ random: () => value }));
      if (!decision.retry) throw new Error('expected a retry');
      expect(decision.waitMs).toBeGreaterThanOrEqual(1000);
      expect(decision.waitMs).toBeLessThanOrEqual(2000);
    }
  });

  it('caps a single wait at maxWaitMs', () => {
    expect(decideRetry(failure({ status: 429, retryAfterMs: 600_000 }), options()))
      .toEqual({ retry: true, waitMs: 60_000 });
    expect(decideRetry(failure({ status: 503, attempt: 3 }), options({ maxWaitMs: 500 })))
      .toEqual({ retry: true, waitMs: 500 });
  });

  it('retries 5xx and network errors for reads only', () => {
    for (const status of [500, 502, 503, 504, 599]) {
      expect(decideRetry(failure({ status }), options()).retry).toBe(true);
      expect(decideRetry(failure({ method: 'chat.postMessage', status }), options()).retry).toBe(false);
    }
    expect(decideRetry(failure({ networkError: true }), options()).retry).toBe(true);
    expect(decideRetry(failure({ method: 'chat.postMessage', networkError: true }), options()).retry).toBe(false);
  });

  it('does not retry other statuses or a failure with no status', () => {
    for (const status of [400, 401, 403, 404, 408, 413]) {
      expect(decideRetry(failure({ status }), options()).retry).toBe(false);
    }
    expect(decideRetry(failure({}), options()).retry).toBe(false);
  });

  it('stops once maxRetries retries have been made', () => {
    expect(decideRetry(failure({ status: 429, attempt: 3 }), options()).retry).toBe(true);
    expect(decideRetry(failure({ status: 429, attempt: 4 }), options()).retry).toBe(false);
    expect(decideRetry(failure({ status: 429, attempt: 1 }), options({ maxRetries: 0 })).retry).toBe(false);
  });

  it('stops when the next wait would overrun maxTotalWaitMs', () => {
    expect(decideRetry(failure({ status: 429, retryAfterMs: 20_000, waitedMs: 100_000 }), options()))
      .toEqual({ retry: true, waitMs: 20_000 });
    expect(decideRetry(failure({ status: 429, retryAfterMs: 20_001, waitedMs: 100_000 }), options()).retry).toBe(false);
  });
});

describe('resolveRetryOptions', () => {
  it('fills in the defaults', () => {
    expect(resolveRetryOptions()).toEqual(DEFAULT_RETRY_OPTIONS);
    expect(resolveRetryOptions({ maxRetries: 1 }).maxRetries).toBe(1);
  });

  it.each(['maxRetries', 'maxTotalWaitMs', 'maxWaitMs', 'baseDelayMs'] as const)('rejects a negative or non-finite %s', (key) => {
    expect(() => resolveRetryOptions({ [key]: -1 })).toThrow(key);
    expect(() => resolveRetryOptions({ [key]: Number.NaN })).toThrow(key);
    expect(() => resolveRetryOptions({ [key]: Infinity })).toThrow(key);
  });
});
