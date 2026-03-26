import type { SlackClient } from './slack-client.ts';
import type { UnreadChannel } from '../types/index.ts';

export async function fetchUnreadChannels(
  client: SlackClient,
  options: {
    onProgress?: (message: string) => void;
  } = {},
): Promise<UnreadChannel[]> {
  const response = await client.getUnreadCounts();
  let channels: UnreadChannel[];

  if (client.authType === 'browser') {
    // client.counts response
    const allChannels = [
      ...(response.channels || []),
      ...(response.mpims || []),
      ...(response.ims || []),
    ];

    channels = allChannels
      .filter((ch: any) => ch.has_unreads || (ch.mention_count && ch.mention_count > 0))
      .map((ch: any) => ({
        id: ch.id,
        mention_count: ch.mention_count || 0,
        has_unreads: ch.has_unreads || false,
      }));

    // Resolve channel names in parallel
    // NOTE: may hit Slack rate limits with many unread channels
    options.onProgress?.('Fetching channel details...');
    await Promise.all(channels.map(async (ch) => {
      try {
        const info = await client.getConversationInfo(ch.id);
        if (info.channel) {
          ch.is_im = info.channel.is_im;
          ch.is_mpim = info.channel.is_mpim;
          ch.is_private = info.channel.is_private;
          if (info.channel.is_im && info.channel.user) {
            try {
              const userInfo = await client.getUserInfo(info.channel.user);
              ch.name = userInfo.user?.real_name || userInfo.user?.name || info.channel.user;
            } catch {
              ch.name = info.channel.user;
            }
          } else {
            ch.name = info.channel.name || ch.id;
          }
        }
      } catch {
        ch.name = ch.id;
      }
    }));
  } else {
    // conversations.list response
    channels = (response.channels || [])
      .filter((ch: any) => ch.is_member && (ch.unread_count > 0 || ch.unread_count_display > 0))
      .map((ch: any) => ({
        id: ch.id,
        name: ch.name,
        mention_count: ch.mention_count_display || 0,
        unread_count: ch.unread_count_display || ch.unread_count || 0,
        has_unreads: true,
        is_im: ch.is_im,
        is_mpim: ch.is_mpim,
        is_private: ch.is_private,
      }));
  }

  // Sort: mentions first, then alphabetical
  channels.sort((a, b) => {
    if (a.mention_count !== b.mention_count) return b.mention_count - a.mention_count;
    return (a.name || '').localeCompare(b.name || '');
  });

  return channels;
}
