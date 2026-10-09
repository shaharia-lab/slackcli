import chalk from 'chalk';
import type {
  SlackCanvas, SlackChannel, SlackMessage, SlackUser, WorkspaceConfig,
  SavedItem, SearchMatch, ChannelSearchResult, PeopleSearchResult, UnreadChannel, UnreadThread, UnreadThreads,
  SlackTeam, SlackUsergroup, UsergroupMember,
  CustomEmoji, DraftSummary, IdentityResult, ProfileCheck,
  DryRunPreview, DryRunTarget,
} from '../types/index.ts';
import { isUsergroupEnabled } from './usergroups.ts';

// Serialise a value as JSON and write it to stdout.
//
// Deliberately process.stdout.write rather than console.log: ora reads
// process.stdout.isTTY at import time (via cli-cursor -> restore-cursor),
// which materialises Bun's Node-compat WriteStream. Once that exists,
// console.log routes through the async stream path, and output past the
// 64 KiB pipe buffer is dropped when the process exits, silently producing
// truncated JSON with exit code 0 (issue #73).
//
// process.stdout.write shares that async pipe path; it is not synchronous.
// It completes only because callers return and let the process exit
// naturally, which drains pending writes. So: never call process.exit()
// after writeJson() — doing so truncates at 64 KiB and reintroduces #73.
// Set process.exitCode and return instead.
export function writeJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

// Write a formatted text result to stdout, with a trailing newline (so callers
// pass the body exactly as they did to console.log).
//
// This is the text-path twin of writeJson, and exists for the same reason:
// console.log routes through Bun's async Node-compat WriteStream, which drops
// everything past the 64 KiB pipe buffer when the process exits before the
// stream drains — silently truncating a large result into a slow reader with
// exit code 0 (issue #373; the JSON path is #73). process.stdout.write shares
// that async path but completes because callers return and let the process exit
// naturally, which drains pending writes. So the same rule applies: never call
// process.exit() after writeText() — set process.exitCode and return instead.
//
// Every command result print goes through this one sink rather than
// console.log, both to fix the truncation and to keep it fixed: a guard test
// fails the build if a command file calls console.log directly.
export function writeText(text: string): void {
  process.stdout.write(text + '\n');
}

function formatDraftAge(createdAt: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor(nowMs / 1000 - createdAt));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatDraftList(drafts: DraftSummary[], nowMs: number = Date.now()): string {
  let output = chalk.bold(`📝 Active Drafts (${drafts.length})\n\n`);

  drafts.forEach((draft, index) => {
    const age = formatDraftAge(draft.date_created, nowMs);
    const preview = truncateText(draft.text.replace(/\s+/g, ' ').trim(), 120);
    const metadata = [`draft: ${draft.draft_id}`];
    if (draft.thread_ts) metadata.push(`thread: ${draft.thread_ts}`);
    if (draft.file_ids.length > 0) metadata.push(`files: ${draft.file_ids.length}`);
    if (draft.date_scheduled) {
      metadata.push(`scheduled: ${formatTimestamp(String(draft.date_scheduled))}`);
    }

    const position = chalk.dim(`${index + 1}.`);
    const ageLabel = chalk.dim(`(${age})`);
    output += `  ${position} ${chalk.bold(draft.channel_id)} ${ageLabel}\n`;
    output += `     ${preview}\n`;
    output += `     ${chalk.dim(metadata.join(' | '))}\n\n`;
  });

  return output;
}

