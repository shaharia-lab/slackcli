import { Command } from 'commander';
import { checkForUpdates, getUpdateHint, performUpdate, quoteCommand } from '../lib/updater.ts';
import { success, error, info } from '../lib/formatter.ts';
import { describeCommand, type CommandHelp } from '../lib/help.ts';

// --help content, kept apart from the command chains below (#324).
const HELP = {
  group: {
    summary: 'Install the latest slackcli release',
    description:
      'Download the latest release binary for this platform from GitHub, verify its SHA-256 digest, and ' +
      'replace the running binary in place. Use "update check" to only report whether a newer version exists.',
    examples: [
      'slackcli update check',
      'slackcli update',
    ],
    notes: [
      'Acts immediately, with no confirmation prompt. Restart slackcli afterwards to use the new version.',
      'Does nothing when installed via Homebrew (prints "brew upgrade slackcli") or run from source with bun (prints "git pull").',
      'Stops before downloading when the install folder is not writable: re-run as "sudo slackcli update", ' +
        'or from an Administrator terminal on Windows.',
    ],
  },
  check: {
    summary: 'Check whether a newer release exists',
    description:
      'Ask GitHub for the latest release and print the current and latest versions. ' +
      'Changes nothing; run "slackcli update" to install.',
    examples: ['slackcli update check'],
    notes: [
      'Always queries GitHub, ignoring the update-notice cache and SLACKCLI_NO_UPDATE_NOTIFIER.',
      'When GitHub cannot be reached it prints "Unable to check for updates", then the up-to-date message, and exits 0.',
    ],
  },
} satisfies Record<string, CommandHelp>;

export function createUpdateCommand(): Command {
  const update = describeCommand(new Command('update'), HELP.group)
    .action(async () => {
      try {
        await performUpdate();
      } catch (err: any) {
        error('Update failed', err.message);
        process.exit(1);
      }
    });

  // Check for updates
  describeCommand(update.command('check'), HELP.check)
    .action(async () => {
      try {
        const result = await checkForUpdates(false);

        info(`Current version: v${result.currentVersion}`);

        if (result.updateAvailable && result.latestVersion) {
          info(`Latest version: ${result.latestVersion}`);
          success(`Update available! Run ${getUpdateHint(quoteCommand)} to update.`);
        } else {
          success('You are on the latest version!');
        }
      } catch (err: any) {
        error('Failed to check for updates', err.message);
        process.exit(1);
      }
    });

  return update;
}
