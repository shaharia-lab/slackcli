import { InvalidInputError } from './cli-errors.ts';

// When a scheduled message should be posted (#379): `--at <time>` or
// `--in <duration>`, turned into the Unix seconds Slack's `post_at` takes.
//
// Hand-rolled rather than a date library: the grammar is three regexes, and a
// library would take a slot in the seven-dependency budget for it. The regexes
// are strict on purpose. `Date.parse()` accepts whatever its engine likes for a
// non-ISO string, so the same input could mean different times, or be refused,
// on another runtime.

/** Slack refuses a `post_at` further ahead than this (`time_too_far`). */
export const MAX_SCHEDULE_DAYS = 120;

const SECONDS_PER_DAY = 86_400;
const UNIT_SECONDS: Readonly<Record<string, number>> = { d: SECONDS_PER_DAY, h: 3_600, m: 60 };

const AT_FORMATS =
  'Use Unix seconds (1791791400), ISO 8601 with an offset (2026-10-12T09:50:00+02:00 or ...Z), ' +
  'or a local date and time ("2026-10-12 09:50").';
const IN_FORMATS = 'Use minutes, hours and days, each at most once: 45m, 2h, 3d, 1h30m.';

const UNIX_SECONDS = /^\d{1,12}$/;
// Date, `T` or a space, hours and minutes, optional seconds (a fraction is
// accepted and dropped: post_at is whole seconds), optional `Z` or offset.
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/;
const DURATION = /^(?:\d+[dhm])+$/;
const DURATION_PART = /(\d+)([dhm])/g;

export interface ScheduleTimeInput {
  /** The `--at` value. */
  at?: string;
  /** The `--in` value. */
  in?: string;
}

/**
 * The `post_at` of a scheduled message, in Unix seconds. Exactly one of `at`
 * and `in` must be given. Throws InvalidInputError for both or neither, for a
 * value that does not parse, for a date or time that does not exist, and for a
 * time that is not in the future or is more than 120 days ahead. `nowMs` is
 * injected so tests are not tied to the clock.
 */
export function parseScheduleTime(input: ScheduleTimeInput, nowMs: number = Date.now()): number {
  const hasAt = input.at !== undefined;
  const hasIn = input.in !== undefined;
  if (hasAt && hasIn) {
    throw new InvalidInputError('--at and --in cannot be used together; pass one of them.');
  }
  if (!hasAt && !hasIn) {
    throw new InvalidInputError('Missing the time to post at. Pass --at <time> or --in <duration>.');
  }

  const nowSeconds = Math.floor(nowMs / 1000);
  const postAt = hasAt ? parseAt(input.at as string) : nowSeconds + parseDuration(input.in as string);

  if (postAt <= nowSeconds) {
    throw new InvalidInputError(
      hasAt
        ? `--at must be in the future: ${input.at} has already passed.`
        : '--in must be longer than zero.',
    );
  }
  if (postAt - nowSeconds > MAX_SCHEDULE_DAYS * SECONDS_PER_DAY) {
    const given = hasAt ? `--at ${input.at}` : `--in ${input.in}`;
    throw new InvalidInputError(
      `Slack schedules a message at most ${MAX_SCHEDULE_DAYS} days ahead; ` +
        `${given} is further away than that.`,
    );
  }
  return postAt;
}

function parseAt(raw: string): number {
  const value = raw.trim();
  if (UNIX_SECONDS.test(value)) return Number(value);

  const match = DATE_TIME.exec(value);
  if (!match) {
    throw new InvalidInputError(`Cannot read --at "${raw}" as a time. ${AT_FORMATS}`);
  }
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number);
  const second = Number(match[6] ?? 0);
  const zone = match[7];

  const ms = zone === undefined
    ? localTime(raw, year, month, day, hour, minute, second)
    : zonedTime(raw, zone, year, month, day, hour, minute, second);
  return Math.floor(ms / 1000);
}

// A time with an explicit `Z` or offset. The fields are checked by building
// the same wall-clock time in UTC and reading it back: JavaScript rolls an
// impossible date over (30 February becomes 2 March) rather than refusing it.
function zonedTime(
  raw: string, zone: string,
  year: number, month: number, day: number, hour: number, minute: number, second: number,
): number {
  const wallClock = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const real = wallClock.getUTCFullYear() === year
    && wallClock.getUTCMonth() === month - 1
    && wallClock.getUTCDate() === day
    && wallClock.getUTCHours() === hour
    && wallClock.getUTCMinutes() === minute
    && wallClock.getUTCSeconds() === second;
  if (!real) throw notARealTime(raw);
  return wallClock.getTime() - offsetMs(raw, zone);
}

function offsetMs(raw: string, zone: string): number {
  if (zone === 'Z') return 0;
  const digits = zone.slice(1).replace(':', '');
  const hours = Number(digits.slice(0, 2));
  const minutes = Number(digits.slice(2));
  const total = hours * 60 + minutes;
  const sign = zone.startsWith('-') ? -1 : 1;
  // The widest real offsets are -12:00 and +14:00.
  const widest = sign < 0 ? 12 * 60 : 14 * 60;
  if (minutes > 59 || total > widest) {
    throw new InvalidInputError(`--at "${raw}" has a UTC offset that does not exist (${zone}).`);
  }
  return sign * total * 60_000;
}

// A time with no offset is read in the machine's timezone. Reading it back
// catches impossible dates and also a wall-clock time the timezone skips when
// its clocks go forward (02:30 on that night does not exist). A time that
// happens twice, when the clocks go back, resolves to the first of the two;
// the command always echoes the absolute time it resolved.
function localTime(
  raw: string,
  year: number, month: number, day: number, hour: number, minute: number, second: number,
): number {
  const local = new Date(year, month - 1, day, hour, minute, second);
  const real = local.getFullYear() === year
    && local.getMonth() === month - 1
    && local.getDate() === day
    && local.getHours() === hour
    && local.getMinutes() === minute
    && local.getSeconds() === second;
  if (!real) throw notARealTime(raw);
  return local.getTime();
}

function notARealTime(raw: string): InvalidInputError {
  return new InvalidInputError(
    `--at "${raw}" is not a real date and time ` +
      '(an impossible date, or a local time skipped when the clocks change).',
  );
}

function parseDuration(raw: string): number {
  const value = raw.trim();
  if (!DURATION.test(value)) {
    throw new InvalidInputError(`Cannot read --in "${raw}" as a duration. ${IN_FORMATS}`);
  }
  const seen = new Set<string>();
  let seconds = 0;
  for (const [, amount, unit] of value.matchAll(DURATION_PART)) {
    if (seen.has(unit)) {
      throw new InvalidInputError(`--in "${raw}" names the unit "${unit}" more than once. ${IN_FORMATS}`);
    }
    seen.add(unit);
    seconds += Number(amount) * UNIT_SECONDS[unit];
  }
  // A run of digits too long to count exactly is far past 120 days anyway;
  // Infinity makes the caller report it as that.
  return Number.isSafeInteger(seconds) ? seconds : Number.POSITIVE_INFINITY;
}