// Format timestamp to human-readable date
export function formatTimestamp(ts: string): string {
  const timestamp = Number.parseFloat(ts) * 1000;
  const date = new Date(timestamp);
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

// Format workspace info
// One profile's `auth list --check` outcome, as the indented lines that follow
// its stored details. A refusal by Slack also gets the command that fixes it.
function profileCheckLines(check: ProfileCheck): string {
  switch (check.status) {
    case 'ok': {
      const botId = check.bot_id ? `, bot ${check.bot_id}` : '';
      return `\n  Status: ${chalk.green('ok')} (${check.user}, ${check.user_id}${botId})`;
    }
    case 'auth_failed':
      return 'code' in check.error
        ? `\n  Status: ${chalk.red('auth failed')} (${check.error.code}: ${check.error.meaning})` +
          `\n  To fix: ${check.error.fix}`
        : `\n  Status: ${chalk.red('auth failed')} (${check.error.message})`;
    case 'unreachable':
      return `\n  Status: ${chalk.yellow('unreachable')} (${check.error.message})`;
  }
}

// `check` is the `auth list --check` outcome; without it the output is exactly
// what plain `auth list` has always printed.
export function formatWorkspace(
  config: WorkspaceConfig,
  isDefault: boolean = false,
  profileKey?: string,
  check?: ProfileCheck,
): string {
  const defaultBadge = isDefault ? chalk.green('(default)') : '';
  const authType = config.auth_type === 'browser' ? '🌐 Browser' : '🔑 Standard';

  // Only surface the profile line when it adds information beyond the ID (i.e. a
  // named or auto-generated key), keeping single-identity output unchanged.
  const profileLine = profileKey && profileKey !== config.workspace_id
    ? `\n  Profile: ${chalk.cyan(profileKey)}`
    : '';

  // Only surface storage when it isn't the default, same rule as the profile
  // line — an all-file setup (still nearly everyone's) prints exactly as before.
  const secretLine = config.secret_backend && config.secret_backend !== 'file'
    ? `\n  Secrets: ${chalk.cyan(config.secret_backend)}`
    : '';

  const checkLines = check ? profileCheckLines(check) : '';

  return `${chalk.bold(config.workspace_name)} ${defaultBadge}
  ID: ${config.workspace_id}${profileLine}
  Auth: ${authType}${secretLine}${checkLines}`;
}

const SELECTION_SOURCE_LABELS: Record<IdentityResult['source'], string> = {
  flag: '--workspace flag',
  env: 'SLACKCLI_WORKSPACE',
  default: 'stored default',
};

function identityStatusLine(identity: IdentityResult): string {
  switch (identity.status) {
    case 'ok':
      return chalk.green('verified');
    case 'auth_failed':
      return chalk.red(`authentication failed (${identity.error.code})`);
    case 'unreachable':
      return chalk.red('unreachable');
  }
}

// Format the `auth whoami` result. The profile line is always printed here,
// unlike in formatWorkspace(): which profile is active is the question asked.
export function formatIdentity(identity: IdentityResult): string {
  const authType = identity.auth_type === 'browser' ? '🌐 Browser' : '🔑 Standard';
  const lines = [
    chalk.bold(identity.workspace_name),
    `  ID: ${identity.workspace_id}`,
    `  Profile: ${chalk.cyan(identity.profile)}`,
  ];

  if (identity.status === 'ok') {
    const botId = identity.bot_id ? `, bot ${identity.bot_id}` : '';
    lines.push(`  User: ${chalk.cyan(identity.user)} (${identity.user_id}${botId})`);
  } else if (identity.user_id) {
    // Not confirmed by Slack on this run, so say where the value comes from.
    lines.push(`  User: ${identity.user_id} ${chalk.dim('(stored at login)')}`);
  }

  lines.push(
    `  Auth: ${authType}`,
    `  Selected by: ${SELECTION_SOURCE_LABELS[identity.source]}`,
    `  Status: ${identityStatusLine(identity)}`,
  );
  return lines.join('\n');
}

// Format channel list
export function formatChannelList(channels: SlackChannel[], users: Map<string, SlackUser>): string {
  const publicChannels: SlackChannel[] = [];
  const privateChannels: SlackChannel[] = [];
  const directMessages: SlackChannel[] = [];
  const groupMessages: SlackChannel[] = [];

  channels.forEach(channel => {
    if (channel.is_im) {
      directMessages.push(channel);
    } else if (channel.is_mpim) {
      groupMessages.push(channel);
    } else if (channel.is_private) {
      privateChannels.push(channel);
    } else {
      publicChannels.push(channel);
    }
  });

  let output = chalk.bold(`📋 Conversations (${channels.length})\n`);

  if (publicChannels.length > 0) {
    output += chalk.cyan('\nPublic Channels:\n');
    publicChannels.forEach((ch, idx) => {
      const archived = ch.is_archived ? chalk.gray(' [archived]') : '';
      const id = chalk.dim(`(${ch.id})`);
      output += `  ${idx + 1}. #${ch.name} ${id}${archived}\n`;
      if (ch.topic?.value) {
        output += `     ${chalk.dim(ch.topic.value)}\n`;
      }
    });
  }

  if (privateChannels.length > 0) {
    output += chalk.yellow('\nPrivate Channels:\n');
    privateChannels.forEach((ch, idx) => {
      const archived = ch.is_archived ? chalk.gray(' [archived]') : '';
      const id = chalk.dim(`(${ch.id})`);
      output += `  ${idx + 1}. 🔒 ${ch.name} ${id}${archived}\n`;
    });
  }

  if (groupMessages.length > 0) {
    output += chalk.magenta('\nGroup Messages:\n');
    groupMessages.forEach((ch, idx) => {
      const id = chalk.dim(`(${ch.id})`);
      output += `  ${idx + 1}. 👥 ${ch.name || 'Group'} ${id}\n`;
    });
  }

  if (directMessages.length > 0) {
    output += chalk.blue('\nDirect Messages:\n');
    directMessages.forEach((ch, idx) => {
      const user = ch.user ? users.get(ch.user) : null;
      const userName = user?.real_name || user?.name || 'Unknown User';
      const id = chalk.dim(`(${ch.id})`);
      output += `  ${idx + 1}. 👤 @${userName} ${id}\n`;
    });
  }

  return output;
}

// Format message with reactions
export function formatMessage(
  msg: SlackMessage,
  users: Map<string, SlackUser>,
  indent: number = 0
): string {
  const indentStr = ' '.repeat(indent);
  const user = msg.user ? users.get(msg.user) : null;
  const userName = user?.real_name || user?.name || msg.bot_id || 'Unknown';
  const timestamp = formatTimestamp(msg.ts);
  const isThread = msg.thread_ts && msg.thread_ts !== msg.ts;
  const threadIndicator = isThread ? chalk.dim(' (in thread)') : '';

  const when = chalk.dim(`[${timestamp}]`);
  const author = chalk.bold(`@${userName}`);
  let output = `${indentStr}${when} ${author}${threadIndicator}\n`;

  // Message text
  const textLines = msg.text.split('\n');
  textLines.forEach(line => {
    output += `${indentStr}  ${line}\n`;
  });

  // Show timestamps for threading
  if (msg.ts) {
    const tsLine = chalk.dim(`ts: ${msg.ts}`);
    output += `${indentStr}  ${tsLine}`;
    if (msg.thread_ts && msg.thread_ts !== msg.ts) {
      output += chalk.dim(` | thread_ts: ${msg.thread_ts}`);
    }
    output += '\n';
  }

  // Files
  if (msg.files && msg.files.length > 0) {
    msg.files.forEach(file => {
      if (file.mode === 'tombstone') {
        output += `${indentStr}  ${chalk.yellow('📎')} ${chalk.dim('(deleted file)')}\n`;
        return;
      }

      const name = file.name || '(unnamed file)';
      const parts: string[] = [];
      if (file.size !== undefined) parts.push(formatFileSize(file.size));
      if (file.mimetype) parts.push(file.mimetype);
      const meta = parts.length > 0 ? ' ' + chalk.dim(`(${parts.join(', ')})`) : '';

      output += `${indentStr}  ${chalk.yellow('📎')} ${chalk.yellow(name)}${meta}\n`;

      const url = file.url_private || file.permalink;
      if (url) {
        output += `${indentStr}     ${chalk.dim(url)}\n`;
      }
    });
  }

  // Reactions
  if (msg.reactions && msg.reactions.length > 0) {
    const reactionsStr = msg.reactions
      .map(r => `${r.name} ${r.count}`)
      .join('  ');
    output += `${indentStr}  ${chalk.dim(reactionsStr)}\n`;
  }

  // Thread indicator
  if (msg.reply_count && !isThread) {
    const replies = chalk.cyan(`💬 ${msg.reply_count} replies`);
    output += `${indentStr}  ${replies}\n`;
  }

  return output;
}

// Format conversation history
export function formatConversationHistory(
  channelName: string,
  messages: SlackMessage[],
  users: Map<string, SlackUser>
): string {
  let output = chalk.bold(`💬 #${channelName} (${messages.length} messages)\n\n`);

  messages.forEach((msg, idx) => {
    output += formatMessage(msg, users);
    if (idx < messages.length - 1) {
      output += '\n';
    }
  });

  return output;
}

// Success message
export function success(message: string): void {
  writeText(`${chalk.green('✅')} ${message}`);
}

// Error message
export function error(message: string, hint?: string): void {
  console.error(chalk.red('❌ Error:'), message);
  if (hint) {
    console.error(chalk.dim(`   ${hint}`));
  }
}

// Info message
export function info(message: string): void {
  writeText(`${chalk.blue('ℹ️')} ${message}`);
}

// Warning message. Written to stderr so diagnostics never contaminate stdout —
// with --json, stdout must carry exactly one parseable object (see writeJson).
export function warning(message: string): void {
  console.error(chalk.yellow('⚠️'), message);
}

// Format saved items list
export function formatSavedItems(items: SavedItem[], users: Map<string, SlackUser>): string {
  let output = chalk.bold(`📌 Saved Items (${items.length})\n\n`);

  items.forEach((item, idx) => {
    const position = chalk.dim(`${idx + 1}.`);
    if (item.type === 'message' && item.message) {
      const msg = item.message;
      const user = msg.user ? users.get(msg.user) : null;
      const userName = user?.real_name || user?.name || msg.bot_id || 'Unknown';
      const timestamp = formatTimestamp(msg.ts);
      const channel = item.channel_name || item.channel_id;
      const text = truncateText(msg.text, 120);
      const state = item.todo_state ? chalk.dim(` [${item.todo_state}]`) : '';
      const author = chalk.bold(`@${userName}`);
      const channelTag = chalk.cyan(`#${channel}`);
      const when = chalk.dim(`[${timestamp}]`);
      const location = chalk.dim(`channel: ${item.channel_id}  ts: ${msg.ts}`);

      output += `  ${position} ${author} in ${channelTag} ${when}${state}\n`;
      output += `     ${text}\n`;
      output += `     ${location}\n\n`;
    } else if (item.type === 'file' && item.file) {
      output += `  ${position} ${chalk.yellow('File:')} ${chalk.bold(item.file.name || item.file.title || 'Untitled')}\n\n`;
    } else {
      const itemType = chalk.dim(`[${item.type}]`);
      output += `  ${position} ${itemType}\n\n`;
    }
  });

  return output;
}

// Format search message results
export function formatSearchMessages(
  query: string,
  matches: SearchMatch[],
  total: number,
): string {
  let output = chalk.bold(`🔍 Search Results for "${query}" (${total} total)\n\n`);

  matches.forEach((match, idx) => {
    const userName = match.username || match.user || 'Unknown';
    const timestamp = formatTimestamp(match.ts);
    const channelName = match.channel?.name || match.channel?.id || 'unknown';
    const text = truncateText(match.text, 150);
    const permalink = match.permalink || '';
    const position = chalk.dim(`${idx + 1}.`);
    const author = chalk.bold(`@${userName}`);
    const channelTag = chalk.cyan(`#${channelName}`);
    const when = chalk.dim(`[${timestamp}]`);

    output += `  ${position} ${author} in ${channelTag} ${when}\n`;
    output += `     ${text}\n`;
    if (permalink) {
      output += `     ${chalk.dim(permalink)}\n`;
    }
    output += '\n';
  });

  return output;
}

// Format channel search results
export function formatChannelSearchResults(
  query: string,
  channels: ChannelSearchResult[],
  total: number,
): string {
  let output = chalk.bold(`📋 Channels matching "${query}" (${total} total)\n\n`);

  channels.forEach((ch, idx) => {
    const memberCount = ch.member_count || ch.num_members;
    const members = memberCount ? chalk.dim(`${memberCount} members`) : '';
    const isMember = ch.is_member ? chalk.green(' [joined]') : '';
    const position = chalk.dim(`${idx + 1}.`);
    const id = chalk.dim(`(${ch.id})`);
    output += `  ${position} #${chalk.bold(ch.name)} ${id} ${members}${isMember}\n`;
    if (ch.purpose?.value) {
      output += `     ${chalk.dim(ch.purpose.value)}\n`;
    }
    output += '\n';
  });

  return output;
}

// Format people search results
export function formatPeopleSearchResults(
  query: string,
  people: PeopleSearchResult[],
  total: number,
): string {
  let output = chalk.bold(`👥 People matching "${query}" (${total} total)\n\n`);

  people.forEach((user, idx) => {
    const profile = user.profile || {};
    const displayName = profile.display_name || user.name || '';
    const realName = profile.real_name || user.real_name || '';
    const email = profile.email ? chalk.dim(`<${profile.email}>`) : '';
    const title = profile.title ? chalk.dim(`- ${profile.title}`) : '';
    const position = chalk.dim(`${idx + 1}.`);
    const handle = chalk.bold(`@${displayName}`);
    const realNamePart = realName ? `(${realName})` : '';
    const id = chalk.dim(`(${user.id})`);

    output += `  ${position} ${handle} ${realNamePart} ${id} ${email}\n`;
    if (title) {
      output += `     ${title}\n`;
    }
    output += '\n';
  });

  return output;
}

// Pick the conversation-type glyph; precedence is DM, group DM, private, public
function channelPrefix(ch: UnreadChannel): string {
  if (ch.is_im) return '👤';
  if (ch.is_mpim) return '👥';
  if (ch.is_private) return '🔒';
  return '#';
}

// Format unread channels list
export function formatUnreadChannels(channels: UnreadChannel[]): string {
  if (channels.length === 0) {
    return chalk.green('All caught up! No unread messages.\n');
  }

  let output = chalk.bold(`💬 Unread Channels (${channels.length})\n\n`);

  channels.forEach((ch, idx) => {
    output += unreadChannelLine(ch, idx);
  });

  output += '\n';
  return output;
}

// One row of the unread list: position, type glyph, name, ID and counts
function unreadChannelLine(ch: UnreadChannel, idx: number): string {
  const prefix = channelPrefix(ch);
  const name = ch.name || ch.id;
  const mentions = ch.mention_count > 0 ? chalk.red(` @${ch.mention_count}`) : '';
  const unreadCount = ch.unread_count ? chalk.yellow(` (${ch.unread_count} unread)`) : '';
  const position = chalk.dim(`${idx + 1}.`);
  const id = chalk.dim(`(${ch.id})`);

  return `  ${position} ${prefix} ${chalk.bold(name)} ${id}${mentions}${unreadCount}\n`;
}

const UNREAD_MESSAGE_INDENT = 5;

// Format the unread list of `conversations unread --messages`: the same rows as
// formatUnreadChannels, each followed by the messages that were read for it
export function formatUnreadMessages(channels: UnreadChannel[], users: Map<string, SlackUser>): string {
  const pad = ' '.repeat(UNREAD_MESSAGE_INDENT);
  let output = chalk.bold(`💬 Unread Channels (${channels.length})\n\n`);
  let notRead = 0;

  channels.forEach((ch, idx) => {
    output += unreadChannelLine(ch, idx);
    if (!ch.messages) {
      notRead += 1;
      return;
    }
    if (ch.messages.length === 0) {
      output += `${pad}${chalk.dim('(no new top-level messages)')}\n`;
    }
    ch.messages.forEach((msg) => {
      output += formatMessage(msg, users, UNREAD_MESSAGE_INDENT) + '\n';
    });
    if (ch.has_more) {
      output += `${pad}${chalk.dim('… more messages not shown; raise --limit')}\n\n`;
    }
  });

  if (notRead > 0) {
    const noun = notRead === 1 ? 'conversation' : 'conversations';
    output += '\n' + chalk.dim(`  ${notRead} ${noun} not read; raise --max-conversations to include them.`) + '\n';
  }

  output += '\n';
  return output;
}

// Format the followed threads with unread replies (`conversations unread
// --messages`): the root message, then its unread replies indented under it.
// `channelNames` maps a channel ID to its name where one is already known.
export function formatUnreadThreadItems(
  threads: UnreadThread[],
  users: Map<string, SlackUser>,
  channelNames: Map<string, string> = new Map(),
  incomplete = false,
): string {
  const pad = ' '.repeat(UNREAD_MESSAGE_INDENT);
  let output = chalk.bold(`🧵 Unread Threads (${threads.length})\n\n`);

  threads.forEach((thread, idx) => {
    const position = chalk.dim(`${idx + 1}.`);
    const where = channelNames.get(thread.channel_id) ?? thread.channel_id;
    const ids = chalk.dim(`(${thread.channel_id}, thread ${thread.thread_ts})`);
    output += `  ${position} ${chalk.bold(where)} ${ids}\n`;
    output += formatMessage(thread.root, users, UNREAD_MESSAGE_INDENT) + '\n';
    thread.unread_replies.forEach((reply) => {
      output += formatMessage(reply, users, UNREAD_MESSAGE_INDENT + 4) + '\n';
    });
    if (thread.has_more) {
      output += `${pad}    ${chalk.dim('… more replies not shown; raise --limit')}\n\n`;
    }
  });

  if (incomplete) {
    output += chalk.dim('  More threads have unread replies than are listed here.') + '\n\n';
  }
  return output;
}

// Format the workspace-wide unread thread summary (browser auth only)
export function formatUnreadThreads(threads: UnreadThreads): string {
  const parts: string[] = [];
  if (threads.has_unreads) parts.push(chalk.yellow('unread replies'));
  if (threads.mention_count > 0) {
    const noun = threads.mention_count === 1 ? 'mention' : 'mentions';
    parts.push(chalk.red(`${threads.mention_count} ${noun}`));
  }
  const summary = parts.length > 0 ? parts.join(', ') : chalk.dim('nothing unread');
  return `${chalk.bold('🧵 Threads:')} ${summary}\n`;
}

// Format pagination hint
export function formatPaginationHint(page: number, totalPages: number): string {
  if (page < totalPages) {
    return chalk.dim(`  Page ${page} of ${totalPages}. Use --page ${page + 1} to see more.\n`);
  }
  return '';
}

// Format canvas list
export function formatCanvasList(canvases: SlackCanvas[]): string {
  let output = chalk.bold(`📄 Canvases (${canvases.length})\n\n`);

  canvases.forEach((canvas, idx) => {
    const title = canvas.title || canvas.name || 'Untitled';
    const created = canvas.created ? formatTimestamp(String(canvas.created)) : '';
    const size = canvas.size ? chalk.dim(`${Math.round(canvas.size / 1024)}KB`) : '';
    const position = chalk.dim(`${idx + 1}.`);
    const id = chalk.dim(`(${canvas.id})`);

    output += `  ${position} ${chalk.bold(title)} ${id} ${size}\n`;
    if (created) {
      output += `     ${chalk.dim(created)}\n`;
    }
    if (canvas.permalink) {
      output += `     ${chalk.dim(canvas.permalink)}\n`;
    }
    output += '\n';
  });

  return output;
}

// Format canvas content for display
export function formatCanvasContent(canvas: SlackCanvas, markdown: string): string {
  const title = canvas.title || canvas.name || 'Untitled';
  const created = canvas.created ? formatTimestamp(String(canvas.created)) : '';

  let header = chalk.bold(`📄 ${title}`) + chalk.dim(` (${canvas.id})`);
  if (created) {
    header += chalk.dim(` | ${created}`);
  }

  return `${header}\n${chalk.dim('─'.repeat(60))}\n\n${markdown}`;
}

// Format file size to human-readable string
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const index = Math.min(i, units.length - 1);
  if (index === 0) return `${bytes} B`;
  return `${(bytes / Math.pow(k, index)).toFixed(1)} ${units[index]}`;
}

