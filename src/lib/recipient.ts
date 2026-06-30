import type { SlackClient } from './slack-client.ts';

// If recipientId is a user ID (starts with U), open a DM channel and return
// its channel ID. Otherwise return recipientId unchanged. The DM-open round
// trip is what `messages send`, `messages draft`, and `messages command`
// each used to do inline.
export async function resolveRecipientChannel(
  client: SlackClient,
  recipientId: string,
): Promise<string> {
  if (!recipientId.startsWith('U')) return recipientId;
  const dm = await client.openConversation(recipientId);
  return dm.channel.id;
}
