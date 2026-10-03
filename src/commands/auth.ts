import { Command } from 'commander';
import ora, { type Ora } from 'ora';
import {
  authenticateStandard,
  authenticateBrowser,
  authenticateAuto,
  AutoLoginError,
  buildProfileList,
  checkAllProfiles,
  checkIdentity,
  type CheckedProfile,
} from '../lib/auth.ts';
import {
  getAllWorkspaceEntries,
  setDefaultWorkspace,
  removeWorkspace,
  clearAllWorkspaces,
  getDefaultWorkspaceId,
  migrateSecrets,
} from '../lib/workspaces.ts';
import { success, error, info, warning, formatWorkspace, formatIdentity, writeJson } from '../lib/formatter.ts';
import chalk from 'chalk';
import { parseCurlCommand, type ParsedCurlResult } from '../lib/curl-parser.ts';
import { resolveCurlInput, type CurlInputResult } from '../lib/curl-input.ts';
import { clearBrowserProfile } from '../lib/browser-launcher.ts';
import { isSlackWorkspaceUrl } from '../lib/browser-auth.ts';
import { confirmWrite } from './usergroups.ts';
import { describeCommand, type CommandHelp } from '../lib/help.ts';
import type { IdentityResult, SecretBackend } from '../types/index.ts';
import { failCommand } from '../lib/command-errors.ts';

