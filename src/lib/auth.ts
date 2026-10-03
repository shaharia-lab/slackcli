import { getLogger } from '@logtape/logtape';
import { SlackClient, SlackTransportError } from './slack-client.ts';
import { SlackAuthError, describeRejectedLogin } from './auth-errors.ts';
import { CliError, NotFoundError } from './cli-errors.ts';
import { errorMessageForLog } from './tildify.ts';
import {
  addWorkspace,
  getAllWorkspaceEntries,
  getWorkspace,
  getWorkspaceEntry,
  type ResolvedWorkspace,
} from './workspaces.ts';
import type {
  StandardAuthConfig,
  BrowserAuthConfig,
  WorkspaceConfig,
  SecretBackend,
  IdentityResult,
  ProfileCheck,
  ProfileList,
  WorkspaceSelectorSource,
} from '../types/index.ts';
import { extractSlackWorkspaceName } from './curl-parser.ts';
import {
  captureSlackTokens,
  openBrowserSession,
  SLACK_CLIENT_URL,
  isSlackWorkspaceUrl,
  type CaptureFailure,
  type BrowserSessionFailure,
} from './browser-auth.ts';

const logger = getLogger(['slackcli', 'auth']);

function logAuthenticated(authType: WorkspaceConfig['auth_type'], workspaceId: string, profileKey: string): void {
  logger.info('Authenticated {auth_type} workspace {workspace_id}', {
    auth_type: authType,
    workspace_id: workspaceId,
    profile_key: profileKey,
  });
}

function logAuthFailed(authType: WorkspaceConfig['auth_type'], error: unknown): void {
  logger.warn('{auth_type} authentication failed: {error}', {
    auth_type: authType,
    // A SlackAuthError's message names the workspace; its code says enough.
    error: error instanceof SlackAuthError ? error.code : errorMessageForLog(error),
  });
}

// The message for a login that failed. A token Slack refused at login is not a
// stored profile gone stale, so it gets its own wording instead of the
// "log in again" advice `SlackAuthError` carries.
function loginFailureMessage(authType: WorkspaceConfig['auth_type'], error: any): string {
  const reason = error instanceof SlackAuthError
    ? describeRejectedLogin(error.code, authType)
    : error.message;
  return `Authentication failed: ${reason}`;
}

// Result of a successful login: the stored config plus the profile key it was
// saved under (which may be user-chosen, the team_id, or auto-generated).
export interface AuthResult {
  config: WorkspaceConfig;
  profileKey: string;
}

// Authenticate with standard token
export async function authenticateStandard(
  token: string,
  workspaceName: string,
  profile?: string,
  secretBackend: SecretBackend = 'file'
): Promise<AuthResult> {
  // Create a temporary config to test the token
  const tempConfig: StandardAuthConfig = {
    workspace_id: 'temp',
    workspace_name: workspaceName,
    auth_type: 'standard',
    token,
    token_type: token.startsWith('xoxb-') ? 'bot' : 'user',
  };

  const client = new SlackClient(tempConfig);

  try {
    const authTest = await client.testAuth();

    // Update with real workspace info
    const config: StandardAuthConfig = {
      ...tempConfig,
      workspace_id: authTest.team_id,
      workspace_name: workspaceName || authTest.team,
      user_id: authTest.user_id,
    };

    // Save the workspace
    const profileKey = await addWorkspace(config, profile, secretBackend);
    logAuthenticated(config.auth_type, config.workspace_id, profileKey);

    return { config, profileKey };
  } catch (error: any) {
    logAuthFailed(tempConfig.auth_type, error);
    throw new Error(loginFailureMessage(tempConfig.auth_type, error));
  }
}

