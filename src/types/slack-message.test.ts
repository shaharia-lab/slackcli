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
});
