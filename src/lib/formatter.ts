import chalk from 'chalk';
import type {
  SlackCanvas, SlackChannel, SlackFile, SlackMessage, SlackUser, WorkspaceConfig,
  SavedItem, SearchMatch, ChannelSearchResult, PeopleSearchResult, UnreadChannel,
} from '../types/index.ts';

// Format timestamp to human-readable date
export function formatTimestamp(ts: string): string {
  const timestamp = parseFloat(ts) * 1000;
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
export function formatWorkspace(config: WorkspaceConfig, isDefault: boolean = false): string {
  const defaultBadge = isDefault ? chalk.green('(default)') : '';
  const authType = config.auth_type === 'browser' ? '🌐 Browser' : '🔑 Standard';

  return `${chalk.bold(config.workspace_name)} ${defaultBadge}
  ID: ${config.workspace_id}
  Auth: ${authType}`;
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
      output += `  ${idx + 1}. #${ch.name} ${chalk.dim(`(${ch.id})`)}${archived}\n`;
      if (ch.topic?.value) {
        output += `     ${chalk.dim(ch.topic.value)}\n`;
      }
    });
  }

  if (privateChannels.length > 0) {
    output += chalk.yellow('\nPrivate Channels:\n');
    privateChannels.forEach((ch, idx) => {
      const archived = ch.is_archived ? chalk.gray(' [archived]') : '';
      output += `  ${idx + 1}. 🔒 ${ch.name} ${chalk.dim(`(${ch.id})`)}${archived}\n`;
    });
  }

  if (groupMessages.length > 0) {
    output += chalk.magenta('\nGroup Messages:\n');
    groupMessages.forEach((ch, idx) => {
      output += `  ${idx + 1}. 👥 ${ch.name || 'Group'} ${chalk.dim(`(${ch.id})`)}\n`;
    });
  }

  if (directMessages.length > 0) {
    output += chalk.blue('\nDirect Messages:\n');
    directMessages.forEach((ch, idx) => {
      const user = ch.user ? users.get(ch.user) : null;
      const userName = user?.real_name || user?.name || 'Unknown User';
      output += `  ${idx + 1}. 👤 @${userName} ${chalk.dim(`(${ch.id})`)}\n`;
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

  let output = `${indentStr}${chalk.dim(`[${timestamp}]`)} ${chalk.bold(`@${userName}`)}${threadIndicator}\n`;

  // Message text
  const textLines = msg.text.split('\n');
  textLines.forEach(line => {
    output += `${indentStr}  ${line}\n`;
  });

  // Show timestamps for threading
  if (msg.ts) {
    output += `${indentStr}  ${chalk.dim(`ts: ${msg.ts}`)}`;
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
      const meta = parts.length > 0 ? ` ${chalk.dim(`(${parts.join(', ')})`)}` : '';

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
    output += `${indentStr}  ${chalk.cyan(`💬 ${msg.reply_count} replies`)}\n`;
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
  console.log(chalk.green('✅'), message);
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
  console.log(chalk.blue('ℹ️'), message);
}

// Warning message
export function warning(message: string): void {
  console.log(chalk.yellow('⚠️'), message);
}

// Format saved items list
export function formatSavedItems(items: SavedItem[], users: Map<string, SlackUser>): string {
  let output = chalk.bold(`📌 Saved Items (${items.length})\n\n`);

  items.forEach((item, idx) => {
    if (item.type === 'message' && item.message) {
      const msg = item.message;
      const user = msg.user ? users.get(msg.user) : null;
      const userName = user?.real_name || user?.name || msg.bot_id || 'Unknown';
      const timestamp = formatTimestamp(msg.ts);
      const channel = item.channel_name || item.channel_id;
      const text = truncateText(msg.text, 120);
      const state = item.todo_state ? chalk.dim(` [${item.todo_state}]`) : '';

      output += `  ${chalk.dim(`${idx + 1}.`)} ${chalk.bold(`@${userName}`)} in ${chalk.cyan(`#${channel}`)} ${chalk.dim(`[${timestamp}]`)}${state}\n`;
      output += `     ${text}\n`;
      output += `     ${chalk.dim(`channel: ${item.channel_id}  ts: ${msg.ts}`)}\n\n`;
    } else if (item.type === 'file' && item.file) {
      output += `  ${chalk.dim(`${idx + 1}.`)} ${chalk.yellow('File:')} ${chalk.bold(item.file.name || item.file.title || 'Untitled')}\n\n`;
    } else {
      output += `  ${chalk.dim(`${idx + 1}.`)} ${chalk.dim(`[${item.type}]`)}\n\n`;
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

    output += `  ${chalk.dim(`${idx + 1}.`)} ${chalk.bold(`@${userName}`)} in ${chalk.cyan(`#${channelName}`)} ${chalk.dim(`[${timestamp}]`)}\n`;
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
    output += `  ${chalk.dim(`${idx + 1}.`)} #${chalk.bold(ch.name)} ${chalk.dim(`(${ch.id})`)} ${members}${isMember}\n`;
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

    output += `  ${chalk.dim(`${idx + 1}.`)} ${chalk.bold(`@${displayName}`)} ${realName ? `(${realName})` : ''} ${chalk.dim(`(${user.id})`)} ${email}\n`;
    if (title) {
      output += `     ${title}\n`;
    }
    output += '\n';
  });

  return output;
}

// Format unread channels list
export function formatUnreadChannels(channels: UnreadChannel[]): string {
  if (channels.length === 0) {
    return chalk.green('All caught up! No unread messages.\n');
  }

  let output = chalk.bold(`💬 Unread Channels (${channels.length})\n\n`);

  channels.forEach((ch, idx) => {
    const prefix = ch.is_im ? '👤' : ch.is_mpim ? '👥' : ch.is_private ? '🔒' : '#';
    const name = ch.name || ch.id;
    const mentions = ch.mention_count > 0 ? chalk.red(` @${ch.mention_count}`) : '';
    const unreadCount = ch.unread_count ? chalk.yellow(` (${ch.unread_count} unread)`) : '';

    output += `  ${chalk.dim(`${idx + 1}.`)} ${prefix} ${chalk.bold(name)} ${chalk.dim(`(${ch.id})`)}${mentions}${unreadCount}\n`;
  });

  output += '\n';
  return output;
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

    output += `  ${chalk.dim(`${idx + 1}.`)} ${chalk.bold(title)} ${chalk.dim(`(${canvas.id})`)} ${size}\n`;
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
