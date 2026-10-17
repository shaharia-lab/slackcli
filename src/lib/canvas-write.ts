import { readFile, stat } from 'node:fs/promises';
import { isatty } from 'node:tty';
import { getLogger } from '@logtape/logtape';
import { InvalidInputError } from './cli-errors.ts';
import { readStreamText, STDIN_PATH, STDIN_TIMEOUT_MS } from './message-input.ts';

const logger = getLogger(['slackcli', 'canvas']);

// `canvas create` and `canvas edit` (#431): the Markdown they send, read from
// a file or standard input, and the one change `canvases.edit` applies per
// call, validated before any Slack call so a bad invocation never half-edits.

/** Slack's limit on the Markdown of a create or of one change: 1 MiB, counted in characters. */
export const CANVAS_MARKDOWN_MAX_CHARS = 1_048_576;

/**
 * What is read at most before counting characters. A character takes up to
 * four bytes in UTF-8, so this lets every text within the limit through and
 * stops anything far past it from being buffered.
 */
export const CANVAS_MARKDOWN_MAX_BYTES = 4 * CANVAS_MARKDOWN_MAX_CHARS;

/** The operations `canvases.edit` accepts, one per call. */
export const CANVAS_EDIT_OPERATIONS = [
  'insert_after',
  'insert_before',
  'insert_at_start',
  'insert_at_end',
  'replace',
  'delete',
  'rename',
] as const;

export type CanvasEditOperation = (typeof CANVAS_EDIT_OPERATIONS)[number];

/** Markdown content as `canvases.create` and `canvases.edit` take it. */
export interface CanvasMarkdownContent {
  type: 'markdown';
  markdown: string;
}

/** One element of `canvases.edit`'s `changes` array. */
export interface CanvasChange {
  operation: CanvasEditOperation;
  section_id?: string;
  document_content?: CanvasMarkdownContent;
  title_content?: CanvasMarkdownContent;
}

/** What each operation needs and allows, from the `canvases.edit` reference. */
const OPERATION_RULES: Record<CanvasEditOperation, { section: 'required' | 'optional' | 'none'; markdown: boolean; title: boolean }> = {
  insert_after: { section: 'required', markdown: true, title: false },
  insert_before: { section: 'required', markdown: true, title: false },
  insert_at_start: { section: 'none', markdown: true, title: false },
  insert_at_end: { section: 'none', markdown: true, title: false },
  replace: { section: 'optional', markdown: true, title: false },
  delete: { section: 'required', markdown: false, title: false },
  rename: { section: 'none', markdown: false, title: true },
};

function isEditOperation(value: string): value is CanvasEditOperation {
  return (CANVAS_EDIT_OPERATIONS as readonly string[]).includes(value);
}

/** Parse `--operation`, trimmed and lower-cased. */
export function parseEditOperation(input: string): CanvasEditOperation {
  const operation = input.trim().toLowerCase();
  if (!isEditOperation(operation)) {
    throw new InvalidInputError(
      `Unknown --operation "${input}"; use one of ${CANVAS_EDIT_OPERATIONS.join(', ')}`,
    );
  }
  return operation;
}

/** The operations that remove existing content, and so ask for confirmation. */
export function isDestructiveOperation(operation: CanvasEditOperation): boolean {
  return operation === 'replace' || operation === 'delete';
}

/** Refuse empty Markdown, and Markdown past Slack's limit. */
export function checkCanvasMarkdown(markdown: string, source: string): void {
  if (markdown.trim() === '') {
    throw new InvalidInputError(`Markdown ${source} is empty`);
  }
  // Counted in code points, as Slack counts characters, not UTF-16 units. A
  // string never has more code points than units, so short ones need no count.
  if (markdown.length > CANVAS_MARKDOWN_MAX_CHARS && [...markdown].length > CANVAS_MARKDOWN_MAX_CHARS) {
    throw new InvalidInputError(
      `Markdown ${source} is longer than Slack's limit of ${CANVAS_MARKDOWN_MAX_CHARS} characters`,
    );
  }
}

/**
 * Check the options of a `canvas edit` before anything is read or sent.
 * Throws InvalidInputError when the operation lacks what it needs (a section
 * for insert_before/insert_after/delete, Markdown for the inserts and replace,
 * a title for rename) or is given something it does not use.
 */
