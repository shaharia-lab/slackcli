import { mkdir, readFile, writeFile, exists } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import type { WorkspacesData, WorkspaceConfig } from '../types/index.ts';

const CONFIG_DIR = join(homedir(), '.config', 'slackcli');
const WORKSPACES_FILE = join(CONFIG_DIR, 'workspaces.json');

// Ensure config directory exists
async function ensureConfigDir(): Promise<void> {
  if (!await exists(CONFIG_DIR)) {
    await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

// Load workspaces data
export async function loadWorkspaces(): Promise<WorkspacesData> {
  await ensureConfigDir();
  
  if (!await exists(WORKSPACES_FILE)) {
    return { workspaces: {} };
  }
  
  try {
    const data = await readFile(WORKSPACES_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error loading workspaces:', error);
    return { workspaces: {} };
  }
}

// Save workspaces data
export async function saveWorkspaces(data: WorkspacesData): Promise<void> {
  await ensureConfigDir();
  await writeFile(WORKSPACES_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// Add or update a workspace
export async function addWorkspace(config: WorkspaceConfig): Promise<void> {
  const data = await loadWorkspaces();
  
  data.workspaces[config.workspace_id] = config;
  
  // Set as default if it's the first workspace
  if (!data.default_workspace) {
    data.default_workspace = config.workspace_id;
  }
  
  await saveWorkspaces(data);
}

// Remove a workspace
export async function removeWorkspace(workspaceId: string): Promise<void> {
  const data = await loadWorkspaces();
  
  if (!data.workspaces[workspaceId]) {
    throw new Error(`Workspace ${workspaceId} not found`);
  }
  
  delete data.workspaces[workspaceId];
  
  // Update default if we removed it
  if (data.default_workspace === workspaceId) {
    const remainingIds = Object.keys(data.workspaces);
    data.default_workspace = remainingIds.length > 0 ? remainingIds[0] : undefined;
  }
  
  await saveWorkspaces(data);
}

// Set default workspace
export async function setDefaultWorkspace(workspaceId: string): Promise<void> {
  const data = await loadWorkspaces();
  
  if (!data.workspaces[workspaceId]) {
    throw new Error(`Workspace ${workspaceId} not found`);
  }
  
  data.default_workspace = workspaceId;
  await saveWorkspaces(data);
}

// Get workspace by ID or name
export async function getWorkspace(identifier?: string): Promise<WorkspaceConfig | null> {
  const data = await loadWorkspaces();
  
  // If no identifier, return default workspace
  if (!identifier) {
    if (!data.default_workspace) {
      return null;
    }
    return data.workspaces[data.default_workspace] || null;
  }
  
  // Try to find by ID first
  if (data.workspaces[identifier]) {
    return data.workspaces[identifier];
  }
  
  // Try to find by name
  const workspaceByName = Object.values(data.workspaces).find(
    w => w.workspace_name === identifier
  );
  
  return workspaceByName || null;
}

// Get all workspaces
export async function getAllWorkspaces(): Promise<WorkspaceConfig[]> {
  const data = await loadWorkspaces();
  return Object.values(data.workspaces);
}

// Clear all workspaces
export async function clearAllWorkspaces(): Promise<void> {
  await saveWorkspaces({ workspaces: {} });
}

// Get default workspace ID
export async function getDefaultWorkspaceId(): Promise<string | undefined> {
  const data = await loadWorkspaces();
  return data.default_workspace;
}

