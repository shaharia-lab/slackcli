import { Command } from 'commander';
import ora from 'ora';
import * as readline from 'node:readline';
import { getAuthenticatedClient } from '../lib/auth.ts';
import {
  formatUsergroup,
  formatUsergroupList,
  writeJson,
} from '../lib/formatter.ts';
import { describeCommand, USER_NAME_NOTE, type CommandHelp } from '../lib/help.ts';
import { isInteractiveTerminal } from '../lib/interactive-input.ts';
import { ConfirmationRequiredError, InvalidInputError, NotFoundError } from '../lib/cli-errors.ts';
import { failCommand } from '../lib/command-errors.ts';
import {
  addUsergroupMembers,
  fetchUsergroupMembers,
  fetchUsergroups,
  normalizeUsergroups,
  removeUsergroupMembers,
  resolveUsergroup,
} from '../lib/usergroups.ts';
import { lazyClient, resolveUserList } from '../lib/name-resolver.ts';
import type { SlackClient } from '../lib/slack-client.ts';
import type { SlackUsergroup } from '../types/index.ts';

// Help text shared by several commands below.
const GROUP_SHAPE =
  '{ id, team_id, name, handle, description, date_create, date_update, date_delete, created_by, user_count, channel_count, users, ... }';
const TEAM_WRITE_NOTE =
  '--team (a T... ID) is needed only on Enterprise Grid: name the member workspace that owns the group, or Slack rejects the write (target_team_must_be_specified_in_org_context).';
const TEAM_READ_NOTE =
  '--team (a T... ID) is only for Enterprise Grid: it scopes the lookup to one member workspace. Leave it out on a single workspace.';
const GROUP_REF_NOTE =
  '<group> is the group ID (S0123456789), its @handle (with or without @) or its exact name (case-insensitive). Slack URLs are not accepted.';
const USER_IDS_NOTE =
  '<users...> are user IDs (U0123456789), @handles or email addresses, space- or comma-separated; a leading @ on an ID is dropped.';

