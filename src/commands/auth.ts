import { Command } from 'commander';
import ora from 'ora';
import { authenticateStandard, authenticateBrowser } from '../lib/auth.ts';
import {
  getAllWorkspaces,
  setDefaultWorkspace,
  removeWorkspace,
  clearAllWorkspaces,
  getDefaultWorkspaceId,
} from '../lib/workspaces.ts';
import { success, error, info, formatWorkspace } from '../lib/formatter.ts';
import chalk from 'chalk';

export function createAuthCommand(): Command {
  const auth = new Command('auth')
    .description('Manage workspace authentication');

  // Login with standard token
  auth
    .command('login')
    .description('Login with standard Slack app token (xoxb-* or xoxp-*)')
    .requiredOption('--token <token>', 'Slack bot or user token')
    .requiredOption('--workspace-name <name>', 'Workspace name for identification')
    .action(async (options) => {
      const spinner = ora('Authenticating...').start();

      try {
        const config = await authenticateStandard(
          options.token,
          options.workspaceName
        );

        spinner.succeed('Authentication successful!');
        success(`Authenticated as workspace: ${config.workspace_name}`);
        info(`Workspace ID: ${config.workspace_id}`);
        if (config.auth_type === 'standard') {
          info(`Token Type: ${config.token_type}`);
        }
      } catch (err: any) {
        spinner.fail('Authentication failed');
        error(err.message);
        process.exit(1);
      }
    });

  // Login with browser tokens
  auth
    .command('login-browser')
    .description('Login with browser session tokens (xoxd-* and xoxc-*)')
    .requiredOption('--xoxd <token>', 'Browser session token (xoxd-*)')
    .requiredOption('--xoxc <token>', 'Browser API token (xoxc-*)')
    .requiredOption('--workspace-url <url>', 'Workspace URL (e.g., https://myteam.slack.com)')
    .option('--workspace-name <name>', 'Optional workspace name for identification')
    .action(async (options) => {
      const spinner = ora('Authenticating...').start();

      try {
        const config = await authenticateBrowser(
          options.xoxd,
          options.xoxc,
          options.workspaceUrl,
          options.workspaceName
        );

        spinner.succeed('Authentication successful!');
        success(`Authenticated as workspace: ${config.workspace_name}`);
        info(`Workspace ID: ${config.workspace_id}`);
        if (config.auth_type === 'browser') {
          info(`Workspace URL: ${config.workspace_url}`);
        }
      } catch (err: any) {
        spinner.fail('Authentication failed');
        error(err.message);
        process.exit(1);
      }
    });

  // List all workspaces
  auth
    .command('list')
    .description('List all authenticated workspaces')
    .action(async () => {
      try {
        const workspaces = await getAllWorkspaces();
        const defaultId = await getDefaultWorkspaceId();

        if (workspaces.length === 0) {
          info('No authenticated workspaces found.');
          info('Run "slackcli auth login" or "slackcli auth login-browser" to authenticate.');
          return;
        }

        console.log(chalk.bold(`\n📋 Authenticated Workspaces (${workspaces.length}):\n`));

        workspaces.forEach((ws, idx) => {
          const isDefault = ws.workspace_id === defaultId;
          console.log(`${idx + 1}. ${formatWorkspace(ws, isDefault)}\n`);
        });
      } catch (err: any) {
        error('Failed to list workspaces', err.message);
        process.exit(1);
      }
    });

  // Set default workspace
  auth
    .command('set-default')
    .description('Set default workspace')
    .argument('<workspace-id>', 'Workspace ID to set as default')
    .action(async (workspaceId) => {
      try {
        await setDefaultWorkspace(workspaceId);
        success(`Set ${workspaceId} as default workspace`);
      } catch (err: any) {
        error('Failed to set default workspace', err.message);
        process.exit(1);
      }
    });

  // Remove workspace
  auth
    .command('remove')
    .description('Remove a workspace')
    .argument('<workspace-id>', 'Workspace ID to remove')
    .action(async (workspaceId) => {
      try {
        await removeWorkspace(workspaceId);
        success(`Removed workspace ${workspaceId}`);
      } catch (err: any) {
        error('Failed to remove workspace', err.message);
        process.exit(1);
      }
    });

  // Logout (clear all workspaces)
  auth
    .command('logout')
    .description('Logout from all workspaces')
    .action(async () => {
      try {
        await clearAllWorkspaces();
        success('Logged out from all workspaces');
      } catch (err: any) {
        error('Failed to logout', err.message);
        process.exit(1);
      }
    });

  // Extract tokens guide
  auth
    .command('extract-tokens')
    .description('Show guide for extracting browser tokens')
    .action(() => {
      console.log(chalk.bold('\n🔍 How to Extract Browser Tokens:\n'));
      console.log('1. Open your Slack workspace in a web browser');
      console.log('2. Open Developer Tools (F12 or Cmd+Option+I)');
      console.log('3. Go to the Network tab');
      console.log('4. Refresh the page or send a message');
      console.log('5. Look for any Slack API request (e.g., conversations.list)');
      console.log('\n📝 Extract the tokens:');
      console.log('   - xoxd token: In the "Cookie" header, look for d=xoxd-...');
      console.log('   - xoxc token: In the request payload, look for "token":"xoxc-..."');
      console.log('\n✨ Use the tokens:');
      console.log('   slackcli auth login-browser \\');
      console.log('     --xoxd=xoxd-... \\');
      console.log('     --xoxc=xoxc-... \\');
      console.log('     --workspace-url=https://yourteam.slack.com\n');
    });

  return auth;
}

