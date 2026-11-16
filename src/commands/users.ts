import { Command } from 'commander';
import ora, { type Ora } from 'ora';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { writeJson, writeText } from '../lib/formatter.ts';
import { applyFields, fieldsOption, FIELDS_DESCRIPTION, FIELDS_FLAG } from '../lib/json-fields.ts';
import { describeCommand, USER_NAME_NOTE, type CommandHelp } from '../lib/help.ts';
import { buildFieldLabelMap, resolveProfileFields } from '../lib/profile-fields.ts';
import { statusOf, listUsersByStatus, type UserStatusFilter } from '../lib/users.ts';
import { failCommand } from '../lib/command-errors.ts';
import { InvalidInputError, NotFoundError } from '../lib/cli-errors.ts';
import { resolveIdentifier } from '../lib/name-resolver.ts';
import { buildPreview, DRY_RUN_DESCRIPTION, DRY_RUN_FLAG, emitDryRun } from '../lib/dry-run.ts';
import { checkStatusText, profileStatusFields, type ProfileStatus } from '../lib/slack-client.ts';
import { confirmWrite } from './usergroups.ts';

// Repeated by set-status and clear-status. A bot token is standard auth, so
// this is a note rather than browserOnly or standardOnly.
const PROFILE_STATUS_BOT_NOTE =
  'A bot token (xoxb) cannot change a person\'s status and fails with unsupported_auth_type before any ' +
  'Slack call. A user token (xoxp) or a browser session works.';

// --help content, kept apart from the command chains below (#324).
const HELP = {
  group: {
    summary: 'Look up users or set your profile status',
    description:
      'Look up one user by ID, list the workspace\'s users with their account status, or set and clear ' +
      'your own profile status. To find someone by name or email, use "slackcli search people". ' +
      '"users list --status" filters account state. It does not read or change your profile status.',
  },
  info: {
    summary: 'Show one user by ID, @handle or email',
    fields: 'the user record',
    description:
      'Show one user: name, handle, email, title, account status (deactivated or not), admin ' +
      'flag and timezone. Use "users list" to enumerate users, "search people" to find one by name.',
    examples: [
      'slackcli users info U0123456789',
      'slackcli users info U0123456789 --resolve-fields',
      'slackcli users info U0123456789 --json',
      'slackcli users info @alice',
      'slackcli users info alice@example.com --json',
      'slackcli users info U0123456789 --json --fields id,real_name,profile.email,tz',
    ],
    json:
      'the raw Slack user object { id, name, real_name, deleted, is_admin, is_bot, tz, tz_label, ' +
      'tz_offset, profile, ... }, plus resolved_fields { <label>: <value> } with --resolve-fields.',
    notes: [
      '<user> is a user ID (U... or W...), an @handle or an email address; Slack URLs are not accepted. ' +
        'An ID is used as given; a handle or email is looked up first.',
      USER_NAME_NOTE,
      'A deactivated user (deleted: true) comes back without tz and is_admin: the text shows Admin: false and TZ: (none); with --json the keys are absent.',
      'email needs the users:read.email scope on an app token; --resolve-fields needs users.profile:read.',
    ],
  },
  list: {
    summary: 'List workspace users with account status',
    fields: 'each item of users',
    description:
      'List workspace users with their account status, filtered by --status. Pages through ' +
      'users.list until --limit users match. Use "users info" for one user\'s full profile.',
    examples: [
      'slackcli users list',
      'slackcli users list --status deactivated --limit 50',
      'slackcli users list --status active --resolve-fields --json',
      'slackcli users list --json --fields id,name,email',
    ],
    json:
      '{ total, status, users: [{ id, name, real_name, email, title, status, deleted, fields }] } ' +
      '— fields only with --resolve-fields; total is the number returned.',
    notes: [
      '--limit counts matching users returned, not users scanned.',
      '--status active means not deactivated, so it includes bots and guests; each row\'s status ' +
        'says active, bot, guest (single-channel), guest (multi-channel) or DEACTIVATED.',
      'This --status flag is account state. Your profile status (the text and emoji beside your name) ' +
        'is "users set-status" and "users clear-status".',
    ],
  },
  setStatus: {
    summary: 'Set your own profile status',
    description:
      'Set the signed-in user\'s profile status, the text and emoji beside their name, through ' +
      'users.profile.set. To read a status, use "users info <id> --json" and look at profile.status_text ' +
      'and profile.status_emoji.',
    examples: [
      'slackcli users set-status --text "Out of office" --emoji ":palm_tree:"',
      'slackcli users set-status --text "Out of office" --emoji ":palm_tree:" --dry-run',
      'slackcli users set-status --text "Out of office" --emoji ":palm_tree:" --yes --json',
    ],
    json: '{ status_text, status_emoji, status_expiration }. status_expiration is 0, so the status does not expire.',
    dryRun: true,
    confirms: true,
    notes: [
      'Both --text and --emoji are required. Pass an empty string to clear one of them. Slack keeps a field you leave out, so this command always sends both.',
      'Status text is at most 100 characters. The status does not expire.',
      PROFILE_STATUS_BOT_NOTE,
      'This sets only your own status. It does not take a user id.',
    ],
  },
  clearStatus: {
    summary: 'Clear your own profile status',
    description:
      'Clear the signed-in user\'s profile status by setting the text and emoji to empty. To read a ' +
      'status, use "users info <id> --json".',
    examples: [
      'slackcli users clear-status',
      'slackcli users clear-status --dry-run',
      'slackcli users clear-status --yes --json',
    ],
    json: '{ status_text, status_emoji, status_expiration }. Both strings are empty, and status_expiration is 0.',
    dryRun: true,
    confirms: true,
    notes: [
      PROFILE_STATUS_BOT_NOTE,
      'Clearing removes the text, the emoji, and any expiry.',
    ],
  },
} satisfies Record<string, CommandHelp>;

