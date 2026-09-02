import { Command } from 'commander';
import ora from 'ora';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { error, formatTeamInfo, writeJson } from '../lib/formatter.ts';
import type { SlackTeam } from '../types/index.ts';

export function createTeamCommand(): Command {
  const team = new Command('team')
    .description('View the workspace (team) itself');

  team
    .command('info')
    .description('Show workspace name, domain, and ID')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--team <workspace-id>', 'Target workspace T-id (enterprise org scoping)')
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
        spinner.fail('Failed to fetch workspace info');
        error(err.message);
        process.exit(1);
      }
    });

  return team;
}
