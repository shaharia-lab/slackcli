// Decides whether a failed browser-auth Slack call is retried, and after how
// long. Pure: no I/O, no clock, no sleeping — `SlackClient.request()` owns the
// loop and the wait, so it can release its rate-limiter slot while it waits.
//
// The standard-token path does not use this: `@slack/web-api` already retries
// on its own.
//
// The rule that matters is idempotency. A 429 means Slack rejected the request
// without acting on it, so any method may be retried. A 5xx or a network error
// says nothing about whether the call was applied — a `chat.postMessage` that
// timed out may still have posted — so only methods known to be reads are
// retried on those. Hand-rolled rather than pulled from npm (`p-retry`, …): it
// is a few lines of policy, and the idempotency split is the part no generic
// library knows.

/**
 * Slack methods safe to repeat after an ambiguous failure (5xx, network error).
 * An explicit allowlist, not a name heuristic: a method missing from it —
 * including one added later — is treated as a write and never retried on
 * anything but a 429.
 */
export const READ_METHODS: ReadonlySet<string> = new Set([
  'auth.test',
  'chat.getPermalink',
  'client.counts',
  'conversations.history',
  'conversations.info',
  'conversations.list',
  'conversations.members',
  'conversations.replies',
  'drafts.list',
  'emoji.list',
  'files.info',
  'files.list',
  'messages.list',
  'saved.list',
  'search.messages',
  'search.modules',
  'stars.list',
  'subscriptions.thread.getView',
  'team.info',
  'team.profile.get',
  'usergroups.list',
  'usergroups.users.list',
  'users.info',
  'users.list',
  'users.lookupByEmail',
]);

export interface RetryOptions {
  /** Retries after the first attempt, so a call makes at most `maxRetries + 1` attempts. */
  maxRetries: number;
  /** Upper bound on the sum of all waits for one call, in milliseconds. */
  maxTotalWaitMs: number;
  /** Upper bound on a single wait, including one asked for by `Retry-After`. */
  maxWaitMs: number;
  /** First backoff delay when there is no `Retry-After`; doubles per retry. */
  baseDelayMs: number;
  /** Source of jitter in [0, 1). Injectable so tests are deterministic. */
  random: () => number;
}

export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  maxTotalWaitMs: 120_000,
  maxWaitMs: 60_000,
  baseDelayMs: 1_000,
  random: Math.random,
};

/** What one failed attempt looked like. */
export interface AttemptFailure {
  method: string;
  /** HTTP status of a non-2xx response; absent for network errors and Slack `ok:false` errors. */
  status?: number;
  /** `fetch` itself rejected: no response was received. */
  networkError: boolean;
  /** Wait requested by the response's `Retry-After` header, in milliseconds. */
  retryAfterMs?: number;
  /** Attempts made so far, including the one that just failed (1-based). */
  attempt: number;
  /** Time already spent waiting between earlier attempts of this call. */
  waitedMs: number;
}

export type RetryDecision = { retry: false } | { retry: true; waitMs: number };

/**
 * Parses a `Retry-After` header given in whole seconds, returning milliseconds.
 * The HTTP-date form, negative numbers and anything else unparseable give
 * `undefined`, so the caller falls back to its own backoff.
 */
export function parseRetryAfter(header: string | null | undefined): number | undefined {
  if (header == null) return undefined;
  const value = header.trim();
  if (!/^\d+$/.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds * 1000 : undefined;
}

export function isReadMethod(method: string): boolean {
  return READ_METHODS.has(method);
}

export function resolveRetryOptions(overrides: Partial<RetryOptions> = {}): RetryOptions {
  const options = { ...DEFAULT_RETRY_OPTIONS, ...overrides };
  for (const key of ['maxRetries', 'maxTotalWaitMs', 'maxWaitMs', 'baseDelayMs'] as const) {
    if (!Number.isFinite(options[key]) || options[key] < 0) {
      throw new Error(`Retry options: ${key} must be a finite number >= 0`);
    }
  }
  return options;
}

function isRetryable(failure: AttemptFailure): boolean {
  if (failure.status === 429) return true;
  const ambiguous = failure.networkError || (failure.status !== undefined && failure.status >= 500);
  return ambiguous && isReadMethod(failure.method);
}

// Exponential backoff with jitter: base * 2^(retry-1), scaled into [50%, 100%)
// of that so concurrent callers spread out, but never down to zero.
function backoffMs(attempt: number, options: RetryOptions): number {
  const exponential = options.baseDelayMs * 2 ** (attempt - 1);
  return Math.round(exponential * (0.5 + options.random() * 0.5));
}

export function decideRetry(failure: AttemptFailure, options: RetryOptions = DEFAULT_RETRY_OPTIONS): RetryDecision {
  if (!isRetryable(failure)) return { retry: false };
  if (failure.attempt > options.maxRetries) return { retry: false };

  // A Retry-After of 0 is no hint at all; back off like a missing header rather
  // than hammering Slack straight away.
  const requested = failure.status === 429 && failure.retryAfterMs !== undefined && failure.retryAfterMs > 0
    ? failure.retryAfterMs
    : backoffMs(failure.attempt, options);
  const waitMs = Math.min(requested, options.maxWaitMs);

  // A wait that would overrun the budget ends the call rather than being
  // shortened: retrying early would only earn another 429.
  if (failure.waitedMs + waitMs > options.maxTotalWaitMs) return { retry: false };
  return { retry: true, waitMs };
}
