// Paces outgoing Slack API calls so a burst of them does not look like scraping.
//
// Slack's Enterprise Grid anomaly detection raises `unexpected_api_call_volume`
// when a client produces more API traffic than a browser or the official app
// would, and it can log the session out. Several slackcli paths fan out one call
// per user or per channel with no delay, so every request is funnelled through
// this limiter before it leaves the process.
//
// Hand-rolled rather than pulled from npm (`p-limit`, `bottleneck`, …): the CLI
// ships as a `bun build --compile` binary under a 150MB CI budget, and this is
// ~60 lines with no other consumer.

export interface RateLimiterOptions {
  /** Maximum number of tasks allowed to run at the same time. Must be >= 1. */
  maxConcurrent: number;
  /** Minimum delay between two task *starts*, in milliseconds. Must be >= 0. */
  minIntervalMs: number;
}

/** Concurrency cap applied to every Slack API call. */
export const SLACK_MAX_CONCURRENT_REQUESTS = 2;

/** Minimum delay between two Slack API calls, in milliseconds. */
export const SLACK_MIN_REQUEST_INTERVAL_MS = 200;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class RateLimiter {
  private readonly maxConcurrent: number;
  private readonly minIntervalMs: number;
  private inFlight = 0;
  private lastStartedAt = 0;
  private waiters: Array<() => void> = [];
  private pumping = false;

  constructor(options: RateLimiterOptions) {
    if (!Number.isFinite(options.maxConcurrent) || options.maxConcurrent < 1) {
      throw new Error('RateLimiter: maxConcurrent must be a finite number >= 1');
    }
    if (!Number.isFinite(options.minIntervalMs) || options.minIntervalMs < 0) {
      throw new Error('RateLimiter: minIntervalMs must be a finite number >= 0');
    }

    this.maxConcurrent = options.maxConcurrent;
    this.minIntervalMs = options.minIntervalMs;
  }

  /**
   * Runs `task` once a slot is free and the minimum interval has elapsed.
   * Rejections propagate unchanged, and the slot is always released.
   *
   * `task` must not itself wait on another `run()` of the same limiter: it would
   * hold its slot while queueing behind itself and deadlock at `maxConcurrent`.
   * `SlackClient` satisfies this — no method awaits one `request()` inside
   * another — so keep composite calls sequential rather than nested.
   */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
      void this.pump();
    });
  }

  private release(): void {
    this.inFlight -= 1;
    void this.pump();
  }

  // Single-threaded drain of the waiter queue. The `pumping` guard keeps exactly
  // one drain alive, so `inFlight` and `lastStartedAt` can only be advanced here
  // and never race across the `await sleep(...)` below.
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;

    try {
      while (this.waiters.length > 0 && this.inFlight < this.maxConcurrent) {
        const wait = this.minIntervalMs - (Date.now() - this.lastStartedAt);
        if (wait > 0) await sleep(wait);

        const next = this.waiters.shift();
        if (!next) break;

        this.inFlight += 1;
        this.lastStartedAt = Date.now();
        next();
      }
    } finally {
      this.pumping = false;
    }
  }
}

/**
 * The limiter every `SlackClient` shares by default. Slack counts API volume per
 * session, not per client object, so the pacing has to be process-wide — a
 * per-instance limiter would let two clients double the rate.
 */
export const slackRateLimiter = new RateLimiter({
  maxConcurrent: SLACK_MAX_CONCURRENT_REQUESTS,
  minIntervalMs: SLACK_MIN_REQUEST_INTERVAL_MS,
});
