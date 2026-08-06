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

// ---------------------------------------------------------------------------
// Profile-key resolution (pure — no IO — so it is straightforward to unit test)
//
// The map key of `data.workspaces` is a "profile key". For legacy files and for
// the first identity of a team it is the `team_id` (unchanged from before
// profiles existed); additional identities in the same team get a distinct key.
// ---------------------------------------------------------------------------

export interface ResolvedWorkspace {
  key: string;
  config: WorkspaceConfig;
}

// A selector matched more than one stored profile. Surfaced instead of silently
// picking one, so the caller can disambiguate with an explicit profile name.
export class AmbiguousWorkspaceError extends Error {
  public identifier: string;
  public keys: string[];

  constructor(identifier: string, keys: string[]) {
    super(
      `"${identifier}" matches multiple profiles: ${keys.join(', ')}. ` +
      `Re-run with --workspace=<profile> (see "slackcli auth list").`
    );
    this.name = 'AmbiguousWorkspaceError';
    this.identifier = identifier;
    this.keys = keys;
  }
}

// Resolve a selector to a single stored record.
//
// Order: exact profile key -> explicit `profile` field -> unambiguous
// workspace_id -> unambiguous workspace_name. A selector that resolves to more
// than one record at any stage throws AmbiguousWorkspaceError rather than
// guessing. Returns null when nothing matches. With no identifier, returns the
// default workspace (legacy behavior).
export function resolveWorkspace(
  data: WorkspacesData,
  identifier?: string,
): ResolvedWorkspace | null {
  if (!identifier) {
    const key = data.default_workspace;
    if (!key) return null;
    const config = data.workspaces[key];
    return config ? { key, config } : null;
  }

  // 1. Exact profile key (the map key). Preserves legacy `team_id` selection.
  const direct = data.workspaces[identifier];
  if (direct) return { key: identifier, config: direct };

  const entries = Object.entries(data.workspaces);

  // 2. Explicit `profile` field match.
  const byProfile = entries.filter(([, c]) => c.profile === identifier);
  if (byProfile.length === 1) return { key: byProfile[0][0], config: byProfile[0][1] };
  if (byProfile.length > 1) {
    throw new AmbiguousWorkspaceError(identifier, byProfile.map(([k]) => k));
  }

  // 3. Workspace id — only when it maps to exactly one profile.
  const byId = entries.filter(([, c]) => c.workspace_id === identifier);
  if (byId.length === 1) return { key: byId[0][0], config: byId[0][1] };
  if (byId.length > 1) {
    throw new AmbiguousWorkspaceError(identifier, byId.map(([k]) => k));
  }

  // 4. Workspace name — again only when unambiguous.
  const byName = entries.filter(([, c]) => c.workspace_name === identifier);
  if (byName.length === 1) return { key: byName[0][0], config: byName[0][1] };
  if (byName.length > 1) {
    throw new AmbiguousWorkspaceError(identifier, byName.map(([k]) => k));
  }

  return null;
}

// Two records describe the same identity when they are the same team, the same
// auth mode, and — when both know it — the same authenticated user id. Legacy
// records predate `user_id`, so a token-only match falls back to the team_id
// slot (see deriveStorageKey) to keep refresh-in-place working for them.
function isSameIdentity(a: WorkspaceConfig, b: WorkspaceConfig): boolean {
  if (a.workspace_id !== b.workspace_id) return false;
  if (a.auth_type !== b.auth_type) return false;
  if (a.auth_type === 'standard' && b.auth_type === 'standard') {
    if (a.token_type !== b.token_type) return false;
  }
  if (a.user_id && b.user_id) return a.user_id === b.user_id;
  return true;
}

// Decide which map key a newly authenticated config should occupy.
//
// - With an explicit profile: use it, but refuse to reuse a key that already
//   belongs to a different team (prevents clobbering an unrelated record).
// - Without a profile: refresh the same identity in place (backward compatible
//   token rotation); otherwise take the free team_id slot for the first
//   identity, or append a numeric suffix so a second identity never silently
//   replaces the first.
export function deriveStorageKey(
  data: WorkspacesData,
  config: WorkspaceConfig,
  profile?: string,
): string {
  if (profile) {
    const existing = data.workspaces[profile];
    if (existing && existing.workspace_id !== config.workspace_id) {
      throw new Error(
        `Profile "${profile}" already belongs to workspace ${existing.workspace_name} ` +
        `(${existing.workspace_id}). Choose a different --profile name.`
      );
    }
    return profile;
  }

  // Refresh an existing identity in place (keeps its key, default, and any name).
  for (const [key, existing] of Object.entries(data.workspaces)) {
    if (!isSameIdentity(existing, config)) continue;
    // For legacy records lacking user_id, only the team_id slot is treated as a
    // refresh target; a namespaced profile is left untouched.
    if (existing.user_id && config.user_id) return key;
    if (!existing.user_id && key === config.workspace_id) return key;
  }

  // First identity for this team keeps the historical team_id key.
  if (!data.workspaces[config.workspace_id]) return config.workspace_id;

  // A different identity already holds the team_id slot: never overwrite it.
  let n = 2;
  while (data.workspaces[`${config.workspace_id}-${n}`]) n++;
  return `${config.workspace_id}-${n}`;
}

// Add or update a workspace. Returns the profile key it was stored under.
export async function addWorkspace(
  config: WorkspaceConfig,
  profile?: string,
): Promise<string> {
  const data = await loadWorkspaces();

  const key = deriveStorageKey(data, config, profile);

  // Only persist a `profile` field when the key carries meaning (an explicit
  // name or an auto-generated one). A first identity stored under its team_id
  // stays shaped exactly like a pre-profiles record.
  const stored: WorkspaceConfig = key === config.workspace_id
    ? config
    : { ...config, profile: key };

  data.workspaces[key] = stored;

  // Set as default if it's the first workspace
  if (!data.default_workspace) {
    data.default_workspace = key;
  }

  await saveWorkspaces(data);
  return key;
}

// Remove a workspace by profile key, workspace id, or name.
export async function removeWorkspace(identifier: string): Promise<void> {
  const data = await loadWorkspaces();

  const resolved = resolveWorkspace(data, identifier);
  if (!resolved) {
    throw new Error(`Workspace ${identifier} not found`);
  }

  delete data.workspaces[resolved.key];

  // Update default if we removed it
  if (data.default_workspace === resolved.key) {
    const remainingIds = Object.keys(data.workspaces);
    data.default_workspace = remainingIds.length > 0 ? remainingIds[0] : undefined;
  }

  await saveWorkspaces(data);
}

// Set default workspace by profile key, workspace id, or name.
export async function setDefaultWorkspace(identifier: string): Promise<void> {
  const data = await loadWorkspaces();

  const resolved = resolveWorkspace(data, identifier);
  if (!resolved) {
    throw new Error(`Workspace ${identifier} not found`);
  }

  data.default_workspace = resolved.key;
  await saveWorkspaces(data);
}

// Get workspace by profile key, id, or name (or the default when omitted).
export async function getWorkspace(identifier?: string): Promise<WorkspaceConfig | null> {
  const data = await loadWorkspaces();
  return resolveWorkspace(data, identifier)?.config ?? null;
}

// Get all workspaces paired with their profile keys.
export async function getAllWorkspaceEntries(): Promise<ResolvedWorkspace[]> {
  const data = await loadWorkspaces();
  return Object.entries(data.workspaces).map(([key, config]) => ({ key, config }));
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
