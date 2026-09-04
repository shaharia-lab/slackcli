import { Command } from 'commander';
import ora from 'ora';
import { open, rm } from 'node:fs/promises';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { isAuthPage } from '../lib/canvas-parser.ts';
import { error, formatFileSize, warning, writeJson } from '../lib/formatter.ts';
import { normalizeIdentifier, workspaceMismatchWarning, workspaceOf } from '../lib/slack-url-parser.ts';
import type { SlackClient } from '../lib/slack-client.ts';
import type { SlackFile } from '../types/index.ts';

const MAX_TEXT_FILE_SIZE = 10 * 1024 * 1024;

interface FileContent {
  source: 'plain_text' | 'original';
  content: string;
}

const TEXT_MIME_TYPES = new Set([
  'application/javascript',
  'application/json',
  'application/rtf',
  'application/sql',
  'application/xml',
  'application/x-httpd-php',
  'application/x-sh',
  'message/rfc822',
]);

function warnOnWorkspaceMismatch(client: SlackClient, linkWorkspace: string | undefined): void {
  const message = workspaceMismatchWarning(linkWorkspace, client.workspaceHost);
  if (message) warning(message);
}

function fileFromResponse(response: { file?: SlackFile }): SlackFile {
  if (!response.file) throw new Error('File not found');
  return response.file;
}

function fileDownloadUrl(file: SlackFile): string {
  const url = file.url_private_download || file.url_private;
  if (!url) throw new Error('No download URL is available for this file');
  return url;
}

export function isTextFile(file: SlackFile): boolean {
  if (file.filetype?.toLowerCase() === 'email') return true;
  const mimeType = file.mimetype?.split(';', 1)[0]?.trim().toLowerCase();
  if (!mimeType) return false;
  return mimeType.startsWith('text/')
    || mimeType.endsWith('+json')
    || mimeType.endsWith('+xml')
    || TEXT_MIME_TYPES.has(mimeType);
}

function isEmailFile(file: SlackFile): boolean {
  return file.filetype?.toLowerCase() === 'email'
    || file.mode?.toLowerCase() === 'email'
    || file.mimetype?.toLowerCase() === 'message/rfc822'
    || file.mimetype?.toLowerCase() === 'application/vnd.slack-email';
}

export function extractedFileContent(
  file: SlackFile,
  raw: boolean,
): FileContent | null {
  if (!raw && isEmailFile(file) && file.plain_text?.trim()) {
    return { source: 'plain_text', content: file.plain_text };
  }
  return null;
}

export async function isAuthenticationResponse(response: Response, file: SlackFile): Promise<boolean> {
  if (/\/(?:signin|ssb\/signin)(?:\/|$)/i.test(response.url)) return true;

  const responseType = response.headers.get('content-type')?.toLowerCase();
  const fileType = file.mimetype?.toLowerCase();
  if (!responseType?.includes('text/html') || fileType === 'text/html') return false;

  const reader = response.clone().body?.getReader();
  if (!reader) return false;
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  while (bytesRead < 64 * 1024) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value.subarray(0, 64 * 1024 - bytesRead);
    chunks.push(chunk);
    bytesRead += chunk.byteLength;
  }
  void reader.cancel().catch(() => {});

  const prefix = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    prefix.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return isAuthPage(new TextDecoder().decode(prefix));
}

export function formatFileInfo(file: SlackFile): string {
  const title = file.title || file.name || 'Untitled';
  const lines = [`📎 ${title}`, `ID: ${file.id}`];
  if (file.name) lines.push(`Name: ${file.name}`);
  if (file.pretty_type) lines.push(`Type: ${file.pretty_type}`);
  if (file.mimetype) lines.push(`MIME type: ${file.mimetype}`);
  if (file.size !== undefined) lines.push(`Size: ${formatFileSize(file.size)} (${file.size} bytes)`);
  if (file.user) lines.push(`Owner: ${file.user}`);
  const created = file.created ?? file.timestamp;
  if (created !== undefined) lines.push(`Created: ${new Date(created * 1000).toISOString()}`);
  if (file.permalink) lines.push(`Permalink: ${file.permalink}`);
  return lines.join('\n');
}

