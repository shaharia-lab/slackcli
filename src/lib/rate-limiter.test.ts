import { describe, expect, it } from 'bun:test';
import {
  RateLimiter,
  SLACK_MAX_CONCURRENT_REQUESTS,
  SLACK_MIN_REQUEST_INTERVAL_MS,
  slackRateLimiter,
} from './rate-limiter.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Timers may fire a hair early depending on the platform clock, so spacing
// assertions allow a small tolerance rather than demanding the exact interval.
const TIMER_TOLERANCE_MS = 5;

/** Runs `count` tasks through `limiter`, recording start times and peak concurrency. */
async function drive(
  limiter: RateLimiter,
  count: number,
  taskDurationMs = 0,
): Promise<{ starts: number[]; peakConcurrent: number }> {
  const starts: number[] = [];
  let inFlight = 0;
  let peakConcurrent = 0;

  await Promise.all(
    Array.from({ length: count }, () =>
      limiter.run(async () => {
        starts.push(Date.now());
        inFlight += 1;
        peakConcurrent = Math.max(peakConcurrent, inFlight);
        if (taskDurationMs > 0) await sleep(taskDurationMs);
        inFlight -= 1;
      }),
    ),
  );

  return { starts, peakConcurrent };
}

describe('RateLimiter', () => {
  it('runs a task and resolves with its value', async () => {
    const limiter = new RateLimiter({ maxConcurrent: 2, minIntervalMs: 0 });

    await expect(limiter.run(async () => 'done')).resolves.toBe('done');
  });

  it('never runs more tasks concurrently than maxConcurrent', async () => {
    const limiter = new RateLimiter({ maxConcurrent: 2, minIntervalMs: 0 });

    const { peakConcurrent } = await drive(limiter, 8, 10);

    expect(peakConcurrent).toBe(2);
  });

  it('serializes fully when maxConcurrent is 1', async () => {
    const limiter = new RateLimiter({ maxConcurrent: 1, minIntervalMs: 0 });

    const { peakConcurrent } = await drive(limiter, 5, 5);

    expect(peakConcurrent).toBe(1);
  });

  it('leaves at least minIntervalMs between task starts', async () => {
    const limiter = new RateLimiter({ maxConcurrent: 2, minIntervalMs: 25 });

    const { starts } = await drive(limiter, 4);

    expect(starts).toHaveLength(4);
    for (let i = 1; i < starts.length; i += 1) {
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(25 - TIMER_TOLERANCE_MS);
    }
  });

  it('paces tasks queued after an idle period without an extra delay', async () => {
    const limiter = new RateLimiter({ maxConcurrent: 2, minIntervalMs: 60 });

    await limiter.run(async () => undefined);
    await sleep(80);

    const before = Date.now();
    await limiter.run(async () => undefined);

    // The interval already elapsed while idle, so the next call must not wait again.
    expect(Date.now() - before).toBeLessThan(60);
  });

  it('does not delay anything when minIntervalMs is 0', async () => {
    const limiter = new RateLimiter({ maxConcurrent: 4, minIntervalMs: 0 });

    const before = Date.now();
    const { starts } = await drive(limiter, 6);

    expect(starts).toHaveLength(6);
    expect(Date.now() - before).toBeLessThan(200);
  });

  it('propagates a rejection and still releases the slot', async () => {
    const limiter = new RateLimiter({ maxConcurrent: 1, minIntervalMs: 0 });

    await expect(limiter.run(async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');

    // A leaked slot would leave this pending forever.
    await expect(limiter.run(async () => 'still works')).resolves.toBe('still works');
  });

  it('keeps running queued tasks after one of them rejects', async () => {
    const limiter = new RateLimiter({ maxConcurrent: 1, minIntervalMs: 0 });
    const completed: string[] = [];

    const results = await Promise.allSettled([
      limiter.run(async () => {
        completed.push('first');
      }),
      limiter.run(async () => {
        throw new Error('middle failed');
      }),
      limiter.run(async () => {
        completed.push('third');
      }),
    ]);

    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(completed).toEqual(['first', 'third']);
  });

  it('starts tasks in the order they were submitted', async () => {
    const limiter = new RateLimiter({ maxConcurrent: 1, minIntervalMs: 0 });
    const order: number[] = [];

    await Promise.all(
      [0, 1, 2, 3, 4].map((index) =>
        limiter.run(async () => {
          order.push(index);
        }),
      ),
    );

    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it('rejects invalid options', () => {
    expect(() => new RateLimiter({ maxConcurrent: 0, minIntervalMs: 0 })).toThrow(/maxConcurrent/);
    expect(() => new RateLimiter({ maxConcurrent: -1, minIntervalMs: 0 })).toThrow(/maxConcurrent/);
    expect(() => new RateLimiter({ maxConcurrent: Number.NaN, minIntervalMs: 0 })).toThrow(/maxConcurrent/);
    expect(() => new RateLimiter({ maxConcurrent: 1, minIntervalMs: -1 })).toThrow(/minIntervalMs/);
    expect(() => new RateLimiter({ maxConcurrent: 1, minIntervalMs: Number.POSITIVE_INFINITY }))
      .toThrow(/minIntervalMs/);
  });
});

describe('slackRateLimiter defaults', () => {
  it('is a RateLimiter configured from the exported Slack constants', () => {
    expect(slackRateLimiter).toBeInstanceOf(RateLimiter);
    expect(SLACK_MAX_CONCURRENT_REQUESTS).toBeGreaterThanOrEqual(1);
    expect(SLACK_MIN_REQUEST_INTERVAL_MS).toBeGreaterThan(0);
  });
});
