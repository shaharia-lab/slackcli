import { Command } from 'commander';
import ora from 'ora';
import * as readline from 'readline';
import { getAuthenticatedClient } from '../lib/auth.ts';
import {
  error,
  formatUsergroup,
  formatUsergroupList,
  writeJson,
} from '../lib/formatter.ts';
import { isInteractiveTerminal } from '../lib/interactive-input.ts';
import {
  addUsergroupMembers,
  fetchUsergroupMembers,
  fetchUsergroups,
  normalizeUsergroups,
  removeUsergroupMembers,
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

// Split a comma/space-separated list of user IDs into a clean array.
export function parseUserIds(raw: string[]): string[] {
  return raw
    .flatMap((token) => token.split(/[\s,]+/))
    .map((s) => s.trim().replace(/^@/, ''))
    .filter(Boolean);
}

// Confirmation gate for a mutating command. Three cases, built on the existing
// isInteractiveTerminal():
//   --yes             -> proceed (explicit consent)
//   TTY,   no --yes   -> prompt y/N interactively
//   non-TTY, no --yes -> REFUSE with a clear message (never auto-pass, so a
//                        script cannot mutate a group unattended by accident)
// Returns true to proceed, false to abort. Every caller exits non-zero on false
// (both the non-TTY refusal and a TTY "no" decline the write and stop).
export async function confirmWrite(prompt: string, assumeYes: boolean): Promise<boolean> {
  if (assumeYes) return true;

  if (!isInteractiveTerminal()) {
    error(
      `Refusing to run this write unattended. stdin is not a terminal, so there is ` +
        `no way to confirm interactively. Re-run with --yes to proceed non-interactively.`,
    );
    return false;
  }

  return new Promise((resolve) => {
    // Prompt on stderr, not stdout: a `--json` command in an interactive
    // terminal still calls this, and writing the "[y/N]" prompt to stdout would
    // corrupt the JSON on the pipe.
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`${prompt} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

export function createUsergroupsCommand(): Command {
  const usergroups = new Command('usergroups')
    .description('List, read, and manage user groups (Slack "subteams")');

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

  // ─── create ──────────────────────────────────────────────────────────────
  usergroups
    .command('create')
    .description('Create a new user group')
    .argument('<name>', 'Display name for the group')
    .option('--handle <handle>', 'Mention handle (without @)')
    .option('--description <text>', 'Description of the group')
    .option('--channels <ids>', 'Comma-separated default channel IDs')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--team <workspace-id>', 'Target workspace T-id (required for writes on an enterprise org)')
    .option('--yes', 'Skip the confirmation prompt (required when stdin is not a TTY)', false)
    .option('--json', 'Output in JSON format', false)
    .action(async (name, options) => {
      if (!(await confirmWrite(`Create user group "${name}"?`, options.yes))) {
        process.exit(1);
      }
      const spinner = ora(`Creating user group "${name}"...`).start();
      try {
        const client = await getAuthenticatedClient(options.workspace);
        const response = await client.createUsergroup(name, {
          handle: options.handle,
          description: options.description,
          channels: options.channels,
          team_id: options.team,
        });
        const group = normalizeUsergroups([response.usergroup])[0];

        spinner.succeed(`Created ${group.name} (${group.id})`);

        if (options.json) {
          writeJson(group);
          return;
        }
        console.log('\n' + formatUsergroup(group, []));
      } catch (err: any) {
        spinner.fail('Failed to create user group');
        error(err.message);
        process.exit(1);
      }
    });

  // ─── update ──────────────────────────────────────────────────────────────
  usergroups
    .command('update')
    .description('Update a user group\'s name, handle, or description')
    .argument('<group>', 'Group ID, @handle, or exact name')
    .option('--name <name>', 'New display name')
    .option('--handle <handle>', 'New mention handle (without @)')
    .option('--description <text>', 'New description')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--team <workspace-id>', 'Target workspace T-id (required for writes on an enterprise org)')
    .option('--yes', 'Skip the confirmation prompt (required when stdin is not a TTY)', false)
    .option('--json', 'Output in JSON format', false)
    .action(async (ref, options) => {
      if (options.name === undefined && options.handle === undefined && options.description === undefined) {
        error('Nothing to update — pass at least one of --name, --handle, or --description.');
        process.exit(1);
      }
      if (!(await confirmWrite(`Update user group "${ref}"?`, options.yes))) {
        process.exit(1);
      }
      const spinner = ora('Updating user group...').start();
      try {
        const client = await getAuthenticatedClient(options.workspace);
        const group = await requireGroup(client, ref, spinner, options.team);

        spinner.text = 'Applying update...';
        const response = await client.updateUsergroup(group.id, {
          name: options.name,
          handle: options.handle,
          description: options.description,
          team_id: options.team,
        });
        const updated = normalizeUsergroups([response.usergroup])[0];

        spinner.succeed(`Updated ${updated.name} (${updated.id})`);

        if (options.json) {
          writeJson(updated);
          return;
        }
        console.log('\n' + formatUsergroup(updated, []));
      } catch (err: any) {
        spinner.fail('Failed to update user group');
        error(err.message);
        process.exit(1);
      }
    });

  // ─── add ─────────────────────────────────────────────────────────────────
  usergroups
    .command('add')
    .description('Add one or more users to a group')
    .argument('<group>', 'Group ID, @handle, or exact name')
    .argument('<users...>', 'One or more user IDs (comma- or space-separated)')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--team <workspace-id>', 'Target workspace T-id (required for writes on an enterprise org)')
    .option('--yes', 'Skip the confirmation prompt (required when stdin is not a TTY)', false)
    .option('--json', 'Output in JSON format', false)
    .action(async (ref, users, options) => {
      const ids = parseUserIds(users);
      if (!(await confirmWrite(`Add ${ids.length} user(s) to "${ref}"?`, options.yes))) {
        process.exit(1);
      }
      const spinner = ora('Adding members...').start();
      try {
        const client = await getAuthenticatedClient(options.workspace);
        const group = await requireGroup(client, ref, spinner, options.team);
        const result = await addUsergroupMembers(client, group.id, ids, {
          teamId: options.team,
          onProgress: (msg) => { spinner.text = msg; },
        });

        if (result.noop) {
          spinner.succeed(`No change — those users are already in ${group.name}`);
        } else {
          spinner.succeed(`Added ${result.added.length} to ${group.name} (now ${result.next.length} members)`);
        }

        if (options.json) {
          writeJson({ usergroup: group.id, ...result });
          return;
        }
      } catch (err: any) {
        spinner.fail('Failed to add members');
        error(err.message);
        process.exit(1);
      }
    });

  // ─── remove ──────────────────────────────────────────────────────────────
  usergroups
    .command('remove')
    .description('Remove one or more users from a group')
    .argument('<group>', 'Group ID, @handle, or exact name')
    .argument('<users...>', 'One or more user IDs (comma- or space-separated)')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--team <workspace-id>', 'Target workspace T-id (required for writes on an enterprise org)')
    .option('--yes', 'Skip the confirmation prompt (required when stdin is not a TTY)', false)
    .option('--json', 'Output in JSON format', false)
    .action(async (ref, users, options) => {
      const ids = parseUserIds(users);
      if (!(await confirmWrite(`Remove ${ids.length} user(s) from "${ref}"?`, options.yes))) {
        process.exit(1);
      }
      const spinner = ora('Removing members...').start();
      try {
        const client = await getAuthenticatedClient(options.workspace);
        const group = await requireGroup(client, ref, spinner, options.team);
        const result = await removeUsergroupMembers(client, group.id, ids, {
          teamId: options.team,
          onProgress: (msg) => { spinner.text = msg; },
        });

        if (result.noop) {
          spinner.succeed(`No change — those users are not in ${group.name}`);
        } else {
          spinner.succeed(`Removed ${result.removed.length} from ${group.name} (now ${result.next.length} members)`);
        }

        if (options.json) {
          writeJson({ usergroup: group.id, ...result });
          return;
        }
      } catch (err: any) {
        spinner.fail('Failed to remove members');
        error(err.message);
        process.exit(1);
      }
    });

  // ─── enable / disable ──────────────────────────────────────────────────────
  usergroups
    .command('enable')
    .description('Enable (restore) a disabled user group')
    .argument('<group>', 'Group ID, @handle, or exact name')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--team <workspace-id>', 'Target workspace T-id (required for writes on an enterprise org)')
    .option('--yes', 'Skip the confirmation prompt (required when stdin is not a TTY)', false)
    .option('--json', 'Output in JSON format', false)
    .action(async (ref, options) => {
      if (!(await confirmWrite(`Enable user group "${ref}"?`, options.yes))) {
        process.exit(1);
      }
      const spinner = ora('Enabling user group...').start();
      try {
        const client = await getAuthenticatedClient(options.workspace);
        const group = await requireGroup(client, ref, spinner, options.team);
        const response = await client.enableUsergroup(group.id, { team_id: options.team });
        const updated = normalizeUsergroups([response.usergroup])[0];

        spinner.succeed(`Enabled ${updated.name} (${updated.id})`);
        if (options.json) {
          writeJson(updated);
          return;
        }
      } catch (err: any) {
        spinner.fail('Failed to enable user group');
        error(err.message);
        process.exit(1);
      }
    });

  usergroups
    .command('disable')
    .description('Disable (archive) a user group')
    .argument('<group>', 'Group ID, @handle, or exact name')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--team <workspace-id>', 'Target workspace T-id (required for writes on an enterprise org)')
    .option('--yes', 'Skip the confirmation prompt (required when stdin is not a TTY)', false)
    .option('--json', 'Output in JSON format', false)
    .action(async (ref, options) => {
      if (!(await confirmWrite(`Disable user group "${ref}"?`, options.yes))) {
        process.exit(1);
      }
      const spinner = ora('Disabling user group...').start();
      try {
        const client = await getAuthenticatedClient(options.workspace);
        const group = await requireGroup(client, ref, spinner, options.team);
        const response = await client.disableUsergroup(group.id, { team_id: options.team });
        const updated = normalizeUsergroups([response.usergroup])[0];

        spinner.succeed(`Disabled ${updated.name} (${updated.id})`);
        if (options.json) {
          writeJson(updated);
          return;
        }
      } catch (err: any) {
        spinner.fail('Failed to disable user group');
        error(err.message);
        process.exit(1);
      }
    });

  return usergroups;
}
