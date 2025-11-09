import { Command } from 'commander';
import { checkForUpdates, performUpdate, getCurrentVersion } from '../lib/updater.ts';
import { success, error, info } from '../lib/formatter.ts';

export function createUpdateCommand(): Command {
  const update = new Command('update')
    .description('Check for and install updates')
    .action(async () => {
      try {
        await performUpdate();
      } catch (err: any) {
        error('Update failed', err.message);
        process.exit(1);
      }
    });

  // Check for updates
  update
    .command('check')
    .description('Check for available updates')
    .action(async () => {
      try {
        const result = await checkForUpdates(false);

        info(`Current version: v${result.currentVersion}`);

        if (result.updateAvailable && result.latestVersion) {
          info(`Latest version: ${result.latestVersion}`);
          success('Update available! Run "slackcli update" to update.');
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

