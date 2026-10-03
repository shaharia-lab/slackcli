import { Command } from 'commander';
import ora from 'ora';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { formatTeamInfo, writeJson } from '../lib/formatter.ts';
import { describeCommand, type CommandHelp } from '../lib/help.ts';
import type { SlackTeam } from '../types/index.ts';
import { failCommand } from '../lib/command-errors.ts';

// --help content, kept apart from the command chains below (#324).
const HELP = {
  group: {
    summary: 'View the workspace (team) itself',
    description:
      'View the workspace (team) itself: its name, domain and ID. For groups of people inside ' +
      'the workspace, use "slackcli usergroups".',
  },
  info: {
    summary: 'Show workspace name, domain and ID',
    description:
      'Show the workspace name, ID, domain, URL, email domain and verification status (Slack ' +
      'team.info). Works with both auth types.',
    examples: [
      'slackcli team info',
      'slackcli team info --workspace acme --json',
      'slackcli team info --team T0123456789 --json',
    ],
    json: '{ id, name, domain, email_domain, url, is_verified, icon } — the workspace.',
    notes: [
      '--team is only for Enterprise Grid: it picks one member workspace (a T... ID) of the org. ' +
        'Without it Slack returns the token\'s own workspace; on a single workspace leave it out.',
    ],
  },
} satisfies Record<string, CommandHelp>;

export function createTeamCommand(): Command {
  const team = describeCommand(new Command('team'), HELP.group);

  describeCommand(team.command('info'), HELP.info)
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--team <workspace-id>', 'Enterprise Grid only: member workspace T-id to look up')
    .option('--json', 'Output in JSON format', false)
    .action(async (options) => {
      const spinner = ora('Fetching workspace info...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);
        const response = await client.getTeamInfo({ team: options.team });
        const t = response.team ?? {};

        const info: SlackTeam = {
          id: t.id,
          name: t.name,
          domain: t.domain,
          email_domain: t.email_domain,
          url: t.url,
          is_verified: t.is_verified,
          icon: t.icon,
        };

        spinner.succeed(`Workspace: ${info.name}`);

        if (options.json) {
          writeJson(info);
          return;
        }

        console.log('\n' + formatTeamInfo(info));
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to fetch workspace info' });
      }
    });

  return team;
}