// Truncate text with ellipsis
function truncateText(text: string | undefined, maxLen: number): string {
  if (!text) return '[no text]';
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen) + '...';
}

// ─── Team (workspace) & user groups ───────────────────────────────────────

// Format team (workspace) info
export function formatTeamInfo(team: SlackTeam): string {
  let output = chalk.bold(`🏢 ${team.name}\n\n`);
  output += `  ${chalk.dim('ID:')}     ${team.id}\n`;
  if (team.domain) output += `  ${chalk.dim('Domain:')} ${team.domain}.slack.com\n`;
  if (team.email_domain) output += `  ${chalk.dim('Email:')}  @${team.email_domain}\n`;
  if (team.url) output += `  ${chalk.dim('URL:')}    ${team.url}\n`;
  if (team.is_verified) output += `  ${chalk.green('✓ Verified')}\n`;
  return output;
}

// Format a list of user groups
export function formatUsergroupList(groups: SlackUsergroup[]): string {
  if (groups.length === 0) {
    return chalk.dim('No user groups found.\n');
  }

  let output = chalk.bold(`👥 User Groups (${groups.length})\n\n`);

  groups.forEach((g, idx) => {
    const handle = g.handle ? chalk.cyan(`@${g.handle}`) : chalk.dim('(no handle)');
    const count = typeof g.user_count === 'number' ? chalk.dim(`${g.user_count} members`) : '';
    const disabled = isUsergroupEnabled(g) ? '' : chalk.yellow(' [disabled]');
    const position = chalk.dim(`${idx + 1}.`);
    const id = chalk.dim(`(${g.id})`);
    output += `  ${position} ${chalk.bold(g.name)} ${handle} ${id} ${count}${disabled}\n`;
    if (g.description) {
      output += `     ${chalk.dim(g.description)}\n`;
    }
    output += '\n';
  });

  return output;
}

