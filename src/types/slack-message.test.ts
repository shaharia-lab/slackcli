import { describe, expect, it } from 'bun:test';
import type { SlackMessage } from './index.ts';

describe('SlackMessage', () => {
  it('includes blocks in JSON serialization when present', () => {
    const msg: SlackMessage = {
      type: 'message',
      user: 'U123',
      text: 'Bot App: Please process this request.',
      ts: '1234567890.000100',
      blocks: [
        {
          type: 'context',
          elements: [
            { type: 'mrkdwn', text: '<https://example.com/tickets/12345|Ticket #12345>' },
          ],
        },
      ],
    };

    const output = JSON.stringify({
      ts: msg.ts,
      user: msg.user,
      text: msg.text,
      type: msg.type,
      blocks: msg.blocks,
    });

    const parsed = JSON.parse(output);
    expect(parsed.blocks).toBeDefined();
    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0].type).toBe('context');
    expect((parsed.blocks[0] as any).elements[0].text).toBe('<https://example.com/tickets/12345|Ticket #12345>');
  });

  it('omits blocks from JSON output when not present', () => {
    const msg: SlackMessage = {
      type: 'message',
      user: 'U456',
      text: 'Plain message without blocks.',
      ts: '1234567890.000200',
    };

    const output = JSON.stringify({
      ts: msg.ts,
      user: msg.user,
      text: msg.text,
      type: msg.type,
      blocks: msg.blocks,
    });

    const parsed = JSON.parse(output);
    expect(parsed.blocks).toBeUndefined();
  });

  it('preserves nested block structure in serialization', () => {
    const msg: SlackMessage = {
      type: 'message',
      bot_id: 'B001',
      text: 'Bot message',
      ts: '1234567890.000300',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '*Header*' },
        },
        {
          type: 'context',
          elements: [
            { type: 'plain_text', text: 'Footer note' },
          ],
        },
      ],
    };

    const parsed = JSON.parse(JSON.stringify({ blocks: msg.blocks }));
    expect(parsed.blocks).toHaveLength(2);
    expect(parsed.blocks[0].type).toBe('section');
    expect(parsed.blocks[1].type).toBe('context');
  });

  it('includes files in JSON serialization when present', () => {
    const msg: SlackMessage = {
      type: 'message',
      user: 'U123',
      text: 'Here is the document',
      ts: '1234567890.000400',
      files: [
        {
          id: 'F001',
          name: 'design.pdf',
          title: 'Design Doc',
          mimetype: 'application/pdf',
          filetype: 'pdf',
          size: 1258291,
          url_private: 'https://files.slack.com/files-pri/T0123/design.pdf',
          permalink: 'https://team.slack.com/files/U123/F001/design.pdf',
          mode: 'hosted',
        },
      ],
    };

    const output = JSON.stringify({
      ts: msg.ts,
      user: msg.user,
      text: msg.text,
      files: msg.files,
    });

    const parsed = JSON.parse(output);
    expect(parsed.files).toBeDefined();
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0].id).toBe('F001');
    expect(parsed.files[0].name).toBe('design.pdf');
    expect(parsed.files[0].size).toBe(1258291);
    expect(parsed.files[0].mimetype).toBe('application/pdf');
  });

  it('omits files from JSON output when not present', () => {
    const msg: SlackMessage = {
      type: 'message',
      user: 'U456',
      text: 'No files here',
      ts: '1234567890.000500',
    };

    const output = JSON.stringify({
      ts: msg.ts,
      text: msg.text,
      files: msg.files,
    });

    const parsed = JSON.parse(output);
    expect(parsed.files).toBeUndefined();
  });

  describe('conversations read JSON mapping', () => {
    // Helper that replicates the exact mapping from conversations.ts
    function mapMessageToJson(msg: SlackMessage) {
      return {
        ts: msg.ts,
        thread_ts: msg.thread_ts,
        user: msg.user,
        text: msg.text,
        type: msg.type,
        reply_count: msg.reply_count,
        reactions: msg.reactions,
        bot_id: msg.bot_id,
        blocks: msg.blocks,
        ...(msg.files?.length ? { files: msg.files.map(f => ({
          id: f.id,
          name: f.name,
          title: f.title,
          mimetype: f.mimetype,
          filetype: f.filetype,
          size: f.size,
          url_private: f.url_private,
          permalink: f.permalink,
          mode: f.mode,
        })) } : {}),
      };
    }

    it('includes selected file fields in JSON when message has files', () => {
      const msg: SlackMessage = {
        type: 'message',
        user: 'U123',
        text: 'See attached',
        ts: '1234567890.000600',
        files: [
          {
            id: 'F001',
            name: 'report.pdf',
            title: 'Quarterly Report',
            mimetype: 'application/pdf',
            filetype: 'pdf',
            size: 2048000,
            url_private: 'https://files.slack.com/files-pri/T0123/report.pdf',
            url_private_download: 'https://files.slack.com/files-pri/T0123/download/report.pdf',
            permalink: 'https://team.slack.com/files/U123/F001/report.pdf',
            mode: 'hosted',
          },
        ],
      };

      const mapped = mapMessageToJson(msg);
      expect(mapped.files).toBeDefined();
      expect(mapped.files).toHaveLength(1);
      expect(mapped.files![0]).toEqual({
        id: 'F001',
        name: 'report.pdf',
        title: 'Quarterly Report',
        mimetype: 'application/pdf',
        filetype: 'pdf',
        size: 2048000,
        url_private: 'https://files.slack.com/files-pri/T0123/report.pdf',
        permalink: 'https://team.slack.com/files/U123/F001/report.pdf',
        mode: 'hosted',
      });
      // url_private_download must NOT be included
      expect((mapped.files![0] as any).url_private_download).toBeUndefined();
    });

    it('omits files key from JSON when message has no files', () => {
      const msg: SlackMessage = {
        type: 'message',
        user: 'U456',
        text: 'No attachments',
        ts: '1234567890.000700',
      };

      const mapped = mapMessageToJson(msg);
      expect('files' in mapped).toBe(false);
    });

    it('omits files key from JSON when files array is empty', () => {
      const msg: SlackMessage = {
        type: 'message',
        user: 'U789',
        text: 'Empty files array',
        ts: '1234567890.000800',
        files: [],
      };

      const mapped = mapMessageToJson(msg);
      expect('files' in mapped).toBe(false);
    });

    it('maps multiple files correctly', () => {
      const msg: SlackMessage = {
        type: 'message',
        user: 'U123',
        text: 'Multiple files',
        ts: '1234567890.000900',
        files: [
          { id: 'F001', name: 'a.png', mimetype: 'image/png', filetype: 'png', size: 1024 },
          { id: 'F002', name: 'b.txt', mimetype: 'text/plain', filetype: 'text', size: 256 },
        ],
      };

      const mapped = mapMessageToJson(msg);
      expect(mapped.files).toHaveLength(2);
      expect(mapped.files![0].id).toBe('F001');
      expect(mapped.files![1].id).toBe('F002');
    });
  });
});
