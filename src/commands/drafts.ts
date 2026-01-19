import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { success, error } from '../lib/formatter.ts';

export function createDraftsCommand(): Command {
  const drafts = new Command('drafts')
    .description('Manage message drafts (requires browser auth)');

  // List drafts
  drafts
    .command('list')
    .description('List drafts (by default shows only active/unsent drafts)')
    .option('--all', 'Show all drafts including sent and deleted')
    .option('--workspace <id|name>', 'Workspace to use')
    .action(async (options) => {
      const spinner = ora('Fetching drafts...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);
        const response = await client.listDrafts();

        spinner.stop();

        if (!response.drafts || response.drafts.length === 0) {
          success('No drafts found');
          return;
        }

        // Filter drafts based on --all flag
        let draftsToShow = response.drafts;
        if (!options.all) {
          // Only show active drafts (not deleted and not sent)
          draftsToShow = response.drafts.filter(
            (d: any) => !d.is_deleted && !d.is_sent
          );
        }

        if (draftsToShow.length === 0) {
          success('No active drafts found (use --all to see sent/deleted drafts)');
          return;
        }

        const label = options.all ? 'All Drafts' : 'Active Drafts';
        console.log(chalk.bold(`\n📝 ${label} (${draftsToShow.length})\n`));

        draftsToShow.forEach((draft: any, idx: number) => {
          // Extract text from blocks if present
          let text = '';
          if (draft.blocks && draft.blocks.length > 0) {
            const block = draft.blocks[0];
            if (block.elements && block.elements.length > 0) {
              const section = block.elements[0];
              if (section.elements && section.elements.length > 0) {
                text = section.elements.map((el: any) => el.text || '').join('');
              }
            }
          }
          const preview = text.substring(0, 60) + (text.length > 60 ? '...' : '');

          // Get destination channel
          const channel = draft.destinations?.[0]?.channel_id || 'Unknown';

          // Status indicator
          let status = '';
          if (options.all) {
            if (draft.is_deleted) {
              status = chalk.red(' [deleted]');
            } else if (draft.is_sent) {
              status = chalk.blue(' [sent]');
            } else {
              status = chalk.green(' [active]');
            }
          }

          console.log(`${chalk.dim(`${idx + 1}.`)} ${chalk.bold(draft.id)}${status}`);
          console.log(`   ${chalk.dim('Channel:')} ${channel}`);
          console.log(`   ${chalk.dim('Preview:')} ${preview || '(empty)'}`);
          console.log();
        });

        success(`Found ${draftsToShow.length} draft(s)`);
      } catch (err: any) {
        spinner.fail('Failed to fetch drafts');
        error(err.message);
        process.exit(1);
      }
    });

  // Create draft
  drafts
    .command('create')
    .description('Create a new draft')
    .requiredOption('--channel-id <id>', 'Channel ID to create draft for')
    .requiredOption('--text <text>', 'Draft message text')
    .option('--workspace <id|name>', 'Workspace to use')
    .action(async (options) => {
      const spinner = ora('Creating draft...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);
        const response = await client.createDraft({
          channelId: options.channelId,
          text: options.text,
        });

        spinner.succeed('Draft created successfully!');
        if (response.draft?.id) {
          success(`Draft ID: ${response.draft.id}`);
        }
      } catch (err: any) {
        spinner.fail('Failed to create draft');
        error(err.message);
        process.exit(1);
      }
    });

  // Delete draft
  drafts
    .command('delete')
    .description('Delete a draft')
    .requiredOption('--draft-id <id>', 'Draft ID to delete')
    .option('--workspace <id|name>', 'Workspace to use')
    .action(async (options) => {
      const spinner = ora('Deleting draft...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);
        await client.deleteDraft(options.draftId);

        spinner.succeed('Draft deleted successfully!');
      } catch (err: any) {
        spinner.fail('Failed to delete draft');
        error(err.message);
        process.exit(1);
      }
    });

  return drafts;
}
