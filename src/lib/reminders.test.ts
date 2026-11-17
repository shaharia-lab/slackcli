import { describe, expect, it } from 'bun:test';
import {
  createReminder, editReminder, fetchReminder, fetchReminders, finishReminder, reminderAddFromOptions,
  reminderId, reminderUpdateFromOptions, removeReminder,
} from './reminders.ts';
import { InvalidInputError, NotFoundError, UnsupportedAuthTypeError } from './cli-errors.ts';

const DESCRIPTION = [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [
  { type: 'text', text: 'Take a break' },
] }] }];
const SAVED = { item_type: 'reminder', item_id: 'Sa0ABC123', description: DESCRIPTION,
  date_due: 1893492000, date_completed: 0, todo_state: 'to_do' };
const LEGACY = { id: 'Rm0ABC123', text: 'Take a break', recurring: false, time: 1893492000 };

function client(overrides: Record<string, any> = {}) {
  const calls: Array<[string, unknown[]]> = [];
  const defaults: Record<string, any> = {
    addReminder: { reminder: LEGACY }, listReminders: { reminders: [] }, getReminder: { reminder: LEGACY },
    listReminderItems: { saved_items: [SAVED] }, updateSavedReminder: { ok: true },
    deleteSavedReminder: { ok: true }, completeReminder: { ok: true }, deleteReminder: { ok: true },
  };
  const stub: any = {
    authType: overrides.authType ?? 'browser',
    requireReminderUserAuth: () => {},
    requireBrowserAuth: () => { if (stub.authType !== 'browser') throw new UnsupportedAuthTypeError('Browser login required'); },
  };
  for (const method of Object.keys(defaults)) {
    stub[method] = async (...args: unknown[]) => {
      calls.push([method, args]);
      return typeof overrides[method] === 'function' ? overrides[method](...args) : defaults[method];
    };
  }
  return { stub, calls };
}

describe('reminder input', () => {
  it('preserves natural-language time and text, and passes recurrence as an object', () => {
    expect(reminderAddFromOptions({ text: ' Take a break ', time: 'in 5 minutes', recurrence: '{"frequency":"daily"}' }))
      .toEqual({ text: ' Take a break ', time: 'in 5 minutes', recurrence: { frequency: 'daily' } });
    expect(reminderAddFromOptions({ text: 'Weekly', time: '1893492000', recurrence: '{"frequency":"weekly","weekdays":["monday"]}' }).recurrence)
      .toEqual({ frequency: 'weekly', weekdays: ['monday'] });
  });

  it.each([{}, { text: ' ' }, { text: 'Task', time: '' }, { text: 'Task', time: '0' },
    { text: 'Task', time: '99999999999999999999' }])('refuses invalid add input %j', (options) => {
    expect(() => reminderAddFromOptions(options)).toThrow(InvalidInputError);
  });

  it.each(['{', 'null', '[]', '{"frequency":"hourly"}', '{"frequency":"daily","weekdays":["monday"]}',
    '{"frequency":"weekly","weekdays":[]}', '{"frequency":"weekly","weekdays":["Funday"]}',
    '{"frequency":"daily","user":"U123"}'])('refuses invalid recurrence %s', (recurrence) => {
    expect(() => reminderAddFromOptions({ text: 'Task', time: 'in 5 minutes', recurrence })).toThrow(InvalidInputError);
  });

  it('builds a literal rich-text description and a timestamp for editing', () => {
    const update = reminderUpdateFromOptions({ text: 'Take a break', time: '2030-01-01T10:00:00Z' });
    expect(update).toEqual({ description: DESCRIPTION, date_due: Date.UTC(2030, 0, 1, 10) / 1000 });
    expect(reminderUpdateFromOptions({ time: '1893492000' })).toEqual({ date_due: 1893492000 });
  });

  it.each([{}, { text: '' }, { time: 'in 5 minutes' }, { time: '2030-02-30T10:00:00Z' }])
    ('refuses invalid update %j', (input) => expect(() => reminderUpdateFromOptions(input)).toThrow(InvalidInputError));

  it.each(['', 'Sa', 'Rm', 'C123', 'Sa0ABC123,Rm0ABC123', 'https://acme.slack.com/archives/C123'])
    ('refuses invalid reminder ID %j', (id) => expect(() => reminderId(id)).toThrow(InvalidInputError));
  it('keeps both ID namespaces without converting them', () => {
    expect(reminderId(' Sa0ABC123 ')).toBe('Sa0ABC123');
    expect(reminderId('Rm0ABC123')).toBe('Rm0ABC123');
  });
});

