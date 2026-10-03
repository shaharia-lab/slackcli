// How a failing command reports its failure: free text by default, or one
// structured JSON object on stderr when the command runs with `--json` (#326).
//
// `classifyError()` turns any thrown value into a stable `code` from a closed
// set (documented in docs/user-guide/scripting.md), using only types and Slack's
// own error codes, never the wording of a message. `failCommand()` is the one
// failure path command files call from their `catch` blocks.

import type { Ora } from 'ora';
import { SlackAuthError } from './auth-errors.ts';
import { CliError, type ErrorCode } from './cli-errors.ts';
import { error as printError } from './formatter.ts';
import { redactText } from './log-redaction.ts';
import { SlackTransportError } from './slack-client.ts';
import { SlackUrlParseError } from './slack-url-parser.ts';

export { ERROR_CODES, type ErrorCode } from './cli-errors.ts';

/** The `error` member of the object a failing `--json` command writes to stderr. */
export interface CommandErrorObject {
  code: ErrorCode;
  message: string;
  hint?: string;
  retryable: boolean;
  /** Slack's own error code, verbatim, when Slack returned one. */
  slack_error?: string;
}

// Slack error codes with a meaning more specific than `unknown`. The five
// authentication codes are not here: the client already turns them into a
// `SlackAuthError`, which is classified first.
const SLACK_CODE_MAP: Readonly<Record<string, ErrorCode>> = {
  channel_not_found: 'not_found',
  user_not_found: 'not_found',
  users_not_found: 'not_found',
  message_not_found: 'not_found',
  thread_not_found: 'not_found',
  file_not_found: 'not_found',
  file_deleted: 'not_found',
  no_such_subteam: 'not_found',
  team_not_found: 'not_found',

  missing_scope: 'permission_denied',
  not_in_channel: 'permission_denied',
  restricted_action: 'permission_denied',
  restricted_action_read_only_channel: 'permission_denied',
  restricted_action_thread_only_channel: 'permission_denied',
  restricted_action_non_threadable_channel: 'permission_denied',
  access_denied: 'permission_denied',
  no_permission: 'permission_denied',
  permission_denied: 'permission_denied',
  enterprise_is_restricted: 'permission_denied',
  team_access_not_granted: 'permission_denied',
  ekm_access_denied: 'permission_denied',
  cant_update_message: 'permission_denied',
  cant_delete_message: 'permission_denied',

  ratelimited: 'rate_limited',
  rate_limited: 'rate_limited',

  invalid_arguments: 'invalid_input',
  invalid_arg_name: 'invalid_input',
  invalid_array_arg: 'invalid_input',
  invalid_form_data: 'invalid_input',
  invalid_ts: 'invalid_input',
  invalid_ts_latest: 'invalid_input',
  invalid_ts_oldest: 'invalid_input',
  invalid_cursor: 'invalid_input',
  invalid_limit: 'invalid_input',
  invalid_blocks: 'invalid_input',
  invalid_blocks_format: 'invalid_input',
  invalid_name: 'invalid_input',
  invalid_users: 'invalid_input',
  msg_too_long: 'invalid_input',
  no_text: 'invalid_input',
  too_many_attachments: 'invalid_input',

  not_allowed_token_type: 'unsupported_auth_type',

  service_unavailable: 'network',
  request_timeout: 'network',
  internal_error: 'network',
};

/** Only these can succeed on a plain retry; everything else needs a change first. */
const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['rate_limited', 'network']);

// Slack's code for a failed call, as both transports attach it (`slackData`).
function slackErrorOf(err: unknown): string | undefined {
  const code = (err as { slackData?: { error?: unknown } } | null | undefined)?.slackData?.error;
  return typeof code === 'string' && code ? code : undefined;
}

// A transport failure that never produced a Slack answer.
function transportCode(err: SlackTransportError): ErrorCode {
  if (err.httpStatus === 429) return 'rate_limited';
  if (err.networkError) return 'network';
  if (err.httpStatus !== undefined && err.httpStatus >= 500) return 'network';
  return 'unknown';
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err === undefined || err === null) return 'Unknown error';
  return String(err);
}

