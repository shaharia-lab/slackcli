#!/usr/bin/env bun

import { Command } from 'commander';
import { createAuthCommand } from './commands/auth.ts';
import { createConversationsCommand } from './commands/conversations.ts';
import { createMessagesCommand } from './commands/messages.ts';
import { createCanvasCommand } from './commands/canvas.ts';
import { createUpdateCommand } from './commands/update.ts';
import { createSavedCommand } from './commands/saved.ts';
import { createSearchCommand } from './commands/search.ts';
import { notifyIfUpdateAvailable } from './lib/updater.ts';
import chalk from 'chalk';

const program = new Command();

// @ts-ignore - This will be replaced at build time
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';

program
  .name('slackcli')
  .description('A fast, developer-friendly CLI tool for interacting with Slack workspaces')
  .version(APP_VERSION);

// Add commands
program.addCommand(createAuthCommand());
program.addCommand(createCanvasCommand());
program.addCommand(createConversationsCommand());
program.addCommand(createMessagesCommand());
program.addCommand(createSavedCommand());
program.addCommand(createSearchCommand());
program.addCommand(createUpdateCommand());

// Show update notification after command output if a newer version is cached
notifyIfUpdateAvailable();

// Parse arguments
program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
