import { describe, expect, it } from 'bun:test';
import { resolveRecipientChannel } from './recipient.ts';
import type { SlackClient } from './slack-client.ts';

function makeClient(stub: {
  openConversation?: (u: string) => Promise<any>;
}): { client: SlackClient; calls: string[] } {
  const calls: string[] = [];
  const client = {
    openConversation: async (u: string) => {
      calls.push(u);
      return stub.openConversation ? stub.openConversation(u) : { channel: { id: `D-${u}` } };
    },
  } as unknown as SlackClient;
  return { client, calls };
}

describe('resolveRecipientChannel', () => {
  it('returns channel IDs unchanged', async () => {
    const { client, calls } = makeClient({});
    expect(await resolveRecipientChannel(client, 'C123')).toBe('C123');
    expect(await resolveRecipientChannel(client, 'GAB12')).toBe('GAB12');
    expect(await resolveRecipientChannel(client, 'D9XY')).toBe('D9XY');
    expect(calls).toEqual([]);
  });

  it('opens a DM and returns the new channel id when recipientId starts with U', async () => {
    const { client, calls } = makeClient({});
    const id = await resolveRecipientChannel(client, 'U777');
    expect(id).toBe('D-U777');
    expect(calls).toEqual(['U777']);
  });

  it('propagates errors from openConversation', async () => {
    const { client } = makeClient({
      openConversation: async () => { throw new Error('user_not_found'); },
    });
    await expect(resolveRecipientChannel(client, 'U1')).rejects.toThrow('user_not_found');
  });
});
