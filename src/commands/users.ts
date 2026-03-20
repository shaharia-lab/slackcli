import chalk from 'chalk';
import { Command } from 'commander';
import ora from 'ora';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { error } from '../lib/formatter.ts';

interface SlackUserInfo {
  id: string;
  name: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_app_user?: boolean;
  profile?: {
    display_name?: string;
    real_name?: string;
    email?: string;
  };
}

function formatUserRow(user: SlackUserInfo, index: number): string {
  const displayName = user.profile?.display_name || user.real_name || user.name;
  const username = user.name;
  const email = user.profile?.email ? chalk.dim(` <${user.profile.email}>`) : '';
  const bot = user.is_bot || user.is_app_user ? chalk.yellow(' [bot]') : '';
  const deleted = user.deleted ? chalk.red(' [deactivated]') : '';

  return `  ${index + 1}. ${chalk.bold(displayName)} ${chalk.dim(`(@${username})`)} ${chalk.dim(`(${user.id})`)}${email}${bot}${deleted}`;
}

export function createUsersCommand(): Command {
  const users = new Command('users')
    .description('List and find workspace users');

  users
    .command('list')
    .description('List all users in the workspace')
    .option('--limit <number>', 'Number of users per page (max 200)', '200')
    .option('--cursor <cursor>', 'Pagination cursor for next page of results')
    .option('--include-bots', 'Include bot users', false)
    .option('--workspace <id|name>', 'Workspace to use (overrides default)')
    .option('--json', 'Output in JSON format', false)
    .action(async (options) => {
      const spinner = ora('Fetching users...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);

        const response = await client.listUsers({
          limit: parseInt(options.limit),
          cursor: options.cursor,
        });

        let members: SlackUserInfo[] = response.members || [];

        if (!options.includeBots) {
          members = members.filter(u => !u.is_bot && !u.is_app_user);
        }

        spinner.succeed(`Found ${members.length} users`);

        if (options.json) {
          console.log(JSON.stringify({
            count: members.length,
            users: members.map(u => ({
              id: u.id,
              username: u.name,
              display_name: u.profile?.display_name || u.real_name || u.name,
              real_name: u.real_name,
              email: u.profile?.email,
              is_bot: u.is_bot || u.is_app_user || false,
              deleted: u.deleted || false,
            })),
          }, null, 2));
        } else {
          console.log('');
          members.forEach((user, idx) => {
            console.log(formatUserRow(user, idx));
          });
        }

        const nextCursor = response.response_metadata?.next_cursor;
        if (nextCursor) {
          console.log(chalk.dim('\nMore results available. Next page:'));
          console.log(chalk.cyan(`  slackcli users list --cursor "${nextCursor}"\n`));
        }
      } catch (err: any) {
        spinner.fail('Failed to list users');
        error(err.message);
        process.exit(1);
      }
    });

  users
    .command('find')
    .description('Find a user by name (searches display name, real name, and username)')
    .argument('<name>', 'Name to search for (partial match, case-insensitive)')
    .option('--include-bots', 'Include bot users', false)
    .option('--workspace <id|name>', 'Workspace to use (overrides default)')
    .option('--json', 'Output in JSON format', false)
    .action(async (name: string, options) => {
      const spinner = ora(`Searching for "${name}"...`).start();

      try {
        const client = await getAuthenticatedClient(options.workspace);
        const needle = name.toLowerCase();
        const matched: SlackUserInfo[] = [];
        let cursor: string | undefined;

        // Paginate through all users to find matches
        do {
          const response = await client.listUsers({
            limit: 200,
            cursor,
          });

          const members: SlackUserInfo[] = response.members || [];

          for (const user of members) {
            if (!options.includeBots && (user.is_bot || user.is_app_user)) continue;
            if (user.deleted) continue;

            const displayName = (user.profile?.display_name || '').toLowerCase();
            const realName = (user.real_name || '').toLowerCase();
            const username = (user.name || '').toLowerCase();

            if (displayName.includes(needle) || realName.includes(needle) || username.includes(needle)) {
              matched.push(user);
            }
          }

          cursor = response.response_metadata?.next_cursor || undefined;
        } while (cursor);

        spinner.succeed(`Found ${matched.length} user${matched.length !== 1 ? 's' : ''} matching "${name}"`);

        if (matched.length === 0) {
          console.log(chalk.dim('\nNo users found.'));
          return;
        }

        if (options.json) {
          console.log(JSON.stringify({
            query: name,
            count: matched.length,
            users: matched.map(u => ({
              id: u.id,
              username: u.name,
              display_name: u.profile?.display_name || u.real_name || u.name,
              real_name: u.real_name,
              email: u.profile?.email,
            })),
          }, null, 2));
        } else {
          console.log('');
          matched.forEach((user, idx) => {
            console.log(formatUserRow(user, idx));
          });
          console.log('');
          console.log(chalk.dim('Use the user ID with search: ') + chalk.cyan(`slackcli search messages --query "from:<@USER_ID>"`));
        }
      } catch (err: any) {
        spinner.fail('Failed to find user');
        error(err.message);
        process.exit(1);
      }
    });

  return users;
}
