import { describe, expect, it } from 'bun:test';
import {
  extractDraftText,
  fetchDrafts,
  findActiveDraft,
  loadActiveDraft,
  parseDraftLimit,
  projectDraft,
  sendDraft,
  validateSendableDraft,
} from './drafts.ts';
import type { SlackDraftListResponse } from '../types/index.ts';

describe('parseDraftLimit', () => {
  it('accepts positive integers', () => {
    expect(parseDraftLimit('1')).toBe(1);
    expect(parseDraftLimit('100')).toBe(100);
  });

  it('rejects zero, negatives, decimals, trailing junk, and unsafe integers', () => {
    for (const value of ['0', '-1', '1.5', '10drafts', 'abc', '9007199254740992']) {
      expect(() => parseDraftLimit(value)).toThrow('--limit must be a positive integer');
    }
  });
});

describe('extractDraftText', () => {
  it('projects formatted text, emoji, links, and mentions without exposing raw blocks', () => {
    const text = extractDraftText([{
      type: 'rich_text',
      elements: [{
        type: 'rich_text_section',
        elements: [
          { type: 'text', text: 'Hello ' },
          { type: 'emoji', name: 'wave' },
          { type: 'text', text: ' — ' },
          { type: 'link', text: 'runbook', url: 'https://example.com/runbook' },
          { type: 'text', text: ' ' },
          { type: 'user', user_id: 'U123' },
          { type: 'text', text: ' in ' },
          { type: 'channel', channel_id: 'C123' },
          { type: 'text', text: ' ' },
          { type: 'usergroup', usergroup_id: 'S123' },
          { type: 'text', text: ' ' },
          { type: 'broadcast', range: 'here' },
        ],
      }],
    }]);

    expect(text).toBe(
      'Hello :wave: — runbook <@U123> in <#C123> <!subteam^S123> <!here>',
    );
  });

  it('uses a link URL without a label and separates list items and blocks with newlines', () => {
    const text = extractDraftText([
      {
        type: 'rich_text',
        elements: [{
          type: 'rich_text_list',
          elements: [
            { type: 'rich_text_section', elements: [{ type: 'text', text: 'First' }] },
            { type: 'rich_text_section', elements: [{ type: 'text', text: 'Second' }] },
          ],
        }],
      },
      {
        type: 'rich_text',
        elements: [{
          type: 'rich_text_section',
          elements: [{ type: 'link', url: 'https://example.com' }],
        }],
      },
    ]);

    expect(text).toBe('First\nSecond\nhttps://example.com');
  });

  it('keeps fallback text from date and unfamiliar future elements', () => {
    const text = extractDraftText([{
      type: 'rich_text',
      elements: [{
        type: 'rich_text_section',
        elements: [
          { type: 'date', fallback: 'Sep 21' },
          { type: 'future_element', text: ' preserved' },
        ],
      }],
    }]);

    expect(text).toBe('Sep 21 preserved');
  });
});

describe('projectDraft', () => {
  it('produces the approved stable projection and omits unset optional fields', () => {
    expect(projectDraft({
      id: 'Dr123',
      date_created: 1700000000,
      date_scheduled: 0,
      destinations: [{ channel_id: 'C123' }],
      blocks: [{
        type: 'rich_text',
        elements: [{
          type: 'rich_text_section',
          elements: [{ type: 'text', text: 'Deploy later' }],
        }],
      }],
    })).toEqual({
      draft_id: 'Dr123',
      channel_id: 'C123',
      text: 'Deploy later',
      date_created: 1700000000,
      file_ids: [],
    });
  });

  it('includes thread, schedule, and file fields when present', () => {
    expect(projectDraft({
      id: 'Dr456',
      date_created: 1700000000,
      date_scheduled: 1700003600,
      destinations: [{ channel_id: 'C456', thread_ts: '1699999999.000100' }],
      file_ids: ['F1', 'F2'],
    })).toEqual({
      draft_id: 'Dr456',
      channel_id: 'C456',
      text: '',
      date_created: 1700000000,
      file_ids: ['F1', 'F2'],
      thread_ts: '1699999999.000100',
      date_scheduled: 1700003600,
    });
  });

  it('fails clearly when Slack omits a required projected field', () => {
    expect(() => projectDraft({
      date_created: 1700000000,
      destinations: [{ channel_id: 'C123' }],
    })).toThrow('without an id');
    expect(() => projectDraft({ id: 'Dr123', date_created: 1700000000 }))
      .toThrow('without a channel destination');
    expect(() => projectDraft({ id: 'Dr123', destinations: [{ channel_id: 'C123' }] }))
      .toThrow('without a creation date');
  });
});

