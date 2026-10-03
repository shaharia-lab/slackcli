import type { AuthType, WorkspaceConfig } from '../types/index.ts';
import { isSlackWorkspaceUrl } from './browser-auth.ts';

// The Slack error codes that mean "these credentials were refused". Permission
// errors (`missing_scope`, `not_in_channel`, …) are deliberately not here: the
// credentials are fine and logging in again changes nothing.
export const AUTH_ERROR_CODES = [
  'invalid_auth',
  'token_expired',
  'token_revoked',
  'not_authed',
  'account_inactive',
] as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

/** What a failing call knows about the profile it ran as. Never a credential. */
export interface AuthErrorProfile {
  /** The key the profile is stored under: its name, or the team id. */
  profileKey: string;
  workspaceName: string;
  authType: AuthType;
  /** Browser profiles only, and only when one is stored. */
  workspaceUrl?: string;
}

export interface AuthErrorDescription {
  /** Slack's code, verbatim, so it stays searchable. */
  code: AuthErrorCode;
  /** One or two sentences on what the code means for this profile. */
  meaning: string;
  /** What to do next: a command to run, or why no command will help. */
  fix: string;
}

export function isAuthErrorCode(code: unknown): code is AuthErrorCode {
  return typeof code === 'string' && (AUTH_ERROR_CODES as readonly string[]).includes(code);
}

// Stored names and URLs end up on a terminal. Drop control characters so a
// damaged or hostile config value cannot move the cursor or recolour output.
function printable(value: string): string {
  return Array.from(value)
    .filter((char) => {
      const point = char.codePointAt(0)!;
      return point > 0x1f && (point < 0x7f || point > 0x9f);
    })
    .join('');
}

// A hostname made only of characters that mean nothing to a shell.
const PLAIN_HOSTNAME = /^[a-z0-9.-]+$/;

// The stored workspace URL as `https://<host>`, or undefined when it is not one
// `auth login-auto --workspace-url` would accept. The fix line is meant to be
// run as printed, often by an agent, so the host must be a slack.com host with
// no port and no character a shell would interpret; anything else from a
// damaged record is dropped and the command falls back to its bare form.
function workspaceOrigin(url: string | undefined): string | undefined {
  if (!url || !isSlackWorkspaceUrl(url)) return undefined;
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  if (parsed.port !== '' || !PLAIN_HOSTNAME.test(host)) return undefined;
  return `https://${host}`;
}

/** The profile metadata of a stored workspace config, without its secrets. */
export function authErrorProfile(config: WorkspaceConfig): AuthErrorProfile {
  return {
    profileKey: config.profile ?? config.workspace_id,
    workspaceName: config.workspace_name,
    authType: config.auth_type,
    ...(config.auth_type === 'browser' ? { workspaceUrl: config.workspace_url } : {}),
  };
}

// The command that logs the profile in again. A standard token cannot be
// re-issued by the CLI, so that command names the values the user must supply.
function loginCommand(profile: AuthErrorProfile): string {
  if (profile.authType === 'standard') {
    return 'slackcli auth login --token <token> --workspace-name <name>';
  }
  const origin = workspaceOrigin(profile.workspaceUrl);
  return origin ? `slackcli auth login-auto --workspace-url ${origin}` : 'slackcli auth login-auto';
}

function meaningOf(code: AuthErrorCode, authType: AuthType): string {
  const browser = authType === 'browser';
  switch (code) {
    case 'invalid_auth':
      return browser
        ? 'The stored browser session is no longer valid. Browser sessions expire when you sign out or Slack rotates the session.'
        : 'The stored token is invalid or has expired.';
    case 'token_expired':
      return browser ? 'The stored browser session has expired.' : 'The stored token has expired.';
    case 'token_revoked':
      return browser
        ? 'The stored browser session was revoked by the user or a workspace admin.'
        : 'The stored token was revoked by the user or a workspace admin.';
    case 'not_authed':
      return 'No token was sent: the stored credentials for this profile are missing.';
    case 'account_inactive':
      return 'The user was deactivated or removed from the workspace.';
  }
}

function fixOf(code: AuthErrorCode, profile: AuthErrorProfile): string {
  if (code === 'account_inactive') {
    return 'logging in again will not help; contact a workspace admin.';
  }
  const command = loginCommand(profile);
  if (code === 'token_revoked' && profile.authType === 'standard') {
    return `${command} (with a new token; the revoked one cannot be reused)`;
  }
  return command;
}

/**
 * Explain one of the five authentication codes for a profile. Pure: the same
 * wording serves every command, on both request paths.
 */
export function describeAuthError(code: AuthErrorCode, profile: AuthErrorProfile): AuthErrorDescription {
  return { code, meaning: meaningOf(code, profile.authType), fix: fixOf(code, profile) };
}

/**
 * The full message a command prints: the profile and Slack's code on the first
 * line, then the meaning and the fix, indented to sit under `error()`'s prefix.
 */
export function formatAuthError(description: AuthErrorDescription, profile: AuthErrorProfile): string {
  const name = printable(profile.workspaceName);
  const namePart = name ? `${name}, ` : '';
  const who = `profile "${printable(profile.profileKey)}" (${namePart}${profile.authType} auth)`;
  return [
    `Authentication failed for ${who}: ${description.code}`,
    `   ${description.meaning}`,
    `   To fix: ${description.fix}`,
  ].join('\n');
}

/**
 * Slack refused a stored profile's credentials. `message` is the complete
 * three-line explanation, so a command that prints `err.message` needs no
 * change; `slackData` is Slack's original payload, as on every other failure.
 */
export class SlackAuthError extends Error {
  readonly code: AuthErrorCode;
  readonly meaning: string;
  readonly fix: string;
  readonly slackData: unknown;

  constructor(code: AuthErrorCode, profile: AuthErrorProfile, slackData?: unknown) {
    const description = describeAuthError(code, profile);
    super(formatAuthError(description, profile));
    this.name = 'SlackAuthError';
    this.code = code;
    this.meaning = description.meaning;
    this.fix = description.fix;
    this.slackData = slackData;
  }
}

/**
 * What to say when the credentials refused are the ones a login command was just
 * given or captured. Nothing is stored yet, so "log in again" would be advice to
 * repeat the step that failed.
 */
export function describeRejectedLogin(code: AuthErrorCode, authType: AuthType): string {
  // The browser wording has to hold for `login-auto` too, where the CLI captured
  // the tokens itself and the user has nothing to copy.
  const supplied = authType === 'browser' ? 'the browser session tokens were' : 'the supplied token was';
  const rejected = `${supplied} rejected by Slack (${code}).`;
  if (code === 'account_inactive') {
    return `${rejected} The user was deactivated or removed from the workspace; contact a workspace admin.`;
  }
  return authType === 'browser'
    ? `${rejected} They must come from a browser that is signed in to this workspace: sign in there, then try again.`
    : `${rejected} Check that it was copied in full and has not been revoked or rotated.`;
}
