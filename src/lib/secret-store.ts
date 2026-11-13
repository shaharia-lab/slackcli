import { spawn } from 'node:child_process';
import { getLogger } from '@logtape/logtape';
import type {
  AuthType,
  SecretBackend,
  WorkspaceConfig,
  WorkspaceMetadata,
  WorkspacesData,
} from '../types/index.ts';

// Records carry backend names, failure reasons and secret keys (`<profile>:<kind>`
// identifiers) only — never a secret value.
const logger = getLogger(['slackcli', 'secret-store']);

// ---------------------------------------------------------------------------
// Credential storage seam (#219).
//
// Workspace metadata (ids, names, auth type, profile) and the secrets that
// authenticate it (xoxb/xoxp token, xoxc/xoxd browser pair) are handled through
// separate paths: metadata stays in workspaces.json, secrets go through a
// SecretStore. The only backend today is FileSecretStore, which keeps secrets
// inline in workspaces.json exactly as before, so the file format is unchanged.
// Native backends (macOS Keychain) plug in behind the same interface.
// ---------------------------------------------------------------------------

// The kinds of secret a workspace can hold. Standard auth has one token;
// browser auth has the xoxc token plus the xoxd session cookie.
export type CredentialKind = 'token' | 'xoxc' | 'xoxd';

export const CREDENTIAL_KINDS: Record<AuthType, readonly CredentialKind[]> = {
  standard: ['token'],
  browser: ['xoxc', 'xoxd'],
};

// Every kind, for cleaning up after a record whose auth_type is missing or
// unknown (a hand-edited or damaged file) — deleting an absent kind is a no-op.
const ALL_CREDENTIAL_KINDS: readonly CredentialKind[] = ['token', 'xoxc', 'xoxd'];

// Where each kind lives on a WorkspaceConfig record.
const CREDENTIAL_FIELDS: Record<CredentialKind, 'token' | 'xoxc_token' | 'xoxd_token'> = {
  token: 'token',
  xoxc: 'xoxc_token',
  xoxd: 'xoxd_token',
};

// A backend stores opaque string secrets under string keys.
//
// `get` resolves to null when the secret does not exist. Every other failure —
// the backend being unavailable, or access to it being denied — rejects with a
// SecretStoreError, so "not there" is never confused with "could not look".
export interface SecretStore {
  readonly backend: string;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export type SecretStoreErrorReason = 'unavailable' | 'access_denied';

export class SecretStoreError extends Error {
  public backend: string;
  public reason: SecretStoreErrorReason;

  constructor(backend: string, reason: SecretStoreErrorReason, message: string) {
    super(message);
    this.name = 'SecretStoreError';
    this.backend = backend;
    this.reason = reason;
  }
}

// A profile's metadata exists but one of its secrets does not.
export class MissingCredentialError extends Error {
  public ref: string;
  public kind: CredentialKind;

