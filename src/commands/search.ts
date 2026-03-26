import { Command } from 'commander';
import ora from 'ora';
import { getAuthenticatedClient } from '../lib/auth.ts';
import {
  error,
  formatSearchMessages,
  formatChannelSearchResults,
  formatPeopleSearchResults,
  formatPaginationHint,
} from '../lib/formatter.ts';
import type { ChannelSearchResult, PeopleSearchResult } from '../types/index.ts';

export function createSearchCommand(): Command {
  const search = new Command('search')
    .description('Search messages, channels, and people');

  // Search messages
  search
    .command('messages')
    .description('Search for messages')
    .argument('<query>', 'Search query (supports Slack search operators)')
    .option('--in <channel>', 'Filter by channel name')
    .option('--from <user>', 'Filter by username')
    .option('--limit <number>', 'Number of results', '20')
    .option('--page <number>', 'Page number', '1')
    .option('--sort <field>', 'Sort by: score or timestamp', 'timestamp')
    .option('--sort-dir <dir>', 'Sort direction: asc or desc', 'desc')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (query, options) => {
      // Append Slack search modifiers to query
      let fullQuery = query;
      if (options.in) fullQuery += ` in:${options.in}`;
      if (options.from) fullQuery += ` from:${options.from}`;

      const spinner = ora(`Searching for "${fullQuery}"...`).start();

      try {
        const client = await getAuthenticatedClient(options.workspace);

        const response = await client.searchMessages(fullQuery, {
          count: parseInt(options.limit),
          page: parseInt(options.page),
          sort: options.sort,
          sort_dir: options.sortDir,
        });

        const matches = response.messages?.matches || [];
        const total = response.messages?.total || 0;

        if (matches.length === 0) {
          spinner.succeed('No messages found');
          return;
        }

        spinner.succeed(`Found ${total} messages (showing ${matches.length})`);

        if (options.json) {
          const pagination = response.messages?.pagination;
          console.log(JSON.stringify({
            query,
            total,
            page: pagination?.page || 1,
            pages: pagination?.page_count || 1,
            matches,
          }, null, 2));
          return;
        }

        console.log('\n' + formatSearchMessages(query, matches, total));

        const pagination = response.messages?.pagination;
        if (pagination) {
          console.log(formatPaginationHint(pagination.page, pagination.page_count));
        }
      } catch (err: any) {
        spinner.fail('Failed to search messages');
        error(err.message);
        process.exit(1);
      }
    });

  // Search channels
  search
    .command('channels')
    .description('Search for channels by name')
    .argument('<query>', 'Channel name or keyword to search')
    .option('--limit <number>', 'Number of results', '20')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (query, options) => {
      const spinner = ora(`Searching channels for "${query}"...`).start();

      try {
        const client = await getAuthenticatedClient(options.workspace);
        const limit = parseInt(options.limit);

        const response = await client.searchModules(query, 'channels', { count: limit });

        let channels: ChannelSearchResult[];
        let total: number;

        if (response.items) {
          // search.modules response (browser auth)
          channels = response.items;
          total = response.pagination?.total_count || channels.length;
        } else {
          // conversations.list fallback (standard auth) — filter client-side
          const q = query.toLowerCase();
          channels = (response.channels || [])
            .filter((ch: any) =>
              ch.name?.toLowerCase().includes(q) ||
              ch.topic?.value?.toLowerCase().includes(q) ||
              ch.purpose?.value?.toLowerCase().includes(q)
            )
            .slice(0, limit);
          total = channels.length;
        }

        if (channels.length === 0) {
          spinner.succeed('No channels found');
          return;
        }

        spinner.succeed(`Found ${total} matching channels (showing ${channels.length})`);

        if (options.json) {
          console.log(JSON.stringify({ query, total, channels }, null, 2));
          return;
        }

        console.log('\n' + formatChannelSearchResults(query, channels, total));
      } catch (err: any) {
        spinner.fail('Failed to search channels');
        error(err.message);
        process.exit(1);
      }
    });

  // Search people
  search
    .command('people')
    .description('Search for people by name or email')
    .argument('<query>', 'Name, username, or email to search')
    .option('--limit <number>', 'Number of results', '20')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (query, options) => {
      const spinner = ora(`Searching people for "${query}"...`).start();

      try {
        const client = await getAuthenticatedClient(options.workspace);
        const limit = parseInt(options.limit);

        const response = await client.searchModules(query, 'people', { count: limit });

        let people: PeopleSearchResult[];
        let total: number;

        if (response.items) {
          // search.modules response (browser auth)
          people = response.items;
          total = response.pagination?.total_count || people.length;
        } else {
          // users.list fallback (standard auth) — filter client-side
          const q = query.toLowerCase();
          people = (response.members || [])
            .filter((user: any) => {
              if (user.deleted || user.is_bot) return false;
              return (
                user.name?.toLowerCase().includes(q) ||
                user.real_name?.toLowerCase().includes(q) ||
                user.profile?.display_name?.toLowerCase().includes(q) ||
                user.profile?.email?.toLowerCase().includes(q)
              );
            })
            .slice(0, limit);
          total = people.length;
        }

        if (people.length === 0) {
          spinner.succeed('No people found');
          return;
        }

        spinner.succeed(`Found ${total} matching people (showing ${people.length})`);

        if (options.json) {
          console.log(JSON.stringify({ query, total, people }, null, 2));
          return;
        }

        console.log('\n' + formatPeopleSearchResults(query, people, total));
      } catch (err: any) {
        spinner.fail('Failed to search people');
        error(err.message);
        process.exit(1);
      }
    });

  return search;
}