describe('reminder reads', () => {
  it('pages modern To-dos including completed rows, deduplicates them and appends legacy reminders', async () => {
    const { stub, calls } = client({
      listReminderItems: async (cursor?: string) => cursor
        ? { saved_items: [SAVED, { ...SAVED, item_id: 'Sa0DEF456', todo_state: 'completed', date_due: 0, date_completed: 123 }] }
        : { saved_items: [SAVED, { item_type: 'message', item_id: 'C123' }], response_metadata: { next_cursor: 'page2' } },
      listReminders: async () => ({ reminders: [{ ...LEGACY, recurring: true }] }),
    });
    const result = await fetchReminders(stub);
    expect(result.map((r) => r.id)).toEqual(['Sa0ABC123', 'Sa0DEF456', 'Rm0ABC123']);
    expect(result[0]).toMatchObject({ source: 'saved', text: 'Take a break', recurring: false, time: 1893492000 });
    expect(result[1]).toMatchObject({ todo_state: 'completed', time: 0, complete_ts: 123 });
    expect(calls.slice(0, 2)).toEqual([['listReminderItems', [undefined]], ['listReminderItems', ['page2']]]);
  });

  it('uses only documented reminder reads with standard user auth', async () => {
    const { stub, calls } = client({ authType: 'standard', listReminders: async () => ({ reminders: [LEGACY] }) });
    expect((await fetchReminders(stub))[0].id).toBe('Rm0ABC123');
    expect(calls).toEqual([['listReminders', []]]);
  });

  it('stops a repeated cursor instead of returning a partial list', async () => {
    const { stub } = client({ listReminderItems: async () => ({ saved_items: [], response_metadata: { next_cursor: 'again' } }) });
    await expect(fetchReminders(stub)).rejects.toThrow('repeated or invalid');
  });

  it('looks up each ID in its own namespace and reports missing modern IDs', async () => {
    const { stub, calls } = client();
    expect((await fetchReminder(stub, 'Sa0ABC123')).id).toBe('Sa0ABC123');
    expect((await fetchReminder(stub, 'Rm0ABC123')).id).toBe('Rm0ABC123');
    expect(calls).toContainEqual(['getReminder', ['Rm0ABC123']]);
    await expect(fetchReminder(stub, 'Sa0MISSING')).rejects.toThrow(NotFoundError);
  });
});

describe('reminder creation', () => {
  it('returns the new saved ID and original Rm ID without matching an older identical To-do', async () => {
    let reads = 0;
    const { stub, calls } = client({ listReminderItems: async () => ({ saved_items: reads++ === 0
      ? [SAVED] : [SAVED, { ...SAVED, item_id: 'Sa0NEW123' }] }) });

    const created = await createReminder(stub, { text: 'Take a break', time: 'in 5 minutes' });

    expect(created).toMatchObject({ id: 'Sa0NEW123', reminder_id: 'Rm0ABC123', source: 'saved' });
    expect(calls.filter(([method]) => method === 'addReminder')).toEqual([
      ['addReminder', [{ text: 'Take a break', time: 'in 5 minutes' }]],
    ]);
  });

  it('retries only the read when Slack has not exposed the created To-do yet', async () => {
    let reads = 0;
    const { stub, calls } = client({ listReminderItems: async () => ({ saved_items: ++reads < 3 ? [] : [SAVED] }) });
    expect((await createReminder(stub, { text: 'Take a break', time: 'in 5 minutes' })).id).toBe('Sa0ABC123');
    expect(calls.filter(([method]) => method === 'addReminder')).toHaveLength(1);
  });

  it('returns a legacy ID for recurring reminders and standard auth', async () => {
    const recurring = client({ addReminder: async () => ({ reminder: { ...LEGACY, recurring: true } }) });
    expect((await createReminder(recurring.stub, { text: 'Take a break', time: '1893492000' })).id).toBe('Rm0ABC123');
    const standard = client({ authType: 'standard' });
    expect((await createReminder(standard.stub, { text: 'Take a break', time: 'in 5 minutes' })).source).toBe('legacy');
    expect(standard.calls).toHaveLength(1);
  });

  it.each([[[]], [[SAVED, { ...SAVED, item_id: 'Sa0DEF456' }]]])
    ('fails safely after a created To-do cannot be resolved uniquely', async (after) => {
      let reads = 0;
      const { stub, calls } = client({ listReminderItems: async () => ({ saved_items: reads++ === 0 ? [] : after }) });
      await expect(createReminder(stub, { text: 'Take a break', time: 'in 5 minutes' })).rejects.toThrow('Do not retry add');
      expect(calls.filter(([method]) => method === 'addReminder')).toHaveLength(1);
      expect(calls.some(([method]) => method === 'deleteSavedReminder')).toBe(false);
    });

  it('matches Slack rich-text normalization without guessing an ID', async () => {
    let reads = 0;
    const { stub } = client({
      addReminder: async () => ({ reminder: { ...LEGACY, text: '*Take a break*' } }),
      listReminderItems: async () => ({ saved_items: reads++ === 0 ? [] : [SAVED] }),
    });
    expect((await createReminder(stub, { text: '*Take a break*', time: 'in 5 minutes' })).id).toBe('Sa0ABC123');
  });
});

describe('reminder mutations', () => {
  it('edits and completes modern To-dos with saved.update, then clears them', async () => {
    const { stub, calls } = client();
    await editReminder(stub, 'Sa0ABC123', { date_due: 1893492000 });
    await finishReminder(stub, 'Sa0ABC123');
    await removeReminder(stub, 'Sa0ABC123');
    expect(calls).toEqual([
      ['updateSavedReminder', ['Sa0ABC123', { date_due: 1893492000 }]],
      ['updateSavedReminder', ['Sa0ABC123', { mark: 'completed', todo_state: 'completed', date_due: 0 }]],
      ['deleteSavedReminder', ['Sa0ABC123']],
    ]);
  });

  it('completes and deletes legacy IDs through reminders.* and rejects editing them', async () => {
    const { stub, calls } = client();
    await finishReminder(stub, 'Rm0ABC123');
    await removeReminder(stub, 'Rm0ABC123');
    await expect(editReminder(stub, 'Rm0ABC123', { date_due: 123 })).rejects.toThrow('deleted and recreated');
    expect(calls).toEqual([['completeReminder', ['Rm0ABC123']], ['deleteReminder', ['Rm0ABC123']]]);
  });

  it('refuses modern IDs with standard auth before a mutation', async () => {
    const { stub, calls } = client({ authType: 'standard' });
    await expect(removeReminder(stub, 'Sa0ABC123')).rejects.toThrow(UnsupportedAuthTypeError);
    await expect(editReminder(stub, 'Sa0ABC123', { date_due: 123 })).rejects.toThrow(UnsupportedAuthTypeError);
    expect(calls).toEqual([]);
  });
});
