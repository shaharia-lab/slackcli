import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { error, info, success, warning, writeJson } from '../lib/formatter.ts';
import { resolveLogDir } from '../lib/logger.ts';
import {
  clearLogs,
  formatRunsText,
  logFilePath,
  parseLastOption,
  readRuns,
  selectRuns,
} from '../lib/logs.ts';
import { confirmWrite } from './usergroups.ts';

function currentLogDir(): string {
  return resolveLogDir(process.env, process.platform, homedir());
}

function loggingIsOff(): boolean {
  return process.env.SLACKCLI_LOG_LEVEL?.trim().toLowerCase() === 'off';
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createLogsCommand(): Command {
  const logs = new Command('logs')
    .description('Find, show and delete the diagnostic log (for bug reports)');

  logs
    .command('path')
    .description('Print where the log file is written')
    .option('--json', 'Output as JSON', false)
    .action((options) => {
      const dir = currentLogDir();
      const path = logFilePath(dir);
      const exists = existsSync(path);

      if (options.json) {
        writeJson({ log_path: path, log_dir: dir, exists });
        return;
      }

      console.log(path);
      if (!exists) {
        warning(loggingIsOff()
          ? 'No log file yet: logging is turned off (SLACKCLI_LOG_LEVEL=off).'
          : 'No log file yet: it is created by the next command you run.');
      }
    });

  logs
    .command('show')
    .description('Print recent runs from the log, already redacted, oldest first')
    .option('--last <n>', 'Show the last <n> runs (default 1)')
    .option('--run <run-id>', 'Show only the run with this run_id')
    .option('--json', 'Output as JSON', false)
    .action(async (options) => {
      if (options.last !== undefined && options.run !== undefined) {
        error('Use either --last or --run, not both.');
        process.exit(1);
      }

      let last: number | undefined;
      if (options.last !== undefined) {
        try {
          last = parseLastOption(options.last);
        } catch (err) {
          error(describeError(err));
          process.exit(1);
        }
      }

      const dir = currentLogDir();
      const path = logFilePath(dir);
      let result;
      try {
        result = await readRuns(dir);
      } catch (err) {
        error(`Cannot read the log in ${dir}: ${describeError(err)}`);
        process.exit(1);
      }

      if (result.skipped > 0) {
        warning(`Skipped ${result.skipped} unreadable log line(s).`);
      }

      const runs = selectRuns(result.runs, { last, runId: options.run });
      if (options.run !== undefined && runs.length === 0) {
        error(`No run with run_id "${options.run}" in the log.`, 'List recent runs with: slackcli logs show --last 10');
        process.exit(1);
      }

      if (options.json) {
        writeJson({ log_path: path, runs, skipped_lines: result.skipped });
        return;
      }

      if (runs.length === 0) {
        info(loggingIsOff()
          ? `No logs yet at ${path}: logging is turned off (SLACKCLI_LOG_LEVEL=off).`
          : `No logs yet at ${path}.`);
        return;
      }

      console.log(formatRunsText(runs));
    });

  logs
    .command('clear')
    .description('Delete the log file and its rotated copies')
    .option('--yes', 'Skip the confirmation prompt (required when stdin is not a terminal)', false)
    .action(async (options) => {
      const dir = currentLogDir();
      if (!(await confirmWrite(`Delete the slackcli log files in ${dir}?`, options.yes))) {
        process.exit(1);
      }

      try {
        const { deleted } = clearLogs(dir);
        if (deleted === 0) {
          info('No log files to delete: the log is already empty.');
        } else {
          success(`Deleted ${deleted} log file(s) from ${dir}.`);
        }
      } catch (err) {
        error(`Cannot delete the log files in ${dir}: ${describeError(err)}`);
        process.exit(1);
      }
    });

  return logs;
}