// --resolve-fields resolves custom profile-field IDs to their human LABELS only
// (one cached team.profile.get call). It does NOT resolve `user`-typed field
// VALUES (Manager, Direct Reports) from U… IDs to names — that is a separate
// future feature; those values stay as IDs. Kept in one place so info/list share
// the exact same wording.
const RESOLVE_FIELDS_HELP =
  'Resolve custom profile-field IDs to their labels (labels only; ' +
  'user-typed values such as Manager stay as IDs)';

type StatusCommandOptions = {
  workspace?: string;
  json?: boolean;
  yes?: boolean;
  dryRun?: boolean;
};

// set-status and clear-status share one write. Validation, the bot-token
// refusal, and the dry-run preview all happen before the confirm prompt.
async function commitOwnStatus(
  status: ProfileStatus,
  options: StatusCommandOptions,
  copy: { action: string; confirm: string; doing: string; done: string; failed: string },
): Promise<void> {
  const spinner: Ora = ora(copy.doing).start();
  try {
    checkStatusText(status.status_text);
    const client = await getAuthenticatedClient(options.workspace);
    client.requireOwnProfileWrite();
    spinner.stop();

    if (options.dryRun) {
      const fields: Record<string, unknown> = { ...profileStatusFields(status) };
      emitDryRun(
        await buildPreview(client, copy.action, { kind: 'profile', name: 'your profile' }, fields),
        options.json,
      );
      return;
    }

    if (!(await confirmWrite(copy.confirm, options.yes === true, options.json))) {
      return;
    }

    spinner.start(copy.doing);
    const result = await client.setOwnStatus(status);
    spinner.succeed(copy.done);
    if (options.json) writeJson(result);
  } catch (err: any) {
    failCommand(err, { json: options.json, spinner, context: copy.failed });
  }
}

