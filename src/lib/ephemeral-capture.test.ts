import { describe, expect, it } from 'bun:test';
import { matchesEphemeral, payloadToMessage, syncResponseToMessage } from './ephemeral-capture.ts';

const CH = 'C123';
const TOKEN = 'tok-abc';
const SELF = 'U999';

describe('matchesEphemeral', () => {
  it('matches when is_ephemeral=true and channel matches', () => {
    expect(matchesEphemeral(
      { type: 'message', channel: CH, is_ephemeral: true, text: 'hi' },
      CH, TOKEN,
    )).toBe(true);
  });

  it('matches when subtype is ephemeral', () => {
    expect(matchesEphemeral(
      { type: 'message', channel: CH, subtype: 'ephemeral', text: 'hi' },
      CH, TOKEN,
    )).toBe(true);
  });

  it('matches when client_msg_id correlates with our token', () => {
    expect(matchesEphemeral(
      { type: 'message', channel: CH, client_msg_id: TOKEN, text: 'hi' },
      CH, TOKEN,
    )).toBe(true);
  });

  it('matches when payload targets self user with is_ephemeral', () => {
    expect(matchesEphemeral(
      { type: 'message', channel: CH, user: SELF, is_ephemeral: true },
      CH, TOKEN, SELF,
    )).toBe(true);
  });

  it('rejects payloads from a different channel', () => {
    expect(matchesEphemeral(
      { type: 'message', channel: 'C_OTHER', is_ephemeral: true, text: 'hi' },
      CH, TOKEN,
    )).toBe(false);
  });

  it('rejects non-message types', () => {
    for (const type of ['hello', 'pong', 'reconnect_url', 'presence_change']) {
      expect(matchesEphemeral(
        { type, channel: CH, is_ephemeral: true },
        CH, TOKEN,
      )).toBe(false);
    }
  });

  it('rejects message in correct channel without ephemeral signal', () => {
    expect(matchesEphemeral(
      { type: 'message', channel: CH, text: 'normal post', user: 'U_OTHER' },
      CH, TOKEN, SELF,
    )).toBe(false);
  });

  it('rejects ephemeral whose client_msg_id belongs to another invocation', () => {
    expect(matchesEphemeral(
      { type: 'message', channel: CH, is_ephemeral: true, client_msg_id: 'other-token', text: 'hi' },
      CH, TOKEN,
    )).toBe(false);
  });

  it('still rejects mismatched client_msg_id even with subtype=ephemeral', () => {
    expect(matchesEphemeral(
      { type: 'message', channel: CH, subtype: 'ephemeral', client_msg_id: 'other-token' },
      CH, TOKEN,
    )).toBe(false);
  });

  it('does not correlate when clientToken is empty', () => {
    expect(matchesEphemeral(
      { type: 'message', channel: CH, client_msg_id: '' },
      CH, '',
    )).toBe(false);
  });

  it('rejects null/undefined payloads', () => {
    expect(matchesEphemeral(null, CH, TOKEN)).toBe(false);
    expect(matchesEphemeral(undefined, CH, TOKEN)).toBe(false);
  });
});

describe('payloadToMessage', () => {
  it('copies common fields and marks the message ephemeral', () => {
    const payload = {
      type: 'message',
      subtype: 'bot_message',
      user: 'U1',
      bot_id: 'B1',
      text: 'hello',
      ts: '1.1',
      thread_ts: '1.0',
      blocks: [{ type: 'section' }],
      attachments: [{ color: '#fff' }],
      files: [{ id: 'F1' }],
      client_msg_id: 'msg-1',
      channel: CH,
    };
    const msg = payloadToMessage(payload);
    expect(msg.type).toBe('message');
    expect(msg.subtype).toBe('bot_message');
    expect(msg.user).toBe('U1');
    expect(msg.bot_id).toBe('B1');
    expect(msg.text).toBe('hello');
    expect(msg.ts).toBe('1.1');
    expect(msg.thread_ts).toBe('1.0');
    expect(msg.blocks).toEqual([{ type: 'section' }]);
    expect(msg.attachments).toEqual([{ color: '#fff' }]);
    expect(msg.files).toEqual([{ id: 'F1' } as any]);
    expect(msg.client_msg_id).toBe('msg-1');
    expect(msg.channel).toBe(CH);
    expect(msg.is_ephemeral).toBe(true);
  });

  it('falls back text to empty string when missing', () => {
    const msg = payloadToMessage({ type: 'message', channel: CH, ts: '1.1' });
    expect(msg.text).toBe('');
    expect(msg.is_ephemeral).toBe(true);
  });

  it('synthesizes ts in Slack sec.microsec format when missing', () => {
    const msg = payloadToMessage({ type: 'message', channel: CH });
    expect(msg.ts).toMatch(/^\d+\.\d{6}$/);
  });
});

describe('syncResponseToMessage', () => {
  it('synthesizes from response.text', () => {
    const msg = syncResponseToMessage(
      { ok: true, response: { text: 'sync ok', blocks: [{ type: 'section' }] } },
      CH,
    );
    expect(msg).not.toBeNull();
    expect(msg!.text).toBe('sync ok');
    expect(msg!.blocks).toEqual([{ type: 'section' }]);
    expect(msg!.is_ephemeral).toBe(true);
    expect(msg!.channel).toBe(CH);
    expect(msg!.ts).toMatch(/^\d+\.\d{6}$/);
  });

  it('synthesizes from message.text', () => {
    const msg = syncResponseToMessage(
      { ok: true, message: { text: 'msg path', attachments: [{ a: 1 }] } },
      CH,
    );
    expect(msg).not.toBeNull();
    expect(msg!.text).toBe('msg path');
    expect(msg!.attachments).toEqual([{ a: 1 }]);
  });

  it('returns null when neither response nor message present', () => {
    expect(syncResponseToMessage({ ok: true }, CH)).toBeNull();
  });

  it('returns null when both are present but empty', () => {
    expect(syncResponseToMessage({ ok: true, response: {} }, CH)).toBeNull();
  });

  it('returns null for null/undefined input', () => {
    expect(syncResponseToMessage(null, CH)).toBeNull();
    expect(syncResponseToMessage(undefined, CH)).toBeNull();
  });

  it('handles blocks-only response without text', () => {
    const msg = syncResponseToMessage(
      { response: { blocks: [{ type: 'section' }] } },
      CH,
    );
    expect(msg).not.toBeNull();
    expect(msg!.text).toBe('');
    expect(msg!.blocks).toEqual([{ type: 'section' }]);
  });
});
