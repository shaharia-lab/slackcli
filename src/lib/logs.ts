// Reading, selecting and deleting the diagnostic log files written by
// `logger.ts`, for the `slackcli logs` command.
//
// The log is JSON Lines, one record per line, and every record carries the
// `run_id` of the process that wrote it. The rotating sink renames the live
// `slackcli.log` to `slackcli.log.1` (and `.1` to `.2`, …) when it fills up, so
// one run's records can straddle two files. Reading every file oldest → newest
// and grouping by `run_id` puts each run back together.

import { createReadStream, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { RedactionPattern } from '@logtape/redaction';
import { LOG_FILE_NAME } from './logger.ts';
import { SLACK_REDACTION_PATTERNS } from './log-redaction.ts';

/** `LOG_FILE_NAME` and its rotations `slackcli.log.1`, `slackcli.log.2`, … */
const LOG_FILE_PATTERN = /^slackcli\.log(?:\.([1-9]\d*))?$/;
const POSITIVE_INTEGER = /^[1-9]\d*$/;

export type LogRecord = Record<string, unknown>;

export interface LogRun {
  run_id: string;
  records: LogRecord[];
}

export interface ReadRunsResult {
  runs: LogRun[];
  /** Lines that were not a JSON object carrying a `run_id`. Blank lines are not counted. */
  skipped: number;
}

export interface RunSelection {
  last?: number;
  runId?: string;
}

export function parseLastOption(value: string): number {
  const last = Number(value);
  if (!POSITIVE_INTEGER.test(value) || !Number.isSafeInteger(last)) {
    throw new Error('--last must be a positive integer');
  }
  return last;
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/**
 * The log files in `dir`, oldest first: `slackcli.log.<highest>` … `.1`, then
 * the live `slackcli.log`. Anything else in the directory is ignored. A missing
 * directory has no log files.
 */
export function listLogFiles(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }

  const files: { path: string; rotation: number }[] = [];
  for (const name of names) {
    const match = LOG_FILE_PATTERN.exec(name);
    if (!match) continue;
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    files.push({ path, rotation: match[1] ? Number(match[1]) : 0 });
  }

  return files.sort((a, b) => b.rotation - a.rotation).map((file) => file.path);
}

// Same call the sink's `redactByPattern()` makes; every pattern is global.
function applyPattern(text: string, { pattern, replacement }: RedactionPattern): string {
  // Narrowed so each `replaceAll` overload sees one type.
  return typeof replacement === 'string'
    ? text.replaceAll(pattern, replacement)
    : text.replaceAll(pattern, replacement);
}

/**
 * Applies the same patterns the log sink uses. The file should already be
 * redacted, but a line written by an older build, or edited by hand, may not be.
 */
export function redactText(text: string): string {
  return SLACK_REDACTION_PATTERNS.reduce(applyPattern, text);
}

function parseLine(line: string): { runId: string; record: LogRecord } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(redactText(line));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;

  const record = parsed as LogRecord;
  const properties = record.properties as Record<string, unknown> | undefined;
  const runId = properties?.run_id;
  if (typeof runId !== 'string' || runId === '') return undefined;
  return { runId, record };
}

/**
 * Reads every log file in `dir`, line by line, and groups the records by
 * `run_id`. Runs are ordered by their first record, oldest first, and each
 * run's records keep file order. Every line is redacted before it is parsed.
 */
export async function readRuns(dir: string): Promise<ReadRunsResult> {
  const runs = new Map<string, LogRecord[]>();
  let skipped = 0;

  for (const file of listLogFiles(dir)) {
    let lines: AsyncIterable<string>;
    try {
      lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
      for await (const line of lines) {
        if (line.trim() === '') continue;
        const parsed = parseLine(line);
        if (!parsed) {
          skipped += 1;
          continue;
        }
        const records = runs.get(parsed.runId);
        if (records) {
          records.push(parsed.record);
        } else {
          runs.set(parsed.runId, [parsed.record]);
        }
      }
    } catch (err) {
      // Rotated away between listing and reading.
      if (isMissing(err)) continue;
      throw err;
    }
  }

  return {
    runs: [...runs].map(([run_id, records]) => ({ run_id, records })),
    skipped,
  };
}

/**
 * `runId` picks that one run (empty when unknown); otherwise the most recent
 * `last` runs (default 1), still oldest first.
 */
export function selectRuns(runs: LogRun[], selection: RunSelection = {}): LogRun[] {
  if (selection.runId !== undefined) {
    return runs.filter((run) => run.run_id === selection.runId);
  }
  const last = selection.last ?? 1;
  return runs.slice(Math.max(0, runs.length - last));
}

function isSessionStart(record: LogRecord): boolean {
  const properties = record.properties as Record<string, unknown> | undefined;
  return properties?.event === 'session_start';
}

function formatValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function formatRecord(record: LogRecord): string {
  const { run_id: _runId, ...properties } = (record.properties as Record<string, unknown> | undefined) ?? {};
  const parts = [
    formatValue(record['@timestamp'] ?? '-'),
    formatValue(record.level ?? '-'),
    formatValue(record.logger ?? '-'),
    formatValue(record.message ?? ''),
  ];
  if (Object.keys(properties).length > 0) parts.push(JSON.stringify(properties));
  return parts.join(' ');
}

function formatHeader(record: LogRecord): string[] {
  const { run_id: _runId, event: _event, ...properties } = record.properties as Record<string, unknown>;
  const lines = [`started: ${formatValue(record['@timestamp'] ?? '-')}`];
  for (const [key, value] of Object.entries(properties)) {
    lines.push(`${key}: ${formatValue(value)}`);
  }
  return lines;
}

/**
 * Plain text for pasting into an issue: per run, the `session_start` header as
 * `key: value` lines, then one line per record.
 */
export function formatRunsText(runs: LogRun[]): string {
  return runs.map((run) => {
    const header = run.records.find(isSessionStart);
    const lines = [`=== run ${run.run_id} ===`];
    if (header) {
      lines.push(...formatHeader(header));
    } else {
      lines.push('(no session_start header: the start of this run was rotated out)');
    }
    lines.push('');
    for (const record of run.records) {
      if (record !== header) lines.push(formatRecord(record));
    }
    return lines.join('\n');
  }).join('\n\n');
}

/**
 * Deletes `slackcli.log` and its rotations from `dir`, and nothing else: the
 * directory may be shared (`SLACKCLI_LOG_DIR`). A missing directory deletes 0.
 */
export function clearLogs(dir: string): { deleted: number } {
  let deleted = 0;
  for (const file of listLogFiles(dir)) {
    try {
      unlinkSync(file);
      deleted += 1;
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
  }
  return { deleted };
}

export function logFilePath(dir: string): string {
  return join(dir, LOG_FILE_NAME);
}
