// Type definitions for SlackCLI

export type AuthType = 'standard' | 'browser';
export type TokenType = 'bot' | 'user';
export type ConversationType = 'public_channel' | 'private_channel' | 'mpim' | 'im';

// Workspace configuration interfaces
export interface StandardAuthConfig {
  workspace_id: string;
  workspace_name: string;
  auth_type: 'standard';
  token: string;
  token_type: TokenType;
}

export interface BrowserAuthConfig {
  workspace_id: string;
  workspace_name: string;
  workspace_url: string;
  auth_type: 'browser';
  xoxd_token: string;
  xoxc_token: string;
}

export type WorkspaceConfig = StandardAuthConfig | BrowserAuthConfig;

export interface WorkspacesData {
  default_workspace?: string;
  workspaces: Record<string, WorkspaceConfig>;
}

// Slack API response types
export interface SlackChannel {
  id: string;
  name?: string;
  is_channel?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_archived?: boolean;
  is_member?: boolean;
  num_members?: number;
  topic?: {
    value: string;
  };
  purpose?: {
    value: string;
  };
  user?: string; // For DMs
}

export interface SlackUser {
  id: string;
  name?: string;
  real_name?: string;
  profile?: {
    email?: string;
    display_name?: string;
    real_name?: string;
  };
}

// Video transcription types
export interface SlackTranscription {
  status: 'processing' | 'complete' | 'error' | 'none';
  locale?: string;
  preview?: {
    content: string;
    has_more: boolean;
  };
}

export interface SlackFile {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  subtype?: string;
  pretty_type?: string;
  mode?: string; // 'hosted', 'tombstone' (deleted), etc.
  url_private?: string;
  url_private_download?: string;
  mp4?: string; // Direct mp4 URL for videos
  vtt?: string;
  transcription?: SlackTranscription;
  // Additional fields from files.list API
  created?: number;
  timestamp?: number;
  size?: number;
  user?: string;
  channels?: string[];
  groups?: string[];
  ims?: string[];
  is_external?: boolean;
  is_public?: boolean;
}

export interface SlackMessage {
  type: string;
  user?: string;
  bot_id?: string;
  text: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
  files?: SlackFile[];
  transcript?: string;
  thread_replies?: SlackMessage[];
  reactions?: Array<{
    name: string;
    count: number;
    users: string[];
  }>;
}

export interface SlackAuthTestResponse {
  ok: boolean;
  url: string;
  team: string;
  user: string;
  team_id: string;
  user_id: string;
  bot_id?: string;
  is_enterprise_install?: boolean;
}

// CLI options interfaces
export interface ConversationListOptions {
  types?: string;
  limit?: number;
  excludeArchived?: boolean;
  workspace?: string;
}

export interface ConversationReadOptions {
  threadTs?: string;
  excludeReplies?: boolean;
  limit?: number;
  oldest?: string;
  latest?: string;
  workspace?: string;
  includeTranscripts?: boolean;
  includeThreads?: boolean;
}

export interface MessageSendOptions {
  recipientId: string;
  message: string;
  threadTs?: string;
  workspace?: string;
}

export interface AuthLoginOptions {
  token: string;
  workspaceName: string;
}

export interface AuthLoginBrowserOptions {
  xoxd: string;
  xoxc: string;
  workspaceUrl: string;
  workspaceName?: string;
}

// Search result types
export interface SlackSearchMatch {
  iid: string;
  team: string;
  channel: {
    id: string;
    name: string;
    is_private?: boolean;
    is_mpim?: boolean;
    is_im?: boolean;
  };
  type: string;
  user?: string;
  username?: string;
  ts: string;
  text: string;
  permalink: string;
}

export interface SlackSearchResult {
  total: number;
  pagination: {
    total_count: number;
    page: number;
    per_page: number;
    page_count: number;
    first: number;
    last: number;
  };
  paging: {
    count: number;
    total: number;
    page: number;
    pages: number;
  };
  matches: SlackSearchMatch[];
}

