#!/usr/bin/env bun
/**
 * Compile slackcli, injecting package.json version as __APP_VERSION__.
 * Usage: bun run scripts/build.ts [extra bun build args...]
 * Example: bun run scripts/build.ts --target=bun-linux-x64 --outfile=dist/slackcli-linux
 */
import { join } from 'node:path';

/**
 * Oldest Bun that can build slackcli: the first release where `--bytecode`
 * works with `--format=esm` for every target we ship. Move it together with
 * the Bun pin in the workflows (docs/development/build-and-release.md).
 */
export const MIN_BUN_VERSION = '1.4.1';

// A full MAJOR.MINOR.PATCH version with optional prerelease and build parts —
// the shape Bun.version always has.
const FULL_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Returns an error message when `bunVersion` is older than MIN_BUN_VERSION or
 * is not a full version, otherwise null. Uses Bun.semver.order rather than
 * Bun.semver.satisfies, which rejects every prerelease and so would turn away
 * a newer canary such as 1.5.0-canary.1. order() is lenient about malformed
 * input (it ranks "1.4" above "1.4.1", and throws on "garbage"), hence the
 * shape check first. Bun.semver itself only exists from Bun 1.0.11, so
 * `order` is optional: without it the Bun is too old by definition.
 */
export function checkBunVersion(
  bunVersion: string,
  order: typeof Bun.semver.order | null | undefined = Bun.semver?.order,
): string | null {
  const supported = !!order && FULL_VERSION.test(bunVersion) && order(bunVersion, MIN_BUN_VERSION) >= 0;
  if (supported) return null;
  return (
    `slackcli builds need Bun >= ${MIN_BUN_VERSION} (found ${bunVersion}). ` +
    'See docs/development/build-and-release.md#why-bun-is-pinned'
  );
}

async function build(): Promise<never> {
  // Imported here, after the version check: Bun 1.0.0 cannot import a named
  // export from JSON, and a top-level import would fail before the check ran.
  const { version } = await import('../package.json');
  const outfileArg = process.argv.find((a) => a.startsWith('--outfile='));
  const outfile = outfileArg?.slice('--outfile='.length) ?? 'dist/slackcli';
  const extraArgs = process.argv.slice(2).filter((a) => !a.startsWith('--outfile='));
  const hasTarget = extraArgs.some((a) => a.startsWith('--target='));
  const cwd = join(import.meta.dir, '..');

  const result = Bun.spawnSync(
    [
      'bun',
      'build',
      '--compile',
      '--minify',
      // Precompiled bytecode roughly halves cold start for a few MB of binary
      // (#137). --bytecode defaults the output to CJS; --format=esm keeps the
      // module semantics of a plain build and is what --splitting requires.
      '--bytecode',
      '--splitting',
      '--format=esm',
      ...(hasTarget ? [] : ['--sourcemap']),
      ...extraArgs,
      '--define',
      `__APP_VERSION__=${JSON.stringify(version)}`,
      'src/index.ts',
      `--outfile=${outfile}`,
    ],
    { stdout: 'inherit', stderr: 'inherit', cwd },
  );

  process.exit(result.exitCode ?? 1);
}

// Guarded so the tests can import checkBunVersion without starting a build.
if (import.meta.main) {
  const problem = checkBunVersion(Bun.version);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  await build();
}