describe('fetchDrafts', () => {
  it('passes the limit, filters inactive entries, projects fields, and reports progress', async () => {
    const calls: unknown[] = [];
    const progress: string[] = [];
    const response: SlackDraftListResponse = {
      ok: true,
      drafts: [
        {
          id: 'DrActive',
          date_created: 1700000000,
          destinations: [{ channel_id: 'C1' }],
          blocks: [],
        },
        {
          id: 'DrDeleted',
          date_created: 1700000001,
          destinations: [{ channel_id: 'C2' }],
          is_deleted: true,
        },
        {
          id: 'DrSent',
          date_created: 1700000002,
          destinations: [{ channel_id: 'C3' }],
          is_sent: true,
        },
      ],
    };
    const client = {
      listDrafts: async (options: { limit?: number }) => {
        calls.push(options);
        return response;
      },
    };

    const drafts = await fetchDrafts(client, {
      limit: 10,
      onProgress: (message) => progress.push(message),
    });

    expect(calls).toEqual([{ limit: 10 }]);
    expect(progress).toEqual(['Fetching active drafts...']);
    expect(drafts).toEqual([{
      draft_id: 'DrActive',
      channel_id: 'C1',
      text: '',
      date_created: 1700000000,
      file_ids: [],
    }]);
  });
});

const sendableDraft = {
  id: 'Dr123',
  destinations: [{ channel_id: 'C123', thread_ts: '1700000000.000001' }],
  blocks: [{
    type: 'rich_text',
    elements: [{
      type: 'rich_text_section',
      elements: [{ type: 'text', text: 'Reviewed *reply*', style: { bold: true } }],
    }],
  }],
};

describe('draft lifecycle', () => {
  it('finds only a matching active draft', () => {
    const response: SlackDraftListResponse = {
      ok: true,
      drafts: [{ ...sendableDraft, is_deleted: true }, { id: 'DrOther' }],
    };
    expect(() => findActiveDraft(response, 'Dr123')).toThrow('was not found');
    expect(findActiveDraft({ ok: true, drafts: [sendableDraft] }, 'Dr123')).toEqual(sendableDraft);
  });

  it('loads a requested draft and reports a truncated listing', async () => {
    const client = { listDrafts: async () => ({ ok: true, drafts: [], has_more: true }) };
    await expect(loadActiveDraft(client, 'DrMissing')).rejects.toThrow('first 1000 active drafts');
    await expect(loadActiveDraft(client, ' ')).rejects.toThrow('cannot be empty');
  });

  it('refuses scheduled, attached, multiple-destination, and empty drafts', () => {
    expect(() => validateSendableDraft({ ...sendableDraft, date_scheduled: 1700000100 }))
      .toThrow('Scheduled drafts');
    expect(() => validateSendableDraft({ ...sendableDraft, file_ids: ['F1'] }))
      .toThrow('file attachments');
    expect(() => validateSendableDraft({ ...sendableDraft, destinations: [{ channel_id: 'C1' }, { channel_id: 'C2' }] }))
      .toThrow('exactly one');
    expect(() => validateSendableDraft({ ...sendableDraft, blocks: [] }))
      .toThrow('supported rich-text');
    expect(() => validateSendableDraft({ ...sendableDraft, blocks: [{ type: 'rich_text', elements: [] }] }))
      .toThrow('no text');
  });

  it('accepts a DM destination carrying its recipient user id', () => {
    expect(validateSendableDraft({
      ...sendableDraft,
      destinations: [{ channel_id: 'D123', user_ids: ['U123'] }],
    }).channelId).toBe('D123');
  });

  it('posts the original blocks in the saved thread, then deletes and gets a link', async () => {
    const calls: unknown[] = [];
    const client = {
      postMessage: async (channel: string, text: string, options: unknown) => {
        calls.push(['post', channel, text, options]);
        return { ts: '1700000001.000002' };
      },
      deleteDraft: async (id: string) => { calls.push(['delete', id]); },
      getPermalink: async (channel: string, ts: string) => {
        calls.push(['link', channel, ts]);
        return { permalink: 'https://example.slack.com/archives/C123/p1700000001000002' };
      },
    };
    expect(await sendDraft(client, 'Dr123', sendableDraft)).toEqual({
      channel_id: 'C123', ts: '1700000001.000002',
      permalink: 'https://example.slack.com/archives/C123/p1700000001000002',
    });
    expect(calls).toEqual([
      ['post', 'C123', 'Reviewed *reply*', { thread_ts: '1700000000.000001', blocks: sendableDraft.blocks }],
      ['delete', 'Dr123'],
      ['link', 'C123', '1700000001.000002'],
    ]);
  });

  it('leaves the draft untouched when posting fails', async () => {
    let deleted = false;
    const client = {
      postMessage: async () => { throw new Error('post failed'); },
      deleteDraft: async () => { deleted = true; },
      getPermalink: async () => ({}),
    };
    await expect(sendDraft(client, 'Dr123', sendableDraft)).rejects.toThrow('post failed');
    expect(deleted).toBe(false);
  });

  it('returns the posted identity when cleanup fails, without inviting a duplicate retry', async () => {
    const client = {
      postMessage: async () => ({ ts: '1700000001.000002' }),
      deleteDraft: async () => { throw new Error('draft_has_conflict'); },
      getPermalink: async () => { throw new Error('link unavailable'); },
    };
    expect(await sendDraft(client, 'Dr123', sendableDraft)).toEqual({
      channel_id: 'C123', ts: '1700000001.000002', cleanup_error: 'draft_has_conflict',
    });
  });
});
