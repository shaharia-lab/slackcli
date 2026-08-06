import { SlackClient } from './slack-client.ts';
import { addWorkspace, getWorkspace } from './workspaces.ts';
import type { StandardAuthConfig, BrowserAuthConfig, WorkspaceConfig } from '../types/index.ts';
import { extractSlackWorkspaceName } from './curl-parser.ts';
import {
  captureSlackTokens,
  openBrowserSession,
  SLACK_CLIENT_URL,
  isSlackWorkspaceUrl,
  type CaptureFailure,
} from './browser-auth.ts';
import type { BrowserSessionFailure } from './browser-auth.ts';

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
  profile?: string
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
    const profileKey = await addWorkspace(config, profile);

    return { config, profileKey };
  } catch (error: any) {
    throw new Error(`Authentication failed: ${error.message}`);
  }
}

// Authenticate with browser tokens
export async function authenticateBrowser(
  xoxdToken: string,
  xoxcToken: string,
  workspaceUrl: string,
  workspaceName?: string,
  profile?: string
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
    const profileKey = await addWorkspace(config, profile);

    return { config, profileKey };
  } catch (error: any) {
    throw new Error(`Authentication failed: ${error.message}`);
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

  const opened = await openBrowserSession({
    headless: options.headless ?? false,
    startUrl: options.workspaceUrl ?? SLACK_CLIENT_URL,
  });
  if (!opened.ok) {
    throw new AutoLoginError(opened.reason, opened.message);
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
    throw new AutoLoginError(capture.reason, capture.message);
  }

  const saved: WorkspaceConfig[] = [];
  const failed: AutoLoginResult['failed'] = [];

  for (const workspace of capture.workspaces) {
    // Last gate before the session cookie is sent anywhere. The extractors
    // already filter, but this is the line that decides where a live
    // credential travels, so it does not delegate that check.
    if (!isSlackWorkspaceUrl(workspace.workspaceUrl)) {
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
        workspace.teamName
      );
      saved.push(config);
    } catch (err: any) {
      failed.push({
        workspaceUrl: workspace.workspaceUrl,
        error: err?.message ?? 'Unknown error',
      });
    }
  }

  return { saved, failed };
}

// Get authenticated client for workspace
export async function getAuthenticatedClient(workspaceIdentifier?: string): Promise<SlackClient> {
  const workspace = await getWorkspace(workspaceIdentifier);

  if (!workspace) {
    if (workspaceIdentifier) {
      throw new Error(`Workspace not found: ${workspaceIdentifier}`);
    } else {
      throw new Error('No workspace configured. Run "slackcli auth login" first.');
    }
  }

  return new SlackClient(workspace);
}