// Authenticate with browser tokens
export async function authenticateBrowser(
  xoxdToken: string,
  xoxcToken: string,
  workspaceUrl: string,
  workspaceName?: string,
  profile?: string,
  secretBackend: SecretBackend = 'file'
): Promise<AuthResult> {
  // Extract workspace name from URL if not provided
  const defaultName = extractSlackWorkspaceName(workspaceUrl);

  // Create a temporary config to test the tokens
  const tempConfig: BrowserAuthConfig = {
    workspace_id: 'temp',
    workspace_name: workspaceName || defaultName,
    workspace_url: workspaceUrl,
    auth_type: 'browser',
    xoxd_token: xoxdToken,
    xoxc_token: xoxcToken,
  };

  const client = new SlackClient(tempConfig);

  try {
    const authTest = await client.testAuth();

    // Update with real workspace info
    const config: BrowserAuthConfig = {
      ...tempConfig,
      workspace_id: authTest.team_id,
      workspace_name: workspaceName || authTest.team,
      user_id: authTest.user_id,
    };

    // Save the workspace
    const profileKey = await addWorkspace(config, profile, secretBackend);
    logAuthenticated(config.auth_type, config.workspace_id, profileKey);

    return { config, profileKey };
  } catch (error: any) {
    logAuthFailed(tempConfig.auth_type, error);
    throw new Error(loginFailureMessage(tempConfig.auth_type, error));
  }
}

export type AutoLoginFailure = BrowserSessionFailure | CaptureFailure;

export interface AutoLoginResult {
  saved: WorkspaceConfig[];
  failed: Array<{ workspaceUrl: string; error: string }>;
}

export interface AutoLoginOptions {
  headless?: boolean;
  workspaceUrl?: string;
  timeoutMs?: number;
  onProgress?: (line: string) => void;
  secretBackend?: SecretBackend;
}

/** Thrown when the browser capture never produced tokens. Carries the reason
 *  so the command layer can print guidance specific to what went wrong. */
export class AutoLoginError extends Error {
  public reason: AutoLoginFailure;

  constructor(reason: AutoLoginFailure, message: string) {
    super(message);
    this.name = 'AutoLoginError';
    this.reason = reason;
  }
}

/**
 * Log in by capturing tokens from a browser the user signs into.
 *
 * Verification and persistence deliberately route through
 * `authenticateBrowser` — the same path `login-browser` and `parse-curl` use
 * — so a workspace enrolled this way is indistinguishable from one added by
 * hand, and there is exactly one place that decides a token is valid.
 *
 * Per-workspace failures are collected rather than thrown: with several
 * workspaces captured at once, one stale token must not discard the rest.
 */
export async function authenticateAuto(
  options: AutoLoginOptions = {}
): Promise<AutoLoginResult> {
  const onProgress = options.onProgress ?? (() => {});

  logger.info('login-auto started', {
    headless: options.headless ?? false,
    workspace_url_given: Boolean(options.workspaceUrl),
    secret_backend: options.secretBackend ?? 'file',
  });

  const opened = await openBrowserSession({
    headless: options.headless ?? false,
    startUrl: options.workspaceUrl ?? SLACK_CLIENT_URL,
  });
  if (!opened.ok) {
    throw autoLoginFailed(opened.reason, opened.message);
  }

  let capture;
  try {
    capture = await captureSlackTokens(opened.session, {
      headless: options.headless ?? false,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.workspaceUrl ? { startUrl: options.workspaceUrl } : {}),
      onProgress,
    });
  } finally {
    // The browser holds a live session; close it whether or not we got what
    // we came for.
    await opened.stop();
  }

  if (!capture.ok) {
    throw autoLoginFailed(capture.reason, capture.message);
  }

  const saved: WorkspaceConfig[] = [];
  const failed: AutoLoginResult['failed'] = [];

  for (const workspace of capture.workspaces) {
    // Last gate before the session cookie is sent anywhere. The extractors
    // already filter, but this is the line that decides where a live
    // credential travels, so it does not delegate that check.
    if (!isSlackWorkspaceUrl(workspace.workspaceUrl)) {
      logger.warn('login-auto refused a non-Slack workspace URL', { team_id: workspace.teamId });
      failed.push({
        workspaceUrl: workspace.workspaceUrl,
        error: 'Refused: not an https slack.com workspace URL',
      });
      continue;
    }

    try {
      // login-auto enrols every captured workspace at once, so a single
      // --profile can't map to it; these keep the default team_id keying.
      const { config } = await authenticateBrowser(
        capture.xoxd,
        workspace.xoxc,
        workspace.workspaceUrl,
        workspace.teamName,
        undefined,
        options.secretBackend ?? 'file'
      );
      saved.push(config);
    } catch (err: any) {
      logger.warn('login-auto could not save a captured workspace: {error}', {
        team_id: workspace.teamId,
        error: errorMessageForLog(err),
      });
      failed.push({
        workspaceUrl: workspace.workspaceUrl,
        error: err?.message ?? 'Unknown error',
      });
    }
  }

  logger.info('login-auto finished: {saved} saved, {failed} failed', {
    saved: saved.length,
    failed: failed.length,
    workspace_ids: saved.map((config) => config.workspace_id),
  });
  return { saved, failed };
}