export function checkEditOptions(options: {
  operation: CanvasEditOperation;
  section?: string;
  hasMarkdown: boolean;
  title?: string;
}): void {
  const { operation, section, hasMarkdown, title } = options;
  const rules = OPERATION_RULES[operation];

  if (rules.section === 'required' && section === undefined) {
    throw new InvalidInputError(`--operation ${operation} needs --section <section-id> (find one with "canvas sections")`);
  }
  if (rules.section === 'none' && section !== undefined) {
    throw new InvalidInputError(`--operation ${operation} does not take --section`);
  }
  if (section?.trim() === '') {
    throw new InvalidInputError('--section needs a section ID');
  }
  if (rules.markdown && !hasMarkdown) {
    throw new InvalidInputError(`--operation ${operation} needs --markdown-file <path|->`);
  }
  if (!rules.markdown && hasMarkdown) {
    throw new InvalidInputError(`--operation ${operation} does not take --markdown-file`);
  }
  if (rules.title && title === undefined) {
    throw new InvalidInputError(`--operation ${operation} needs --title <title>`);
  }
  if (!rules.title && title !== undefined) {
    throw new InvalidInputError('--title is only used with --operation rename');
  }
  if (title?.trim() === '') {
    throw new InvalidInputError('--title needs some text');
  }
}

/** Build the one change of a `canvas edit`, checked by checkEditOptions(). */
export function buildCanvasChange(options: {
  operation: CanvasEditOperation;
  section?: string;
  markdown?: string;
  title?: string;
}): CanvasChange {
  const { operation, section, markdown, title } = options;
  checkEditOptions({ operation, section, hasMarkdown: markdown !== undefined, title });

  const change: CanvasChange = { operation };
  if (section !== undefined) change.section_id = section.trim();
  if (markdown !== undefined) change.document_content = { type: 'markdown', markdown };
  if (title !== undefined) change.title_content = { type: 'markdown', markdown: title };
  return change;
}

export interface MarkdownInputDeps {
  isStdinTTY: () => boolean;
  readStdin: (maxBytes: number) => Promise<string>;
  fileSize: (path: string) => Promise<number>;
  readFile: (path: string) => Promise<string>;
}

const defaultDeps: MarkdownInputDeps = {
  // File descriptor 0 is asked directly: deciding must not open process.stdin.
  isStdinTTY: () => isatty(0),
  readStdin: (maxBytes) => readStreamText(process.stdin, { maxBytes, timeoutMs: STDIN_TIMEOUT_MS }),
  fileSize: async (path) => (await stat(path)).size,
  readFile: (path) => readFile(path, 'utf8'),
};

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read the Markdown of `--markdown-file`: a path, or `-` for standard input
 * (only `-` itself; `./-` is a file). Fails before any Slack call on a
 * terminal on stdin, an unreadable or oversized source, empty Markdown, or
 * Markdown past Slack's limit. The text is sent as read.
 */
export async function readCanvasMarkdown(path: string, deps: MarkdownInputDeps = defaultDeps): Promise<string> {
  if (!path) {
    throw new InvalidInputError('--markdown-file path cannot be empty');
  }

  let markdown: string;
  if (path === STDIN_PATH) {
    // A terminal on stdin would wait for typing that an agent never sends.
    if (deps.isStdinTTY()) {
      throw new InvalidInputError(
        '--markdown-file - reads the Markdown from standard input, but stdin is a terminal; pipe the text in',
        'slackcli canvas create --title "Notes" --markdown-file - < ./notes.md',
      );
    }
    try {
      markdown = await deps.readStdin(CANVAS_MARKDOWN_MAX_BYTES);
    } catch (err) {
      throw new InvalidInputError(`Cannot read Markdown from standard input: ${reason(err)}`);
    }
    checkCanvasMarkdown(markdown, 'from standard input');
  } else {
    try {
      const size = await deps.fileSize(path);
      if (size > CANVAS_MARKDOWN_MAX_BYTES) {
        throw new Error(`file is larger than ${CANVAS_MARKDOWN_MAX_BYTES} bytes`);
      }
      markdown = await deps.readFile(path);
    } catch (err) {
      throw new InvalidInputError(`Cannot read Markdown file ${path}: ${reason(err)}`);
    }
    checkCanvasMarkdown(markdown, `file ${path}`);
  }

  logger.debug('canvas markdown resolved', { source: path === STDIN_PATH ? 'stdin' : 'file', length: markdown.length });
  return markdown;
}
