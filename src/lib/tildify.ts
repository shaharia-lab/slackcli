// Path display for log records. Lives in its own module so any lib can use it
// without importing `logger.ts` (which imports `updater.ts`; see the note there).

import { homedir } from 'node:os';

/** Replaces a leading home directory with `~`, so logs do not carry the username. */
export function tildify(path: string, home: string): string {
  if (!home) return path;
  if (path === home) return '~';
  for (const separator of ['/', '\\']) {
    if (path.startsWith(home + separator)) return `~${path.slice(home.length)}`;
  }
  return path;
}

/**
 * `tildify()` for free text: every home-directory path inside an error message
 * or stack trace (`EACCES: permission denied, open '/home/u/…'`) becomes `~/…`.
 */
export function tildifyText(text: string, home: string): string {
  if (!home) return text;
  return text.replaceAll(`${home}/`, '~/').replaceAll(`${home}\\`, '~\\');
}

/**
 * An error's message as it may be logged: the home directory written as `~`.
 * Every `error` field in a log record goes through this, since a filesystem or
 * spawn error names the absolute path it failed on.
 */
export function errorMessageForLog(
  error: unknown,
  fallback = 'unknown error',
  home: string = homedir(),
): string {
  return tildifyText(rawErrorMessage(error) || fallback, home);
}

function rawErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error == null) return '';
  // A non-Error object would stringify as "[object Object]", and serialising
  // it could log request data, so it gets the fallback instead.
  if (typeof error === 'object') return '';
  return String(error);
}