export function createUsersCommand(): Command {
  const users = describeCommand(new Command('users'), HELP.group);

  // users info <id>
  describeCommand(users.command('info'), HELP.info)
    .argument('<user>', 'User ID (e.g. U0123456789), @handle or email')
    .option('--resolve-fields', RESOLVE_FIELDS_HELP, false)
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .option(FIELDS_FLAG, FIELDS_DESCRIPTION)
    .action(async (user, options) => {
      const spinner = ora(`Fetching user ${user}...`).start();

      try {
        const fields = fieldsOption(options);
        const client = await getAuthenticatedClient(options.workspace);
        // A handle (@alice) or email is looked up; an ID is used as given.
        const userId = await resolveIdentifier(client, user, user, 'user', '<user>', {
          onProgress: (text) => { spinner.text = text; },
        });
        const response = await client.getUserInfo(userId);

        if (!response.ok || !response.user) {
          failCommand(new NotFoundError(response.error || 'Unknown error'), {
            json: options.json,
            spinner,
            context: 'User not found',
          });
          return;
        }

        const u = response.user;

        let resolvedFields: Record<string, string> | undefined;
        if (options.resolveFields) {
          const labels = await buildFieldLabelMap(client);
          resolvedFields = resolveProfileFields(u, labels);
        }

        spinner.succeed(`Found ${u.real_name || u.name}`);

        if (options.json) {
          writeJson(applyFields('users info', resolvedFields ? { ...u, resolved_fields: resolvedFields } : u, fields));
          return;
        }

        writeText('');
        writeText(`  Name:     ${u.real_name || u.name}`);
        writeText(`  Handle:   @${u.name}`);
        writeText(`  ID:       ${u.id}`);
        writeText(`  Email:    ${u.profile?.email || '(none)'}`);
        writeText(`  Title:    ${u.profile?.title || '(none)'}`);
        writeText(`  Status:   ${statusOf(u)}`);
        writeText(`  Deleted:  ${u.deleted === true}`);
        writeText(`  Admin:    ${u.is_admin === true}`);
        writeText(`  TZ:       ${u.tz || '(none)'} (${u.tz_label || 'n/a'}, offset ${u.tz_offset ?? 'n/a'})`);
        if (resolvedFields) {
          writeText('  Fields:');
          for (const [label, value] of Object.entries(resolvedFields)) {
            if (value) writeText(`    ${label}: ${value}`);
          }
        }
        writeText('');
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to fetch user' });
      }
    });

  // users list
  describeCommand(users.command('list'), HELP.list)
    .option('--limit <number>', 'Max matching users to return', '200')
    .option('--status <status>', 'Filter by status: all | active | deactivated', 'all')
    .option('--resolve-fields', RESOLVE_FIELDS_HELP, false)
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .option(FIELDS_FLAG, FIELDS_DESCRIPTION)
    .action(async (options) => {
      const limit = Number.parseInt(options.limit, 10);
      const status = String(options.status).toLowerCase() as UserStatusFilter;

      if (!Number.isFinite(limit) || limit <= 0) {
        failCommand(new InvalidInputError('--limit must be a positive integer'), { json: options.json });
        return;
      }
      if (status !== 'all' && status !== 'active' && status !== 'deactivated') {
        failCommand(new InvalidInputError('--status must be one of: all | active | deactivated'), { json: options.json });
        return;
      }

      const spinner = ora('Listing users...').start();

      try {
        const fields = fieldsOption(options);
        const client = await getAuthenticatedClient(options.workspace);

        // --limit is MATCHES RETURNED: scan pages until `limit` users pass the
        // status filter (or the workspace is exhausted), not a scan-depth cap.
        const filtered = await listUsersByStatus(client, {
          limit,
          status,
          onProgress: (msg) => { spinner.text = msg; },
        });

        let labels: Record<string, string> | undefined;
        if (options.resolveFields) labels = await buildFieldLabelMap(client);

        const rows = filtered.map((u) => {
          const base: any = {
            id: u.id,
            name: u.name,
            real_name: u.real_name || u.profile?.real_name || '',
            email: u.profile?.email || '',
            title: u.profile?.title || '',
            status: statusOf(u),
            deleted: u.deleted === true,
          };
          if (labels) base.fields = resolveProfileFields(u, labels);
          return base;
        });

        spinner.succeed(`Listed ${rows.length} users (${status})`);

        if (options.json) {
          writeJson(applyFields('users list', { total: rows.length, status, users: rows }, fields));
          return;
        }

        writeText('');
        for (const r of rows) {
          const flag = r.deleted ? '✗' : ' ';
          writeText(`  ${flag} ${r.id}  ${(r.name || '').padEnd(24)} ${r.status.padEnd(22)} ${r.email}`);
        }
        writeText('');
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to list users' });
      }
    });

  describeCommand(users.command('set-status'), HELP.setStatus)
    .requiredOption('--text <text>', 'Status text (100 characters at most; empty clears it)')
    .requiredOption('--emoji <emoji>', 'Status emoji, such as :palm_tree: (empty clears it)')
    .option('--yes', 'Set the status without a prompt', false)
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .option(DRY_RUN_FLAG, DRY_RUN_DESCRIPTION, false)
    .action(async (options: StatusCommandOptions & { text: string; emoji: string }) => {
      const status = { status_text: options.text, status_emoji: options.emoji };
      const shown = `${status.status_emoji} ${status.status_text}`.trim();
      await commitOwnStatus(status, options, {
        action: 'set status',
        confirm: shown ? `Set your profile status to ${shown}?` : 'Set your profile status to empty?',
        doing: 'Setting profile status...',
        done: shown ? `Status set to ${shown}` : 'Status set to empty',
        failed: 'Failed to set profile status',
      });
    });

  describeCommand(users.command('clear-status'), HELP.clearStatus)
    .option('--yes', 'Clear the status without a prompt', false)
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .option(DRY_RUN_FLAG, DRY_RUN_DESCRIPTION, false)
    .action(async (options: StatusCommandOptions) => {
      await commitOwnStatus(
        { status_text: '', status_emoji: '' },
        options,
        {
          action: 'clear status',
          confirm: 'Clear your profile status?',
          doing: 'Clearing profile status...',
          done: 'Status cleared',
          failed: 'Failed to clear profile status',
        },
      );
    });

  return users;
}