interface Classified {
  code: ErrorCode;
  message: string;
  hint?: string;
  slackError?: string;
}

function classify(err: unknown): Classified {
  if (err instanceof SlackAuthError) {
    // The message is three lines (who, meaning, fix); the fix is the hint.
    return { code: 'auth_failed', message: err.message.split('\n')[0], hint: err.fix, slackError: err.code };
  }
  if (err instanceof CliError) {
    return { code: err.code, message: err.jsonMessage ?? err.message, hint: err.hint };
  }
  if (err instanceof SlackUrlParseError) {
    return { code: 'invalid_input', message: err.message };
  }
  const slackError = slackErrorOf(err);
  if (slackError) {
    return { code: SLACK_CODE_MAP[slackError] ?? 'unknown', message: messageOf(err), slackError };
  }
  if (err instanceof SlackTransportError) {
    return { code: transportCode(err), message: messageOf(err) };
  }
  return { code: 'unknown', message: messageOf(err) };
}

/**
 * Classify any thrown value. Pure. `message` and `hint` are redacted of Slack
 * credentials; they never carry request parameters, since no error message the
 * CLI builds does.
 */
export function classifyError(err: unknown): CommandErrorObject {
  return toErrorObject(classify(err));
}

// The documented field order, so every error object reads the same.
function toErrorObject({ code, message, hint, slackError }: Classified): CommandErrorObject {
  return {
    code,
    message: redactText(message),
    ...(hint ? { hint: redactText(hint) } : {}),
    retryable: RETRYABLE_CODES.has(code),
    ...(slackError ? { slack_error: slackError } : {}),
  };
}

/** The single line a failing `--json` command writes to stderr. */
export function renderJsonError(error: CommandErrorObject): string {
  return JSON.stringify({ error }) + '\n';
}

export interface FailCommandOptions {
  /** The command's `--json` flag. */
  json?: boolean;
  /** The command's running spinner, if any: failed in text mode, stopped silently in JSON mode. */
  spinner?: Pick<Ora, 'fail' | 'stop'>;
  /** Text mode: the spinner's failure line, printed above the error. */
  context?: string;
  /** Text mode: the dim line under the error. Under `--json`, used when the error carries no hint of its own. */
  hint?: string;
  /** Replaces the error's own message, in both modes. */
  message?: string;
}

/**
 * Report a command failure and set exit code 1. Returns instead of exiting, so
 * a pending write is never cut short (#73): the caller returns right after.
 *
 * Text mode prints what command files always printed: with a spinner and a
 * `context`, the spinner fails with `context` and the message follows as an
 * error line; with a spinner and no `context`, the spinner fails with the
 * message itself; with no spinner, just the error line.
 *
 * JSON mode stops the spinner without printing and writes one single-line
 * `{"error":{…}}` object to stderr. stdout is never written.
 */
export function failCommand(err: unknown, options: FailCommandOptions = {}): void {
  const { json, spinner, context, hint } = options;
  process.exitCode = 1;

  if (json) {
    spinner?.stop();
    const classified = classify(err);
    process.stderr.write(renderJsonError(toErrorObject({
      ...classified,
      message: options.message ?? classified.message,
      hint: classified.hint ?? hint,
    })));
    return;
  }

  const message = options.message ?? messageOf(err);
  if (spinner && context === undefined) {
    spinner.fail(message);
    return;
  }
  spinner?.fail(context);
  printError(message, hint);
}

// Set once per run from the program's preAction hook, for the last-resort
// handlers in process-errors.ts, which have no command options to read.
let jsonErrorMode = false;

/** Record whether the running command has `--json` set. */
export function setJsonErrorMode(on: boolean): void {
  jsonErrorMode = on;
}

/** Whether the running command has `--json` set (false before any command runs). */
export function isJsonErrorMode(): boolean {
  return jsonErrorMode;
}
