import { afterEach, describe, expect, it } from 'bun:test';
import { InvalidInputError } from './cli-errors.ts';
import { MAX_SCHEDULE_DAYS, parseScheduleTime } from './schedule-time.ts';

// Saturday 10 October 2026, 12:00:00 UTC.
const NOW_MS = Date.UTC(2026, 9, 10, 12, 0, 0);
const NOW = NOW_MS / 1000;
const DAY = 86_400;

// Bun reads process.env.TZ at run time, so a test can pick the machine's
// timezone. Deleting the variable does not undo a change; `bun test` runs in
// UTC, so that is what a test without one goes back to.
const savedTz = process.env.TZ;
function setTimezone(zone: string): void {
  process.env.TZ = zone;
}

afterEach(() => {
  process.env.TZ = savedTz ?? 'UTC';
});

function at(value: string, nowMs = NOW_MS): number {
  return parseScheduleTime({ at: value }, nowMs);
}

function within(value: string, nowMs = NOW_MS): number {
  return parseScheduleTime({ in: value }, nowMs);
}

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(InvalidInputError);
    return (err as Error).message;
  }
  throw new Error('expected an InvalidInputError');
}

describe('parseScheduleTime --at', () => {
  it('takes Unix seconds as they are', () => {
    expect(at(String(NOW + 600))).toBe(NOW + 600);
    expect(at(` ${NOW + 600} `)).toBe(NOW + 600);
  });

  it.each([
    ['2026-10-12T09:50:00Z', Date.UTC(2026, 9, 12, 9, 50, 0)],
    ['2026-10-12T09:50Z', Date.UTC(2026, 9, 12, 9, 50, 0)],
    ['2026-10-12 09:50:30Z', Date.UTC(2026, 9, 12, 9, 50, 30)],
    ['2026-10-12T09:50:00+02:00', Date.UTC(2026, 9, 12, 7, 50, 0)],
    ['2026-10-12T09:50:00+0200', Date.UTC(2026, 9, 12, 7, 50, 0)],
    ['2026-10-12T09:50:00-05:30', Date.UTC(2026, 9, 12, 15, 20, 0)],
    ['2026-10-12T23:30:00-03:00', Date.UTC(2026, 9, 13, 2, 30, 0)],
    ['2026-10-12T09:50:00.999Z', Date.UTC(2026, 9, 12, 9, 50, 0)],
  ])('reads ISO 8601 %p with its offset', (value, expectedMs) => {
    expect(at(value)).toBe(expectedMs / 1000);
  });

  it('gives the same instant for an offset time whatever the machine timezone', () => {
    setTimezone('America/New_York');
    expect(at('2026-10-12T09:50:00+02:00')).toBe(Date.UTC(2026, 9, 12, 7, 50, 0) / 1000);
  });

  it.each([
    ['UTC', '2026-10-12 09:50', Date.UTC(2026, 9, 12, 9, 50, 0)],
    ['Europe/Berlin', '2026-10-12 09:50', Date.UTC(2026, 9, 12, 7, 50, 0)],
    ['Europe/Berlin', '2026-10-12T09:50', Date.UTC(2026, 9, 12, 7, 50, 0)],
    ['Europe/Berlin', '2026-10-12 09:50:15', Date.UTC(2026, 9, 12, 7, 50, 15)],
    ['America/New_York', '2026-10-12 09:50', Date.UTC(2026, 9, 12, 13, 50, 0)],
    // After Berlin's clocks go back on 25 October the offset is +01:00.
    ['Europe/Berlin', '2026-10-26 09:50', Date.UTC(2026, 9, 26, 8, 50, 0)],
    ['Asia/Kolkata', '2026-10-12 09:50', Date.UTC(2026, 9, 12, 4, 20, 0)],
  ])('in %s reads the bare local time %p in that timezone', (zone, value, expectedMs) => {
    setTimezone(zone);
    expect(at(value)).toBe(expectedMs / 1000);
  });

  it('refuses a local time skipped when the clocks go forward', () => {
    setTimezone('Europe/Berlin');
    // 29 March 2026: 02:00 jumps to 03:00 in Berlin.
    const now = Date.UTC(2026, 2, 1, 12, 0, 0);
    expect(refusal(() => at('2026-03-29 02:30', now))).toContain('not a real date and time');
    expect(at('2026-03-29 01:59', now)).toBe(Date.UTC(2026, 2, 29, 0, 59, 0) / 1000);
    expect(at('2026-03-29 03:00', now)).toBe(Date.UTC(2026, 2, 29, 1, 0, 0) / 1000);
  });

  it('reads a local time that happens twice as the first of the two', () => {
    setTimezone('Europe/Berlin');
    // 25 October 2026: 03:00 CEST goes back to 02:00 CET, so 02:30 happens twice.
    expect(at('2026-10-25 02:30')).toBe(Date.UTC(2026, 9, 25, 0, 30, 0) / 1000);
  });

  it.each([
    '2026-02-30 09:50',
    '2026-02-30T09:50:00Z',
    '2027-02-29 09:50',
    '2026-13-01 09:50',
    '2026-00-10 09:50',
    '2026-10-32 09:50',
    '2026-10-12 24:00',
    '2026-10-12 09:60',
    '2026-10-12T09:50:60Z',
  ])('refuses the impossible date or time %p', (value) => {
    expect(refusal(() => at(value))).toContain('is not a real date and time');
  });

  it('accepts 29 February in a leap year', () => {
    const now = Date.UTC(2027, 11, 1, 0, 0, 0);
    expect(at('2028-02-29T09:50:00Z', now)).toBe(Date.UTC(2028, 1, 29, 9, 50, 0) / 1000);
  });

  it.each([
    '2026-10-12T09:50:00+15:00',
    '2026-10-12T09:50:00+14:30',
    '2026-10-12T09:50:00+14:01',
    '2026-10-12T09:50:00-14:00',
    '2026-10-12T09:50:00-12:01',
    '2026-10-12T09:50:00+02:60',
  ])('refuses the offset in %p', (value) => {
    expect(refusal(() => at(value))).toContain('UTC offset that does not exist');
  });

  it('accepts the widest real offsets, +14:00 and -12:00', () => {
    expect(at('2026-10-12T09:50:00+14:00')).toBe(Date.UTC(2026, 9, 11, 19, 50, 0) / 1000);
    expect(at('2026-10-12T09:50:00-12:00')).toBe(Date.UTC(2026, 9, 12, 21, 50, 0) / 1000);
  });

  it.each([
    '',
    '   ',
    'tomorrow',
    'next monday 9am',
    '2026-10-12',
    '09:50',
    '2026-10-12 9:50',
    '2026/10/12 09:50',
    '12-10-2026 09:50',
    '2026-10-12T09:50:00 +02:00',
    '2026-10-12T09:50:00z',
    '2026-10-12t09:50:00Z',
    '2026-10-12T09:50:00+2',
    '1791791400.5',
    '-1791791400',
    '1e10',
    'Mon, 12 Oct 2026 09:50:00 GMT',
  ])('refuses %p as unreadable, naming the formats', (value) => {
    const message = refusal(() => at(value));
    expect(message).toContain('Cannot read --at');
    expect(message).toContain('ISO 8601');
  });

  it('refuses a time in the past, and the present second itself', () => {
    expect(refusal(() => at(String(NOW - 1)))).toContain('must be in the future');
    expect(refusal(() => at(String(NOW)))).toContain('must be in the future');
    expect(refusal(() => at('2026-10-10T12:00:00Z'))).toContain('must be in the future');
    expect(refusal(() => at('2020-01-01T00:00:00Z'))).toContain('has already passed');
    expect(refusal(() => at('0'))).toContain('must be in the future');
    expect(at(String(NOW + 1))).toBe(NOW + 1);
  });

  it('counts the present second from a clock that is partway through it', () => {
    expect(refusal(() => at(String(NOW), NOW_MS + 999))).toContain('must be in the future');
    expect(at(String(NOW + 1), NOW_MS + 999)).toBe(NOW + 1);
  });

  it('accepts exactly 120 days ahead and refuses one second more', () => {
    const edge = NOW + MAX_SCHEDULE_DAYS * DAY;
    expect(MAX_SCHEDULE_DAYS).toBe(120);
    expect(at(String(edge))).toBe(edge);
    expect(refusal(() => at(String(edge + 1)))).toContain('at most 120 days ahead');
    expect(refusal(() => at('2027-10-10T12:00:00Z'))).toContain('at most 120 days ahead');
    expect(refusal(() => at('999999999999'))).toContain('at most 120 days ahead');
  });
});

