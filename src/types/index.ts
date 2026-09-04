// Type definitions for SlackCLI

export type AuthType = 'standard' | 'browser';
export type TokenType = 'bot' | 'user';
export type ConversationType = 'public_channel' | 'private_channel' | 'mpim' | 'im';

// Workspace configuration interfaces
export interface StandardAuthConfig {
  workspace_id: string;
  workspace_name: string;
  // Unique, user-selected profile name for this record. Optional and additive:
  // legacy records without it are keyed by workspace_id and keep working.
  profile?: string;
  // Authenticated user/bot id (from auth.test). Distinguishes a token refresh of
  // the same identity from a genuinely new identity within the same team.
  user_id?: string;
  auth_type: 'standard';
  token: string;
  token_type: TokenType;
}

export interface BrowserAuthConfig {
  workspace_id: string;
  workspace_name: string;
  workspace_url: string;
  profile?: string;
  user_id?: string;
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

export interface SlackFile {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  created?: number;
  timestamp?: number;
  user?: string;
  pretty_type?: string;
  is_public?: boolean;
  public_url_shared?: boolean;
  plain_text?: string;
  simplified_html?: string;
  url_private?: string;
  url_private_download?: string;
  permalink?: string;
  mode?: string;
}

export interface SlackMessage {
  type: string;
  user?: string;
  bot_id?: string;
  text: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
  reactions?: Array<{
    name: string;
    count: number;
    users: string[];
  }>;
  blocks?: Array<Record<string, unknown>>;
  attachments?: Array<Record<string, unknown>>;
  files?: SlackFile[];
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
}

export interface MessageSendOptions {
  recipientId: string;
  message: string;
  threadTs?: string;
  file?: string;
  workspace?: string;
}

export interface MessageDraftOptions {
  recipientId: string;
  message: string;
  threadTs?: string;
  workspace?: string;
}

export interface AuthLoginOptions {
  token: string;
  workspaceName: string;
  profile?: string;
}

export interface AuthLoginBrowserOptions {
  xoxd: string;
  xoxc: string;
  workspaceUrl: string;
  workspaceName?: string;
  profile?: string;
}

// Saved items
export interface SavedItem {
  type: 'message' | 'file' | string;
  channel_id: string;
  channel_name?: string;
  message?: SlackMessage;
  date_saved?: number;
  todo_state?: string;
  file?: {
    name?: string;
    title?: string;
    url_private?: string;
  };
}

// Search results
export interface SearchMatch {
  ts: string;
  text: string;
  username?: string;
  user?: string;
  permalink?: string;
  channel?: {
    id: string;
    name: string;
  };
}

export interface ChannelSearchResult {
  id: string;
  name: string;
  is_member?: boolean;
  is_private?: boolean;
  member_count?: number;
  num_members?: number;
  purpose?: {
    value: string;
  };
  topic?: {
    value: string;
  };
}

export interface PeopleSearchResult {
  id: string;
  name?: string;
  real_name?: string;
  profile?: {
    display_name?: string;
    real_name?: string;
    email?: string;
    title?: string;
  };
}

// Unread channel info
export interface UnreadChannel {
  id: string;
  name?: string;
  mention_count: number;
  unread_count?: number;
  has_unreads: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
}

// Canvas types
export interface SlackCanvas {
  id: string;
  title?: string;
  name?: string;
  created?: number;
  updated?: number;
  edit_timestamp?: number;
  user?: string;
  editors?: string[];
  size?: number;
  filetype?: string;
  url_private?: string;
  url_private_download?: string;
  permalink?: string;
}

export interface CanvasListOptions {
  channel?: string;
  limit?: number;
  workspace?: string;
}

export interface CanvasReadOptions {
  channel?: string;
  raw?: boolean;
  workspace?: string;
}

// Team (workspace) info — from team.info. Only the fields worth surfacing at
// the CLI; the raw response carries many more.
export interface SlackTeam {
  id: string;
  name: string;
  domain?: string;
  email_domain?: string;
  url?: string;
  is_verified?: boolean;
  icon?: Record<string, unknown>;
}

export interface TeamInfoOptions {
  workspace?: string;
}

// User Group ("subteam") — Slack's own name for a named group of users.
// Modeled on the usergroups.list shape (include_count + include_disabled).
export interface SlackUsergroup {
  id: string;
  team_id?: string;
  name: string;
  handle?: string;
  description?: string;
  is_external?: boolean;
  is_usergroup?: boolean;
  is_subteam?: boolean;
  // Unix seconds; date_delete === 0 means the group is enabled/active.
  date_create?: number;
  date_update?: number;
  date_delete?: number;
  created_by?: string;
  user_count?: number;
  channel_count?: number;
  // Present when the group's membership is returned inline (include_users).
  users?: string[];
}

// A resolved member of a user group: the id plus best-effort name resolution.
export interface UsergroupMember {
  id: string;
  name?: string;
  real_name?: string;
  display_name?: string;
  is_bot?: boolean;
  deleted?: boolean;
}

export interface UsergroupListOptions {
  includeDisabled?: boolean;
  team?: string;
  workspace?: string;
}

export interface UsergroupReadOptions {
  team?: string;
  workspace?: string;
}

export interface UsergroupCreateOptions {
  handle?: string;
  description?: string;
  channels?: string;
  team?: string;
  workspace?: string;
}

export interface UsergroupUpdateOptions {
  name?: string;
  handle?: string;
  description?: string;
  team?: string;
  workspace?: string;
}

export interface UsergroupMembersOptions {
  team?: string;
  workspace?: string;
}

// Custom (workspace) emoji
export interface CustomEmoji {
  // Emoji short name without the surrounding colons (e.g. `party-parrot`).
  name: string;
  // A real emoji points at an image URL; an alias points at another emoji's
  // name. `is_alias` disambiguates, and `alias_for` names the target when true.
  url?: string;
  is_alias: boolean;
  alias_for?: string;
}

export interface EmojiListOptions {
  limit?: number;
  aliases?: boolean;
  workspace?: string;
}

export interface EmojiGetOptions {
  workspace?: string;
}
