// Helpers that make `conversations read` safe to poll: a strict "newer than the
// cursor" filter, a self filter, and the cursor to pass back as --oldest.
import type { SlackAuthTestResponse, SlackMessage } from '../types/index.ts';
import { InvalidInputError } from './cli-errors.ts';

// Split a Slack ts ("1234567890.123456", or bare epoch seconds "1234567890")
// into integer seconds and the fractional digits.
function splitTs(ts: string): { seconds: bigint; fraction: string } {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(ts);
  if (!match) throw new InvalidInputError(`Invalid Slack timestamp: ${ts}`);
  return { seconds: BigInt(match[1]), fraction: match[2] ?? '' };
}

/**
 * Compare two Slack timestamps: negative when a < b, 0 when equal, positive when
 * a > b. Compares the seconds as integers and the fractional part digit by digit
 * (right-padded), never as floats, so microsecond differences are not lost.
 */
export function compareTs(a: string, b: string): number {
  const left = splitTs(a);
  const right = splitTs(b);
  if (left.seconds !== right.seconds) return left.seconds < right.seconds ? -1 : 1;
  const width = Math.max(left.fraction.length, right.fraction.length, 6);
  const leftFraction = left.fraction.padEnd(width, '0');
  const rightFraction = right.fraction.padEnd(width, '0');
  if (leftFraction === rightFraction) return 0;
  return leftFraction < rightFraction ? -1 : 1;
}

/**
 * Keep only messages strictly newer than `oldest`. conversations.replies always
 * returns the thread parent whatever `oldest` is, so without this a thread poll
 * sees the parent on every call. No `oldest` → messages unchanged.
 */
export function filterNewerThan(messages: SlackMessage[], oldest?: string): SlackMessage[] {
  if (!oldest) return messages;
  return messages.filter(msg => Boolean(msg.ts) && compareTs(msg.ts, oldest) > 0);
}

export interface SelfIdentity {
  userId: string;
  botId?: string;
}

/** Drop messages written by the authenticated user, or by its bot. */
export function filterSelf(messages: SlackMessage[], self: SelfIdentity): SlackMessage[] {
  return messages.filter(msg => {
    if (msg.user === self.userId) return false;
    if (self.botId && msg.bot_id === self.botId) return false;
    return true;
  });
}

/**
 * The cursor for the next poll: the newest ts of the page, never older than the
 * `oldest` passed in. Computed on the unfiltered page so a page of only your own
 * messages still advances it. Empty page → `oldest` unchanged; neither → null.
 */
export function nextOldest(messages: SlackMessage[], oldest?: string): string | null {
  let cursor: string | null = oldest ?? null;
  for (const msg of messages) {
    if (!msg.ts) continue;
    if (cursor === null || compareTs(msg.ts, cursor) > 0) cursor = msg.ts;
  }
  return cursor;
}

export interface IdentitySource {
  readonly storedUserId: string | undefined;
  readonly isBotToken: boolean;
  testAuth(): Promise<SlackAuthTestResponse>;
}

/**
 * Who "self" is for --exclude-self. Uses the user_id saved at login; calls
 * auth.test once when it is missing (legacy records) or when the token is a bot
 * token (bot_id is not stored). Throws rather than silently skipping the filter.
 */
export async function resolveSelfIdentity(source: IdentitySource): Promise<SelfIdentity> {
  if (source.storedUserId && !source.isBotToken) {
    return { userId: source.storedUserId };
  }
  const auth = await source.testAuth();
  const userId = auth.user_id || source.storedUserId;
  if (!userId) {
    throw new Error('Could not determine the authenticated user for --exclude-self (auth.test returned no user_id).');
  }
  return auth.bot_id ? { userId, botId: auth.bot_id } : { userId };
}

export interface ReadPageOptions {
  oldest?: string;
  // Drop threaded replies from channel history (ignored for a thread read).
  excludeReplies?: boolean;
  isThread?: boolean;
  // Set to drop the authenticated identity's own messages.
  self?: SelfIdentity;
}

export interface ReadPage {
  messages: SlackMessage[];
  nextOldest: string | null;
  hasMore: boolean;
}

/**
 * Apply `conversations read`'s filters to one raw API page, in order: cursor and
 * has_more from the raw page → ts > oldest → --exclude-replies → --exclude-self.
 * Message order is left as Slack returned it.
 */
export function processReadPage(
  response: { messages?: SlackMessage[]; has_more?: boolean },
  options: ReadPageOptions = {}
): ReadPage {
  const raw = response.messages ?? [];
  let messages = filterNewerThan(raw, options.oldest);
  if (!options.isThread && options.excludeReplies) {
    messages = messages.filter(msg => !msg.thread_ts || msg.thread_ts === msg.ts);
  }
  if (options.self) {
    messages = filterSelf(messages, options.self);
  }
  return {
    messages,
    nextOldest: nextOldest(raw, options.oldest),
    hasMore: Boolean(response.has_more),
  };
}