// --help content, kept apart from the command chains below (#324).
const HELP = {
  group: {
    summary: 'Log in, list, verify and remove workspaces',
    description:
      'Store, select, verify and remove Slack credentials. Log in with an app token (login), ' +
      'browser session tokens (login-browser, parse-curl) or by signing in to a browser (login-auto). ' +
      'Each login is stored as a profile; the first one becomes the default workspace.',
  },
  login: {
    summary: 'Log in with a Slack app token (xoxb/xoxp)',
    description:
      'Log in with a Slack app token: a bot token (xoxb-...) or a user token (xoxp-...). ' +
      'The token is verified with auth.test, then stored. Use login-browser or login-auto ' +
      'instead when you have no Slack app.',
    examples: [
      'slackcli auth login --token "$SLACK_TOKEN" --workspace-name acme',
      'slackcli auth login --token "$SLACK_BOT_TOKEN" --workspace-name acme --profile acme-bot',
      'slackcli auth login --token "$SLACK_TOKEN" --workspace-name acme --secret-backend keychain',
    ],
    notes: [
      'Pass the token from an environment variable, not as a literal: a literal lands in shell history.',
      '--profile names the stored profile. Without it, logging in again as the same identity refreshes ' +
        'it in place; a different identity for the same workspace is stored as <workspace-id>-2, -3, ...',
      '--secret-backend applies only when the profile is new; use "auth migrate-secrets" to move an existing one.',
    ],
  },
  loginBrowser: {
    summary: 'Log in with browser session tokens (xoxd/xoxc)',
    description:
      'Log in with the browser session tokens of a signed-in Slack web client: the d cookie (xoxd-...) ' +
      'and the API token (xoxc-...). The tokens are verified, then stored. To skip copying them by hand, ' +
      'use parse-curl (paste a DevTools cURL) or login-auto (sign in to a browser).',
    examples: [
      'slackcli auth login-browser --xoxd "$SLACK_XOXD" --xoxc "$SLACK_XOXC" --workspace-url https://acme.slack.com',
      'slackcli auth login-browser --xoxd "$SLACK_XOXD" --xoxc "$SLACK_XOXC" --workspace-url https://acme.slack.com --profile acme-me',
    ],
    notes: [
      'Pass tokens from environment variables, not as literals: a literal lands in shell history.',
      'Browser session tokens unlock browser-only commands (drafts) and let "conversations get" find a thread reply; "auth extract-tokens" shows where to find them.',
      '--profile and --secret-backend work as for "auth login".',
    ],
  },
  loginAuto: {
    summary: 'Log in by signing in to Slack in a browser',
    description:
      'Launch a Chromium-family browser (Chrome, Chromium, Edge, Brave) with a dedicated slackcli profile, ' +
      'wait for you to sign in, and capture the browser session tokens of every workspace you are signed in to. ' +
      'The easiest way to get browser session tokens.',
    examples: [
      'slackcli auth login-auto',
      'slackcli auth login-auto --workspace-url https://acme.slack.com --timeout 600',
      'slackcli auth login-auto --headless',
    ],
    notes: [
      '--workspace-url must be an https URL on a slack.com host.',
      '--headless only works when the dedicated profile is already signed in (from an earlier login-auto).',
      'The browser profile stays signed in, so a later login-auto needs no interaction; "auth logout" deletes it.',
      'SLACKCLI_BROWSER picks the browser executable, SLACKCLI_BROWSER_PROFILE the profile directory.',
      'Partial success exits 0: workspaces that could not be saved are reported as warnings.',
    ],
  },
  list: {
    summary: 'List stored workspaces and profiles',
    description:
      'List every stored profile with its workspace, auth type and which one is the default. ' +
      'Reads local config only; add --check to verify each profile against Slack. ' +
      'Use whoami instead to check just the workspace a command would use.',
    examples: [
      'slackcli auth list',
      'slackcli auth list --check',
      'slackcli auth list --check --json',
    ],
    json:
      '{ default, workspaces: [{ profile, workspace_id, workspace_name, auth_type, is_default, ' +
      'secret_backend, check? }] }. default is null when none is set; check ({ status, ... }) is present only with --check.',
    notes: [
      '--check makes one auth.test call per profile and exits 1 unless every profile is ok.',
      'Never prints a token.',
    ],
  },
  whoami: {
    summary: 'Show and verify the active identity',
    description:
      'Show which workspace, profile and user a command would act as, and verify the credentials with one auth.test call. ' +
      'Use list --check instead to verify every stored profile.',
    examples: [
      'slackcli auth whoami',
      'slackcli auth whoami --workspace T0123456789',
      'slackcli auth whoami --json',
    ],
    json:
      '{ status, profile, workspace_id, workspace_name, auth_type, source, ... }. status is ok (adds user, ' +
      'user_id, bot_id?), auth_failed (adds error: { code, meaning, fix }) or unreachable (adds error: { message, http_status? }).',
    notes: [
      'source says where the selection came from: flag (--workspace), env (SLACKCLI_WORKSPACE) or default.',
      'Exits 1 when Slack refuses the credentials or cannot be reached; the output is still printed.',
    ],
  },
  setDefault: {
    summary: 'Set the default workspace',
    description:
      'Make a stored profile the default workspace, used by every command that is not given ' +
      '--workspace or SLACKCLI_WORKSPACE.',
    examples: [
      'slackcli auth set-default T0123456789',
      'slackcli auth set-default acme-bot',
    ],
    notes: [
      '<workspace> is matched as a profile name, then a workspace ID, then a workspace name; ' +
        'an ID or name shared by several profiles is rejected as ambiguous (use the profile name).',
      'Changes local config only, immediately, with no confirmation prompt.',
    ],
  },
  remove: {
    summary: 'Remove one stored workspace profile',
    description:
      'Delete one stored profile and its credentials. Use logout instead to remove every profile. ' +
      'Removing the default makes the next remaining profile the default.',
    examples: [
      'slackcli auth remove T0123456789',
      'slackcli auth remove acme-bot',
    ],
    notes: [
      '<workspace> is matched as for set-default: profile name, workspace ID or workspace name.',
      'Acts immediately, with no confirmation prompt. The token is not revoked on Slack\'s side.',
    ],
  },
  logout: {
    summary: 'Remove every stored workspace',
    description:
      'Delete every stored profile and its credentials, and the login-auto browser profile ' +
      '(which would otherwise sign in again without prompting). Use remove instead for one profile.',
    examples: [
      'slackcli auth logout',
      'slackcli auth logout --keep-browser-session',
    ],
    notes: [
      'Acts immediately, with no confirmation prompt. Tokens are not revoked on Slack\'s side.',
      'A browser profile directory slackcli did not create is left alone, with a warning.',
    ],
  },
  extractTokens: {
    summary: 'Show how to find browser session tokens',
    description:
      'Print a step-by-step guide for finding the xoxd and xoxc browser session tokens in browser DevTools. ' +
      'Prints text only: it reads and stores nothing.',
    examples: ['slackcli auth extract-tokens'],
    notes: ['login-auto captures the tokens for you; parse-curl extracts them from a copied cURL command.'],
  },
  parseCurl: {
    summary: 'Extract browser tokens from a cURL command',
    description:
      'Extract the xoxd and xoxc browser session tokens and the workspace URL from a Slack API request ' +
      'copied from browser DevTools (Copy as cURL). With --login, also log in with them.',
    examples: [
      'slackcli auth parse-curl --login',
      'slackcli auth parse-curl --from-clipboard --login',
      'slackcli auth parse-curl --login < request.curl',
    ],
    notes: [
      'The cURL command is read from the argument, --from-clipboard, piped stdin, or pasted interactively ' +
        '(end with an empty line), in that order.',
      'Prefer --from-clipboard or stdin over the argument: an argument lands in shell history.',
      'Without --login it stores nothing, but prints the full xoxd/xoxc tokens on stdout as a ready-to-run ' +
        '"auth login-browser" command: do not capture or log that output. With --login only a 20-character prefix is shown.',
    ],
  },
  migrateSecrets: {
    summary: 'Move stored credentials to another backend',
    description:
      'Move stored credentials between the config file and the macOS Keychain, for every profile or one. ' +
      'Each copy is verified on the new backend before the old one is removed.',
    examples: [
      'slackcli auth migrate-secrets --to keychain',
      'slackcli auth migrate-secrets --to file --profile acme-bot --yes',
    ],
    confirms: true,
    notes: [
      '--to keychain is macOS only.',
      'Profiles already on the target are skipped. If an old copy could not be removed, re-run to retry.',
    ],
  },
} satisfies Record<string, CommandHelp>;