// --help content, kept apart from the command chains below (#324).
const HELP = {
  group: {
    summary: 'List, read and manage user groups',
    description:
      'List, read and manage user groups (Slack "subteams", the mentionable @groups of people). ' +
      'Every write asks for confirmation first. Works with both auth types; writes need the ' +
      'usergroups:write scope on an app token.',
  },
  list: {
    summary: 'List the workspace\'s user groups',
    description:
      'List the workspace\'s user groups, sorted by name, with handle, member count and ' +
      'enabled/disabled state. Use "usergroups read" for one group and its members.',
    examples: [
      'slackcli usergroups list',
      'slackcli usergroups list --include-disabled --json',
      'slackcli usergroups list --team T0123456789 --json',
    ],
    json:
      '{ usergroup_count, usergroups: [{ id, team_id, name, handle, description, date_create, ' +
      'date_update, date_delete, created_by, user_count, channel_count, ... }] } — date_delete 0 means enabled.',
    notes: [
      'Disabled (archived) groups are left out unless --include-disabled is set.',
      TEAM_READ_NOTE,
    ],
  },
  read: {
    summary: 'Show a user group and its members',
    description:
      'Show one user group and its members, with each member ID resolved to a name. Use ' +
      '"usergroups list" to find the group first.',
    examples: [
      'slackcli usergroups read @platform',
      'slackcli usergroups read "Platform Team"',
      'slackcli usergroups read S0123456789 --team T0123456789 --json',
    ],
    json:
      '{ id, name, handle, description, user_count, ..., member_ids: [...], members: [{ id, name, ' +
      'real_name, display_name, is_bot, deleted }] } — the group plus its members (only id and name for an S... ID the list does not return).',
    notes: [
      GROUP_REF_NOTE,
      'No group matches: exits 1. An S... ID is used as given, even when the list does not show it.',
      TEAM_READ_NOTE,
    ],
  },
  create: {
    summary: 'Create a new user group',
    description: 'Create a user group with a display name and, optionally, a handle, description and default channels.',
    examples: [
      'slackcli usergroups create "Platform Team" --handle platform --yes',
      'slackcli usergroups create "Platform Team" --handle platform --description "Owns the platform" --channels C0123456789 --yes --json',
      'slackcli usergroups create "Platform Team" --team T0123456789 --yes',
    ],
    json: `${GROUP_SHAPE} — the group as created.`,
    confirms: true,
    notes: [
      '--channels takes channel IDs (C0123456789), comma-separated. Add members afterwards with "usergroups add".',
      TEAM_WRITE_NOTE,
    ],
  },
  update: {
    summary: 'Change a group\'s name, handle or description',
    description:
      'Change a user group\'s name, handle and/or description. Pass at least one of --name, ' +
      '--handle or --description; with none it exits 1 before asking anything. Members: use "usergroups add" / "remove".',
    examples: [
      'slackcli usergroups update @platform --description "Owns platform and infra" --yes',
      'slackcli usergroups update S0123456789 --name "Platform" --handle platform-team --yes --json',
    ],
    json: `${GROUP_SHAPE} — the group after the change.`,
    confirms: true,
    notes: [
      GROUP_REF_NOTE,
      TEAM_WRITE_NOTE,
    ],
  },
  add: {
    summary: 'Add one or more users to a group',
    description:
      'Add users to a user group. Reads the current members, adds yours and writes the full list ' +
      'back (Slack only replaces whole member lists), so existing members are kept.',
    examples: [
      'slackcli usergroups add @platform U0123456789 --yes',
      'slackcli usergroups add S0123456789 U0123456789,U0123456780 --yes --json',
    ],
    json:
      '{ usergroup, added, removed, next, noop } — group ID, IDs added, IDs removed (empty), ' +
      'the member list after the write, and noop true when nothing changed.',
    confirms: true,
    notes: [
      GROUP_REF_NOTE,
      USER_IDS_NOTE,
      USER_NAME_NOTE,
      'Users already in the group change nothing: reported as a no-op, no write.',
      TEAM_WRITE_NOTE,
    ],
  },
  remove: {
    summary: 'Remove one or more users from a group',
    description:
      'Remove users from a user group. Reads the current members, drops yours and writes the ' +
      'rest back, so other members are kept. To retire a whole group, use "usergroups disable".',
    examples: [
      'slackcli usergroups remove @platform U0123456789 --yes',
      'slackcli usergroups remove S0123456789 U0123456789 U0123456780 --yes --json',
    ],
    json:
      '{ usergroup, added, removed, next, noop } — group ID, IDs added (empty), IDs removed, ' +
      'the member list after the write, and noop true when nothing changed.',
    confirms: true,
    notes: [
      GROUP_REF_NOTE,
      USER_IDS_NOTE,
      USER_NAME_NOTE,
      'Refuses (exit 1) to remove the last member: Slack does not allow an empty group.',
      TEAM_WRITE_NOTE,
    ],
  },
  enable: {
    summary: 'Enable (restore) a disabled user group',
    description: 'Enable a disabled user group, so it can be mentioned again. The reverse of "usergroups disable".',
    examples: [
      'slackcli usergroups enable @platform --yes',
      'slackcli usergroups enable S0123456789 --yes --json',
    ],
    json: `${GROUP_SHAPE} — the group after the change.`,
    confirms: true,
    notes: [
      GROUP_REF_NOTE,
      TEAM_WRITE_NOTE,
    ],
  },
  disable: {
    summary: 'Disable (archive) a user group',
    description:
      'Disable (archive) a user group: it can no longer be mentioned. Slack has no hard delete; ' +
      '"usergroups enable" restores it.',
    examples: [
      'slackcli usergroups disable @platform --yes',
      'slackcli usergroups disable S0123456789 --yes --json',
    ],
    json: `${GROUP_SHAPE} — the group after the change.`,
    confirms: true,
    notes: [
      GROUP_REF_NOTE,
      'A disabled group still resolves by handle or name, and shows in "usergroups list --include-disabled".',
      TEAM_WRITE_NOTE,
    ],
  },
} satisfies Record<string, CommandHelp>;

// Resolve a <group> argument (id / @handle / name) to a group, or report the
// failure and return undefined, so the caller returns. Shared by every
// subcommand that takes a group reference.
async function requireGroup(
  client: any,
  ref: string,
  spinner: ReturnType<typeof ora>,
  options: { team?: string; json?: boolean },
): Promise<SlackUsergroup | undefined> {
  spinner.text = 'Resolving user group...';
  const group = await resolveUsergroup(client, ref, {
    teamId: options.team,
    onProgress: (msg) => { spinner.text = msg; },
  });
  if (!group) {
    failCommand(new NotFoundError(`No user group matching "${ref}" (try an ID, @handle, or exact name)`), {
      json: options.json,
      spinner,
    });
    return undefined;
  }
  return group;
}

// Split a comma/space-separated list of user references (IDs, @handles,
// emails) into a clean array, keeping each one as typed. A bare "@" is dropped.
export function splitUserRefs(raw: string[]): string[] {
  return raw
    .flatMap((token) => token.split(/[\s,]+/))
    .map((s) => s.trim())
    .filter((s) => s.replace(/^@/, ''));
}

