import { Command } from 'commander';
import ora from 'ora';
import { getAuthenticatedClient } from '../lib/auth.ts';
import {
  error,
  formatUsergroup,
  formatUsergroupList,
  writeJson,
} from '../lib/formatter.ts';
import {
  fetchUsergroupMembers,
  fetchUsergroups,
  resolveUsergroup,
} from '../lib/usergroups.ts';
import type { SlackUsergroup } from '../types/index.ts';

// Resolve a <group> argument (id / @handle / name) to a group, or fail the
// spinner and exit. Shared by every subcommand that takes a group reference.
async function requireGroup(
  client: any,
  ref: string,
  spinner: ReturnType<typeof ora>,
  teamId?: string,
): Promise<SlackUsergroup> {
  spinner.text = 'Resolving user group...';
  const group = await resolveUsergroup(client, ref, {
    teamId,
    onProgress: (msg) => { spinner.text = msg; },
  });
  if (!group) {
    spinner.fail(`No user group matching "${ref}" (try an ID, @handle, or exact name)`);
    process.exit(1);
  }
  return group;
}

export function createUsergroupsCommand(): Command {
  const usergroups = new Command('usergroups')
    .description('List and read user groups (Slack "subteams")');

  // ─── list ────────────────────────────────────────────────────────────────
  usergroups
    .command('list')
    .description('List the workspace\'s user groups')
    .option('--include-disabled', 'Include disabled (archived) groups', false)
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--team <workspace-id>', 'Target workspace T-id (enterprise org scoping)')
    .option('--json', 'Output in JSON format', false)
    .action(async (options) => {
      const spinner = ora('Fetching user groups...').start();
      try {
        const client = await getAuthenticatedClient(options.workspace);
        const groups = await fetchUsergroups(client, {
          includeDisabled: options.includeDisabled,
          teamId: options.team,
          onProgress: (msg) => { spinner.text = msg; },
        });

        spinner.succeed(`Found ${groups.length} user group${groups.length === 1 ? '' : 's'}`);

        if (options.json) {
          writeJson({ usergroup_count: groups.length, usergroups: groups });
          return;
        }
        console.log('\n' + formatUsergroupList(groups));
      } catch (err: any) {
        spinner.fail('Failed to fetch user groups');
        error(err.message);
        process.exit(1);
      }
    });

  // ─── read ────────────────────────────────────────────────────────────────
  usergroups
    .command('read')
    .description('Show a user group and its members')
    .argument('<group>', 'Group ID, @handle, or exact name')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--team <workspace-id>', 'Target workspace T-id (enterprise org scoping)')
    .option('--json', 'Output in JSON format', false)
    .action(async (ref, options) => {
      const spinner = ora('Fetching user group...').start();
      try {
        const client = await getAuthenticatedClient(options.workspace);
        const group = await requireGroup(client, ref, spinner, options.team);
        const { ids, members } = await fetchUsergroupMembers(client, group.id, {
          teamId: options.team,
          onProgress: (msg) => { spinner.text = msg; },
        });

        spinner.succeed(`${group.name} — ${members.length} member${members.length === 1 ? '' : 's'}`);

        if (options.json) {
          writeJson({ ...group, member_ids: ids, members });
          return;
        }
        console.log('\n' + formatUsergroup(group, members));
      } catch (err: any) {
        spinner.fail('Failed to read user group');
        error(err.message);
        process.exit(1);
      }
    });

  return usergroups;
}
