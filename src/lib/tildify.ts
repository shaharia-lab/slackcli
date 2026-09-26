// Path display for log records. Lives in its own module so any lib can use it
// without importing `logger.ts` (which imports `updater.ts`; see the note there).

/** Replaces a leading home directory with `~`, so logs do not carry the username. */
export function tildify(path: string, home: string): string {
  if (!home) return path;
  if (path === home) return '~';
  for (const separator of ['/', '\\']) {
    if (path.startsWith(home + separator)) return `~${path.slice(home.length)}`;
  }
  return path;
}
