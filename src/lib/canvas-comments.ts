import { getLogger } from '@logtape/logtape';
import type { SlackClient } from './slack-client.ts';
import type { SlackMessage } from '../types/index.ts';
import { InvalidInputError, NotFoundError } from './cli-errors.ts';
import { fetchThreadReplies } from './thread-parent.ts';

const logger = getLogger(['slackcli', 'canvas']);

const CANVAS_ID_PATTERN = /^F[A-Z0-9]+$/i;

// A thread holds at most 1000 replies in one conversations.replies page.
const MAX_REPLIES = 1000;

type OnProgress = (message: string) => void;

export interface CanvasComment extends SlackMessage {
  replies: SlackMessage[];
}

export interface CanvasComments {
  channel_id: string;
  has_more: boolean;
  comments: CanvasComment[];
}

/**
 * The conversation that holds a canvas's comments (#501).
 *
 * Slack has no API for canvas comments. They are stored as ordinary messages in
 * a hidden conversation whose ID is the canvas file ID with its leading `F`
 * swapped for `C` (canvas `F0123456789` → conversation `C0123456789`): each
 * top-level message is a comment and its thread holds the replies, so
 * `conversations.history` and `conversations.replies` read them like any
 * channel. This mapping is undocumented Slack behaviour, found by the issue's
 * reporter with a browser session: if Slack changes it, this is the one place
 * to fix. A canvas nobody has commented on has no such conversation yet, and
 * Slack answers `channel_not_found`.
 */
export function canvasCommentChannelId(canvasId: string): string {
  return `C${canvasId.slice(1).toUpperCase()}`;
}

/** `canvasId` when it looks like a canvas file ID (F...), else an invalid-input error. */
export function checkCanvasId(canvasId: string): string {
  if (!CANVAS_ID_PATTERN.test(canvasId)) {
    throw new InvalidInputError(
      `Invalid canvas ID: ${canvasId}`,
      'Canvas ID must start with F followed by alphanumeric characters (e.g., F1234567890).',
    );
  }
  return canvasId;
}

function isChannelNotFound(err: unknown): boolean {
  return (err as { slackData?: { error?: unknown } } | null | undefined)?.slackData?.error === 'channel_not_found';
}

/**
 * Read up to `limit` comments of a canvas, oldest first, each with its replies.
 * One `conversations.history` call, plus one `conversations.replies` call per
 * comment that has replies.
 */
export async function fetchCanvasComments(
  client: Pick<SlackClient, 'getConversationHistory' | 'getConversationReplies'>,
  canvasId: string,
  options: { limit: number; onProgress?: OnProgress },
): Promise<CanvasComments> {
  const channelId = canvasCommentChannelId(canvasId);

  options.onProgress?.('Fetching canvas comments...');
  let history: any;
  try {
    history = await client.getConversationHistory(channelId, { limit: options.limit });
  } catch (err) {
    if (isChannelNotFound(err)) {
      throw new NotFoundError(
        `No comments found for canvas ${canvasId}`,
        'The canvas has no comments yet, or this workspace cannot see it.',
      );
    }
    throw err;
  }

  // History comes newest first; comments read oldest first, like the canvas.
  const top: SlackMessage[] = [...(history?.messages ?? [])].reverse();
  const withReplies = top.filter((msg) => (msg.reply_count ?? 0) > 0);
  if (withReplies.length > 0) options.onProgress?.('Fetching comment replies...');

  // Issued together; the rate limiter still paces them.
  const replyPages = await Promise.all(
    withReplies.map((msg) => fetchThreadReplies(client, channelId, msg.ts, { limit: MAX_REPLIES })),
  );
  const repliesByTs = new Map<string, SlackMessage[]>();
  withReplies.forEach((msg, index) => {
    // The first message of a replies page is the comment itself.
    const messages: SlackMessage[] = replyPages[index]?.messages ?? [];
    repliesByTs.set(msg.ts, messages.filter((reply) => reply.ts !== msg.ts));
  });

  logger.debug('Read {count} comments of canvas {canvas_id}', { count: top.length, canvas_id: canvasId });

  return {
    channel_id: channelId,
    has_more: Boolean(history?.has_more),
    comments: top.map((msg) => ({ ...msg, replies: repliesByTs.get(msg.ts) ?? [] })),
  };
}
