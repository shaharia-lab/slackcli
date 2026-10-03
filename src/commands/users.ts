import { Command } from 'commander';
import ora from 'ora';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { writeJson } from '../lib/formatter.ts';
import { applyFields, fieldsOption, FIELDS_DESCRIPTION, FIELDS_FLAG } from '../lib/json-fields.ts';
import { describeCommand, USER_NAME_NOTE, type CommandHelp } from '../lib/help.ts';
import { buildFieldLabelMap, resolveProfileFields } from '../lib/profile-fields.ts';
import { statusOf, listUsersByStatus, type UserStatusFilter } from '../lib/users.ts';
import { failCommand } from '../lib/command-errors.ts';
import { InvalidInputError, NotFoundError } from '../lib/cli-errors.ts';
import { resolveIdentifier } from '../lib/name-resolver.ts';

// --help content, kept apart from the command chains below (#324).
const HELP = {
  group: {
    summary: 'Look up users and their account status',
    description:
      'Look up one user by ID, or list the workspace\'s users with their account status. To find ' +
      'someone by name or email, use "slackcli search people".',
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

        console.log('');
        console.log(`  Name:     ${u.real_name || u.name}`);
        console.log(`  Handle:   @${u.name}`);
        console.log(`  ID:       ${u.id}`);
        console.log(`  Email:    ${u.profile?.email || '(none)'}`);
        console.log(`  Title:    ${u.profile?.title || '(none)'}`);
        console.log(`  Status:   ${statusOf(u)}`);
        console.log(`  Deleted:  ${u.deleted === true}`);
        console.log(`  Admin:    ${u.is_admin === true}`);
        console.log(`  TZ:       ${u.tz || '(none)'} (${u.tz_label || 'n/a'}, offset ${u.tz_offset ?? 'n/a'})`);
        if (resolvedFields) {
          console.log('  Fields:');
          for (const [label, value] of Object.entries(resolvedFields)) {
            if (value) console.log(`    ${label}: ${value}`);
          }
        }
        console.log('');
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

        console.log('');
        for (const r of rows) {
          const flag = r.deleted ? '✗' : ' ';
          console.log(`  ${flag} ${r.id}  ${(r.name || '').padEnd(24)} ${r.status.padEnd(22)} ${r.email}`);
        }
        console.log('');
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to list users' });
      }
    });

  return users;
}