  constructor(ref: string, kind: CredentialKind) {
    super(
      `Stored credentials for profile "${ref}" are incomplete (missing ${kind}). ` +
      `Re-authenticate with "slackcli auth login" or "slackcli auth login-browser".`
    );
    this.name = 'MissingCredentialError';
    this.ref = ref;
    this.kind = kind;
  }
}

// The key a secret is stored under: the profile reference plus the kind.
// Profile names are user-chosen and may themselves contain ':', so the kind is
// always the segment after the LAST separator.
export function secretKey(ref: string, kind: CredentialKind): string {
  if (!ref) throw new Error('Secret reference must not be empty');
  return `${ref}:${kind}`;
}

export function parseSecretKey(key: string): { ref: string; kind: CredentialKind } {
  const sep = key.lastIndexOf(':');
  const ref = sep > 0 ? key.slice(0, sep) : '';
  const kind = key.slice(sep + 1);
  if (!ref || !Object.hasOwn(CREDENTIAL_FIELDS, kind)) {
    throw new Error(`Invalid secret key: "${key}"`);
  }
  return { ref, kind: kind as CredentialKind };
}

// Split a full config into the secrets it carries, keyed by kind.
function credentialsOf(config: WorkspaceConfig): Array<[CredentialKind, string]> {
  if (config.auth_type === 'standard') return [['token', config.token]];
  return [['xoxc', config.xoxc_token], ['xoxd', config.xoxd_token]];
}

// The config with its secrets removed — what is safe to keep as metadata.
export function metadataOf(config: WorkspaceConfig): WorkspaceMetadata {
  if (config.auth_type === 'standard') {
    const { token: _token, ...metadata } = config;
    return metadata;
  }
  const { xoxc_token: _xoxc, xoxd_token: _xoxd, ...metadata } = config;
  return metadata;
}

// Persist every secret of `config` under profile reference `ref`.
export async function storeCredentials(
  store: SecretStore,
  ref: string,
  config: WorkspaceConfig,
): Promise<void> {
  for (const [kind, value] of credentialsOf(config)) {
    await store.set(secretKey(ref, kind), value);
  }
}

// Rebuild a full config from stored metadata plus the secrets in the store.
// A missing secret throws MissingCredentialError; backend failures propagate.
export async function loadCredentials(
  store: SecretStore,
  ref: string,
  metadata: WorkspaceMetadata,
): Promise<WorkspaceConfig> {
  const kinds = CREDENTIAL_KINDS[metadata.auth_type] as readonly CredentialKind[] | undefined;
  if (!kinds) {
    throw new Error(
      `Profile "${ref}" has an unknown auth type (${String(metadata.auth_type)}). ` +
      `Remove it with "slackcli auth remove" and authenticate again.`
    );
  }

  const secrets: Partial<Record<CredentialKind, string>> = {};
  for (const kind of kinds) {
    const value = await store.get(secretKey(ref, kind));
    if (value === null) throw new MissingCredentialError(ref, kind);
    secrets[kind] = value;
  }

  if (metadata.auth_type === 'standard') {
    return { ...metadata, token: secrets.token as string };
  }
  return {
    ...metadata,
    xoxc_token: secrets.xoxc as string,
    xoxd_token: secrets.xoxd as string,
  };
}

// Delete every secret for profile `ref`. Deleting an absent secret is a no-op,
// so an unrecognised auth type deletes every kind rather than failing: remove
// and logout are how a user recovers from a damaged record.
export async function deleteCredentials(
  store: SecretStore,
  ref: string,
  authType: AuthType,
): Promise<void> {
  for (const kind of CREDENTIAL_KINDS[authType] ?? ALL_CREDENTIAL_KINDS) {
    await store.delete(secretKey(ref, kind));
  }
}

// ---------------------------------------------------------------------------
// FileSecretStore: the legacy backend. Secrets live inline on the profile's
// record in the loaded workspaces.json document, under the same field names as
// always (`token`, `xoxc_token`, `xoxd_token`). It mutates the in-memory
// document only; the caller persists it with saveWorkspaces(), which keeps the
// file's 0600 mode and the one-write-per-command behaviour.
// ---------------------------------------------------------------------------
export class FileSecretStore implements SecretStore {
  public readonly backend = 'file';

  constructor(private readonly data: WorkspacesData) {}

  // The record's fields, viewed as a plain map for kind-driven access.
  private record(ref: string): Record<string, unknown> | undefined {
    return this.data.workspaces[ref] as unknown as Record<string, unknown> | undefined;
  }

  async get(key: string): Promise<string | null> {
    const { ref, kind } = parseSecretKey(key);
    const record = this.record(ref);
    if (!record || !CREDENTIAL_KINDS[record.auth_type as AuthType]?.includes(kind)) {
      return null;
    }
    const value = record[CREDENTIAL_FIELDS[kind]];
    return typeof value === 'string' ? value : null;
  }

  async set(key: string, value: string): Promise<void> {
    const { ref, kind } = parseSecretKey(key);
    const record = this.record(ref);
    if (!record) {
      throw new Error(`Cannot store ${kind} for unknown profile "${ref}"`);
    }
    if (!CREDENTIAL_KINDS[record.auth_type as AuthType]?.includes(kind)) {
      throw new Error(
        `Profile "${ref}" uses ${String(record.auth_type)} auth and cannot hold a ${kind} credential`
      );
    }
    record[CREDENTIAL_FIELDS[kind]] = value;
  }