describe('parseScheduleTime --in', () => {
  it.each([
    ['45m', 45 * 60],
    ['2h', 2 * 3600],
    ['3d', 3 * DAY],
    ['1h30m', 5400],
    ['1d2h3m', DAY + 2 * 3600 + 180],
    ['30m1h', 5400],
    ['090m', 5400],
    [' 2h ', 7200],
    ['1m', 60],
  ])('adds %p to now', (value, seconds) => {
    expect(within(value)).toBe(NOW + seconds);
  });

  it('measures from the current second', () => {
    expect(within('1m', NOW_MS + 999)).toBe(NOW + 60);
  });

  it.each([
    '',
    '  ',
    '45',
    'm',
    '45s',
    '1.5h',
    '-1h',
    '1h 30m',
    '1H',
    '1w',
    'soon',
    '1h30',
  ])('refuses %p as unreadable, naming the units', (value) => {
    const message = refusal(() => within(value));
    expect(message).toContain('Cannot read --in');
    expect(message).toContain('45m, 2h, 3d, 1h30m');
  });

  it('refuses a unit given twice', () => {
    expect(refusal(() => within('1h2h'))).toContain('names the unit "h" more than once');
  });

  it('refuses a zero duration', () => {
    expect(refusal(() => within('0m'))).toContain('must be longer than zero');
    expect(refusal(() => within('0d0h0m'))).toContain('must be longer than zero');
  });

  it('accepts exactly 120 days and refuses anything past it', () => {
    expect(within('120d')).toBe(NOW + 120 * DAY);
    expect(within('119d24h')).toBe(NOW + 120 * DAY);
    expect(refusal(() => within('120d1m'))).toContain('at most 120 days ahead');
    expect(refusal(() => within('121d'))).toContain('at most 120 days ahead');
    expect(refusal(() => within(`${'9'.repeat(30)}d`))).toContain('at most 120 days ahead');
  });
});

describe('parseScheduleTime flags', () => {
  it('refuses both --at and --in', () => {
    expect(refusal(() => parseScheduleTime({ at: String(NOW + 60), in: '1h' }, NOW_MS)))
      .toContain('--at and --in cannot be used together');
  });

  it('refuses neither', () => {
    expect(refusal(() => parseScheduleTime({}, NOW_MS))).toContain('Pass --at <time> or --in <duration>');
  });

  it('uses the real clock when none is injected', () => {
    const before = Math.floor(Date.now() / 1000);
    const postAt = parseScheduleTime({ in: '1h' });
    const after = Math.floor(Date.now() / 1000);
    expect(postAt).toBeGreaterThanOrEqual(before + 3600);
    expect(postAt).toBeLessThanOrEqual(after + 3600);
  });
});
