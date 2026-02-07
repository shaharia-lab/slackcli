import { WebClient } from '@slack/web-api';
import type { WorkspaceConfig, SlackAuthTestResponse, FileUploadUrlResponse, FileUploadCompleteResponse } from '../types/index.ts';

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

  // Get presigned upload URL (step 1 of 3-step upload)
  async getUploadUrl(filename: string, length: number): Promise<FileUploadUrlResponse> {
    return this.request('files.getUploadURLExternal', {
      filename,
      length: String(length),
    });
  }

  // Upload file content to presigned URL (step 2 of 3-step upload)
  // This is a direct POST to an external URL — no Slack auth needed
  async uploadToUrl(uploadUrl: string, fileContent: Uint8Array, filename: string): Promise<void> {
    const formData = new FormData();
    formData.append('file', new Blob([fileContent]), filename);

    const response = await fetch(uploadUrl, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`File upload failed: HTTP ${response.status}`);
    }
  }

  // Complete upload and share to channel/thread (step 3 of 3-step upload)
  async completeUpload(files: Array<{ id: string; title?: string }>, options: {
    channel_id?: string;
    thread_ts?: string;
    initial_comment?: string;
  } = {}): Promise<FileUploadCompleteResponse> {
    const params: Record<string, any> = {
      files: JSON.stringify(files),
    };
    if (options.channel_id) params.channel_id = options.channel_id;
    if (options.thread_ts) params.thread_ts = options.thread_ts;
    if (options.initial_comment) params.initial_comment = options.initial_comment;

    return this.request('files.completeUploadExternal', params);
  }

  // Upload one or more files end-to-end, bundled into a single message
  async uploadFiles(filePaths: string[], options: {
    channel_id?: string;
    thread_ts?: string;
    titles?: string[];
    initial_comment?: string;
    onProgress?: (step: string) => void;
  } = {}): Promise<FileUploadCompleteResponse> {
    const fileEntries: Array<{ id: string; title?: string }> = [];

    for (let i = 0; i < filePaths.length; i++) {
      const filePath = filePaths[i];
      const file = Bun.file(filePath);
      const fileContent = new Uint8Array(await file.arrayBuffer());
      const filename = filePath.split('/').pop() || 'file';
      const length = fileContent.byteLength;

      options.onProgress?.(`Uploading file ${i + 1}/${filePaths.length}: ${filename}`);
      const { upload_url, file_id } = await this.getUploadUrl(filename, length);
      await this.uploadToUrl(upload_url, fileContent, filename);

      const entry: { id: string; title?: string } = { id: file_id };
      if (options.titles?.[i]) entry.title = options.titles[i];
      fileEntries.push(entry);
    }

    options.onProgress?.('Finalizing upload...');
    return this.completeUpload(fileEntries, {
      channel_id: options.channel_id,
      thread_ts: options.thread_ts,
      initial_comment: options.initial_comment,
    });
  }
}

