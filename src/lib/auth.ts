import { SlackClient } from './slack-client.ts';
import { addWorkspace, getWorkspace } from './workspaces.ts';
import type { StandardAuthConfig, BrowserAuthConfig, WorkspaceConfig } from '../types/index.ts';

// Authenticate with standard token
export async function authenticateStandard(
  token: string,
  workspaceName: string
): Promise<WorkspaceConfig> {
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
    };

    // Save the workspace
    await addWorkspace(config);

    return config;
  } catch (error: any) {
    throw new Error(`Authentication failed: ${error.message}`);
  }
}

// Authenticate with browser tokens
export async function authenticateBrowser(
  xoxdToken: string,
  xoxcToken: string,
  workspaceUrl: string,
  workspaceName?: string
): Promise<WorkspaceConfig> {
  // Extract workspace name from URL if not provided
  const urlMatch = workspaceUrl.match(/https?:\/\/([^.]+)\.slack\.com/);
  const defaultName = urlMatch ? urlMatch[1] : 'workspace';

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
    };

    // Save the workspace
    await addWorkspace(config);

    return config;
  } catch (error: any) {
    throw new Error(`Authentication failed: ${error.message}`);
  }
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

