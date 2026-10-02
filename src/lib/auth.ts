import { getLogger } from '@logtape/logtape';
import { SlackClient } from './slack-client.ts';
import { SlackAuthError, describeRejectedLogin } from './auth-errors.ts';
import { errorMessageForLog } from './tildify.ts';
import { addWorkspace, getWorkspace } from './workspaces.ts';
import type {
  StandardAuthConfig,
  BrowserAuthConfig,
  WorkspaceConfig,
  SecretBackend,
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

/** Where the effective workspace selector came from, highest precedence first. */
export type WorkspaceSelectorSource = 'flag' | 'env' | 'default';

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
  const workspace = await lookup(selector.identifier);

  if (!workspace) {
    logger.warn('No workspace resolved ({source})', { source: selector.source });
    if (selector.identifier === undefined) {
      throw new Error('No workspace configured. Run "slackcli auth login" first.');
    }
    const origin = selector.source === 'env' ? ` (from ${WORKSPACE_ENV_VAR})` : '';
    throw new Error(`Workspace not found: ${selector.identifier}${origin}`);
  }

  logger.debug('Using {auth_type} workspace {workspace_id} ({source})', {
    auth_type: workspace.auth_type,
    workspace_id: workspace.workspace_id,
    source: selector.source,
  });
  return workspace;
}

// Get authenticated client for workspace
export async function getAuthenticatedClient(workspaceIdentifier?: string): Promise<SlackClient> {
  const selector = effectiveWorkspaceSelector(workspaceIdentifier, process.env[WORKSPACE_ENV_VAR]);
  return new SlackClient(await selectWorkspace(selector));
}
