import packageJson from '../package.json';

declare const __APP_VERSION__: string | undefined;

/** App version: bake-time define for compiled binaries, else package.json. */
export function getAppVersion(): string {
  if (typeof __APP_VERSION__ !== 'undefined') {
    return __APP_VERSION__;
  }
  return packageJson.version;
}

/** True when running via the Bun interpreter (source / `bun run`), not a compiled binary. */
export function isRunningUnderBun(): boolean {
  const base = process.execPath.split(/[/\\]/).pop() ?? '';
  return base === 'bun' || base === 'bun.exe';
}
