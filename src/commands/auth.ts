import { Command } from 'commander';
import ora from 'ora';
import { authenticateStandard, authenticateBrowser, authenticateAuto, AutoLoginError } from '../lib/auth.ts';
import {
  getAllWorkspaces,
  setDefaultWorkspace,
  removeWorkspace,
  clearAllWorkspaces,
  getDefaultWorkspaceId,
} from '../lib/workspaces.ts';
import { success, error, info, warning, formatWorkspace } from '../lib/formatter.ts';
import chalk from 'chalk';
import { parseCurlCommand, CurlParseError, looksLikeCurlCommand } from '../lib/curl-parser.ts';
import { readClipboard } from '../lib/clipboard.ts';
import { readInteractiveInput, isInteractiveTerminal, hasPipedInput } from '../lib/interactive-input.ts';
import { clearBrowserProfile } from '../lib/browser-launcher.ts';
import { isSlackWorkspaceUrl } from '../lib/browser-auth.ts';

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

  // Login by capturing tokens from a browser session
  auth
    .command('login-auto')
    .description('Login by signing into Slack in a browser (captures tokens automatically)')
    .option('--workspace-url <url>', 'Open a specific workspace (e.g., https://myteam.slack.com)')
    .option('--headless', 'Run without a visible window (only works if already signed in)')
    .option('--timeout <seconds>', 'How long to wait for sign-in', '300')
    .action(async (options) => {
      const timeoutSeconds = Number(options.timeout);
      if (
        !Number.isFinite(timeoutSeconds) ||
        !Number.isInteger(timeoutSeconds) ||
        timeoutSeconds <= 0
      ) {
        error('--timeout must be a positive number of seconds');
        process.exit(1);
      }

      // Checked here as well as at the launcher: this value becomes browser
      // argv, and it is the host the session cookie would be sent to.
      if (options.workspaceUrl && !isSlackWorkspaceUrl(options.workspaceUrl)) {
        error('--workspace-url must be an https URL on a slack.com host');
        console.log(chalk.dim('   e.g. https://myteam.slack.com'));
        process.exit(1);
      }

      const spinner = ora('Launching browser...').start();

      try {
        const result = await authenticateAuto({
          headless: options.headless === true,
          workspaceUrl: options.workspaceUrl,
          timeoutMs: timeoutSeconds * 1000,
          // The spinner owns the terminal line, so progress has to go through it.
          onProgress: (line) => {
            spinner.text = line;
          },
        });

        if (result.saved.length === 0) {
          spinner.fail('No workspaces could be authenticated');
          result.failed.forEach((f) => error(`${f.workspaceUrl}: ${f.error}`));
          process.exit(1);
        }

        spinner.succeed(
          `Authenticated ${result.saved.length} workspace${result.saved.length === 1 ? '' : 's'}`
        );

        result.saved.forEach((config) => {
          success(`${config.workspace_name} ${chalk.dim(`(${config.workspace_id})`)}`);
        });

        // Partial success is still success — surface the misses without
        // discarding the workspaces that did authenticate.
        result.failed.forEach((f) => {
          warning(`Skipped ${f.workspaceUrl}: ${f.error}`);
        });
      } catch (err: any) {
        spinner.fail('Automatic login failed');
        error(err.message);

        if (err instanceof AutoLoginError && err.reason === 'browser_not_found') {
          console.log(chalk.yellow('\n💡 Or extract tokens manually:'));
          console.log(chalk.cyan('   slackcli auth parse-curl --login\n'));
        }
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
    .option('--keep-browser-session', 'Leave the login-auto browser profile signed in')
    .action(async (options) => {
      try {
        await clearAllWorkspaces();

        // The browser profile is a credential store in its own right: while it
        // exists, `login-auto` re-mints valid tokens with no interaction. A
        // logout that left it behind would report a logout it did not perform.
        if (options.keepBrowserSession) {
          warning('Browser session kept — "auth login-auto" can still sign in without prompting.');
        } else {
          const cleared = await clearBrowserProfile();
          // Never silent about a profile left behind: it is a live credential,
          // and a logout the user believes is complete would not be.
          if (!cleared.cleared && cleared.reason === 'not_ours') {
            warning(
              `Left ${cleared.path} alone — slackcli did not create it, so it was not deleted.`
            );
            console.log(chalk.dim('   Remove it yourself if it holds a Slack session.'));
          }
        }

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
      console.log(chalk.bold('\n✨ Easiest: let slackcli do it\n'));
      console.log(chalk.cyan('   slackcli auth login-auto'));
      console.log(chalk.dim('   Opens a browser, you sign in, tokens are captured automatically.'));
      console.log(chalk.dim('   Enrols every workspace you are signed into.\n'));
      console.log(chalk.bold('🔍 Or extract them by hand:\n'));
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
      console.log('\n💡 Or use the easy way:');
      console.log('   Right-click on any Slack API request → Copy → Copy as cURL');
      console.log('   Then run: slackcli auth parse-curl --login');
      console.log('   (Interactive mode - just paste and press Enter twice)\n');
      console.log('   Or: slackcli auth parse-curl --from-clipboard --login');
      console.log('   (Reads directly from your clipboard)\n');
    });

  // Parse cURL command to extract tokens
  auth
    .command('parse-curl')
    .description('Extract xoxd and xoxc tokens from a cURL command')
    .argument('[curl-command]', 'cURL command (or use --from-clipboard / interactive mode)')
    .option('--login', 'Automatically login with extracted tokens')
    .option('--from-clipboard', 'Read cURL command from system clipboard')
    .action(async (curlCommand, options) => {
      try {
        let curlInput = curlCommand;

        // Get input from various sources (in priority order)
        if (!curlInput && options.fromClipboard) {
          const spinner = ora('Reading from clipboard...').start();
          const clipboardResult = await readClipboard();

          if (!clipboardResult.success) {
            spinner.fail('Failed to read clipboard');
            error(clipboardResult.error || 'Unknown clipboard error');
            console.log(chalk.yellow('\n💡 Tip: Try the interactive mode instead:'));
            console.log(chalk.cyan('   slackcli auth parse-curl --login\n'));
            process.exit(1);
          }

          curlInput = clipboardResult.content || '';
          spinner.succeed('Read from clipboard');

          if (!looksLikeCurlCommand(curlInput)) {
            error('Clipboard content does not appear to be a cURL command');
            console.log(chalk.yellow('\n💡 Tip: Make sure you copied the cURL command from browser DevTools'));
            console.log(chalk.yellow('   Right-click on request → Copy → Copy as cURL\n'));
            process.exit(1);
          }
        } else if (!curlInput && hasPipedInput()) {
          const stdinChunks: Buffer[] = [];
          for await (const chunk of process.stdin) {
            stdinChunks.push(chunk);
          }
          if (stdinChunks.length > 0) {
            curlInput = Buffer.concat(stdinChunks).toString('utf-8');
          }
        } else if (!curlInput && isInteractiveTerminal()) {
          curlInput = await readInteractiveInput({
            prompt: 'Paste your cURL command (press Enter twice when done):',
            hint: 'Copy the cURL command from browser DevTools (Right-click → Copy → Copy as cURL)',
          });
        }

        if (!curlInput || curlInput.trim() === '') {
          error('No cURL command provided. Usage:');
          console.log('\n  Interactive mode (recommended):');
          console.log(chalk.cyan('    slackcli auth parse-curl --login'));
          console.log('\n  From clipboard:');
          console.log(chalk.cyan('    slackcli auth parse-curl --from-clipboard --login'));
          console.log('\n  Piped input:');
          console.log(chalk.cyan('    pbpaste | slackcli auth parse-curl --login'));
          process.exit(1);
        }

        console.log(chalk.bold('\n🔍 Parsing cURL command...\n'));

        // Parse the cURL command
        const parsed = parseCurlCommand(curlInput);

        // Display extracted tokens
        success('✅ Successfully extracted tokens!\n');
        console.log(chalk.bold('Workspace:'));
        console.log(`  Name: ${chalk.cyan(parsed.workspaceName)}`);
        console.log(`  URL:  ${chalk.cyan(parsed.workspaceUrl)}\n`);

        console.log(chalk.bold('Tokens:'));
        console.log(`  xoxd: ${chalk.green(parsed.xoxd.substring(0, 20))}...${chalk.gray(`(${parsed.xoxd.length} chars)`)}`);
        console.log(`  xoxc: ${chalk.green(parsed.xoxc.substring(0, 20))}...${chalk.gray(`(${parsed.xoxc.length} chars)`)}\n`);

        // If --login flag is set, authenticate directly
        if (options.login) {
          const spinner = ora('Authenticating with extracted tokens...').start();
          try {
            const config = await authenticateBrowser(parsed.xoxd, parsed.xoxc, parsed.workspaceUrl, parsed.workspaceName);
            spinner.succeed('Authentication successful!');
            success(`Authenticated as workspace: ${config.workspace_name}`);
            info(`Workspace ID: ${config.workspace_id}`);
          } catch (err: any) {
            spinner.fail('Authentication failed');
            error(err.message);
            process.exit(1);
          }
        } else {
          console.log(chalk.bold('To login with these tokens, run:\n'));
          console.log(chalk.cyan('  slackcli auth parse-curl --login'));
          console.log(chalk.gray('\nOr manually:\n'));
          console.log(`  slackcli auth login-browser \\`);
          console.log(`    --xoxd="${parsed.xoxd}" \\`);
          console.log(`    --xoxc="${parsed.xoxc}" \\`);
          console.log(`    --workspace-url="${parsed.workspaceUrl}"\n`);
        }
      } catch (err: any) {
        error('Failed to parse cURL command', err.message);
        console.log(chalk.yellow('\n💡 Tip: Right-click on a Slack API request in browser DevTools'));
        console.log(chalk.yellow('   → Copy → Copy as cURL, then paste here\n'));
        process.exit(1);
      }
    });

  return auth;
}
