import { describe, expect, it } from 'bun:test';
import {
  columnNamesOf,
  columnTypeOf,
  fetchListRecords,
  LISTS_MAX_PAGES,
  listCellUpdateOf,
  listCellWriteOf,
  listIdOf,
} from './lists.ts';
import { formatListRecords } from './formatter.ts';
import { applyFields, fieldsOption } from './json-fields.ts';
import { InvalidInputError } from './cli-errors.ts';
import type { SlackClient } from './slack-client.ts';
import type { SlackListRecord, SlackListRecordsResponse } from '../types/index.ts';

describe('listIdOf', () => {
  it('accepts a list file ID as-is', () => {
    expect(listIdOf('F0123456789')).toBe('F0123456789');
  });

  it('extracts the list file ID from a list URL, the same as the ID form', () => {
    expect(listIdOf('https://acme.slack.com/lists/T0123456789/F0123456789')).toBe('F0123456789');
  });

  it('rejects a channel ID and a list URL that names no file', () => {
    expect(() => listIdOf('C0123456789')).toThrow();
    expect(() => listIdOf('https://acme.slack.com/lists/T0123456789')).toThrow('could not read an ID');
  });
});

describe('fetchListRecords', () => {
  it('follows next_cursor until it is empty, passing each cursor and reporting progress', async () => {
    const calls: Array<string | undefined> = [];
    const progress: string[] = [];
    const pages: SlackListRecordsResponse[] = [
      { ok: true, records: [{ id: 'Rec1' }], response_metadata: { next_cursor: 'page-2' } },
      { ok: true, records: [{ id: 'Rec2' }], response_metadata: { next_cursor: '' } },
    ];
    const client: Pick<SlackClient, 'listRecords'> = {
      listRecords: async (listId, options = {}) => {
        expect(listId).toBe('F0123456789');
        calls.push(options.cursor);
        return pages[calls.length - 1];
      },
    };

    const records = await fetchListRecords(client, 'F0123456789', { onProgress: (message) => progress.push(message) });

    expect(calls).toEqual([undefined, 'page-2']);
    expect(records.map((record) => record.id)).toEqual(['Rec1', 'Rec2']);
    expect(progress).toHaveLength(2);
  });

  it('stops when a page returns the cursor it was asked for', async () => {
    const client: Pick<SlackClient, 'listRecords'> = {
      listRecords: async () => ({
        ok: true,
        records: [{ id: 'RecLoop' }],
        response_metadata: { next_cursor: 'same' },
      }),
    };

    const records = await fetchListRecords(client, 'F0123456789');

    expect(records).toHaveLength(2);
  });

  it('stops at the page bound when every page brings a new cursor', async () => {
    let page = 0;
    const client: Pick<SlackClient, 'listRecords'> = {
      listRecords: async () => {
        page += 1;
        return { ok: true, records: [{ id: `Rec${page}` }], response_metadata: { next_cursor: `c${page}` } };
      },
    };

    const records = await fetchListRecords(client, 'F0123456789');

    expect(records).toHaveLength(LISTS_MAX_PAGES);
  });
});

describe('columnNamesOf', () => {
  it('maps column IDs to names from the list schema', () => {
    const names = columnNamesOf([
      { id: 'Col1', name: 'Task', type: 'text' },
      { id: 'Col2', name: 'Owner', type: 'user' },
    ]);

    expect(names.get('Col1')).toBe('Task');
    expect(names.get('Col2')).toBe('Owner');
  });

  it('is empty when the response carries no schema', () => {
    expect(columnNamesOf(undefined).size).toBe(0);
  });
});

describe('formatListRecords', () => {
  const records: SlackListRecord[] = [
    {
      id: 'Rec1',
      fields: [
        { column_id: 'Col1', text: 'Ship it' },
        { column_id: 'Col2', user: ['U0123456789'] },
        { column_id: 'Col3', select: ['Opt1', 'Opt2'] },
        { column_id: 'Col4', number: [3] },
      ],
    },
    { id: 'Rec2' },
  ];

  it('prints one line per record, naming columns where known and showing the ID otherwise', () => {
    const lines = formatListRecords(records, new Map([['Col1', 'Task']])).split('\n');

    expect(lines).toEqual([
      'Rec1  Task: Ship it | Col2: U0123456789 | Col3: Opt1, Opt2 | Col4: 3',
      'Rec2',
    ]);
  });
});

describe('list JSON and --fields', () => {
  it('projects --fields over each record of the read envelope', () => {
    const payload = {
      list_id: 'F0123456789',
      record_count: 1,
      records: [{ id: 'Rec1', list_id: 'F0123456789', fields: [{ column_id: 'Col1', text: 'x' }] }],
    };

    expect(applyFields('lists read', payload, fieldsOption({ fields: 'id', json: true }))).toEqual({
      list_id: 'F0123456789',
      record_count: 1,
      records: [{ id: 'Rec1' }],
    });
  });

  it('projects --fields over the single record of the record envelope', () => {
    const payload = { list_id: 'F0123456789', id: 'Rec1', date_created: 1700000000, fields: [] };

    expect(applyFields('lists record', payload, fieldsOption({ fields: 'id,date_created', json: true })))
      .toEqual({ id: 'Rec1', date_created: 1700000000 });
  });
});

