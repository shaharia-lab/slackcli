/**
 * Resolves the message text of `messages send`, `edit` and `draft` from
 * `--message`, `--message-file <path>` or `--message-file -` (standard input).
 *
 * Standard input is reached through `MessageInputDeps` so tests never touch
 * the real stdin (same seam idea as `curl-input.ts`).
 */

import { readFile } from 'node:fs/promises';
import { isatty } from 'node:tty';
import { getLogger } from '@logtape/logtape';
import { InvalidInputError } from './cli-errors.ts';

const logger = getLogger(['slackcli', 'message-input']);

/** The `--message-file` value that means "read standard input". */
export const STDIN_PATH = '-';

/**
 * Hard ceiling on what is read from stdin. A Slack message holds about 40 KB,
 * so anything past 1 MB is a mistake (the wrong pipe, an endless producer) and
 * must fail instead of being buffered.
 */
export const MAX_STDIN_BYTES = 1024 * 1024;

/**
 * How long the whole read may take. It is a backstop against a pipe nobody
 * ever closes (an unattended run would hang forever), so it is generous: a
 * producer that needs minutes, such as a build, still gets its text through.
 */
export const STDIN_TIMEOUT_MS = 5 * 60_000;

export interface MessageTextOptions {
  message?: string;
  messageFile?: string;
}

export interface MessageInputDeps {
  isStdinTTY: () => boolean;
  readStdin: () => Promise<string>;
  readFile: (path: string) => Promise<string>;
}

export interface StreamLimits {
  maxBytes: number;
  timeoutMs: number;
}

/** The part of a readable stream `readStreamText()` uses. */
export interface TextSource {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
  destroy?(): unknown;
}

/**
 * Read a stream to its end as UTF-8, bounded in size and time.
 *
 * Three things end the read, and each one detaches every listener and
 * destroys the stream so nothing keeps buffering or keeps the process alive:
 * end of input (`end`, `close`, or a zero-length chunk, which is what a read
 * at end of file returns and which some runtimes deliver as data), more than
 * `maxBytes`, and `timeoutMs` without end of input.
 */
export function readStreamText(
  stream: TextSource,
  limits: StreamLimits = { maxBytes: MAX_STDIN_BYTES, timeoutMs: STDIN_TIMEOUT_MS }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('close', onEnd);
      stream.off('error', onError);
      stream.destroy?.();
      if (err) {
        reject(err);
      } else {
        resolve(Buffer.concat(chunks).toString('utf-8'));
      }
    };

    const onData = (chunk: Buffer | string) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : chunk;
      if (bytes.length === 0) {
        finish();
        return;
      }
      total += bytes.length;
      if (total > limits.maxBytes) {
        finish(new Error(`input is larger than ${limits.maxBytes} bytes`));
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => finish();
    const onError = (err: unknown) => finish(err instanceof Error ? err : new Error(String(err)));

    const timer = setTimeout(
      () => finish(new Error(`no end of input after ${limits.timeoutMs / 1000} s; the writing side of the pipe is still open`)),
      limits.timeoutMs
    );

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('close', onEnd);
    stream.on('error', onError);
  });
}

const defaultDeps: MessageInputDeps = {
  // File descriptor 0 is asked directly: deciding must not open process.stdin.
  isStdinTTY: () => isatty(0),
  readStdin: () => readStreamText(process.stdin),
  readFile: (path) => readFile(path, 'utf8'),
};

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// `printf '%s\n'`, `echo` and a heredoc all end the text with one newline the
// caller did not mean to send. Exactly one is dropped; any further blank lines
// were written on purpose.
function stripShellNewline(text: string): string {
  if (text.endsWith('\r\n')) return text.slice(0, -2);
  if (text.endsWith('\n')) return text.slice(0, -1);
  return text;
}

async function readFromStdin(deps: MessageInputDeps): Promise<string> {
  // A terminal on stdin would wait for typing that an agent never sends, so
  // refuse before reading anything.
  if (deps.isStdinTTY()) {
    throw new InvalidInputError(
      '--message-file - reads the message from standard input, but stdin is a terminal; pipe the text in',
      'printf \'%s\' "$TEXT" | slackcli messages send ... --message-file -'
    );
  }

  let text: string;
  try {
    text = await deps.readStdin();
  } catch (err) {
    throw new InvalidInputError(`Cannot read message from standard input: ${reason(err)}`);
  }

  if (!text.trim()) {
    throw new InvalidInputError('Message file - (standard input) is empty');
  }
  return stripShellNewline(text);
}

async function readFromFile(path: string, deps: MessageInputDeps): Promise<string> {
  let text: string;
  try {
    text = await deps.readFile(path);
  } catch (err) {
    throw new InvalidInputError(`Cannot read message file ${path}: ${reason(err)}`);
  }

  if (!text.trim()) {
    throw new InvalidInputError(`Message file ${path} is empty`);
  }
  return text;
}

// Resolve the message text from either --message or --message-file.
//
// Commander enforces the mutual exclusion, so this only has to cover the cases
// it cannot: neither flag given (--message can no longer be a requiredOption
// once --message-file can supply the same value), and a file or stdin that
// carries nothing worth sending. Both must fail before any Slack call, so a
// bad invocation never half-posts. Only `-` itself means stdin; `./-` is a file.
export async function resolveMessageText(
  options: MessageTextOptions,
  deps: MessageInputDeps = defaultDeps
): Promise<string> {
  if (options.messageFile !== undefined) {
    const path = options.messageFile;
    if (!path) {
      throw new InvalidInputError('--message-file path cannot be empty');
    }

    const fromStdin = path === STDIN_PATH;
    const text = fromStdin ? await readFromStdin(deps) : await readFromFile(path, deps);
    logger.debug('message text resolved', { source: fromStdin ? 'stdin' : 'file', length: text.length });
    return text;
  }

  if (options.message === undefined) {
    throw new InvalidInputError('Either --message or --message-file is required');
  }
  logger.debug('message text resolved', { source: 'argument', length: options.message.length });
  return options.message;
}
