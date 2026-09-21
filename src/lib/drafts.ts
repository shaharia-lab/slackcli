import type { DraftSummary, SlackDraft } from '../types/index.ts';
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