// Format a custom-emoji list for the terminal.
export function formatEmojiList(emoji: CustomEmoji[]): string {
  const aliasCount = emoji.filter(e => e.is_alias).length;
  const realCount = emoji.length - aliasCount;

  let output = chalk.bold(
    `😀 Custom emoji (${emoji.length} — ${realCount} original, ${aliasCount} alias)\n\n`,
  );

  emoji.forEach((e) => {
    const name = chalk.cyan(`:${e.name}:`);
    if (e.is_alias) {
      const target = chalk.dim(`→ :${e.alias_for}:`);
      output += `  ${name} ${target}\n`;
    } else {
      const url = e.url ? ' ' + chalk.dim(e.url) : '';
      output += `  ${name}${url}\n`;
    }
  });

  return output;
}

// Format a single user group with its resolved members
export function formatUsergroup(group: SlackUsergroup, members: UsergroupMember[]): string {
  const handle = group.handle ? chalk.cyan(`@${group.handle}`) : chalk.dim('(no handle)');
  const disabled = isUsergroupEnabled(group) ? chalk.green(' [enabled]') : chalk.yellow(' [disabled]');

  let output = chalk.bold(`👥 ${group.name}`) + ` ${handle}${disabled}\n\n`;
  output += `  ${chalk.dim('ID:')}      ${group.id}\n`;
  if (group.description) output += `  ${chalk.dim('About:')}   ${group.description}\n`;
  output += `  ${chalk.dim('Members:')} ${members.length}\n`;

  if (members.length > 0) {
    output += '\n';
    members.forEach((m, idx) => {
      const display = m.display_name || m.name || m.id;
      const real = m.real_name && m.real_name !== display ? ` (${m.real_name})` : '';
      const bot = m.is_bot ? chalk.dim(' [bot]') : '';
      const gone = m.deleted ? chalk.dim(' [deactivated]') : '';
      const position = chalk.dim(`${idx + 1}.`);
      const handle = chalk.bold(`@${display}`);
      const id = chalk.dim(`(${m.id})`);
      output += `  ${position} ${handle}${chalk.dim(real)} ${id}${bot}${gone}\n`;
    });
  }

  return output;
}