  async delete(key: string): Promise<void> {
    const { ref, kind } = parseSecretKey(key);
    const record = this.record(ref);
    if (record) delete record[CREDENTIAL_FIELDS[kind]];
  }
}

// ---------------------------------------------------------------------------
// MacOSKeychainSecretStore: shells out to the macOS `security` CLI rather than
// adding an FFI binding to Security.framework — the same trade-off
// cdp-client.ts made against Playwright, to stay inside the 150MB CI binary
// budget with no extra dependency. It also keeps /usr/bin/security, a stable
// Apple-signed binary, as the app every item trusts, so a self-update of our
// ad-hoc-signed binary never triggers a new Keychain prompt.
//
// A write never puts the secret in argv (#515): `security -i` reads the
// `add-generic-password` command line from stdin instead, so `ps` sees only
// `security -i`. Reads and deletes carry no secret and pass plain argv. Every
// item is stored under service "slackcli", account
// `<profile key>:<token|xoxc|xoxd>` (secretKey()).
// ---------------------------------------------------------------------------

const KEYCHAIN_SERVICE = 'slackcli';

// The exit code `security` uses for "no such keychain item" (errSecItemNotFound).
const SEC_ITEM_NOT_FOUND = 44;

export interface SecurityCliResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Runs the `security` CLI with the given arguments, writing `input` (if any) to
// its stdin and then closing it. Injectable so tests never need
// a real macOS keychain — see cdp-client.test.ts for the same pattern applied
// to an untestable transport.
export type SecurityCliRunner = (args: string[], input?: string) => Promise<SecurityCliResult>;

export const runSecurityCli: SecurityCliRunner = (args, input) =>
  new Promise((resolve) => {
    const proc = spawn('security', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    // A spawn failure surfaces through proc's 'error' below; this only stops
    // the matching EPIPE on stdin from being thrown as unhandled.
    proc.stdin.on('error', () => {});
    proc.stdin.end(input ?? '');
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('error', (err: NodeJS.ErrnoException) => {
      resolve({
        code: -1,
        stdout: '',
        stderr: err.code === 'ENOENT' ? 'security: command not found (ENOENT)' : String(err.message ?? err),
      });
    });

    proc.on('close', (code) => {
      resolve({ code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });

// `security -i` reads each command line into a fixed 4096-byte buffer and runs
// whatever overflows it as a further command, so a line must fit with room for
// its terminating newline (SecurityTool/macOS/security.c, MAX_LINE_LEN).
const SECURITY_MAX_LINE_BYTES = 4095;

// Quote one argument for the `security -i` line parser (split_line() in
// SecurityTool/macOS/security.c): inside double quotes, a backslash makes the
// next byte literal, so escaping `\` and `"` is enough. A line break would end
// the command early and a NUL would truncate it; neither occurs in a Slack
// credential or a sensible profile name, so they are refused rather than encoded.
function quoteSecurityArg(arg: string, what: string): string {
  if (/[\0\n\r]/.test(arg)) {
    throw new Error(`Cannot store ${what} in the Keychain: it contains a line break or NUL character`);
  }
  return `"${arg.replace(/[\\"]/g, (ch) => `\\${ch}`)}"`;
}

// The stdin line `security -i` runs for a write. -U updates an existing item in
// place rather than failing with "already exists" (needed for token refresh).
function addGenericPasswordLine(key: string, value: string): string {
  const line = [
    'add-generic-password',
    '-a', quoteSecurityArg(key, `"${key}"`),
    '-s', KEYCHAIN_SERVICE,
    '-w', quoteSecurityArg(value, `the value for "${key}"`),
    '-U',
  ].join(' ');
  if (Buffer.byteLength(line, 'utf8') >= SECURITY_MAX_LINE_BYTES) {
    throw new Error(`Cannot store the value for "${key}" in the Keychain: it is too long`);
  }
  return `${line}\n`;
}

function isNotFound(result: SecurityCliResult): boolean {
  return result.code === SEC_ITEM_NOT_FOUND || /could not be found/i.test(result.stderr);
}

function isCommandMissing(result: SecurityCliResult): boolean {
  return result.code === -1 || /ENOENT/.test(result.stderr);
}

function keychainError(result: SecurityCliResult, action: string): SecretStoreError {
  const error = buildKeychainError(result, action);
  logger.warn('Keychain {action} failed: {reason}', {
    action,
    reason: error.reason,
    exit_code: result.code,
  });
  return error;
}

function buildKeychainError(result: SecurityCliResult, action: string): SecretStoreError {
  if (isCommandMissing(result)) {
    return new SecretStoreError(
      'keychain',
      'unavailable',
      `Could not run the macOS "security" CLI to ${action} (${result.stderr || 'not found'}).`,
    );
  }
  return new SecretStoreError(
    'keychain',
    'access_denied',
    `Keychain ${action} failed (${result.stderr || 'security exited ' + result.code}).`,
  );
}

export class MacOSKeychainSecretStore implements SecretStore {
  public readonly backend = 'keychain';

  constructor(
    private readonly run: SecurityCliRunner = runSecurityCli,
    private readonly platform: string = process.platform,
  ) {}

  private assertAvailable(): void {
    if (this.platform !== 'darwin') {
      logger.warn('Keychain backend requested on {platform}: unavailable', {
        platform: this.platform,
        reason: 'unavailable',
      });
      throw new SecretStoreError(
        'keychain',
        'unavailable',
        'The macOS Keychain backend is only available on macOS.',
      );
    }
  }

  async get(key: string): Promise<string | null> {
    this.assertAvailable();
    const result = await this.run([
      'find-generic-password', '-a', key, '-s', KEYCHAIN_SERVICE, '-w',
    ]);
    if (result.code === 0) return result.stdout;
    if (isNotFound(result)) return null;
    throw keychainError(result, `read "${key}"`);
  }

  async set(key: string, value: string): Promise<void> {
    this.assertAvailable();
    // The secret goes through stdin, never argv (#515). `security -i` exits
    // with the status of the last command it ran, which is this one.
    const result = await this.run(['-i'], addGenericPasswordLine(key, value));
    if (result.code !== 0) throw keychainError(result, `write "${key}"`);
  }

  async delete(key: string): Promise<void> {
    this.assertAvailable();
    const result = await this.run(['delete-generic-password', '-a', key, '-s', KEYCHAIN_SERVICE]);
    if (result.code !== 0 && !isNotFound(result)) throw keychainError(result, `delete "${key}"`);
  }
}

// ---------------------------------------------------------------------------
// RoutingSecretStore: dispatches each key to the backend its own profile
// record is tagged with (`secret_backend`, default 'file'), so a single
// document can hold profiles on different backends at once. It reads the
// backend from `data` fresh on every call — not cached — which is what makes
// a profile's mid-migration metadata flip (workspaces.ts) take effect
// immediately for whichever backend is asked for next.
// ---------------------------------------------------------------------------
export class RoutingSecretStore implements SecretStore {
  public readonly backend = 'routing';

  constructor(
    private readonly data: WorkspacesData,
    private readonly keychain: SecretStore = new MacOSKeychainSecretStore(),
  ) {}

  private storeFor(ref: string): SecretStore {
    const record = this.data.workspaces[ref] as { secret_backend?: SecretBackend } | undefined;
    const backend: SecretBackend = record?.secret_backend ?? 'file';
    logger.debug('Secret backend for {profile_key}: {backend}', { profile_key: ref, backend });
    return backend === 'keychain' ? this.keychain : new FileSecretStore(this.data);
  }

  async get(key: string): Promise<string | null> {
    return this.storeFor(parseSecretKey(key).ref).get(key);
  }

  async set(key: string, value: string): Promise<void> {
    return this.storeFor(parseSecretKey(key).ref).set(key, value);
  }

  async delete(key: string): Promise<void> {
    return this.storeFor(parseSecretKey(key).ref).delete(key);
  }
}

// Whether two full configs carry byte-identical secrets — used by migration to
// verify a credential read back from the new backend exactly matches what was
// written, before the old backend's copy is ever removed.
export function credentialsMatch(a: WorkspaceConfig, b: WorkspaceConfig): boolean {
  if (a.auth_type !== b.auth_type) return false;
  if (a.auth_type === 'standard') {
    return b.auth_type === 'standard' && a.token === b.token;
  }
  return b.auth_type === 'browser' && a.xoxc_token === b.xoxc_token && a.xoxd_token === b.xoxd_token;
}