/** Log the typed reason before it reaches the command layer. */
function autoLoginFailed(reason: AutoLoginFailure, message: string): AutoLoginError {
  logger.error('login-auto failed: {reason}', { reason });
  return new AutoLoginError(reason, message);
}

/** Selects the profile for one shell or session when `--workspace` is absent. */
export const WORKSPACE_ENV_VAR = 'SLACKCLI_WORKSPACE';

export type { WorkspaceSelectorSource };

export interface WorkspaceSelector {
  /** Absent when the stored default applies. */
  identifier?: string;
  source: WorkspaceSelectorSource;
}

/**
 * Pick the effective workspace selector: the `--workspace` flag, then
 * `SLACKCLI_WORKSPACE`, then the stored default. Pure, so the precedence is
 * testable without touching `process.env`. The env value is trimmed and an
 * empty one counts as unset — an exported-but-blank variable must not turn
 * every command into "workspace not found".
 */
export function effectiveWorkspaceSelector(flag?: string, env?: string): WorkspaceSelector {
  if (flag) return { identifier: flag, source: 'flag' };
  const fromEnv = env?.trim();
  if (fromEnv) return { identifier: fromEnv, source: 'env' };
  return { source: 'default' };
}

// Resolve a selector through `lookup` or throw. Shared by the two public
// variants below, which differ only in whether the profile key is kept.
async function selectWith<T>(
  selector: WorkspaceSelector,
  lookup: (identifier?: string) => Promise<T | null>,
  configOf: (found: T) => WorkspaceConfig,
): Promise<T> {
  const found = await lookup(selector.identifier);

  if (!found) {
    logger.warn('No workspace resolved ({source})', { source: selector.source });
    if (selector.identifier === undefined) {
      throw new CliError('auth_failed', 'No workspace configured. Run "slackcli auth login" first.', 'slackcli auth login-auto');
    }
    const origin = selector.source === 'env' ? ` (from ${WORKSPACE_ENV_VAR})` : '';
    throw new NotFoundError(`Workspace not found: ${selector.identifier}${origin}`, 'slackcli auth list');
  }

  const workspace = configOf(found);
  logger.debug('Using {auth_type} workspace {workspace_id} ({source})', {
    auth_type: workspace.auth_type,
    workspace_id: workspace.workspace_id,
    source: selector.source,
  });
  return found;
}

/**
 * Resolve a selector to a stored workspace or throw. A selector that matches
 * nothing is an error whatever its source: an env value never falls back to
 * the stored default, since that would silently run against another workspace.
 * `lookup` is the seam tests use in place of the real config file.
 */
export async function selectWorkspace(
  selector: WorkspaceSelector,
  lookup: (identifier?: string) => Promise<WorkspaceConfig | null> = getWorkspace,
): Promise<WorkspaceConfig> {
  return selectWith(selector, lookup, (config) => config);
}

/** `selectWorkspace()`, keeping the profile key the workspace is stored under. */
export async function selectWorkspaceEntry(
  selector: WorkspaceSelector,
  lookup: (identifier?: string) => Promise<ResolvedWorkspace | null> = getWorkspaceEntry,
): Promise<ResolvedWorkspace> {
  return selectWith(selector, lookup, (entry) => entry.config);
}

// Get authenticated client for workspace
export async function getAuthenticatedClient(workspaceIdentifier?: string): Promise<SlackClient> {
  const selector = effectiveWorkspaceSelector(workspaceIdentifier, process.env[WORKSPACE_ENV_VAR]);
  return new SlackClient(await selectWorkspace(selector));
}

