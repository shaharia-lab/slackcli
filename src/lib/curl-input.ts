/**
 * Resolves where `auth parse-curl` reads its cURL command from.
 *
 * Priority: the positional argument, then `--from-clipboard`, then piped
 * stdin, then an interactive prompt on a TTY. The function never prints or
 * exits — it returns a typed result and the command maps it to output. The
 * clipboard, stdin and TTY are reached through `CurlInputDeps` so tests can
 * stub them (same seam idea as `cdp-client.ts`).
 */

import { readClipboard, type ClipboardResult } from './clipboard.ts';
import { looksLikeCurlCommand } from './curl-parser.ts';
import { readInteractiveInput, isInteractiveTerminal, hasPipedInput } from './interactive-input.ts';

export type CurlInputSource = 'argument' | 'clipboard' | 'stdin' | 'interactive';

export type CurlInputResult =
  | { ok: true; input: string; source: CurlInputSource }
  | { ok: false; reason: 'clipboard-failed'; source: 'clipboard'; message: string }
  | { ok: false; reason: 'not-curl'; source: 'clipboard' }
  // `source` is undefined when no source applied (no argument, no
  // `--from-clipboard`, no piped stdin, no TTY).
  | { ok: false; reason: 'empty'; source?: CurlInputSource };

export type CurlInputProgress = 'clipboard-read-start';

export interface CurlInputOptions {
  fromClipboard?: boolean;
  onProgress?: (event: CurlInputProgress) => void;
}

export interface CurlInputDeps {
  readClipboard: () => Promise<ClipboardResult>;
  hasPipedInput: () => boolean;
  isInteractiveTerminal: () => boolean;
  readStdin: () => Promise<string>;
  readInteractive: () => Promise<string>;
}

async function readProcessStdin(): Promise<string> {
  const stdinChunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    stdinChunks.push(chunk);
  }
  return stdinChunks.length > 0 ? Buffer.concat(stdinChunks).toString('utf-8') : '';
}

const defaultDeps: CurlInputDeps = {
  readClipboard,
  hasPipedInput,
  isInteractiveTerminal,
  readStdin: readProcessStdin,
  readInteractive: () =>
    readInteractiveInput({
      prompt: 'Paste your cURL command (press Enter twice when done):',
      hint: 'Copy the cURL command from browser DevTools (Right-click → Copy → Copy as cURL)',
    }),
};

function withInput(input: string, source: CurlInputSource): CurlInputResult {
  return input.trim() === '' ? { ok: false, reason: 'empty', source } : { ok: true, input, source };
}

async function fromClipboard(
  deps: CurlInputDeps,
  onProgress?: (event: CurlInputProgress) => void,
): Promise<CurlInputResult> {
  onProgress?.('clipboard-read-start');
  const clipboardResult = await deps.readClipboard();
  if (!clipboardResult.success) {
    return {
      ok: false,
      reason: 'clipboard-failed',
      source: 'clipboard',
      message: clipboardResult.error || 'Unknown clipboard error',
    };
  }

  const content = clipboardResult.content || '';
  if (!looksLikeCurlCommand(content)) {
    return { ok: false, reason: 'not-curl', source: 'clipboard' };
  }
  return withInput(content, 'clipboard');
}

export async function resolveCurlInput(
  curlCommand: string | undefined,
  options: CurlInputOptions = {},
  deps: CurlInputDeps = defaultDeps,
): Promise<CurlInputResult> {
  if (curlCommand) {
    return withInput(curlCommand, 'argument');
  }
  if (options.fromClipboard) {
    return fromClipboard(deps, options.onProgress);
  }
  if (deps.hasPipedInput()) {
    return withInput(await deps.readStdin(), 'stdin');
  }
  if (deps.isInteractiveTerminal()) {
    return withInput(await deps.readInteractive(), 'interactive');
  }
  return { ok: false, reason: 'empty' };
}
