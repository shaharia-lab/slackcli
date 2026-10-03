#!/usr/bin/env bun

import chalk from 'chalk';
import { createProgram } from './program.ts';
import { notifyIfUpdateAvailable } from './lib/updater.ts';
import { renderBanner, shouldShowBanner, shouldUseColor, supportsUnicode } from './lib/banner.ts';
import { getAppVersion } from './version.ts';

const program = createProgram();

// Show update notification after command output if a newer version is cached.
// Not awaited on purpose: the notice prints from a `beforeExit` handler, and
// awaiting would hold up the command on the background release check.
void notifyIfUpdateAvailable();

// Bare `slackcli` in a terminal gets the welcome screen and exits 0. Anything
// else, including a bare run from a script or pipe, goes to Commander, which
// prints help to stderr and exits 1 when no command is given.
if (shouldShowBanner({ args: process.argv.slice(2), isTTY: process.stdout.isTTY })) {
  process.stdout.write(renderBanner({
    version: getAppVersion(),
    columns: process.stdout.columns || 80,
    unicode: supportsUnicode(process.env, process.platform),
    color: shouldUseColor(process.env, chalk.level),
  }));
} else {
  program.parse(process.argv);
}
