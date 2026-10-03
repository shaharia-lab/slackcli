// Errors the CLI raises itself, typed so a failing command can be classified
// without reading its message (see `classifyError()` in command-errors.ts).
// This module imports nothing, so any lib module can throw these without
// creating an import cycle.

/**
 * The stable, documented set of failure codes reported under `--json`
 * (`docs/user-guide/scripting.md`). Adding a code is a contract change.
 */
export const ERROR_CODES = [
  'auth_failed',
  'not_found',
  'permission_denied',
  'rate_limited',
  'invalid_input',
  'network',
  'confirmation_required',
  'unsupported_auth_type',
  'unknown',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** A failure the CLI detected itself, with the code it reports under `--json`. */
export class CliError extends Error {
  readonly code: ErrorCode;
  /** What to do next, reported as `hint` under `--json`. Never printed in text mode. */
  readonly hint?: string;
  /**
   * Replaces `message` under `--json`, for a message that quotes what the user
   * typed (a JSON parser's error echoes the input, i.e. message content).
   */
  readonly jsonMessage?: string;

  constructor(code: ErrorCode, message: string, hint?: string, jsonMessage?: string) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.hint = hint;
    this.jsonMessage = jsonMessage;
  }
}

/** A flag, argument or input the command cannot use as given. */
export class InvalidInputError extends CliError {
  constructor(message: string, hint?: string, jsonMessage?: string) {
    super('invalid_input', message, hint, jsonMessage);
    this.name = 'InvalidInputError';
  }
}

/** The thing the command was asked about does not exist. */
export class NotFoundError extends CliError {
  constructor(message: string, hint?: string) {
    super('not_found', message, hint);
    this.name = 'NotFoundError';
  }
}

/** The command needs the other auth type (e.g. drafts need browser auth). */
export class UnsupportedAuthTypeError extends CliError {
  constructor(message: string, hint?: string) {
    super('unsupported_auth_type', message, hint);
    this.name = 'UnsupportedAuthTypeError';
  }
}

/** A write was refused because nobody confirmed it. */
export class ConfirmationRequiredError extends CliError {
  constructor(message: string, hint?: string) {
    super('confirmation_required', message, hint);
    this.name = 'ConfirmationRequiredError';
  }
}
