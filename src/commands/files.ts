import { Command } from 'commander';
import ora from 'ora';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { success, error } from '../lib/formatter.ts';

function collectFile(val: string, acc: string[]): string[] {
  acc.push(val);
  return acc;
}

export function createFilesCommand(): Command {
  const files = new Command('files')
    .description('Upload and manage files');

  // Upload file(s)
  files
    .command('upload')
    .description('Upload one or more files to a channel or thread')
    .requiredOption('--file <path>', 'Local file path (repeat for multiple files)', collectFile, [])
    .option('--channel-id <id>', 'Channel ID to share the file in')
    .option('--thread-ts <timestamp>', 'Share as reply in a thread')
    .option('--title <title>', 'File title (repeat to match each --file)', collectFile, [])
    .option('--message <text>', 'Initial comment with the file')
    .option('--workspace <id|name>', 'Workspace to use')
    .action(async (options) => {
      const filePaths: string[] = options.file.map((f: string) => resolve(f));

      for (const fp of filePaths) {
        if (!existsSync(fp)) {
          error(`File not found: ${fp}`);
          process.exit(1);
        }
      }

      const spinner = ora('Preparing upload...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);

        const response = await client.uploadFiles(filePaths, {
          channel_id: options.channelId,
          thread_ts: options.threadTs,
          titles: options.title.length > 0 ? options.title : undefined,
          initial_comment: options.message,
          onProgress: (step) => { spinner.text = step; },
        });

        const count = filePaths.length;
        spinner.succeed(`${count} file${count > 1 ? 's' : ''} uploaded successfully!`);
        if (response.files) {
          response.files.forEach((f: any) => success(`File ID: ${f.id}`));
        }
      } catch (err: any) {
        spinner.fail('Failed to upload file');
        error(err.message);
        process.exit(1);
      }
    });

  return files;
}
