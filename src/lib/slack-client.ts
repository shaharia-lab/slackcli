import { WebClient } from '@slack/web-api';
import type { WorkspaceConfig, SlackAuthTestResponse } from '../types/index.ts';
import { parseMrkdwn } from './mrkdwn.ts';

export class SlackClient {
  private config: WorkspaceConfig;
  private webClient?: WebClient;

  constructor(config: WorkspaceConfig) {
    this.config = config;

    // Only use WebClient for standard auth
    if (config.auth_type === 'standard') {
      this.webClient = new WebClient(config.token);
    }
  }

  // Make API request (handles both auth types)
  async request(method: string, params: Record<string, any> = {}): Promise<any> {
    if (this.config.auth_type === 'standard') {
      return this.standardRequest(method, params);
    } else {
      return this.browserRequest(method, params);
    }
  }

  // Standard token request (using @slack/web-api)
  private async standardRequest(method: string, params: Record<string, any>): Promise<any> {
    if (!this.webClient) {
      throw new Error('WebClient not initialized');
    }

    try {
      const response = await this.webClient.apiCall(method, params);
      return response;
    } catch (error: any) {
      throw new Error(`Slack API error: ${error.message}`);
    }
  }

  // Browser token request (custom implementation)
  private async browserRequest(method: string, params: Record<string, any>): Promise<any> {
    if (this.config.auth_type !== 'browser') {
      throw new Error('Invalid auth type');
    }

    const url = `${this.config.workspace_url}/api/${method}`;

    const formBody = new URLSearchParams({
      token: this.config.xoxc_token,
      ...params,
    });

    try {
      // URL-encode the xoxd token for the cookie
      const encodedXoxdToken = encodeURIComponent(this.config.xoxd_token);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Cookie': `d=${encodedXoxdToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': 'https://app.slack.com',
          'User-Agent': 'Mozilla/5.0 (compatible; SlackCLI/0.1.0)',
        },
        body: formBody,
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data: any = await response.json();

      if (!data.ok) {
        throw new Error(data.error || 'Unknown API error');
      }

      return data;
    } catch (error: any) {
      throw new Error(`Slack API error: ${error.message}`);
    }
  }

  // Test authentication
  async testAuth(): Promise<SlackAuthTestResponse> {
    return this.request('auth.test', {});
  }

  // List conversations
  async listConversations(options: {
    types?: string;
    limit?: number;
    exclude_archived?: boolean;
    cursor?: string;
  } = {}): Promise<any> {
    return this.request('conversations.list', options);
  }

  // Get conversation history
  async getConversationHistory(channel: string, options: {
    cursor?: string;
    latest?: string;
    oldest?: string;
    inclusive?: boolean;
    limit?: number;
  } = {}): Promise<any> {
    // Filter out undefined values
    const params: Record<string, any> = { channel };
    if (options.cursor) params.cursor = options.cursor;
    if (options.latest) params.latest = options.latest;
    if (options.oldest) params.oldest = options.oldest;
    if (options.inclusive !== undefined) params.inclusive = options.inclusive;
    if (options.limit) params.limit = options.limit;

    return this.request('conversations.history', params);
  }

  // Get conversation replies (thread)
  async getConversationReplies(channel: string, ts: string, options: {
    cursor?: string;
    latest?: string;
    oldest?: string;
    inclusive?: boolean;
    limit?: number;
  } = {}): Promise<any> {
    const params: Record<string, any> = { channel, ts };
    if (options.cursor) params.cursor = options.cursor;
    if (options.latest) params.latest = options.latest;
    if (options.oldest) params.oldest = options.oldest;
    if (options.inclusive !== undefined) params.inclusive = options.inclusive;
    if (options.limit) params.limit = options.limit;

    return this.request('conversations.replies', params);
  }

  // Post message
  async postMessage(channel: string, text: string, options: {
    thread_ts?: string;
  } = {}): Promise<any> {
    const params: Record<string, any> = { channel, text };
    if (options.thread_ts) params.thread_ts = options.thread_ts;

    return this.request('chat.postMessage', params);
  }

  // Create draft message
  async createDraft(channelId: string, text: string, options: {
    thread_ts?: string;
  } = {}): Promise<any> {
    if (this.config.auth_type === 'standard') {
      throw new Error('Draft creation requires browser authentication');
    }

    const destinations: any = [{ channel_id: channelId }];
    if (options.thread_ts) {
      destinations[0].thread_ts = options.thread_ts;
      destinations[0].broadcast = false;
    }

    const params: Record<string, any> = {
      client_msg_id: crypto.randomUUID(),
      blocks: JSON.stringify(parseMrkdwn(text)),
      destinations: JSON.stringify(destinations),
      file_ids: '[]',
      is_from_composer: 'false',
    };

    return this.request('drafts.create', params);
  }

  // Get user info
  async getUserInfo(userId: string): Promise<any> {
    return this.request('users.info', { user: userId });
  }

  // Get multiple users info
  async getUsersInfo(userIds: string[]): Promise<any> {
    const users: any[] = [];

    for (const userId of userIds) {
      try {
        const response = await this.getUserInfo(userId);
        if (response.ok && response.user) {
          users.push(response.user);
        }
      } catch (error) {
        // Skip users we can't fetch
        console.error(`Failed to fetch user ${userId}`);
      }
    }

    return { ok: true, users };
  }

  // Open a conversation (DM)
  async openConversation(users: string): Promise<any> {
    return this.request('conversations.open', { users });
  }

  // Add reaction to message
  async addReaction(channel: string, timestamp: string, name: string): Promise<any> {
    return this.request('reactions.add', {
      channel,
      timestamp,
      name
    });
  }

  // Remove reaction from message
  async removeReaction(channel: string, timestamp: string, name: string): Promise<any> {
    return this.request('reactions.remove', {
      channel,
      timestamp,
      name
    });
  }

  // List saved items (browser: saved.list, standard: stars.list)
  async listSavedItems(options: {
    count?: number;
    cursor?: string;
  } = {}): Promise<any> {
    const params: Record<string, any> = {};
    if (options.count) params.count = options.count;
    if (options.cursor) params.cursor = options.cursor;

    if (this.config.auth_type === 'browser') {
      return this.request('saved.list', params);
    }
    return this.request('stars.list', params);
  }

  // Batch-fetch messages by channel + timestamp (browser auth only).
  // Groups are {channel, timestamps[]} — Slack returns full message objects
  // regardless of whether they're top-level or thread replies.
  async listMessages(messageIds: Array<{ channel: string; timestamps: string[] }>): Promise<any> {
    return this.request('messages.list', {
      message_ids: JSON.stringify(messageIds),
    });
  }

  // Search messages
  async searchMessages(query: string, options: {
    count?: number;
    page?: number;
    sort?: string;
    sort_dir?: string;
  } = {}): Promise<any> {
    const params: Record<string, any> = { query };
    if (options.count) params.count = options.count;
    if (options.page) params.page = options.page;
    if (options.sort) params.sort = options.sort;
    if (options.sort_dir) params.sort_dir = options.sort_dir;
    return this.request('search.messages', params);
  }

  // Search by module (browser: search.modules, standard: falls back to search.all)
  async searchModules(query: string, module: 'channels' | 'people', options: {
    count?: number;
    cursor?: string;
  } = {}): Promise<any> {
    if (this.config.auth_type === 'browser') {
      const params: Record<string, any> = {
        query,
        module,
        count: options.count || 20,
      };
      if (options.cursor) params.cursor = options.cursor;
      return this.request('search.modules', params);
    }

    // Standard auth: no search.modules available — fall back to
    // listing + client-side filtering (may be slow on large workspaces)
    if (module === 'channels') {
      return this.listConversations({
        types: 'public_channel,private_channel',
        limit: 1000,
        exclude_archived: true,
      });
    } else {
      return this.listUsers({ limit: 1000 });
    }
  }

  // List users
  async listUsers(options: {
    cursor?: string;
    limit?: number;
  } = {}): Promise<any> {
    const params: Record<string, any> = {};
    if (options.cursor) params.cursor = options.cursor;
    if (options.limit) params.limit = options.limit;
    return this.request('users.list', params);
  }

  // Get conversation info
  async getConversationInfo(channel: string): Promise<any> {
    return this.request('conversations.info', { channel });
  }

  // Get unread counts (browser: client.counts, standard: conversations.list with unread data)
  async getUnreadCounts(): Promise<any> {
    if (this.config.auth_type === 'browser') {
      return this.request('client.counts', {});
    }
    return this.listConversations({
      types: 'public_channel,private_channel,mpim,im',
      limit: 1000,
    });
  }

  // List canvas files
  async listCanvases(options: {
    limit?: number;
    channel?: string;
  } = {}): Promise<any> {
    const params: Record<string, any> = { types: 'canvas' };
    if (options.limit) params.count = options.limit;
    if (options.channel) params.channel = options.channel;
    return this.request('files.list', params);
  }

  // Get file info (used to get canvas download URL)
  async getFileInfo(fileId: string): Promise<any> {
    return this.request('files.info', { file: fileId });
  }

  // Download file content with auth, size guard, and auth page detection
  async downloadFile(url: string, maxBytes: number = 10 * 1024 * 1024): Promise<string> {
    const headers: Record<string, string> = {};

    if (this.config.auth_type === 'standard') {
      headers['Authorization'] = `Bearer ${this.config.token}`;
    } else if (this.config.auth_type === 'browser') {
      const encodedXoxdToken = encodeURIComponent(this.config.xoxd_token);
      headers['Cookie'] = `d=${encodedXoxdToken}`;
      headers['Origin'] = 'https://app.slack.com';
    }

    const response = await fetch(url, { headers });

    if (!response.ok) {
      throw new Error(`Download failed: HTTP ${response.status}`);
    }

    // Early exit when Content-Length is known and exceeds limit
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > maxBytes) {
      await response.body?.cancel();
      throw new Error(`File too large: ${contentLength} bytes (max ${maxBytes})`);
    }

    // Stream-based size guard (handles chunked transfer / missing Content-Length)
    const reader = response.body?.getReader();
    if (!reader) {
      return '';
    }

    const chunks: Uint8Array[] = [];
    let bytesRead = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel();
        throw new Error(`File too large: exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }

    const merged = new Uint8Array(bytesRead);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return new TextDecoder().decode(merged);
  }

  // Get canvas file ID associated with a channel or DM
  async getChannelCanvasId(channelId: string): Promise<string | null> {
    const response = await this.getConversationInfo(channelId);
    const props = response?.channel?.properties;
    if (!props) return null;

    // Standard channel canvas
    if (props.canvas?.file_id) return props.canvas.file_id;

    // DM / private conversation (stored as meeting_notes)
    if (props.meeting_notes?.file_id) return props.meeting_notes.file_id;

    // Fallback: check tabs for a canvas entry
    const canvasTab = props.tabs?.find((t: any) => t.type === 'canvas');
    if (canvasTab?.data?.file_id) return canvasTab.data.file_id;

    return null;
  }

  // Check auth type
  get authType(): string {
    return this.config.auth_type;
  }
}