describe('listCellUpdateOf', () => {
  const row = 'Rec0123456789';
  const column = 'Col0123456789';

  it('builds a text cell as one rich_text section', () => {
    expect(listCellUpdateOf(row, column, 'text', 'hello')).toEqual({
      row_id: row,
      column_id: column,
      rich_text: [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'hello' }] }] }],
    });
  });

  it('builds a checkbox cell as a boolean', () => {
    expect(listCellUpdateOf(row, column, 'checkbox', 'true')).toEqual({ row_id: row, column_id: column, checkbox: true });
    expect(listCellUpdateOf(row, column, 'checkbox', 'false')).toEqual({ row_id: row, column_id: column, checkbox: false });
  });

  it('builds the to-do list columns with the checkbox, user and date shapes', () => {
    expect(listCellUpdateOf(row, column, 'todo_completed', 'true')).toEqual({ row_id: row, column_id: column, checkbox: true });
    expect(listCellUpdateOf(row, column, 'todo_assignee', 'U0123456789')).toEqual({
      row_id: row,
      column_id: column,
      user: ['U0123456789'],
    });
    expect(listCellUpdateOf(row, column, 'todo_due_date', '2026-10-30')).toEqual({
      row_id: row,
      column_id: column,
      date: ['2026-10-30'],
    });
  });

  it('builds a user cell from a comma list of user IDs under the user key', () => {
    expect(listCellUpdateOf(row, column, 'user', 'U0123456789, W0123456789')).toEqual({
      row_id: row,
      column_id: column,
      user: ['U0123456789', 'W0123456789'],
    });
  });

  it('builds a date cell as a one-item list of YYYY-MM-DD', () => {
    expect(listCellUpdateOf(row, column, 'date', '2026-10-28')).toEqual({ row_id: row, column_id: column, date: ['2026-10-28'] });
  });

  it('builds a number cell as a one-item list holding a number, not a string', () => {
    expect(listCellUpdateOf(row, column, 'number', '7')).toEqual({ row_id: row, column_id: column, number: [7] });
  });

  it('refuses a value that does not fit its type', () => {
    expect(() => listCellUpdateOf(row, column, 'checkbox', 'yes')).toThrow(InvalidInputError);
    expect(() => listCellUpdateOf(row, column, 'user', '')).toThrow(InvalidInputError);
    expect(() => listCellUpdateOf(row, column, 'user', 'alice')).toThrow(InvalidInputError);
    expect(() => listCellUpdateOf(row, column, 'date', '2026-02-31')).toThrow(InvalidInputError);
    expect(() => listCellUpdateOf(row, column, 'date', '28/10/2026')).toThrow(InvalidInputError);
    expect(() => listCellUpdateOf(row, column, 'number', '')).toThrow(InvalidInputError);
    expect(() => listCellUpdateOf(row, column, 'number', 'seven')).toThrow(InvalidInputError);
  });

  it('refuses a column type it cannot set, and names that type', () => {
    expect(() => listCellUpdateOf(row, column, 'created_by', 'x')).toThrow(InvalidInputError);
    expect(() => listCellUpdateOf(row, column, 'created_by', 'x')).toThrow('"created_by"');
    expect(() => listCellUpdateOf(row, column, 'select', 'x')).toThrow('"select"');
  });
});

describe('columnTypeOf', () => {
  const schema = [
    { id: 'Col0123456789', name: 'Done', type: 'checkbox' },
    { id: 'Col0987654321', name: 'Owner', type: 'user' },
  ];

  it('returns the schema type of the column ID', () => {
    expect(columnTypeOf(schema, 'Col0123456789')).toBe('checkbox');
    expect(columnTypeOf(schema, 'Col0987654321')).toBe('user');
  });

  it('throws InvalidInputError for a column ID the schema does not list, or when there is no schema', () => {
    expect(() => columnTypeOf(schema, 'Col0000000000')).toThrow(InvalidInputError);
    expect(() => columnTypeOf(undefined, 'Col0123456789')).toThrow(InvalidInputError);
  });
});

describe('listCellWriteOf', () => {
  const schema = [{ id: 'Col0123456789', name: 'Done', type: 'checkbox' }];

  it('reads the record with lists.records.info, then builds the cell for the column type it finds', async () => {
    const calls: Array<[string, string]> = [];
    const client: Pick<SlackClient, 'getListRecord'> = {
      getListRecord: async (listId, recordId) => {
        calls.push([listId, recordId]);
        return { ok: true, record: { id: recordId }, list: { list_metadata: { schema } } };
      },
    };

    const write = await listCellWriteOf(client, 'F0123456789', 'Rec0123456789', 'Col0123456789', 'true');

    expect(calls).toEqual([['F0123456789', 'Rec0123456789']]);
    expect(write).toEqual({
      type: 'checkbox',
      cell: { row_id: 'Rec0123456789', column_id: 'Col0123456789', checkbox: true },
    });
  });

  it('throws for a column the schema does not list, before any cell is built', async () => {
    const client: Pick<SlackClient, 'getListRecord'> = {
      getListRecord: async () => ({ ok: true, list: { list_metadata: { schema } } }),
    };

    await expect(listCellWriteOf(client, 'F0123456789', 'Rec0123456789', 'Col0000000000', 'true'))
      .rejects.toThrow(InvalidInputError);
  });
});
