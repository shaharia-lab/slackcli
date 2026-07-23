#!/usr/bin/env bun
/**
 * Compile slackcli, injecting package.json version as __APP_VERSION__.
 * Usage: bun run scripts/build.ts [extra bun build args...]
 * Example: bun run scripts/build.ts --target=bun-linux-x64 --outfile=dist/slackcli-linux
 */
import { join } from 'path';
import { version } from '../package.json';

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
