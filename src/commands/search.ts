import { Command } from 'commander';
import ora from 'ora';
import { getAuthenticatedClient } from '../lib/auth.ts';
import {
  error,
  formatSearchMessages,
  formatChannelSearchResults,
  formatPeopleSearchResults,
  formatPaginationHint,
  writeJson,
} from '../lib/formatter.ts';
import { describeCommand } from '../lib/help.ts';
import type { ChannelSearchResult, PeopleSearchResult } from '../types/index.ts';
import { buildFieldLabelMap, resolveProfileFields } from '../lib/profile-fields.ts';

// Help text shared by several commands below.
const EMPTY_RESULT_NOTE =
  'No match prints nothing on stdout, even with --json (exit 0).';

export function createSearchCommand(): Command {
  const search = describeCommand(new Command('search'), {
    summary: 'Search messages, channels and people',
    description:
      'Search messages (Slack search operators supported), or find channels and people by name. ' +
      'Message search needs a user token (xoxp) or browser auth; channels and people work with ' +
      'any token but search differently by auth type.',
  });

  // Search messages
  describeCommand(search.command('messages'), {
    summary: 'Search messages with Slack search operators',
    description:
      'Search messages across the conversations you can see, one page at a time (Slack ' +
      'search.messages). Use "conversations read" instead to read one channel in order.',
    examples: [
      'slackcli search messages "deployment failed"',
      'slackcli search messages "release" --in engineering --from alice --sort score',
      'slackcli search messages "after:2026-07-01 has:link" --limit 50 --page 2 --json',
    ],
    json:
      '{ query, total, page, pages, matches: [...] } — matches are Slack\'s raw search results ' +
      '(ts, text, user, username, channel { id, name }, permalink, ...); query is the text as typed.',
    notes: [
      'Needs a user token (xoxp) or browser auth. A bot token (xoxb) fails: Slack allows ' +
        'search.messages for user tokens only.',
      'The query takes Slack operators (in:, from:, before:, after:, on:, during:, has:, is:, with:). ' +
        '--in and --from just append in:<channel> and from:<user> to it.',
      'Paged: when page < pages, rerun with --page <page + 1>. No match prints nothing on stdout, ' +
        'even with --json (exit 0).',
    ],
  })
    .argument('<query>', 'Search query (supports Slack search operators)')
    .option('--in <channel>', 'Filter by channel name (appends in:<channel> to the query)')
    .option('--from <user>', 'Filter by username (appends from:<user> to the query)')
    .option('--limit <number>', 'Number of results per page', '20')
    .option('--page <number>', 'Page number (1-based)', '1')
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
          count: Number.parseInt(options.limit),
          page: Number.parseInt(options.page),
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
          writeJson({
            query,
            total,
            page: pagination?.page || 1,
            pages: pagination?.page_count || 1,
            matches,
          });
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
  describeCommand(search.command('channels'), {
    summary: 'Find channels by name or keyword',
    description:
      'Find channels by name or keyword. Use "conversations list" to page through every ' +
      'conversation instead, or "search messages" to search message text.',
    examples: [
      'slackcli search channels platform',
      'slackcli search channels incident --limit 50 --json',
    ],
    json:
      '{ query, total, channels: [...] } — the matching channel objects (id, name, ...); the ' +
      'fields depend on the auth type.',
    notes: [
      'Browser auth: Slack\'s own search (search.modules), ranked by Slack; total is Slack\'s ' +
        'match count, which can exceed the channels returned.',
      'App token (xoxb/xoxp): no search API, so it lists up to 1000 non-archived channels the ' +
        'token can see in one call and keeps those whose name, topic or purpose contains the ' +
        'query (case-insensitive); total is the number returned.',
      EMPTY_RESULT_NOTE,
    ],
  })
    .argument('<query>', 'Channel name or keyword to search')
    .option('--limit <number>', 'Number of results', '20')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (query, options) => {
      const spinner = ora(`Searching channels for "${query}"...`).start();

      try {
        const client = await getAuthenticatedClient(options.workspace);
        const limit = Number.parseInt(options.limit);

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
          writeJson({ query, total, channels });
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
  describeCommand(search.command('people'), {
    summary: 'Find people by name, username or email',
    description:
      'Find people by name, username or email. Use "users info" when you already have the user ' +
      'ID, or "users list" to enumerate users by account status.',
    examples: [
      'slackcli search people alice',
      'slackcli search people "@acme.com" --limit 50',
      'slackcli search people alice --resolve-fields --json',
    ],
    json:
      '{ query, total, people: [...] } — the matching user objects (id, name, real_name, profile, ' +
      '...), each with resolved_fields { <label>: <value> } when --resolve-fields is set.',
    notes: [
      'Browser auth: Slack\'s own search (search.modules), ranked by Slack; total is Slack\'s ' +
        'match count, which can exceed the people returned.',
      'App token (xoxb/xoxp): no search API, so it lists the first 1000 users in one call, skips ' +
        'deactivated users and bots, and keeps those whose username, real name, display name or ' +
        'email contains the query (case-insensitive); total is the number returned.',
      EMPTY_RESULT_NOTE,
    ],
  })
    .argument('<query>', 'Name, username, or email to search')
    .option('--limit <number>', 'Number of results', '20')
    .option(
      '--resolve-fields',
      'Resolve custom profile-field IDs to their labels (labels only; ' +
        'user-typed values such as Manager stay as IDs)',
      false,
    )
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (query, options) => {
      const spinner = ora(`Searching people for "${query}"...`).start();

      try {
        const client = await getAuthenticatedClient(options.workspace);
        const limit = Number.parseInt(options.limit);

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

        // --resolve-fields labels each result's custom profile fields, using the
        // same shared resolver as `users info` / `users list`. Labels only; a
        // result carrying no profile.fields is passed through untouched.
        let resolvedByPerson: Array<Record<string, string>> | undefined;
        if (options.resolveFields) {
          const labels = await buildFieldLabelMap(client);
          resolvedByPerson = people.map((p: any) => resolveProfileFields(p, labels));
        }

        if (options.json) {
          const out = resolvedByPerson
            ? people.map((p: any, i: number) => ({ ...p, resolved_fields: resolvedByPerson![i] }))
            : people;
          writeJson({ query, total, people: out });
          return;
        }

        console.log('\n' + formatPeopleSearchResults(query, people, total));

        // Mirror `users info`/`users list`: when --resolve-fields is set, show the
        // labelled custom fields in text output too, not only in --json.
        if (resolvedByPerson) {
          people.forEach((p: any, i: number) => {
            const entries = Object.entries(resolvedByPerson![i]).filter(([, v]) => v);
            if (entries.length === 0) return;
            console.log(`  ${p.name || p.id} fields:`);
            for (const [label, value] of entries) console.log(`    ${label}: ${value}`);
          });
          console.log('');
        }
      } catch (err: any) {
        spinner.fail('Failed to search people');
        error(err.message);
        process.exit(1);
      }
    });

  return search;
}