// `@slack/web-api` retries a dead connection for about thirty minutes by
// default. An identity check is asked for an answer now, so the standard path
// gets the same three retries the browser path makes.
const IDENTITY_CHECK_SDK_RETRIES = 3;

/** Seams for `checkIdentity()`; the defaults are what the CLI runs with. */
export interface IdentityCheckDeps {
  /** The `SLACKCLI_WORKSPACE` value. Defaults to the process environment. */
  env?: string;
  lookup?: (identifier?: string) => Promise<ResolvedWorkspace | null>;
  createClient?: (config: WorkspaceConfig) => Pick<SlackClient, 'testAuth'>;
}

/**
 * Who the CLI is acting as: resolve the profile the same way every command
 * does, then verify it with exactly one `auth.test` call.
 *
 * Refused credentials and an unreachable Slack are results, not exceptions, so
 * the caller can still report the stored profile. A selector that resolves to
 * no profile (none configured, unknown, ambiguous) throws, as does any other
 * failure of the call. The result never holds a token.
 */
export async function checkIdentity(
  identifier?: string,
  deps: IdentityCheckDeps = {},
): Promise<IdentityResult> {
  const {
    env = process.env[WORKSPACE_ENV_VAR],
    lookup = getWorkspaceEntry,
    createClient = (config) => new SlackClient(config, { sdkRetries: IDENTITY_CHECK_SDK_RETRIES }),
  } = deps;

  const selector = effectiveWorkspaceSelector(identifier, env);
  const { key, config } = await selectWorkspaceEntry(selector, lookup);
  const stored = {
    profile: key,
    workspace_id: config.workspace_id,
    workspace_name: config.workspace_name,
    auth_type: config.auth_type,
    source: selector.source,
  };
  const storedUser = config.user_id ? { user_id: config.user_id } : {};
  const logOutcome = (status: IdentityResult['status'], detail: Record<string, unknown> = {}) =>
    logger.info('Identity check for {profile_key}: {status}', {
      profile_key: key,
      workspace_id: config.workspace_id,
      auth_type: config.auth_type,
      source: selector.source,
      status,
      ...detail,
    });

  try {
    const authTest = await createClient(config).testAuth();
    logOutcome('ok');
    return {
      ...stored,
      status: 'ok',
      user: authTest.user,
      user_id: authTest.user_id,
      ...(authTest.bot_id ? { bot_id: authTest.bot_id } : {}),
    };
  } catch (error: unknown) {
    if (error instanceof SlackAuthError) {
      logOutcome('auth_failed', { slack_error: error.code });
      return {
        ...stored,
        ...storedUser,
        status: 'auth_failed',
        error: { code: error.code, meaning: error.meaning, fix: error.fix },
      };
    }
    if (error instanceof SlackTransportError) {
      logOutcome('unreachable', { http_status: error.httpStatus });
      return {
        ...stored,
        ...storedUser,
        status: 'unreachable',
        error: {
          message: error.message,
          ...(error.httpStatus === undefined ? {} : { http_status: error.httpStatus }),
        },
      };
    }
    throw error;
  }
}

/** One stored profile's key with the outcome of its check. */
export interface CheckedProfile {
  profile: string;
  check: ProfileCheck;
}

/** Reported before each profile is checked; `index` starts at 1. */
export interface ProfileCheckProgress {
  profile: string;
  index: number;
  total: number;
}

/** Seams for `checkAllProfiles()`; the defaults are what the CLI runs with. */
export interface ProfileCheckDeps {
  /** The stored profiles, metadata only. */
  listEntries?: () => Promise<ResolvedWorkspace[]>;
  /** Reads one profile, credentials included, by its exact key. */
  lookup?: (key: string) => Promise<ResolvedWorkspace | null>;
  createClient?: NonNullable<IdentityCheckDeps['createClient']>;
}

// `IdentityResult` without the profile details: `auth list` prints those from
// the stored record, so only what the check itself found is kept.
function toProfileCheck(identity: IdentityResult): ProfileCheck {
  switch (identity.status) {
    case 'ok':
      return {
        status: 'ok',
        user: identity.user,
        user_id: identity.user_id,
        ...(identity.bot_id ? { bot_id: identity.bot_id } : {}),
      };
    case 'auth_failed':
      return { status: 'auth_failed', error: identity.error };
    case 'unreachable':
      return { status: 'unreachable', error: identity.error };
  }
}

const failureMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function checkProfile(key: string, deps: Required<Omit<ProfileCheckDeps, 'listEntries'>>): Promise<ProfileCheck> {
  let entry: ResolvedWorkspace | null;
  try {
    entry = await deps.lookup(key);
  } catch (error: unknown) {
    // Credentials that cannot be read cannot authenticate. Report the store's
    // own message for this profile instead of ending the whole run.
    logger.warn('Profile check for {profile_key}: credentials unreadable: {error}', {
      profile_key: key,
      error: errorMessageForLog(error),
    });
    return { status: 'auth_failed', error: { message: failureMessage(error) } };
  }
  if (!entry) {
    logger.warn('Profile check for {profile_key}: profile no longer stored', { profile_key: key });
    return { status: 'auth_failed', error: { message: `Profile "${key}" is no longer stored.` } };
  }

  const found = entry;
  try {
    // The entry already read is the only one the lookup can return, so
    // neither SLACKCLI_WORKSPACE nor the stored default can redirect the check.
    return toProfileCheck(
      await checkIdentity(key, { lookup: async () => found, createClient: deps.createClient }),
    );
  } catch (error: unknown) {
    // Neither refused credentials nor a transport failure: Slack did not say
    // the credentials are bad, so they are not reported as such.
    logger.warn('Profile check for {profile_key}: check failed: {error}', {
      profile_key: key,
      error: errorMessageForLog(error),
    });
    return { status: 'unreachable', error: { message: failureMessage(error) } };
  }
}

/**
 * Verify every stored profile with one `auth.test` call each, in stored order.
 *
 * Sequential, since the rate limiter is process-wide. A profile that fails in
 * any way becomes a result and the remaining profiles are still checked; only a
 * config file that cannot be listed throws. Results never hold a token.
 */
export async function checkAllProfiles(
  onProgress?: (progress: ProfileCheckProgress) => void,
  deps: ProfileCheckDeps = {},
): Promise<CheckedProfile[]> {
  const {
    listEntries = getAllWorkspaceEntries,
    lookup = getWorkspaceEntry,
    createClient = (config) => new SlackClient(config, { sdkRetries: IDENTITY_CHECK_SDK_RETRIES }),
  } = deps;

  const entries = await listEntries();
  const results: CheckedProfile[] = [];
  for (const [index, { key }] of entries.entries()) {
    onProgress?.({ profile: key, index: index + 1, total: entries.length });
    results.push({ profile: key, check: await checkProfile(key, { lookup, createClient }) });
  }

  logger.info('Checked {total} profiles: {ok} ok, {auth_failed} auth_failed, {unreachable} unreachable', {
    total: results.length,
    ok: results.filter((r) => r.check.status === 'ok').length,
    auth_failed: results.filter((r) => r.check.status === 'auth_failed').length,
    unreachable: results.filter((r) => r.check.status === 'unreachable').length,
  });
  return results;
}

/**
 * The stored profiles as `auth list --json` reports them. Pure: it reads only
 * the metadata it is given. `checks` (from `checkAllProfiles()`) adds a `check`
 * to each profile it names; without it no entry has one.
 */
export function buildProfileList(
  entries: ResolvedWorkspace[],
  defaultKey: string | undefined,
  checks?: CheckedProfile[],
): ProfileList {
  const checkOf = new Map(checks?.map(({ profile, check }) => [profile, check]));
  // A stored default can outlive its profile; never name one that is not listed.
  const listedDefault = entries.some(({ key }) => key === defaultKey) ? defaultKey : undefined;
  return {
    default: listedDefault ?? null,
    workspaces: entries.map(({ key, config }) => {
      const check = checkOf.get(key);
      return {
        profile: key,
        workspace_id: config.workspace_id,
        workspace_name: config.workspace_name,
        auth_type: config.auth_type,
        is_default: key === listedDefault,
        secret_backend: config.secret_backend ?? 'file',
        ...(check ? { check } : {}),
      };
    }),
  };
}