// Validates the `--secret-backend` flag shared by every login path. Exits the
// process on an invalid value or on `keychain` requested off macOS — both are
// deliberately checked here, before any network call, rather than left to
// surface later from deep inside MacOSKeychainSecretStore's own runtime guard.
// `platform` is injectable (same convention as browser-launcher.ts's
// findBrowser) so the off-macOS branch is testable on every CI runner, not
// just a real Mac.
export function resolveSecretBackend(
  value: string,
  platform: string = process.platform,
): SecretBackend {
  if (value !== 'file' && value !== 'keychain') {
    error(`--secret-backend must be "file" or "keychain" (got "${value}")`);
    process.exit(1);
  }
  if (value === 'keychain' && platform !== 'darwin') {
    error('--secret-backend keychain is only available on macOS.');
    process.exit(1);
  }
  return value;
}

// Prints the message, usage and tips for a `parse-curl` input that could not
// be resolved. The caller exits; the strings are the ones the handler used to
// print inline.
function reportCurlInputFailure(
  result: Extract<CurlInputResult, { ok: false }>,
  clipboardSpinner: Ora,
): void {
  switch (result.reason) {
    case 'clipboard-failed':
      clipboardSpinner.fail('Failed to read clipboard');
      error(result.message);
      console.log(chalk.yellow('\n💡 Tip: Try the interactive mode instead:'));
      console.log(chalk.cyan('   slackcli auth parse-curl --login\n'));
      return;
    case 'not-curl':
      clipboardSpinner.succeed('Read from clipboard');
      error('Clipboard content does not appear to be a cURL command');
      console.log(chalk.yellow('\n💡 Tip: Make sure you copied the cURL command from browser DevTools'));
      console.log(chalk.yellow('   Right-click on request → Copy → Copy as cURL\n'));
      return;
    case 'empty':
      error('No cURL command provided. Usage:');
      console.log('\n  Interactive mode (recommended):');
      console.log(chalk.cyan('    slackcli auth parse-curl --login'));
      console.log('\n  From clipboard:');
      console.log(chalk.cyan('    slackcli auth parse-curl --from-clipboard --login'));
      console.log('\n  Piped input:');
      console.log(chalk.cyan('    pbpaste | slackcli auth parse-curl --login'));
      return;
  }
}

async function loginWithParsedTokens(parsed: ParsedCurlResult, secretBackend: SecretBackend): Promise<void> {
  const spinner = ora('Authenticating with extracted tokens...').start();
  try {
    const { config, profileKey } = await authenticateBrowser(
      parsed.xoxd,
      parsed.xoxc,
      parsed.workspaceUrl,
      parsed.workspaceName,
      undefined,
      secretBackend
    );
    spinner.succeed('Authentication successful!');
    success(`Authenticated as workspace: ${config.workspace_name}`);
    info(`Workspace ID: ${config.workspace_id}`);
    info(`Profile: ${profileKey}`);
  } catch (err: any) {
    spinner.fail('Authentication failed');
    error(err.message);
    process.exit(1);
  }
}

