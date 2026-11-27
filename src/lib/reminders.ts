import type { SlackClient } from './slack-client.ts';
import { normalizeLegacyReminderId, normalizeSavedReminderId, SAVED_WRITE_AUTH_MESSAGE } from './slack-client.ts';
import { CliError, InvalidInputError, NotFoundError } from './cli-errors.ts';
import { extractDraftText } from './drafts.ts';
import { parseDueTime } from './schedule-time.ts';
import { parseMrkdwn } from './mrkdwn.ts';
import type { ReminderAddInput, ReminderRecord, ReminderRecurrence, SavedReminderUpdate } from '../types/index.ts';

type ReminderClient = Pick<SlackClient,
  'authType' | 'requireReminderUserAuth' | 'requireBrowserAuth' | 'addReminder' | 'listReminders' |
  'getReminder' | 'completeReminder' | 'deleteReminder' | 'listReminderItems' |
  'updateSavedReminder' | 'deleteSavedReminder'>;

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

export function reminderId(raw: string): string {
  return raw.trim().startsWith('Sa') ? normalizeSavedReminderId(raw) : normalizeLegacyReminderId(raw);
}

function reminderText(text: string | undefined): string {
  if (typeof text !== 'string' || !text.trim()) throw new InvalidInputError('--text must contain reminder text.');
  return text;
}

function recurrenceOption(raw: string | undefined): ReminderRecurrence | undefined {
  if (raw === undefined) return undefined;
  let value: any;
  try { value = JSON.parse(raw); } catch { throw new InvalidInputError('--recurrence must be a JSON object.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || !['daily', 'weekly', 'monthly', 'yearly'].includes(value.frequency)
      || Object.keys(value).some((key) => !['frequency', 'weekdays'].includes(key))) {
    throw new InvalidInputError('--recurrence needs frequency: daily, weekly, monthly or yearly.');
  }
  if (value.weekdays !== undefined && (value.frequency !== 'weekly' || !Array.isArray(value.weekdays)
      || value.weekdays.length === 0 || value.weekdays.some((day: unknown) => !WEEKDAYS.includes(day as string)))) {
    throw new InvalidInputError('--recurrence weekdays must be a nonempty array of weekday names, with frequency weekly.');
  }
  return { frequency: value.frequency, ...(value.weekdays ? { weekdays: value.weekdays } : {}) };
}

export function reminderAddFromOptions(options: { text?: string; time?: string; recurrence?: string }): ReminderAddInput {
  const text = reminderText(options.text);
  const time = options.time?.trim();
  if (!time) throw new InvalidInputError('--time is required: use Unix seconds or Slack natural language such as "in 5 minutes".');
  if (/^\d+$/.test(time) && (!Number.isSafeInteger(Number(time)) || Number(time) <= 0)) {
    throw new InvalidInputError('--time must be a positive, safe integer when given as seconds.');
  }
  const recurrence = recurrenceOption(options.recurrence);
  return { text, time, ...(recurrence ? { recurrence } : {}) };
}

export function reminderUpdateFromOptions(options: { text?: string; time?: string }): SavedReminderUpdate {
  if (options.text === undefined && options.time === undefined) {
    throw new InvalidInputError('Pass --text and/or --time to update a reminder.');
  }
  const update: SavedReminderUpdate = {};
  if (options.text !== undefined) {
    update.description = [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [
      { type: 'text', text: reminderText(options.text) },
    ] }] }];
  }
  if (options.time !== undefined) update.date_due = parseDueTime(options.time, '--time');
  return update;
}

export function requireReminderTarget(client: ReminderClient, id: string, editing = false): void {
  client.requireReminderUserAuth();
  if (editing) client.requireBrowserAuth(SAVED_WRITE_AUTH_MESSAGE);
  if (id.startsWith('Sa')) client.requireBrowserAuth(SAVED_WRITE_AUTH_MESSAGE);
  else if (editing) throw new InvalidInputError('Editing requires a modern To-do ID (Sa…) from reminders list. Legacy recurring reminders must be deleted and recreated.');
}