// Format a single custom emoji's details.
export function formatEmoji(emoji: CustomEmoji): string {
  let output = chalk.bold(`😀 :${emoji.name}:\n`);
  if (emoji.is_alias) {
    output += `  ${chalk.dim('Type:')} alias\n`;
    output += `  ${chalk.dim('Alias for:')} :${emoji.alias_for}:\n`;
  } else {
    output += `  ${chalk.dim('Type:')} original\n`;
    if (emoji.url) {
      output += `  ${chalk.dim('URL:')} ${emoji.url}\n`;
    }
  }
  return output;
}

// A dry-run preview as text (#328): fixed header lines, then one labelled line
// per payload field. Multi-line text keeps its line breaks, indented under the
// label, so what is shown is exactly what would be sent.
export function formatDryRun(preview: DryRunPreview): string {
  const rows: Array<[string, string]> = [
    ['Workspace', `${preview.workspace.name} (${preview.workspace.profile})`],
    ['Action', preview.action],
    ['Target', formatDryRunTarget(preview.target)],
  ];
  if (preview.target.thread_ts) rows.push(['Thread', preview.target.thread_ts]);
  for (const [key, value] of Object.entries(preview.payload)) {
    rows.push([dryRunLabel(key), formatDryRunValue(value)]);
  }

  const width = Math.max(...rows.map(([label]) => label.length)) + 1;
  const indent = ' '.repeat(2 + width + 1);
  const continuation = `\n${indent}`;
  const lines = rows.map(([label, value]) => {
    const cell = `${label}:`.padEnd(width);
    const body = value.split('\n').join(continuation);
    return `  ${cell} ${body}`;
  });
  return [chalk.bold('Dry run: nothing was sent.'), ...lines].join('\n');
}

function formatDryRunTarget(target: DryRunTarget): string {
  let text = target.id ?? '(new)';
  if (target.name) text = target.id ? `${text} (${target.name})` : target.name;
  if (target.kind === 'user') text += ', direct message';
  if (target.kind === 'draft') text = `draft ${text}`;
  if (target.ts) text += `, message ${target.ts}`;
  return text;
}

function dryRunLabel(key: string): string {
  const words = key.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function formatDryRunValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value.length > 0 ? value.join(', ') : '(none)';
  }
  return JSON.stringify(value);
}