function printLoginHint(parsed: ParsedCurlResult): void {
  console.log(chalk.bold('To login with these tokens, run:\n'));
  console.log(chalk.cyan('  slackcli auth parse-curl --login'));
  console.log(chalk.gray('\nOr manually:\n'));
  console.log(`  slackcli auth login-browser \\`);
  console.log(`    --xoxd="${parsed.xoxd}" \\`);
  console.log(`    --xoxc="${parsed.xoxc}" \\`);
  console.log(`    --workspace-url="${parsed.workspaceUrl}"\n`);
}

export function createAuthCommand(): Command {
  const auth = describeCommand(new Command('auth'), HELP.group);

  // Login with standard token
  describeCommand(auth.command('login'), HELP.login)
    .requiredOption('--token <token>', 'Slack bot or user token')
    .requiredOption('--workspace-name <name>', 'Workspace name for identification')
    .option('--profile <name>', 'Store under a named profile (keeps multiple identities for one workspace)')
    .option('--secret-backend <backend>', 'Where to store credentials for a NEW profile: file (default) or keychain (macOS only)', 'file')
    .action(async (options) => {
      const secretBackend = resolveSecretBackend(options.secretBackend);
      const spinner = ora('Authenticating...').start();

      try {
        const { config, profileKey } = await authenticateStandard(
          options.token,
          options.workspaceName,
          options.profile,
          secretBackend
        );

        spinner.succeed('Authentication successful!');
        success(`Authenticated as workspace: ${config.workspace_name}`);
        info(`Workspace ID: ${config.workspace_id}`);
        info(`Profile: ${profileKey}`);
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
  describeCommand(auth.command('login-browser'), HELP.loginBrowser)
    .requiredOption('--xoxd <token>', 'Browser session token (xoxd-*)')
    .requiredOption('--xoxc <token>', 'Browser API token (xoxc-*)')
    .requiredOption('--workspace-url <url>', 'Workspace URL (e.g., https://myteam.slack.com)')
    .option('--workspace-name <name>', 'Optional workspace name for identification')
    .option('--profile <name>', 'Store under a named profile (keeps multiple identities for one workspace)')
    .option('--secret-backend <backend>', 'Where to store credentials for a NEW profile: file (default) or keychain (macOS only)', 'file')
    .action(async (options) => {
      const secretBackend = resolveSecretBackend(options.secretBackend);
      const spinner = ora('Authenticating...').start();

      try {
        const { config, profileKey } = await authenticateBrowser(
          options.xoxd,
          options.xoxc,
          options.workspaceUrl,
          options.workspaceName,
          options.profile,
          secretBackend
        );

        spinner.succeed('Authentication successful!');
        success(`Authenticated as workspace: ${config.workspace_name}`);
        info(`Workspace ID: ${config.workspace_id}`);
        info(`Profile: ${profileKey}`);
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
  describeCommand(auth.command('login-auto'), HELP.loginAuto)
    .option('--workspace-url <url>', 'Open a specific workspace (e.g., https://myteam.slack.com)')
    .option('--headless', 'Run without a visible window (only works if already signed in)')
    .option('--timeout <seconds>', 'How long to wait for sign-in', '300')
    .option('--secret-backend <backend>', 'Where to store credentials for a NEW profile: file (default) or keychain (macOS only)', 'file')
    .action(async (options) => {
      const secretBackend = resolveSecretBackend(options.secretBackend);
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
          secretBackend,
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
          const workspaceId = chalk.dim(`(${config.workspace_id})`);
          success(`${config.workspace_name} ${workspaceId}`);
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
  describeCommand(auth.command('list'), HELP.list)
    .option('--check', 'Verify every profile with one auth.test call each (exits 1 unless all are ok)', false)
    .option('--json', 'Output in JSON format', false)
    .action(async (options) => {
      // Started only for --check: plain `auth list` reads local config alone.
      let spinner: Ora | undefined;
      try {
        const entries = await getAllWorkspaceEntries();
        const defaultKey = await getDefaultWorkspaceId();

        let checks: CheckedProfile[] | undefined;
        if (options.check && entries.length > 0) {
          spinner = ora('Checking profiles...').start();
          const progress = spinner;
          checks = await checkAllProfiles(({ profile, index, total }) => {
            progress.text = `Checking ${profile} (${index}/${total})...`;
          });
          const failed = checks.filter(({ check }) => check.status !== 'ok').length;
          if (failed === 0) {
            spinner.succeed(`All ${checks.length} profile${checks.length === 1 ? '' : 's'} verified`);
          } else {
            spinner.fail(`${failed} of ${checks.length} profile${checks.length === 1 ? '' : 's'} not verified`);
            // Not process.exit(): the output below must drain first (see writeJson).
            process.exitCode = 1;
          }
        }

        if (options.json) {
          writeJson(buildProfileList(entries, defaultKey, checks));
          return;
        }

        if (entries.length === 0) {
          info('No authenticated workspaces found.');
          info('Run "slackcli auth login" or "slackcli auth login-browser" to authenticate.');
          return;
        }

        console.log(chalk.bold(`\n📋 Authenticated Workspaces (${entries.length}):\n`));

        const checkOf = new Map(checks?.map(({ profile, check }) => [profile, check]));
        entries.forEach(({ key, config }, idx) => {
          const isDefault = key === defaultKey;
          console.log(`${idx + 1}. ${formatWorkspace(config, isDefault, key, checkOf.get(key))}\n`);
        });
      } catch (err: any) {
        if (options.json) {
          failCommand(err, { json: true, spinner });
          return;
        }
        spinner?.stop();
        error('Failed to list workspaces', err.message);
        process.exit(1);
      }
    });

  // Show the active identity and verify its credentials
  describeCommand(auth.command('whoami'), HELP.whoami)
    .option('--workspace <id|name>', 'Workspace to use: profile name, workspace ID or workspace name')
    .option('--json', 'Output in JSON format', false)
    .action(async (options) => {
      const spinner = ora('Checking identity...').start();

      let identity: IdentityResult;
      try {
        identity = await checkIdentity(options.workspace);
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Could not check identity' });
        return;
      }

      if (identity.status === 'ok') {
        spinner.succeed('Credentials verified');
      } else {
        spinner.fail(
          identity.status === 'auth_failed' ? 'Slack refused the credentials' : 'Slack could not be reached'
        );
        // Not process.exit(): the output below must drain first (see writeJson).
        process.exitCode = 1;
      }

      if (options.json) {
        writeJson(identity);
        return;
      }

      console.log(`\n${formatIdentity(identity)}\n`);
      if (identity.status === 'auth_failed') {
        error(`${identity.error.code}: ${identity.error.meaning}`, `To fix: ${identity.error.fix}`);
      } else if (identity.status === 'unreachable') {
        error(
          identity.error.message,
          'Slack could not be reached, so the credentials were not checked. Check the connection and try again.'
        );
      }
    });

  // Set default workspace
  describeCommand(auth.command('set-default'), HELP.setDefault)
    .argument('<workspace>', 'Profile name, workspace ID, or workspace name')
    .action(async (identifier) => {
      try {
        await setDefaultWorkspace(identifier);
        success(`Set ${identifier} as default workspace`);
      } catch (err: any) {
        error('Failed to set default workspace', err.message);
        process.exit(1);
      }
    });

  // Remove workspace
  describeCommand(auth.command('remove'), HELP.remove)
    .argument('<workspace>', 'Profile name, workspace ID, or workspace name')
    .action(async (identifier) => {
      try {
        await removeWorkspace(identifier);
        success(`Removed workspace ${identifier}`);
      } catch (err: any) {
        error('Failed to remove workspace', err.message);
        process.exit(1);
      }
    });

  // Logout (clear all workspaces)
  describeCommand(auth.command('logout'), HELP.logout)
    .option('--keep-browser-session', 'Leave the login-auto browser profile signed in (login-auto can still sign in without prompting)')
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
  describeCommand(auth.command('extract-tokens'), HELP.extractTokens)
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
  describeCommand(auth.command('parse-curl'), HELP.parseCurl)
    .argument('[curl-command]', 'cURL command copied from DevTools (or use --from-clipboard, stdin, or interactive paste)')
    .option('--login', 'Automatically login with extracted tokens')
    .option('--from-clipboard', 'Read cURL command from system clipboard')
    .option('--secret-backend <backend>', 'With --login: where to store credentials for a NEW profile: file (default) or keychain (macOS only)', 'file')
    .action(async (curlCommand, options) => {
      const secretBackend = options.login ? resolveSecretBackend(options.secretBackend) : 'file';
      try {
        const clipboardSpinner = ora('Reading from clipboard...');
        const resolved = await resolveCurlInput(curlCommand, {
          fromClipboard: options.fromClipboard,
          onProgress: () => clipboardSpinner.start(),
        });
        if (!resolved.ok) {
          reportCurlInputFailure(resolved, clipboardSpinner);
          process.exit(1);
        }
        if (resolved.source === 'clipboard') {
          clipboardSpinner.succeed('Read from clipboard');
        }
        const curlInput = resolved.input;

        console.log(chalk.bold('\n🔍 Parsing cURL command...\n'));

        // Parse the cURL command
        const parsed = parseCurlCommand(curlInput);

        // Display extracted tokens
        success('✅ Successfully extracted tokens!\n');
        console.log(chalk.bold('Workspace:'));
        console.log(`  Name: ${chalk.cyan(parsed.workspaceName)}`);
        console.log(`  URL:  ${chalk.cyan(parsed.workspaceUrl)}\n`);

        const tokenLength = (token: string) => chalk.gray(`(${token.length} chars)`);
        console.log(chalk.bold('Tokens:'));
        console.log(`  xoxd: ${chalk.green(parsed.xoxd.substring(0, 20))}...${tokenLength(parsed.xoxd)}`);
        console.log(`  xoxc: ${chalk.green(parsed.xoxc.substring(0, 20))}...${tokenLength(parsed.xoxc)}\n`);

        // If --login flag is set, authenticate directly
        if (options.login) {
          await loginWithParsedTokens(parsed, secretBackend);
        } else {
          printLoginHint(parsed);
        }
      } catch (err: any) {
        error('Failed to parse cURL command', err.message);
        console.log(chalk.yellow('\n💡 Tip: Right-click on a Slack API request in browser DevTools'));
        console.log(chalk.yellow('   → Copy → Copy as cURL, then paste here\n'));
        process.exit(1);
      }
    });

  // Move stored credentials to a different SecretStore backend
  describeCommand(auth.command('migrate-secrets'), HELP.migrateSecrets)
    .requiredOption('--to <backend>', 'Target backend: file or keychain (macOS only)')
    .option('--profile <name>', 'Migrate only this profile (default: every configured profile)')
    .option('--yes', 'Skip the confirmation prompt', false)
    .action(async (options) => {
      const target = resolveSecretBackend(options.to);

      const prompt = options.profile
        ? `Migrate profile "${options.profile}" to the ${target} backend?`
        : `Migrate every configured profile to the ${target} backend?`;
      if (!(await confirmWrite(prompt, options.yes))) {
        process.exit(1);
      }

      const spinner = ora('Migrating credentials...').start();
      try {
        const { results, failed } = await migrateSecrets(target, options.profile);
        const moved = results.filter((r) => r.migrated);
        const already = results.filter((r) => !r.migrated && !r.pendingCleanup);
        // The new backend already holds a verified copy for every one of
        // these — only the old copy's removal is outstanding, so this is
        // never counted as a failure, just flagged for a later retry.
        const pendingCleanup = results.filter((r) => r.pendingCleanup);

        if (moved.length === 0 && pendingCleanup.length === 0 && failed.length === 0) {
          spinner.succeed(
            already.length > 0
              ? `Already on the ${target} backend — nothing to migrate.`
              : 'No matching profile found.'
          );
        } else if (failed.length === 0) {
          spinner.succeed(`Migrated ${moved.length} profile${moved.length === 1 ? '' : 's'} to ${target}.`);
        } else {
          spinner.warn(`Migrated ${moved.length}, ${failed.length} failed.`);
        }

        moved.filter((r) => !r.pendingCleanup).forEach((r) => success(`${r.key}: ${r.from} -> ${r.to}`));
        already.forEach((r) => info(`${r.key}: already on ${r.to}`));
        pendingCleanup.forEach((r) => warning(
          `${r.key}: now on ${r.to}, but the old ${r.pendingCleanup} copy could not be removed yet — re-run this command to retry.`
        ));
        failed.forEach((f) => error(`${f.key}: ${f.error}`));

        if (failed.length > 0) process.exit(1);
      } catch (err: any) {
        spinner.fail('Migration failed');
        error(err.message);
        process.exit(1);
      }
    });

  return auth;
}