export async function writeResponseToFile(response: Response, outputPath: string): Promise<number> {
  const handle = await open(outputPath, 'wx');
  let bytesWritten = 0;

  try {
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        let offset = 0;
        while (offset < value.byteLength) {
          const result = await handle.write(value, offset, value.byteLength - offset);
          offset += result.bytesWritten;
        }
        bytesWritten += value.byteLength;
      }
    }
    await handle.close();
    return bytesWritten;
  } catch (err) {
    await handle.close().catch(() => {});
    await rm(outputPath, { force: true });
    throw err;
  }
}

export function createFilesCommand(): Command {
  const files = new Command('files')
    .description('Inspect, read, and download Slack files');

  files
    .command('info')
    .description('Show metadata for a Slack file')
    .argument('<file-id-or-url>', 'Slack file ID or URL')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (input, options) => {
      const spinner = ora('Fetching file metadata...').start();

      try {
        const fileId = normalizeIdentifier(input, 'file', '<file-id-or-url>');
        const client = await getAuthenticatedClient(options.workspace);
        warnOnWorkspaceMismatch(client, workspaceOf(input));
        const file = fileFromResponse(await client.getFileInfo(fileId));

        spinner.succeed(`File: ${file.title || file.name || file.id}`);
        if (options.json) {
          writeJson(file);
          return;
        }
        console.log('\n' + formatFileInfo(file));
      } catch (err: any) {
        spinner.fail('Failed to fetch file metadata');
        error(err.message);
        process.exit(1);
      }
    });

  files
    .command('read')
    .description('Print the content of a textual Slack file')
    .argument('<file-id-or-url>', 'Slack file ID or URL')
    .option('--raw', 'Read the original file instead of Slack-extracted plain text', false)
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (input, options) => {
      const spinner = ora('Fetching file...').start();

      try {
        const fileId = normalizeIdentifier(input, 'file', '<file-id-or-url>');
        const client = await getAuthenticatedClient(options.workspace);
        warnOnWorkspaceMismatch(client, workspaceOf(input));
        const file = fileFromResponse(await client.getFileInfo(fileId));

        let result = extractedFileContent(file, options.raw);
        if (!result) {
          if (!isTextFile(file)) {
            throw new Error(
              `This file is not textual (${file.mimetype || 'unknown MIME type'}). ` +
              'Use files download instead.',
            );
          }
          spinner.text = 'Downloading file content...';
          const content = await client.downloadFile(fileDownloadUrl(file), MAX_TEXT_FILE_SIZE);
          if (isAuthPage(content)) {
            throw new Error('The downloaded content is a Slack sign-in page. Your token may have expired.');
          }
          result = { source: 'original', content };
        }

        spinner.succeed(`File: ${file.title || file.name || file.id}`);
        if (options.json) {
          writeJson({
            id: file.id,
            name: file.name,
            title: file.title,
            mimetype: file.mimetype,
            source: result.source,
            content: result.content,
          });
          return;
        }
        process.stdout.write(result.content + (result.content.endsWith('\n') ? '' : '\n'));
      } catch (err: any) {
        spinner.fail('Failed to read file');
        error(err.message);
        process.exit(1);
      }
    });

  files
    .command('download')
    .description('Download the original Slack file')
    .argument('<file-id-or-url>', 'Slack file ID or URL')
    .requiredOption('--output <path>', 'Path for the downloaded file')
    .option('--workspace <id|name>', 'Workspace to use')
    .action(async (input, options) => {
      const spinner = ora('Downloading file...').start();

      try {
        const fileId = normalizeIdentifier(input, 'file', '<file-id-or-url>');
        const client = await getAuthenticatedClient(options.workspace);
        warnOnWorkspaceMismatch(client, workspaceOf(input));
        const file = fileFromResponse(await client.getFileInfo(fileId));
        const response = await client.fetchFile(fileDownloadUrl(file));
        if (await isAuthenticationResponse(response, file)) {
          await response.body?.cancel();
          throw new Error('The downloaded content is a Slack sign-in page. Your token may have expired.');
        }
        const bytesWritten = await writeResponseToFile(response, options.output);

        spinner.succeed(`Downloaded ${bytesWritten} bytes to ${options.output}`);
      } catch (err: any) {
        spinner.fail('Failed to download file');
        if (err?.code === 'EEXIST') {
          error(`Output file already exists: ${options.output}`);
        } else {
          error(err.message);
        }
        process.exit(1);
      }
    });

  return files;
}
