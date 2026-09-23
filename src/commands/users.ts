import { Command } from 'commander';
import ora from 'ora';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { error, writeJson } from '../lib/formatter.ts';
import { buildFieldLabelMap, resolveProfileFields } from '../lib/profile-fields.ts';
import { statusOf, listUsersByStatus, type UserStatusFilter } from '../lib/users.ts';

// --resolve-fields resolves custom profile-field IDs to their human LABELS only
// (one cached team.profile.get call). It does NOT resolve `user`-typed field
// VALUES (Manager, Direct Reports) from U… IDs to names — that is a separate
// future feature; those values stay as IDs. Kept in one place so info/list share
// the exact same wording.
const RESOLVE_FIELDS_HELP =
  'Resolve custom profile-field IDs to their labels (labels only; ' +
  'user-typed values such as Manager stay as IDs)';

export function createUsersCommand(): Command {
  const users = new Command('users')
    .description('Look up users and their account status');

  // users info <id>
  users
    .command('info')
    .description('Get a single user, including account status (deleted), timezone, and title')
    .argument('<user>', 'User ID (e.g. U012HH99H63)')
    .option('--resolve-fields', RESOLVE_FIELDS_HELP, false)
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (user, options) => {
      const spinner = ora(`Fetching user ${user}...`).start();

      try {
        const client = await getAuthenticatedClient(options.workspace);
        const response = await client.getUserInfo(user);

        if (!response.ok || !response.user) {
          spinner.fail('User not found');
          error(response.error || 'Unknown error');
          process.exit(1);
        }

        const u = response.user;

        let resolvedFields: Record<string, string> | undefined;
        if (options.resolveFields) {
          const labels = await buildFieldLabelMap(client);
          resolvedFields = resolveProfileFields(u, labels);
        }

        spinner.succeed(`Found ${u.real_name || u.name}`);

        if (options.json) {
          writeJson(resolvedFields ? { ...u, resolved_fields: resolvedFields } : u);
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
        spinner.fail('Failed to fetch user');
        error(err.message);
        process.exit(1);
      }
    });

  // users list
  users
    .command('list')
    .description('List workspace users with account status (paginates users.list)')
    .option('--limit <number>', 'Max matching users to return', '200')
    .option('--status <status>', 'Filter by status: all | active | deactivated', 'all')
    .option('--resolve-fields', RESOLVE_FIELDS_HELP, false)
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (options) => {
      const limit = Number.parseInt(options.limit, 10);
      const status = String(options.status).toLowerCase() as UserStatusFilter;

      if (!Number.isFinite(limit) || limit <= 0) {
        error('--limit must be a positive integer');
        process.exit(1);
      }
      if (status !== 'all' && status !== 'active' && status !== 'deactivated') {
        error('--status must be one of: all | active | deactivated');
        process.exit(1);
      }

      const spinner = ora('Listing users...').start();

      try {
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
          writeJson({ total: rows.length, status, users: rows });
          return;
        }

        console.log('');
        for (const r of rows) {
          const flag = r.deleted ? '✗' : ' ';
          console.log(`  ${flag} ${r.id}  ${(r.name || '').padEnd(24)} ${r.status.padEnd(22)} ${r.email}`);
        }
        console.log('');
      } catch (err: any) {
        spinner.fail('Failed to list users');
        error(err.message);
        process.exit(1);
      }
    });

  return users;
}
