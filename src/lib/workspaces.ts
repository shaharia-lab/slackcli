import { mkdir, readFile, writeFile, exists } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import type { WorkspacesData, WorkspaceConfig, SecretBackend } from '../types/index.ts';
import {
  FileSecretStore,
  MacOSKeychainSecretStore,
  RoutingSecretStore,
  credentialsMatch,
  deleteCredentials,
  loadCredentials,
  metadataOf,
  storeCredentials,
  type SecretStore,
} from './secret-store.ts';

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

// The credential backend for a loaded document. Secrets are read and written
// only through this. A RoutingSecretStore lets different profiles in the same
// document live on different backends (file vs. macOS Keychain) at once, so
// migrating one profile never disturbs another (#219 part 2).
function secretStoreFor(data: WorkspacesData): SecretStore {
  return new RoutingSecretStore(data);
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

// ---------------------------------------------------------------------------
// Credential-aware document operations. Each works on a loaded document and a
// SecretStore without touching the filesystem, so the IO wrappers below stay
// thin and the credential routing is unit-testable against any backend.
// ---------------------------------------------------------------------------

// Store `config` in `data` (metadata on the record, secrets via `store`).
// `backend` picks which SecretStore backend a NEW profile's secrets are
// tagged for; it has no effect on a refreshed existing profile, which keeps
// whatever backend it already migrated to (see migrateWorkspaceCredentials).
// Returns the profile key it was stored under.
export async function putWorkspace(
  data: WorkspacesData,
  store: SecretStore,
  config: WorkspaceConfig,
  profile?: string,
  backend: SecretBackend = 'file',
): Promise<string> {
  const key = deriveStorageKey(data, config, profile);

  // Only persist a `profile` field when the key carries meaning (an explicit
  // name or an auto-generated one). A first identity stored under its team_id
  // stays shaped exactly like a pre-profiles record. Same for `secret_backend`:
  // omit it for the default ('file') so an all-file document round-trips with
  // no new fields at all.
  const metadata = metadataOf(config);
  const existingBackend = data.workspaces[key]?.secret_backend;
  const effectiveBackend = existingBackend ?? backend;
  // A pending old-backend cleanup (migrateOneWorkspace) must survive an
  // ordinary refresh the same way secret_backend does — otherwise a routine
  // `auth login` between a migration's flip and its cleanup retry silently
  // orphans the marker, and with it any hope of ever removing that leftover
  // copy through the CLI.
  const existingPending = data.workspaces[key]?.secret_cleanup_pending;
  const stored = {
    ...metadata,
    ...(key === config.workspace_id ? {} : { profile: key }),
    ...(effectiveBackend === 'file' ? {} : { secret_backend: effectiveBackend }),
    ...(existingPending ? { secret_cleanup_pending: existingPending } : {}),
  };

  const previous = data.workspaces[key];

  // The record holds metadata only until the store attaches the secrets; the
  // document is not persisted in between.
  data.workspaces[key] = stored as WorkspaceConfig;
  await storeCredentials(store, key, config);

  // Re-keying a profile to a different auth type leaves the old type's secrets
  // unreachable. Drop them only once the new ones are stored, so a failing
  // store never leaves the profile with neither set. The kinds of the two auth
  // types never overlap, so this cannot delete what was just written.
  if (previous && previous.auth_type !== config.auth_type) {
    await deleteCredentials(store, key, previous.auth_type);
  }

  // Set as default if it's the first workspace
  if (!data.default_workspace) {
    data.default_workspace = key;
  }

  return key;
}

// Resolve a selector and rebuild its full config from the store. Returns null
// when nothing matches.
export async function readWorkspace(
  data: WorkspacesData,
  store: SecretStore,
  identifier?: string,
): Promise<WorkspaceConfig | null> {
  const resolved = resolveWorkspace(data, identifier);
  if (!resolved) return null;
  return loadCredentials(store, resolved.key, metadataOf(resolved.config));
}

// Delete a profile's credentials, then its record. Credentials go first so a
// failing backend leaves the profile listed (and the removal retryable) rather
// than orphaning secrets nothing references any more.
export async function dropWorkspace(
  data: WorkspacesData,
  store: SecretStore,
  identifier: string,
): Promise<void> {
  const resolved = resolveWorkspace(data, identifier);
  if (!resolved) {
    throw new Error(`Workspace ${identifier} not found`);
  }

  await deleteCredentials(store, resolved.key, resolved.config.auth_type);
  delete data.workspaces[resolved.key];

  // Update default if we removed it
  if (data.default_workspace === resolved.key) {
    const remainingIds = Object.keys(data.workspaces);
    data.default_workspace = remainingIds.length > 0 ? remainingIds[0] : undefined;
  }
}

// Delete every profile's credentials and records.
export async function dropAllWorkspaces(
  data: WorkspacesData,
  store: SecretStore,
): Promise<void> {
  for (const [key, config] of Object.entries(data.workspaces)) {
    await deleteCredentials(store, key, config.auth_type);
  }
  data.workspaces = {};
  data.default_workspace = undefined;
}

// Add or update a workspace. Returns the profile key it was stored under.
export async function addWorkspace(
  config: WorkspaceConfig,
  profile?: string,
  backend: SecretBackend = 'file',
): Promise<string> {
  const data = await loadWorkspaces();
  const key = await putWorkspace(data, secretStoreFor(data), config, profile, backend);
  await saveWorkspaces(data);
  return key;
}

// ---------------------------------------------------------------------------
// Migration between SecretStore backends (#219 part 2).
//
// The concrete backend instances for the two ends of a migration are passed
// in explicitly (rather than resolved via the document, as secretStoreFor()
// does) because the OLD backend has to stay addressable by its own identity
// even after the record's `secret_backend` field flips to the new one in step
// 4 below — a RoutingSecretStore would silently start reading the new
// backend for that key the moment the flip happens.
// ---------------------------------------------------------------------------
export interface SecretBackends {
  file: SecretStore;
  keychain: SecretStore;
}

// Build the concrete backend pair for a loaded document. `keychain` may be
// overridden (tests inject a fake one; production leaves the real one).
export function secretBackendsFor(
  data: WorkspacesData,
  keychain: SecretStore = new MacOSKeychainSecretStore(),
): SecretBackends {
  return { file: new FileSecretStore(data), keychain };
}

export interface MigrationResult {
  key: string;
  authType: WorkspaceConfig['auth_type'];
  from: SecretBackend;
  to: SecretBackend;
  // false when the profile was already on the target backend — a safe no-op,
  // not an error, so a retried or repeated migration reports cleanly.
  migrated: boolean;
  // The backend that still holds a (now redundant) copy not yet confirmed
  // deleted — either from this call's own flip or a previous one that didn't
  // finish — or null once nothing is outstanding. Note this can differ from
  // `from` when the pending copy is left over from an EARLIER migration (e.g.
  // this call is itself a no-op because the profile is already on `target`).
  // Never a failure signal on its own: `to` already holds a verified copy
  // regardless. migrateSecrets keeps retrying the delete.
  pendingCleanup: SecretBackend | null;
}

// Move one profile's credentials from its current backend to `target`,
// verifying every byte before anything old is touched:
//
//   1. Read + validate the credentials on the CURRENT backend.
//   2. Write them to the TARGET backend (cleaning up on a write failure).
//   3. Read them back from the target and compare — a failed read-back or a
//      mismatch both clean up the target and leave the source untouched.
//   4. Flip `secret_backend` in the in-memory document by replacing the
//      record with fresh metadata, and mark `secret_cleanup_pending: from` —
//      the OLD backend's copy still exists (deleting it is `migrateSecrets`'s
//      job, not this function's, since it must happen only after this flip is
//      durably saved) and this field is what makes that deletion retryable
//      across separate process runs if it fails or is never reached.
//
// On any failure before step 4, `data` is not mutated at all, so the caller's
// eventual saveWorkspaces() (if it even runs) persists nothing new — the
// on-disk file is exactly as if migration had not been attempted. That is
// what makes a failed or interrupted migration safe to just retry.
export async function migrateWorkspaceCredentials(
  data: WorkspacesData,
  backends: SecretBackends,
  identifier: string,
  target: SecretBackend,
): Promise<MigrationResult> {
  const resolved = resolveWorkspace(data, identifier);
  if (!resolved) {
    throw new Error(`Workspace ${identifier} not found`);
  }

  const key = resolved.key;
  const authType = resolved.config.auth_type;
  const from = resolved.config.secret_backend ?? 'file';
  const existingPending = (resolved.config as { secret_cleanup_pending?: SecretBackend })
    .secret_cleanup_pending;

  if (from === target) {
    // Already on the target backend — but if a PRIOR migration's old-copy
    // cleanup never finished, that is still outstanding work, surfaced here
    // so migrateSecrets retries it even when this call itself is a no-op.
    return { key, authType, from, to: target, migrated: false, pendingCleanup: existingPending ?? null };
  }

  const fromStore = backends[from];
  const toStore = backends[target];
  const metadata = metadataOf(resolved.config);

  const current = await loadCredentials(fromStore, key, metadata);

  try {
    await storeCredentials(toStore, key, current);
    const verified = await loadCredentials(toStore, key, metadata);
    if (!credentialsMatch(current, verified)) {
      throw new Error(
        `Migration verification failed for "${key}": credentials read back from ${target} ` +
        `did not match what was written. Nothing on ${from} was touched.`
      );
    }
  } catch (err) {
    // Covers a failed write AND a failed or mismatched read-back alike: either
    // way the target must not keep a partial or unverified copy.
    await deleteCredentials(toStore, key, authType).catch(() => {});
    throw err;
  }

  // metadataOf() only strips secrets, not `secret_backend` — this record's own
  // metadata still carries the OLD backend's tag, so it must be dropped
  // explicitly rather than merely conditionally overwritten, or migrating back
  // to 'file' would silently leave the stale 'keychain' tag in place.
  const { secret_backend: _oldBackend, secret_cleanup_pending: _oldPending, ...baseMetadata } =
    metadata as typeof metadata & { secret_backend?: SecretBackend; secret_cleanup_pending?: SecretBackend };
  data.workspaces[key] = {
    ...baseMetadata,
    ...(target === 'file' ? {} : { secret_backend: target }),
    secret_cleanup_pending: from,
  } as WorkspaceConfig;

  return { key, authType, from, to: target, migrated: true, pendingCleanup: from };
}

// Migrate one profile to `target`, including the save-before-cleanup
// sequencing described above. `save` persists the document; the IO wrapper
// passes the real saveWorkspaces(), and tests inject a fake, so this whole
// sequence — flip, durable save, then best-effort old-copy cleanup with
// retry — is exercised without ever touching the real filesystem.
//
// A cleanup failure here is NEVER thrown: by the time it runs, `target`
// already holds a verified, saved, authoritative copy, so the profile is
// fully usable regardless. It just leaves `secret_cleanup_pending` set in the
// saved document, so the very next call for this profile — even one that
// requests a no-op migration, since migrateWorkspaceCredentials's `from ===
// target` branch reports it via `pendingCleanup` — retries the delete.
export async function migrateOneWorkspace(
  data: WorkspacesData,
  backends: SecretBackends,
  key: string,
  target: SecretBackend,
  save: (data: WorkspacesData) => Promise<void>,
): Promise<MigrationResult> {
  const result = await migrateWorkspaceCredentials(data, backends, key, target);
  if (result.migrated) {
    await save(data);
  }
  if (!result.pendingCleanup) return result;

  const pendingBackend = result.pendingCleanup;
  try {
    await deleteCredentials(backends[pendingBackend], result.key, result.authType);
    delete (data.workspaces[result.key] as { secret_cleanup_pending?: SecretBackend }).secret_cleanup_pending;
    await save(data);
    return { ...result, pendingCleanup: null };
  } catch {
    return result; // still pending; the next call (any target) retries it
  }
}

// IO wrapper: migrate one profile (or, with no identifier, every profile) to
// `target`. Continues past a single profile's failure (like
// authenticateAuto's partial-success handling) so one bad profile does not
// block migrating the rest; failures are returned, not thrown.
export async function migrateSecrets(
  target: SecretBackend,
  identifier?: string,
): Promise<{ results: MigrationResult[]; failed: Array<{ key: string; error: string }> }> {
  const data = await loadWorkspaces();
  const keys = identifier
    ? [resolveWorkspace(data, identifier)?.key ?? identifier]
    : Object.keys(data.workspaces);

  const results: MigrationResult[] = [];
  const failed: Array<{ key: string; error: string }> = [];

  for (const key of keys) {
    const backends = secretBackendsFor(data);
    try {
      results.push(await migrateOneWorkspace(data, backends, key, target, saveWorkspaces));
    } catch (err: any) {
      failed.push({ key, error: err?.message ?? 'Unknown error' });
    }
  }

  return { results, failed };
}

// Remove a workspace by profile key, workspace id, or name.
export async function removeWorkspace(identifier: string): Promise<void> {
  const data = await loadWorkspaces();
  await dropWorkspace(data, secretStoreFor(data), identifier);
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
// Only this path resolves secrets; listing and set-default use metadata alone.
export async function getWorkspace(identifier?: string): Promise<WorkspaceConfig | null> {
  const data = await loadWorkspaces();
  return readWorkspace(data, secretStoreFor(data), identifier);
}

// Get all workspaces paired with their profile keys.
export async function getAllWorkspaceEntries(): Promise<ResolvedWorkspace[]> {
  const data = await loadWorkspaces();
  return Object.entries(data.workspaces).map(([key, config]) => ({ key, config }));
}

// Clear all workspaces, deleting every profile's credentials first.
export async function clearAllWorkspaces(): Promise<void> {
  const data = await loadWorkspaces();
  await dropAllWorkspaces(data, secretStoreFor(data));
  await saveWorkspaces({ workspaces: {} });
}

// Get default workspace ID
export async function getDefaultWorkspaceId(): Promise<string | undefined> {
  const data = await loadWorkspaces();
  return data.default_workspace;
}
