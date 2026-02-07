import { describe, expect, it } from 'bun:test';
import { formatSearchResults, formatTimestamp } from './formatter';
import type { SlackSearchResponse } from '../types/index.ts';

function makeSearchResponse(overrides: Partial<SlackSearchResponse> = {}): SlackSearchResponse {
  return {
    ok: true,
    query: 'test query',
    messages: {
      matches: [],
      paging: { count: 20, total: 0, page: 1, pages: 0 },
    },
    files: {
      matches: [],
      paging: { count: 20, total: 0, page: 1, pages: 0 },
    },
    ...overrides,
  };
}

describe('formatSearchResults', () => {
  it('should show the search query', () => {
    const result = formatSearchResults(makeSearchResponse({ query: 'hello world' }));
    expect(result).toContain('hello world');
  });

  it('should show total counts for messages and files', () => {
    const response = makeSearchResponse({
      messages: {
        matches: [],
        paging: { count: 20, total: 42, page: 1, pages: 3 },
      },
      files: {
        matches: [],
        paging: { count: 20, total: 7, page: 1, pages: 1 },
      },
    });
    const result = formatSearchResults(response);
    expect(result).toContain('42 messages');
    expect(result).toContain('7 files');
  });

  it('should display message matches with channel, user, and text', () => {
    const response = makeSearchResponse({
      messages: {
        matches: [
          {
            type: 'message',
            user: 'U123',
            username: 'alice',
            ts: '1700000000.000000',
            text: 'This is a test message',
            channel: { id: 'C1', name: 'general' },
            permalink: 'https://slack.com/archives/C1/p1700000000',
          },
        ],
        paging: { count: 20, total: 1, page: 1, pages: 1 },
      },
    });
    const result = formatSearchResults(response);
    expect(result).toContain('@alice');
    expect(result).toContain('#general');
    expect(result).toContain('This is a test message');
    expect(result).toContain('https://slack.com/archives/C1/p1700000000');
  });

  it('should truncate long message text at 200 characters', () => {
    const longText = 'a'.repeat(300);
    const response = makeSearchResponse({
      messages: {
        matches: [
          {
            type: 'message',
            user: 'U1',
            username: 'bob',
            ts: '1700000000.000000',
            text: longText,
            channel: { id: 'C1', name: 'general' },
            permalink: '',
          },
        ],
        paging: { count: 20, total: 1, page: 1, pages: 1 },
      },
    });
    const result = formatSearchResults(response);
    expect(result).toContain('a'.repeat(200) + '...');
    expect(result).not.toContain('a'.repeat(201));
  });

  it('should display file matches with title and filetype', () => {
    const response = makeSearchResponse({
      files: {
        matches: [
          {
            id: 'F1',
            name: 'report.pdf',
            title: 'Q4 Report',
            filetype: 'pdf',
            user: 'U1',
            timestamp: 1700000000,
            channels: ['C1'],
            permalink: 'https://slack.com/files/U1/F1/report.pdf',
          },
        ],
        paging: { count: 20, total: 1, page: 1, pages: 1 },
      },
    });
    const result = formatSearchResults(response);
    expect(result).toContain('Q4 Report');
    expect(result).toContain('pdf');
    expect(result).toContain('https://slack.com/files/U1/F1/report.pdf');
  });

  it('should show "No results found" when both matches are empty', () => {
    const result = formatSearchResults(makeSearchResponse());
    expect(result).toContain('No results found');
  });

  it('should show paging info when there are multiple pages', () => {
    const response = makeSearchResponse({
      messages: {
        matches: [{ type: 'message', user: 'U1', username: 'u', ts: '1700000000.0', text: 'hi', channel: { id: 'C1', name: 'g' }, permalink: '' }],
        paging: { count: 20, total: 100, page: 2, pages: 5 },
      },
    });
    const result = formatSearchResults(response);
    expect(result).toContain('Page 2 of 5');
  });

  it('should not show paging info for single-page results', () => {
    const response = makeSearchResponse({
      messages: {
        matches: [{ type: 'message', user: 'U1', username: 'u', ts: '1700000000.0', text: 'hi', channel: { id: 'C1', name: 'g' }, permalink: '' }],
        paging: { count: 20, total: 1, page: 1, pages: 1 },
      },
    });
    const result = formatSearchResults(response);
    expect(result).not.toContain('Page');
  });

  it('should handle messages with newlines by collapsing them', () => {
    const response = makeSearchResponse({
      messages: {
        matches: [
          {
            type: 'message',
            user: 'U1',
            username: 'user',
            ts: '1700000000.0',
            text: 'line one\nline two\nline three',
            channel: { id: 'C1', name: 'ch' },
            permalink: '',
          },
        ],
        paging: { count: 20, total: 1, page: 1, pages: 1 },
      },
    });
    const result = formatSearchResults(response);
    expect(result).toContain('line one line two line three');
  });

  it('should fall back to user ID when username is missing', () => {
    const response = makeSearchResponse({
      messages: {
        matches: [
          {
            type: 'message',
            user: 'U99FALLBACK',
            username: '',
            ts: '1700000000.0',
            text: 'test',
            channel: { id: 'C1', name: 'ch' },
            permalink: '',
          },
        ],
        paging: { count: 20, total: 1, page: 1, pages: 1 },
      },
    });
    const result = formatSearchResults(response);
    expect(result).toContain('U99FALLBACK');
  });
});