// Resolve <users...> to IDs before a membership write's confirmation prompt.
// A client is created only when a handle or email needs a lookup, so a list of
// IDs keeps the no-auth confirmation refusal it always had. On failure it
// reports the error and returns undefined, so the caller just returns.
async function memberIdsOrFail(
  users: string[],
  options: { workspace?: string; json?: boolean },
  context: string,
): Promise<{ ids: string[]; client?: SlackClient } | undefined> {
  try {
    const client = lazyClient(() => getAuthenticatedClient(options.workspace));
    const ids = await resolveUserList(client.get, splitUserRefs(users), '<users...>');
    return { ids, client: client.created() };
  } catch (err: any) {
    failCommand(err, { json: options.json, context });
    return undefined;
  }
}

// Confirmation gate for a mutating command. Three cases, built on the existing
// isInteractiveTerminal():
//   --yes             -> proceed (explicit consent)
//   TTY,   no --yes   -> prompt y/N interactively
//   non-TTY, no --yes -> REFUSE with a clear message (never auto-pass, so a
//                        script cannot mutate a group unattended by accident)
// Returns true to proceed, false to abort. On false it has already reported the
// refusal (as a `confirmation_required` object under --json) and set exit code
// 1, so every caller just returns.
export async function confirmWrite(prompt: string, assumeYes: boolean, json = false): Promise<boolean> {
  if (assumeYes) return true;

  if (!isInteractiveTerminal()) {
    failCommand(
      new ConfirmationRequiredError(
        `Refusing to run this write unattended. stdin is not a terminal, so there is ` +
          `no way to confirm interactively. Re-run with --yes to proceed non-interactively.`,
        'Re-run with --yes to confirm the write.',
      ),
      { json },
    );
    return false;
  }

  const confirmed = await new Promise<boolean>((resolve) => {
    // Prompt on stderr, not stdout: a `--json` command in an interactive
    // terminal still calls this, and writing the "[y/N]" prompt to stdout would
    // corrupt the JSON on the pipe.
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`${prompt} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
  if (!confirmed) {
    // Declining at the prompt is silent in text mode, as it always was.
    if (json) {
      failCommand(new ConfirmationRequiredError('The write was not confirmed.'), { json });
    } else {
      process.exitCode = 1;
    }
  }
  return confirmed;
}

export function createUsergroupsCommand(): Command {
  const usergroups = describeCommand(new Command('usergroups'), HELP.group);

  // ─── list ────────────────────────────────────────────────────────────────
  describeCommand(usergroups.command('list'), HELP.list)
    .option('--include-disabled', 'Include disabled (archived) groups', false)
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--team <workspace-id>', 'Enterprise Grid only: member workspace T-id to list')
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
        failCommand(err, { json: options.json, spinner, context: 'Failed to fetch user groups' });
      }
    });

  // ─── read ────────────────────────────────────────────────────────────────
  describeCommand(usergroups.command('read'), HELP.read)
    .argument('<group>', 'Group ID, @handle, or exact name')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--team <workspace-id>', 'Enterprise Grid only: member workspace T-id that owns the group')
    .option('--json', 'Output in JSON format', false)
    .action(async (ref, options) => {
      const spinner = ora('Fetching user group...').start();
      try {
        const client = await getAuthenticatedClient(options.workspace);
        const group = await requireGroup(client, ref, spinner, options);
        if (!group) return;
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
        failCommand(err, { json: options.json, spinner, context: 'Failed to read user group' });
      }
    });

  // ─── create ──────────────────────────────────────────────────────────────
  describeCommand(usergroups.command('create'), HELP.create)
    .argument('<name>', 'Display name for the group')
    .option('--handle <handle>', 'Mention handle (without @)')
    .option('--description <text>', 'Description of the group')
    .option('--channels <ids>', 'Comma-separated default channel IDs')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--team <workspace-id>', 'Target workspace T-id (required for writes on an enterprise org)')
    .option('--yes', 'Skip the confirmation prompt (required when stdin is not a TTY)', false)
    .option('--json', 'Output in JSON format', false)
    .action(async (name, options) => {
      if (!(await confirmWrite(`Create user group "${name}"?`, options.yes, options.json))) {
        return;
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
        failCommand(err, { json: options.json, spinner, context: 'Failed to create user group' });
      }
    });

  // ─── update ──────────────────────────────────────────────────────────────
  describeCommand(usergroups.command('update'), HELP.update)
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
        failCommand(
          new InvalidInputError('Nothing to update — pass at least one of --name, --handle, or --description.'),
          { json: options.json },
        );
        return;
      }
      if (!(await confirmWrite(`Update user group "${ref}"?`, options.yes, options.json))) {
        return;
      }
      const spinner = ora('Updating user group...').start();
      try {
        const client = await getAuthenticatedClient(options.workspace);
        const group = await requireGroup(client, ref, spinner, options);
        if (!group) return;

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
        failCommand(err, { json: options.json, spinner, context: 'Failed to update user group' });
      }
    });

  // ─── add ─────────────────────────────────────────────────────────────────
  describeCommand(usergroups.command('add'), HELP.add)
    .argument('<group>', 'Group ID, @handle, or exact name')
    .argument('<users...>', 'User IDs, @handles or emails (comma- or space-separated)')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--team <workspace-id>', 'Target workspace T-id (required for writes on an enterprise org)')
    .option('--yes', 'Skip the confirmation prompt (required when stdin is not a TTY)', false)
    .option('--json', 'Output in JSON format', false)
    .action(async (ref, users, options) => {
      const resolved = await memberIdsOrFail(users, options, 'Failed to add members');
      if (!resolved) return;
      const { ids } = resolved;
      if (!(await confirmWrite(`Add ${ids.length} user(s) to "${ref}"?`, options.yes, options.json))) {
        return;
      }
      const spinner = ora('Adding members...').start();
      try {
        const client = resolved.client ?? await getAuthenticatedClient(options.workspace);
        const group = await requireGroup(client, ref, spinner, options);
        if (!group) return;
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
        failCommand(err, { json: options.json, spinner, context: 'Failed to add members' });
      }
    });

  // ─── remove ──────────────────────────────────────────────────────────────
  describeCommand(usergroups.command('remove'), HELP.remove)
    .argument('<group>', 'Group ID, @handle, or exact name')
    .argument('<users...>', 'User IDs, @handles or emails (comma- or space-separated)')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--team <workspace-id>', 'Target workspace T-id (required for writes on an enterprise org)')
    .option('--yes', 'Skip the confirmation prompt (required when stdin is not a TTY)', false)
    .option('--json', 'Output in JSON format', false)
    .action(async (ref, users, options) => {
      const resolved = await memberIdsOrFail(users, options, 'Failed to remove members');
      if (!resolved) return;
      const { ids } = resolved;
      if (!(await confirmWrite(`Remove ${ids.length} user(s) from "${ref}"?`, options.yes, options.json))) {
        return;
      }
      const spinner = ora('Removing members...').start();
      try {
        const client = resolved.client ?? await getAuthenticatedClient(options.workspace);
        const group = await requireGroup(client, ref, spinner, options);
        if (!group) return;
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
        failCommand(err, { json: options.json, spinner, context: 'Failed to remove members' });
      }
    });

  // ─── enable / disable ──────────────────────────────────────────────────────
  describeCommand(usergroups.command('enable'), HELP.enable)
    .argument('<group>', 'Group ID, @handle, or exact name')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--team <workspace-id>', 'Target workspace T-id (required for writes on an enterprise org)')
    .option('--yes', 'Skip the confirmation prompt (required when stdin is not a TTY)', false)
    .option('--json', 'Output in JSON format', false)
    .action(async (ref, options) => {
      if (!(await confirmWrite(`Enable user group "${ref}"?`, options.yes, options.json))) {
        return;
      }
      const spinner = ora('Enabling user group...').start();
      try {
        const client = await getAuthenticatedClient(options.workspace);
        const group = await requireGroup(client, ref, spinner, options);
        if (!group) return;
        const response = await client.enableUsergroup(group.id, { team_id: options.team });
        const updated = normalizeUsergroups([response.usergroup])[0];

        spinner.succeed(`Enabled ${updated.name} (${updated.id})`);
        if (options.json) {
          writeJson(updated);
          return;
        }
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to enable user group' });
      }
    });

  describeCommand(usergroups.command('disable'), HELP.disable)
    .argument('<group>', 'Group ID, @handle, or exact name')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--team <workspace-id>', 'Target workspace T-id (required for writes on an enterprise org)')
    .option('--yes', 'Skip the confirmation prompt (required when stdin is not a TTY)', false)
    .option('--json', 'Output in JSON format', false)
    .action(async (ref, options) => {
      if (!(await confirmWrite(`Disable user group "${ref}"?`, options.yes, options.json))) {
        return;
      }
      const spinner = ora('Disabling user group...').start();
      try {
        const client = await getAuthenticatedClient(options.workspace);
        const group = await requireGroup(client, ref, spinner, options);
        if (!group) return;
        const response = await client.disableUsergroup(group.id, { team_id: options.team });
        const updated = normalizeUsergroups([response.usergroup])[0];

        spinner.succeed(`Disabled ${updated.name} (${updated.id})`);
        if (options.json) {
          writeJson(updated);
          return;
        }
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to disable user group' });
      }
    });

  return usergroups;
}
