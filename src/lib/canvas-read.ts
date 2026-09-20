import { isAuthPage } from './canvas-parser.ts';
import type { SlackClient } from './slack-client.ts';
import type { SlackCanvas, SlackUser } from '../types/index.ts';

const CANVAS_ID_PATTERN = /^F[A-Z0-9]+$/i;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

type OnProgress = (message: string) => void;

/**
 * An expected `canvas read` failure. `summary` is the spinner's fail line and
 * `detail` the follow-up error line, if any. `exitCode` is kept per failure:
 * some paths have always exited 0 after the spinner fails, and callers depend
 * on that, so it is not collapsed into a single "failed" code.
 */
export class CanvasReadError extends Error {
  readonly summary: string;
  readonly detail?: string;
  readonly exitCode: 0 | 1;

  constructor(summary: string, exitCode: 0 | 1, detail?: string) {
    super(detail ?? summary);
    this.name = 'CanvasReadError';
    this.summary = summary;
    this.detail = detail;
    this.exitCode = exitCode;
  }
}

export interface CanvasMentions {
  users: Map<string, SlackUser>;
  channels: Map<string, string>;
}

/** Resolve the canvas file ID from an explicit ID or from a channel's canvas. */
export async function resolveCanvasId(
  client: SlackClient,
  input: { canvasId?: string; channel?: string },
  onProgress?: OnProgress,
): Promise<string> {
  let fileId: string | null | undefined = input.canvasId;

  if (!fileId && input.channel) {
    onProgress?.('Looking up channel canvas...');
    fileId = await client.getChannelCanvasId(input.channel);
    if (!fileId) {
      throw new CanvasReadError('No canvas found for this channel', 0);
    }
  }

  if (!fileId) {
    throw new CanvasReadError(
      'Missing canvas ID',
      1,
      'Provide a canvas ID or use --channel to read a channel canvas.',
    );
  }

  if (!CANVAS_ID_PATTERN.test(fileId)) {
    throw new CanvasReadError(
      'Invalid canvas ID',
      1,
      'Canvas ID must start with F followed by alphanumeric characters (e.g., F1234567890).',
    );
  }

  return fileId;
}

/** Fetch a canvas's file metadata and download its HTML body. */
export async function fetchCanvasHtml(
  client: SlackClient,
  fileId: string,
  onProgress?: OnProgress,
): Promise<{ file: SlackCanvas; html: string }> {
  onProgress?.('Fetching canvas metadata...');
  const fileInfo = await client.getFileInfo(fileId);
  const file = fileInfo.file;

  if (!file) {
    throw new CanvasReadError('Canvas not found', 0);
  }

  const downloadUrl = file.url_private_download || file.url_private;
  if (!downloadUrl) {
    throw new CanvasReadError('No download URL available for this canvas', 0);
  }

  onProgress?.('Downloading canvas content...');
  const html = await client.downloadFile(downloadUrl, MAX_FILE_SIZE);

  // An expired token gets Slack's sign-in page back instead of the canvas.
  if (isAuthPage(html)) {
    throw new CanvasReadError(
      'Authentication expired',
      1,
      'The downloaded content is a Slack sign-in page. Your token may have expired.',
    );
  }

  return { file, html };
}

/**
 * Look up the users and channels mentioned as `<@U…>` / `<#C…>` in canvas
 * markdown. Channels that cannot be resolved are skipped.
 */
export async function resolveCanvasMentions(
  client: SlackClient,
  markdown: string,
  onProgress?: OnProgress,
): Promise<CanvasMentions> {
  const userIds = new Set<string>();
  const channelIds = new Set<string>();
  for (const match of markdown.matchAll(/<@(U[A-Z0-9]+)>/gi)) {
    userIds.add(match[1]);
  }
  for (const match of markdown.matchAll(/<#(C[A-Z0-9]+)>/gi)) {
    channelIds.add(match[1]);
  }

  const mentions: CanvasMentions = { users: new Map(), channels: new Map() };
  if (userIds.size === 0 && channelIds.size === 0) {
    return mentions;
  }

  onProgress?.('Resolving mentions...');

  if (userIds.size > 0) {
    const usersResponse = await client.getUsersInfo(Array.from(userIds));
    usersResponse.users?.forEach((user: SlackUser) => {
      mentions.users.set(user.id, user);
    });
  }

  for (const channelId of channelIds) {
    try {
      const info = await client.getConversationInfo(channelId);
      if (info.channel?.name) {
        mentions.channels.set(channelId, info.channel.name);
      }
    } catch {
      // Skip channels we can't resolve
    }
  }

  return mentions;
}

/** Replace resolved `<@U…>` / `<#C…>` mentions with `@name` / `#channel`. */
export function applyCanvasMentions(markdown: string, mentions: CanvasMentions): string {
  let result = markdown;
  for (const [id, user] of mentions.users) {
    const displayName = user.real_name || user.name || id;
    result = result.replace(new RegExp(`<@${id}>`, 'g'), `@${displayName}`);
  }
  for (const [id, name] of mentions.channels) {
    result = result.replace(new RegExp(`<#${id}>`, 'g'), `#${name}`);
  }
  return result;
}