function savedRecord(item: any): ReminderRecord {
  return {
    id: normalizeSavedReminderId(item.item_id), source: 'saved', recurring: false,
    text: typeof item.description === 'string' ? item.description
      : extractDraftText(Array.isArray(item.description) ? item.description : []),
    ...(typeof item.date_due === 'number' ? { time: item.date_due } : {}),
    ...(typeof item.date_completed === 'number' ? { complete_ts: item.date_completed } : {}),
    ...(typeof item.todo_state === 'string' ? { todo_state: item.todo_state } : {}),
  };
}

function legacyRecord(item: any): ReminderRecord {
  if (!item || typeof item.id !== 'string') throw new CliError('unknown', 'Slack returned a reminder without an ID.');
  return {
    id: normalizeLegacyReminderId(item.id), source: 'legacy', text: typeof item.text === 'string' ? item.text : '',
    recurring: item.recurring === true,
    ...(typeof item.time === 'number' ? { time: item.time } : {}),
    ...(typeof item.complete_ts === 'number' ? { complete_ts: item.complete_ts } : {}),
  };
}

async function savedReminders(client: ReminderClient): Promise<ReminderRecord[]> {
  const items = new Map<string, ReminderRecord>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const response = await client.listReminderItems(cursor);
    for (const item of response.saved_items ?? []) {
      if (item.item_type === 'reminder') {
        const record = savedRecord(item);
        items.set(record.id, record);
      }
    }
    const next = response.response_metadata?.next_cursor;
    if (!next) return [...items.values()];
    if (typeof next !== 'string' || cursors.has(next)) throw new CliError('unknown', 'Slack returned a repeated or invalid To-do cursor.');
    cursors.add(next);
    cursor = next;
  }
  throw new CliError('unknown', 'Slack returned too many To-do pages; the reminder list would be incomplete.');
}

export async function fetchReminders(client: ReminderClient): Promise<ReminderRecord[]> {
  client.requireReminderUserAuth();
  const modern = client.authType === 'browser' ? await savedReminders(client) : [];
  const legacy = await client.listReminders();
  return [...modern, ...(legacy.reminders ?? []).map(legacyRecord)];
}

export async function fetchReminder(client: ReminderClient, id: string): Promise<ReminderRecord> {
  requireReminderTarget(client, id);
  if (id.startsWith('Rm')) return legacyRecord((await client.getReminder(id)).reminder);
  const item = (await savedReminders(client)).find((item) => item.id === id);
  if (!item) throw new NotFoundError(`Reminder To-do ${id} was not found.`, 'Use an ID from reminders list in the selected workspace.');
  return item;
}

export async function createReminder(client: ReminderClient, input: ReminderAddInput): Promise<ReminderRecord> {
  client.requireReminderUserAuth();
  // Capture IDs before creating: matching text alone could select an older
  // reminder with identical text/time and later delete the wrong item.
  const before = client.authType === 'browser' ? new Set((await savedReminders(client)).map((r) => r.id)) : undefined;
  const result = legacyRecord((await client.addReminder(input)).reminder);
  if (!before || result.recurring) return result;
  const texts = new Set([result.text, extractDraftText(parseMrkdwn(result.text).map((block) => ({ ...block })))]);
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidates = (await savedReminders(client)).filter((item) => !before.has(item.id)
      && texts.has(item.text) && (result.time === undefined || item.time === result.time));
    if (candidates.length === 1) return { ...candidates[0], reminder_id: result.id };
    if (candidates.length > 1) break;
  }
  // The write happened. Do not retry it or guess an Sa… ID from the Rm… ID.
  throw new CliError('unknown', `Slack created reminder ${result.id}, but its To-do ID could not be resolved uniquely. Do not retry add.`,
    'Run reminders list to find the created To-do before editing or deleting it.');
}

export async function editReminder(client: ReminderClient, id: string, update: SavedReminderUpdate): Promise<void> {
  requireReminderTarget(client, id, true);
  await client.updateSavedReminder(id, update);
}

export async function finishReminder(client: ReminderClient, id: string): Promise<void> {
  requireReminderTarget(client, id);
  if (id.startsWith('Sa')) {
    await client.updateSavedReminder(id, { mark: 'completed', todo_state: 'completed', date_due: 0 });
  } else {
    await client.completeReminder(id);
  }
}

export async function removeReminder(client: ReminderClient, id: string): Promise<void> {
  requireReminderTarget(client, id);
  if (id.startsWith('Sa')) await client.deleteSavedReminder(id);
  else await client.deleteReminder(id);
}
