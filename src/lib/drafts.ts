import type { DraftSummary, SlackDraft, SlackDraftListResponse } from '../types/index.ts';
import type { SlackClient } from './slack-client.ts';

const POSITIVE_INTEGER = /^[1-9]\d*$/;

export function parseDraftLimit(value: string): number {
  if (!POSITIVE_INTEGER.test(value)) {
    throw new Error('--limit must be a positive integer');
  }

  const limit = Number(value);
  if (!Number.isSafeInteger(limit)) {
    throw new Error('--limit must be a positive integer');
  }
  return limit;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function richTextValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(richTextValue).join('');

  const element = asRecord(value);
  if (!element) return '';

  const type = typeof element.type === 'string' ? element.type : '';
  if (type === 'text') return typeof element.text === 'string' ? element.text : '';
  if (type === 'emoji') {
    return typeof element.name === 'string' ? `:${element.name}:` : '';
  }
  if (type === 'link') {
    if (typeof element.text === 'string') return element.text;
    return typeof element.url === 'string' ? element.url : '';
  }
  if (type === 'channel' && typeof element.channel_id === 'string') {
    return `<#${element.channel_id}>`;
  }
  if (type === 'user' && typeof element.user_id === 'string') {
    return `<@${element.user_id}>`;
  }
  if (type === 'usergroup' && typeof element.usergroup_id === 'string') {
    return `<!subteam^${element.usergroup_id}>`;
  }
  if (type === 'broadcast' && typeof element.range === 'string') {
    return `<!${element.range}>`;
  }
  if (type === 'date' && typeof element.fallback === 'string') {
    return element.fallback;
  }

  const children = Array.isArray(element.elements) ? element.elements : [];
  const separator = type === 'rich_text_list' ? '\n' : '';
  if (children.length > 0) return children.map(richTextValue).join(separator);

  // Preserve text from an unfamiliar element type rather than silently
  // dropping it if Slack extends the undocumented response shape.
  return typeof element.text === 'string' ? element.text : '';
}

export function extractDraftText(blocks: Array<Record<string, unknown>> = []): string {
  return blocks.map(richTextValue).filter(Boolean).join('\n');
}

export function projectDraft(draft: SlackDraft): DraftSummary {
  if (!draft.id) {
    throw new Error('Slack returned a draft without an id');
  }
  const destination = draft.destinations?.[0];
  if (!destination?.channel_id) {
    throw new Error(`Slack returned draft ${draft.id} without a channel destination`);
  }
  if (draft.date_created === undefined) {
    throw new Error(`Slack returned draft ${draft.id} without a creation date`);
  }

  return {
    draft_id: draft.id,
    channel_id: destination.channel_id,
    text: extractDraftText(draft.blocks),
    date_created: draft.date_created,
    file_ids: draft.file_ids ?? [],
    ...(destination.thread_ts ? { thread_ts: destination.thread_ts } : {}),
    ...(draft.date_scheduled && draft.date_scheduled > 0
      ? { date_scheduled: draft.date_scheduled }
      : {}),
  };
}

export async function fetchDrafts(
  client: Pick<SlackClient, 'listDrafts'>,
  options: { limit: number; onProgress?: (message: string) => void },
): Promise<DraftSummary[]> {
  options.onProgress?.('Fetching active drafts...');
  const response = await client.listDrafts({ limit: options.limit });

  return (response.drafts ?? [])
    .filter((draft) => !draft.is_deleted && !draft.is_sent)
    .map(projectDraft)
    .slice(0, options.limit);
}

export interface SentDraftResult {
  channel_id: string;
  ts: string;
  permalink?: string;
  cleanup_error?: string;
}

export function findActiveDraft(response: SlackDraftListResponse, draftId: string): SlackDraft {
  const draft = response.drafts?.find((item) => item.id === draftId && !item.is_deleted && !item.is_sent);
  if (!draft) {
    throw new Error(`Active draft ${draftId} was not found`);
  }
  return draft;
}

export function validateSendableDraft(draft: SlackDraft): {
  channelId: string;
  threadTs?: string;
  text: string;
  blocks: Array<Record<string, unknown>>;
} {
  if (draft.date_scheduled && draft.date_scheduled > 0) {
    throw new Error('Scheduled drafts cannot be sent with this command');
  }
  if (draft.file_ids?.length) {
    throw new Error('Drafts with file attachments cannot be sent with this command');
  }
  if (draft.destinations?.length !== 1) {
    throw new Error('Draft must have exactly one channel destination');
  }
  const destination = draft.destinations[0];
  const channelId = destination?.channel_id;
  if (!channelId) throw new Error('Draft must have exactly one channel destination');
  if (destination.broadcast) {
    throw new Error('Draft has unsupported destination options');
  }
  const blocks = draft.blocks ?? [];
  if (!blocks.length || blocks.some((block) => block.type !== 'rich_text')) {
    throw new Error('Draft must contain supported rich-text blocks');
  }
  const text = extractDraftText(blocks);
  if (!text.trim()) {
    throw new Error('Draft has no text to send');
  }
  return { channelId, threadTs: destination.thread_ts, text, blocks };
}

export async function loadActiveDraft(
  client: Pick<SlackClient, 'listDrafts'>,
  draftId: string,
): Promise<SlackDraft> {
  if (!draftId.trim()) throw new Error('Draft ID cannot be empty');
  const response = await client.listDrafts({ limit: 1000 });
  try {
    return findActiveDraft(response, draftId);
  } catch (error) {
    if (response.has_more) {
      throw new Error(`Draft ${draftId} was not found in the first 1000 active drafts`);
    }
    throw error;
  }
}

export async function sendDraft(
  client: Pick<SlackClient, 'postMessage' | 'deleteDraft' | 'getPermalink'>,
  draftId: string,
  draft: SlackDraft,
): Promise<SentDraftResult> {
  const { channelId, threadTs, text, blocks } = validateSendableDraft(draft);
  const posted = await client.postMessage(channelId, text, { thread_ts: threadTs, blocks });
  if (typeof posted.ts !== 'string' || !posted.ts) {
    throw new Error('Slack posted the draft but returned no message timestamp; check the channel before retrying');
  }

  const result: SentDraftResult = { channel_id: channelId, ts: posted.ts };
  try {
    await client.deleteDraft(draftId);
  } catch (error) {
    result.cleanup_error = error instanceof Error ? error.message : String(error);
  }
  try {
    const link = await client.getPermalink(channelId, posted.ts);
    if (link?.permalink) result.permalink = link.permalink;
  } catch {
    // A failed link lookup cannot undo a delivered message.
  }
  return result;
}
