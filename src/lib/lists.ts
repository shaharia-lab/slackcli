import type { SlackClient } from './slack-client.ts';
import type { ListCellUpdate, SlackListColumn, SlackListRecord } from '../types/index.ts';
import { normalizeIdentifier } from './slack-url-parser.ts';
import { InvalidInputError } from './cli-errors.ts';

/**
 * The schema type of one column, from the list metadata that lists.records.info
 * returns. A column ID the schema does not list throws.
 */
export function columnTypeOf(schema: SlackListColumn[] | undefined, columnId: string): string {
  const schemaColumn = (schema ?? []).find((candidate) => candidate.id === columnId);
  if (!schemaColumn?.type) throw new InvalidInputError(`Column ${columnId} is not in the list schema.`);
  return schemaColumn.type;
}

/**
 * One cell of a lists.cells.update call, built from the user's raw value and the
 * column's schema type. Each type checks its value first, so a bad value fails
 * before any request. The column types that can be set are text, checkbox, user,
 * date and number; `user` takes comma-separated user IDs, and `date` takes YYYY-MM-DD.
 * A to-do list's own columns (todo_completed, todo_assignee, todo_due_date) take the
 * checkbox, user and date shapes.
 */
export function listCellUpdateOf(rowId: string, columnId: string, columnType: string, value: string): ListCellUpdate {
  const cell = { row_id: rowId, column_id: columnId };
  switch (columnType) {
    case 'text':
      return {
        ...cell,
        rich_text: [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: value }] }] }],
      };
    case 'checkbox':
    case 'todo_completed':
      if (value !== 'true' && value !== 'false') {
        throw new InvalidInputError('A checkbox cell takes "true" or "false".');
      }
      return { ...cell, checkbox: value === 'true' };
    case 'user':
    case 'todo_assignee': {
      const users = value.split(',').map((id) => id.trim()).filter(Boolean);
      if (users.length === 0 || users.some((id) => !/^[UW][A-Z0-9]+$/.test(id))) {
        throw new InvalidInputError('A user cell takes one or more user IDs (U... or W...), separated by commas.');
      }
      return { ...cell, user: users };
    }
    case 'date':
    case 'todo_due_date': {
      const day = new Date(`${value}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== value) {
        throw new InvalidInputError('A date cell takes a real date as YYYY-MM-DD.');
      }
      return { ...cell, date: [value] };
    }
    case 'number': {
      const number = value.trim() === '' ? Number.NaN : Number(value);
      if (!Number.isFinite(number)) throw new InvalidInputError('A number cell takes a finite number.');
      return { ...cell, number: [number] };
    }
    default:
      throw new InvalidInputError(
        `Column type "${columnType}" cannot be set with lists edit-cell. Settable types: text, checkbox, user, date, number, and the to-do columns.`,
      );
  }
}

/**
 * The cell for one edit-cell call. It reads the record with lists.records.info, so
 * the list schema gives the column's type, and the cell takes its shape from that type.
 */
export async function listCellWriteOf(
  client: Pick<SlackClient, 'getListRecord'>,
  listId: string,
  recordId: string,
  columnId: string,
  value: string,
): Promise<{ type: string; cell: ListCellUpdate }> {
  const response = await client.getListRecord(listId, recordId);
  const type = columnTypeOf(response.list?.list_metadata?.schema, columnId);
  return { type, cell: listCellUpdateOf(recordId, columnId, type, value) };
}

// A bound on the pages followed, so a cursor that never ends cannot loop forever.
// Same guard as the scheduled-messages walk.
export const LISTS_MAX_PAGES = 100;

/** A list is named by its file ID (F...) or by a Slack list URL that carries it. */
export function listIdOf(input: string): string {
  return normalizeIdentifier(input, 'file', '<list>');
}

/** Every record of a list, across pages. An empty or repeated next_cursor ends the walk. */
export async function fetchListRecords(
  client: Pick<SlackClient, 'listRecords'>,
  listId: string,
  options: { onProgress?: (message: string) => void } = {},
): Promise<SlackListRecord[]> {
  const records: SlackListRecord[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < LISTS_MAX_PAGES; page++) {
    options.onProgress?.(`Fetching list records (${records.length} so far)...`);
    const response = await client.listRecords(listId, { cursor });
    records.push(...(response.records ?? []));
    const next = response.response_metadata?.next_cursor;
    if (!next || next === cursor) break;
    cursor = next;
  }
  return records;
}

/** Column ID -> column name, from the list schema when the response carries one. */
export function columnNamesOf(schema: SlackListColumn[] | undefined): Map<string, string> {
  const names = new Map<string, string>();
  for (const column of schema ?? []) {
    if (column.name) names.set(column.id, column.name);
  }
  return names;
}
