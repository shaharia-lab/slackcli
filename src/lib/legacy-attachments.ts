// Slack's legacy message attachments as plain text lines, for the message
// formatter (#555). Bot notifications (Grafana alerting, CI, monitoring) often
// carry their whole content in `attachments[]` and leave `text` empty.

import type { SlackMessage } from '../types/index.ts';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
}

function fieldLines(attachment: Record<string, unknown>): string[] {
  if (!Array.isArray(attachment.fields)) return [];
  const lines: string[] = [];
  for (const value of attachment.fields) {
    const field = asRecord(value);
    if (!field) continue;
    const title = stringField(field, 'title');
    const text = stringField(field, 'value');
    if (title && text) lines.push(`${title}: ${text}`);
    else if (title || text) lines.push(title || text);
  }
  return lines;
}

/**
 * The text lines of one legacy attachment: `pretext`, `title` (with
 * `title_link`), `text`, then each field as `title: value`, then `footer`.
 * `fallback` stands in when there is no `title` and no `text`, unless the
 * attachment carries blocks (those render elsewhere) or the fallback repeats
 * the message text. Multi-line values split into lines.
 */
export function attachmentLines(attachment: unknown, messageText: string = ''): string[] {
  const record = asRecord(attachment);
  if (!record) return [];

  const title = stringField(record, 'title');
  const link = stringField(record, 'title_link');
  const text = stringField(record, 'text');
  const parts: string[] = [stringField(record, 'pretext')];

  if (title) parts.push(link ? `${title} (${link})` : title);
  if (text) parts.push(text);
  if (!title && !text) {
    const fallback = stringField(record, 'fallback');
    const hasBlocks = Array.isArray(record.blocks) && record.blocks.length > 0;
    if (!hasBlocks && fallback !== messageText.trim()) parts.push(fallback);
  }
  parts.push(...fieldLines(record), stringField(record, 'footer'));

  return parts.filter((part) => part !== '').flatMap((part) => part.split('\n'));
}

/**
 * Every legacy attachment of a message that has something to show, in order,
 * as text lines. Attachments with nothing to show are dropped.
 */
export function extractAttachments(msg: Pick<SlackMessage, 'text' | 'attachments'>): string[][] {
  return (msg.attachments ?? [])
    .map((attachment) => attachmentLines(attachment, msg.text ?? ''))
    .filter((lines) => lines.length > 0);
}
