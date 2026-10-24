// Slack `table` blocks as plain text rows, for the message formatter (#446).
// Slack sends a table in `message.blocks` or, for a table pasted into the
// composer, in `message.attachments[].blocks`; both are read here.

import type { SlackMessage } from '../types/index.ts';
import { extractDraftText } from './drafts.ts';

const COLUMN_SEPARATOR = ' | ';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * The text of one table cell: a `raw_text` cell's `text`, or a `rich_text`
 * cell's runs joined. Any other cell type is empty, so the columns stay put.
 * Line breaks become spaces so a cell never splits its row.
 */
export function tableCellText(cell: unknown): string {
  const record = asRecord(cell);
  if (!record) return '';
  let text = '';
  if (record.type === 'raw_text' && typeof record.text === 'string') text = record.text;
  if (record.type === 'rich_text') text = extractDraftText([record]);
  return collapseLineBreaks(text);
}

// Every whitespace run holding a `\n` becomes one space. Not `/\s*\n\s*/g`:
// that retries its leading `\s*` across a long run with no newline, O(n²) (#448).
function collapseLineBreaks(text: string): string {
  const lines = text.split('\n');
  const last = lines.length - 1;
  return lines
    .map((line, i) => {
      let part = line;
      if (i > 0) part = part.trimStart();
      if (i < last) part = part.trimEnd();
      return part;
    })
    .filter((part, i) => part !== '' || i === 0 || i === last)
    .join(' ');
}

function tableRows(block: Record<string, unknown>): string[][] {
  if (!Array.isArray(block.rows)) return [];
  return block.rows
    .filter((row): row is unknown[] => Array.isArray(row) && row.length > 0)
    .map((row) => row.map(tableCellText));
}

/**
 * Every table in a message, in order: those in `blocks` first, then those in
 * each attachment's `blocks`. Other block types and tables without rows are
 * skipped.
 */
export function extractTables(msg: Pick<SlackMessage, 'blocks' | 'attachments'>): string[][][] {
  const blocks: unknown[] = [...(msg.blocks ?? [])];
  for (const attachment of msg.attachments ?? []) {
    const nested = asRecord(attachment)?.blocks;
    if (Array.isArray(nested)) blocks.push(...nested);
  }

  const tables: string[][][] = [];
  for (const value of blocks) {
    const block = asRecord(value);
    if (block?.type !== 'table') continue;
    const rows = tableRows(block);
    if (rows.length > 0) tables.push(rows);
  }
  return tables;
}

/**
 * A table as aligned text lines, one per row: each column padded to its widest
 * cell, short rows padded with empty cells, no trailing whitespace.
 */
export function formatTableRows(rows: string[][]): string[] {
  const columns = Math.max(0, ...rows.map((row) => row.length));
  const widths = Array.from({ length: columns }, (_, i) =>
    Math.max(...rows.map((row) => (row[i] ?? '').length)));
  return rows.map((row) =>
    widths.map((width, i) => (row[i] ?? '').padEnd(width)).join(COLUMN_SEPARATOR).trimEnd());
}
