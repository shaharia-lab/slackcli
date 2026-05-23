import type { SlackMessage } from '../types/index.ts';

// Returns true when an MS-socket frame represents an ephemeral message we
// should capture for the given channel + invocation correlation token.
export function matchesEphemeral(
  payload: any,
  channelId: string,
  clientToken: string,
  selfUserId?: string,
): boolean {
  if (!payload || payload.type !== 'message') return false;
  if (payload.channel !== channelId) return false;

  const isEphemeral = payload.is_ephemeral === true || payload.subtype === 'ephemeral';
  const correlated = clientToken !== '' && payload.client_msg_id === clientToken;
  const directlyTargeted = !!selfUserId && payload.user === selfUserId && payload.is_ephemeral === true;

  return isEphemeral || correlated || directlyTargeted;
}

// Converts a raw MS-socket frame into a SlackMessage, marking it ephemeral.
export function payloadToMessage(payload: any): SlackMessage {
  return {
    type: 'message',
    subtype: payload.subtype,
    user: payload.user,
    bot_id: payload.bot_id,
    text: payload.text || '',
    ts: payload.ts || String(Date.now() / 1000),
    thread_ts: payload.thread_ts,
    blocks: payload.blocks,
    attachments: payload.attachments,
    files: payload.files,
    is_ephemeral: true,
    client_msg_id: payload.client_msg_id,
    channel: payload.channel,
  };
}

// When chat.command replies synchronously inside the HTTP body, build a
// synthetic SlackMessage from the response. Returns null if no reply body.
export function syncResponseToMessage(syncResp: any, channelId: string): SlackMessage | null {
  if (!syncResp) return null;

  const body = syncResp.response || syncResp.message;
  if (!body) return null;

  const text = body.text;
  const blocks = body.blocks;
  const attachments = body.attachments;

  if (!text && !blocks && !attachments) return null;

  return {
    type: 'message',
    text: text || '',
    ts: String(Date.now() / 1000),
    is_ephemeral: true,
    channel: channelId,
    blocks,
    attachments,
  };
}
