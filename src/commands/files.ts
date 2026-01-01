import { Command } from 'commander';
import ora from 'ora';
import { writeFileSync } from 'fs';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { success, error, info } from '../lib/formatter.ts';

export function createFilesCommand(): Command {
  const files = new Command('files')
    .description('Download and read files from Slack');

  // Read file content (text-based files)
  files
    .command('read')
    .description('Read file content as text (for VTT, text files, etc.)')
    .requiredOption('--url <url>', 'File URL (url_private or url_private_download)')
    .option('--workspace <id|name>', 'Workspace to use')
    .action(async (options) => {
      const spinner = ora('Fetching file content...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);
        const content = await client.fetchFileContent(options.url);

        spinner.succeed('File content retrieved!');
        console.log('\n' + content);
      } catch (err: any) {
        spinner.fail('Failed to fetch file');
        error(err.message);
        process.exit(1);
      }
    });

  // Download file (binary)
  files
    .command('download')
    .description('Download a file to disk')
    .requiredOption('--url <url>', 'File URL (url_private or url_private_download)')
    .requiredOption('--output <path>', 'Output file path')
    .option('--workspace <id|name>', 'Workspace to use')
    .action(async (options) => {
      const spinner = ora('Downloading file...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);
        const buffer = await client.fetchFileBinary(options.url);

        writeFileSync(options.output, Buffer.from(buffer));

        spinner.succeed('File downloaded successfully!');
        success(`Saved to: ${options.output}`);
        info(`Size: ${buffer.byteLength} bytes`);
      } catch (err: any) {
        spinner.fail('Failed to download file');
        error(err.message);
        process.exit(1);
      }
    });

  return files;
}
