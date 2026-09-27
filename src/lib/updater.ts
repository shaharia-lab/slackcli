import { writeFile, chmod, rename, unlink, mkdtemp, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  accessSync,
  constants,
  openSync,
  closeSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import chalk from 'chalk';
import { getLogger } from '@logtape/logtape';
import { errorMessageForLog } from './tildify.ts';
import { info, success, error as logError } from './formatter.ts';
import { getAppVersion, isRunningUnderBun } from '../version.ts';

const logger = getLogger(['slackcli', 'updater']);

const DEFAULT_CONFIG_DIR = join(homedir(), '.config', 'slackcli');
let configDir = DEFAULT_CONFIG_DIR;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
// After a failed background check, wait this long before trying again, so an
// offline user does not pay for (and wait on) the check on every command.
export const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000; // 1 hour
// The background check must never make a finished command slow to exit.
export const BACKGROUND_CHECK_TIMEOUT_MS = 1500;
// `update` and `update check` were asked for explicitly, so they can wait longer.
export const FOREGROUND_CHECK_TIMEOUT_MS = 10_000;

interface UpdateCache {
  checkedAt: number;
  latestVersion?: string;
  // Set when the last background check failed; cleared by the next success.
  failedAt?: number;
}

const GITHUB_REPO = 'shaharia-lab/slackcli';
const CURRENT_VERSION = getAppVersion();

interface GitHubRelease {
  tag_name: string;
  name: string;
  body: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
    // "sha256:<hex>", published by GitHub for every release asset.
    digest?: string;
  }>;
}

// Test seam: point the update cache at a throwaway directory; null restores the default.
export function setUpdateCacheDirForTesting(dir: string | null): void {
  configDir = dir ?? DEFAULT_CONFIG_DIR;
}

function updateCacheFile(): string {
  return join(configDir, 'update-check.json');
}

// Get current version
export function getCurrentVersion(): string {
  return CURRENT_VERSION;
}

// Fetch latest release from GitHub. The timeout covers the whole lookup,
// body included; on expiry the request is aborted and this returns null.
export async function fetchLatestRelease(
  timeoutMs: number = FOREGROUND_CHECK_TIMEOUT_MS
): Promise<GitHubRelease | null> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'SlackCLI',
        },
        signal: AbortSignal.timeout(timeoutMs),
      }
    );

    if (!response.ok) {
      logger.debug('Latest-release lookup returned HTTP {http_status}', { http_status: response.status });
      return null;
    }

    const release = (await response.json()) as GitHubRelease;
    logger.debug('Latest release is {latest_version}', { latest_version: release?.tag_name });
    return release;
  } catch (err) {
    // Update checks fail soft: callers treat null as "could not check".
    logger.debug('Latest-release lookup failed: {error}', {
      error: errorMessageForLog(err),
    });
    return null;
  }
}

// Compare versions (simple semver comparison)
export function isNewerVersion(latest: string, current: string): boolean {
  const latestParts = latest.replace('v', '').split('.').map(Number);
  const currentParts = current.replace('v', '').split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    if (latestParts[i] > currentParts[i]) return true;
    if (latestParts[i] < currentParts[i]) return false;
  }

  return false;
}

// Get platform-specific binary name
function getBinaryName(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'linux') return arch === 'arm64' ? 'slackcli-linux-arm64' : 'slackcli-linux';
  if (platform === 'darwin') return arch === 'arm64' ? 'slackcli-macos-arm64' : 'slackcli-macos';
  if (platform === 'win32') return 'slackcli-windows.exe';

  throw new Error(`Unsupported platform: ${platform}`);
}

// Verify downloaded bytes against the digest the release published.
//
// Fails closed on a missing or non-sha256 digest: the party we are defending
// against here is whoever can substitute the response, and a skip-when-absent
// check would simply be switched off by dropping the field.
export function verifyAssetDigest(
  binaryName: string,
  bytes: Uint8Array,
  expected: string | undefined
): void {
  if (!expected) {
    throw new Error(
      `Release asset ${binaryName} has no digest to verify against — refusing to install it. ` +
        `Download it manually and check it against checksums.txt from the release.`
    );
  }

  const [algorithm, digest] = expected.split(':');

  if (algorithm !== 'sha256' || !digest) {
    throw new Error(`Unsupported digest format for ${binaryName}: ${expected}`);
  }

  const actual = createHash('sha256').update(bytes).digest('hex');

  if (actual !== digest.toLowerCase()) {
    throw new Error(
      `Checksum mismatch for ${binaryName}: expected sha256:${digest}, got sha256:${actual}`
    );
  }
}

// Check for updates
export async function checkForUpdates(silent: boolean = true): Promise<{
  updateAvailable: boolean;
  latestVersion?: string;
  currentVersion: string;
}> {
  const release = await fetchLatestRelease(FOREGROUND_CHECK_TIMEOUT_MS);

  if (!release) {
    if (!silent) {
      info('Unable to check for updates');
    }
    return { updateAvailable: false, currentVersion: CURRENT_VERSION };
  }

  const latestVersion = release.tag_name;
  const updateAvailable = isNewerVersion(latestVersion, CURRENT_VERSION);
  logger.info('Update check: current {current_version}, latest {latest_version}, update available {update_available}', {
    current_version: CURRENT_VERSION,
    latest_version: latestVersion,
    update_available: updateAvailable,
  });

  if (updateAvailable && !silent) {
    info(`New version available: ${latestVersion} (current: v${CURRENT_VERSION})`);
    info(`Run "${getUpdateCommand()}"${updateCommandSuffix()} to update`);
  }

  return {
    updateAvailable,
    latestVersion,
    currentVersion: CURRENT_VERSION,
  };
}

// Download and install update
export async function performUpdate(): Promise<void> {
  if (isRunningUnderBun()) {
    logger.info('Self-update skipped: running from source');
    info('Running from source (bun) — update with `git pull`, not `slackcli update`.');
    return;
  }

  // Replacing a binary inside a Homebrew Cellar leaves brew's record out of
  // sync with what is actually installed (#276), so defer to brew instead.
  if (isInstalledViaHomebrew()) {
    logger.info('Self-update skipped: installed via Homebrew');
    info('Installed via Homebrew — run: brew upgrade slackcli');
    return;
  }

  info(`Checking for updates...`);

  const release = await fetchLatestRelease(FOREGROUND_CHECK_TIMEOUT_MS);

  if (!release) {
    logger.error('Self-update failed: could not fetch the latest release');
    throw new Error('Unable to fetch latest release');
  }

  const latestVersion = release.tag_name;

  if (!isNewerVersion(latestVersion, CURRENT_VERSION)) {
    logger.info('Self-update: already on {current_version} (latest {latest_version})', {
      current_version: CURRENT_VERSION,
      latest_version: latestVersion,
    });
    success(`Already on latest version (v${CURRENT_VERSION})`);
    return;
  }

  // Replacing the binary renames files inside its folder. Refuse before the
  // download rather than fail at rename() with a raw EACCES afterwards (#284).
  if (!isInstallDirWritable()) {
    logger.error('Self-update refused: the install folder is not writable');
    throw new Error(installDirNotWritableMessage(dirname(process.execPath)));
  }

  info(`Downloading version ${latestVersion}...`);

  const binaryName = getBinaryName();
  const asset = release.assets.find(a => a.name === binaryName);

  logger.info('Self-update: {current_version} → {latest_version} ({asset})', {
    current_version: CURRENT_VERSION,
    latest_version: latestVersion,
    asset: binaryName,
  });

  if (!asset) {
    logger.error('Self-update failed: no release asset named {asset}', { asset: binaryName });
    throw new Error(`Binary not found for ${binaryName}`);
  }

  // Download binary
  const response = await fetch(asset.browser_download_url);

  if (!response.ok) {
    logger.error('Self-update download returned HTTP {http_status}', { http_status: response.status });
    throw new Error(`Failed to download: ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  logger.info('Downloaded {bytes} bytes', { bytes: bytes.length });

  // Before anything touches the disk: these bytes become the running binary.
  try {
    verifyAssetDigest(binaryName, bytes, asset.digest);
  } catch (err) {
    logger.error('Digest verification failed: {error}', {
      error: errorMessageForLog(err),
    });
    throw err;
  }
  logger.info('Digest verification passed ({digest})', { digest: asset.digest });

  // mkdtemp creates a fresh 0700 directory and fails rather than reusing an
  // existing path, so a same-host user cannot pre-create the file we are about
  // to chmod 0755 and rename over the CLI itself.
  const tmpDir = await mkdtemp(join(tmpdir(), 'slackcli-update-'));
  const tmpPath = join(tmpDir, binaryName);

  // Get current binary path
  const currentBinary = process.execPath;

  try {
    // Write to temp file
    await writeFile(tmpPath, bytes);
    await chmod(tmpPath, 0o755);

    info(`Installing update...`);

    // Backup current binary
    const backupPath = `${currentBinary}.backup`;
    await rename(currentBinary, backupPath);

    // Move new binary to current location
    await rename(tmpPath, currentBinary);

    // Remove backup
    await unlink(backupPath);

    // Keep the notifier's cache in step with what is now installed, so the
    // next run does not announce an update from a stale cached check.
    writeUpdateCache({ checkedAt: Date.now(), latestVersion });

    logger.info('Self-update installed {latest_version}', { latest_version: latestVersion });
    success(`Updated to version ${latestVersion}`);
    info('Please restart slackcli to use the new version');
  } catch (error: any) {
    // Try to restore from backup if it exists
    logger.error('Self-update install failed: {error}', {
      error: errorMessageForLog(error),
    });
    logError(`Update failed: ${error.message}`);
    throw error;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

// Read cached update check result synchronously. Fields of the wrong type are
// dropped, so a hand-edited or older cache file cannot break the notifier.
function readUpdateCache(): UpdateCache | null {
  try {
    const data: unknown = JSON.parse(readFileSync(updateCacheFile(), 'utf-8'));
    if (typeof data !== 'object' || data === null) return null;
    const { checkedAt, latestVersion, failedAt } = data as Record<string, unknown>;
    const cache: UpdateCache = { checkedAt: typeof checkedAt === 'number' ? checkedAt : 0 };
    if (typeof latestVersion === 'string') cache.latestVersion = latestVersion;
    if (typeof failedAt === 'number') cache.failedAt = failedAt;
    return cache;
  } catch {
    return null;
  }
}

// True when `timestamp` lies within the last `windowMs`. A timestamp in the
// future (clock moved back) counts as outside, so it cannot suppress checks.
function isWithin(timestamp: number | undefined, now: number, windowMs: number): boolean {
  return timestamp !== undefined && timestamp <= now && now - timestamp < windowMs;
}

// Write update check result to cache
function writeUpdateCache(cache: UpdateCache): void {
  try {
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true, mode: 0o700 });
    }
    writeFileSync(updateCacheFile(), JSON.stringify(cache, null, 2));
  } catch (err) {
    // Silently fail — cache is best-effort
    logger.debug('Could not write the update cache: {error}', {
      error: errorMessageForLog(err),
    });
  }
}

// Detect if the binary was installed via Homebrew
export function isInstalledViaHomebrew(): boolean {
  const execPath = process.execPath;
  return execPath.includes('homebrew') || execPath.includes('Cellar') || execPath.includes('linuxbrew');
}

// True when the current user may create and rename files in the folder that
// holds the binary, which is what replacing it needs (not write access to the
// file itself). Takes the path so tests can point it at a folder they control.
export function isInstallDirWritable(execPath: string = process.execPath): boolean {
  const dir = dirname(execPath);
  try {
    if (process.platform === 'win32') {
      // access(W_OK) on Windows only reads the read-only attribute, which
      // folders never carry, and ignores the ACLs that protect folders such as
      // C:\Program Files. Creating (then removing) a file is the real test.
      const probe = join(dir, `.slackcli-write-test-${randomUUID()}`);
      closeSync(openSync(probe, 'wx'));
      unlinkSync(probe);
    } else {
      accessSync(dir, constants.W_OK);
    }
    return true;
  } catch {
    return false;
  }
}

// A non-Homebrew install in a folder this user cannot write, such as
// /usr/local/bin. slackcli never elevates itself; it only says how to.
function needsElevation(): boolean {
  return !isInstalledViaHomebrew() && !isInstallDirWritable();
}

// Return the appropriate update command for this installation
export function getUpdateCommand(): string {
  if (isInstalledViaHomebrew()) return 'brew upgrade slackcli';
  // Windows has no sudo: the command stays the same and updateCommandSuffix()
  // asks for an Administrator terminal instead.
  if (process.platform !== 'win32' && !isInstallDirWritable()) return 'sudo slackcli update';
  return 'slackcli update';
}

// Text to append after the quoted update command: on Windows, where the
// command is unchanged, this is how an unwritable install folder is surfaced.
export function updateCommandSuffix(): string {
  return process.platform === 'win32' && needsElevation() ? ' from an Administrator terminal' : '';
}

// Why `slackcli update` refuses to start, and what to run instead.
function installDirNotWritableMessage(installDir: string): string {
  const remedy =
    process.platform === 'win32'
      ? 'run slackcli update from an Administrator terminal'
      : 'run: sudo slackcli update';
  return `No write permission for ${installDir} — ${remedy}`;
}

// True when the invoked command is `update` (or one of its subcommands).
// argv is process.argv-shaped: runtime, script, then the user's arguments.
export function isUpdateCommand(argv: string[]): boolean {
  const command = argv.slice(2).find(arg => !arg.startsWith('-'));
  return command === 'update';
}

// An env flag is on when set to anything but empty, `0` or `false` (any case).
function isTruthyEnv(value: string | undefined): boolean {
  return !!value && !['0', 'false'].includes(value.toLowerCase());
}

// True when the user opted out (SLACKCLI_NO_UPDATE_NOTIFIER) or we run in CI.
export function isUpdateNotifierDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyEnv(env.SLACKCLI_NO_UPDATE_NOTIFIER) || isTruthyEnv(env.CI);
}

// Show a one-line update notification after the command finishes (via beforeExit),
// and refresh the cache in the background if it is stale. The banner uses the
// freshly fetched version when the refresh finished, the cached one otherwise.
// Returns the pending refresh so tests can await it; the CLI does not.
export function notifyIfUpdateAvailable(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  // Opted out, or in CI: no cache read, no GitHub request, no banner (#283).
  if (isUpdateNotifierDisabled(env)) {
    return Promise.resolve();
  }

  // `update` and `update check` report versions themselves; a banner read from
  // the pre-update version and cache would contradict them (#276).
  if (isUpdateCommand(argv)) {
    return Promise.resolve();
  }

  // Local `bun run` / source checkout — not a release binary; skip self-update nags.
  if (isRunningUnderBun()) {
    return Promise.resolve();
  }

  const cache = readUpdateCache();
  const now = Date.now();
  let freshLatest: string | undefined;
  let refresh = Promise.resolve();

  // Refresh when the last successful check is older than 24h, unless a check
  // failed within the back-off window.
  const stale = !isWithin(cache?.checkedAt, now, CHECK_INTERVAL_MS);
  const backingOff = isWithin(cache?.failedAt, now, RETRY_AFTER_FAILURE_MS);
  const refreshing = stale && !backingOff;
  if (stale && backingOff) {
    logger.debug('Update check skipped: backing off after a failed check');
  }
  if (refreshing) {
    refresh = fetchLatestRelease(BACKGROUND_CHECK_TIMEOUT_MS)
      .then(release => {
        if (release) {
          freshLatest = release.tag_name;
          writeUpdateCache({ checkedAt: now, latestVersion: release.tag_name });
        } else {
          // Keep what we knew, and note the failure so the next run backs off.
          writeUpdateCache({ ...cache, checkedAt: cache?.checkedAt ?? 0, failedAt: now });
        }
      })
      .catch(() => {});
  }

  const cachedLatest = cache?.latestVersion;
  const cachedIsNewer = cachedLatest !== undefined && isNewerVersion(cachedLatest, CURRENT_VERSION);

  // Nothing can be shown: no refresh pending and the cache has nothing newer.
  if (!refreshing && !cachedIsNewer) {
    return refresh;
  }

  const updateCmd = getUpdateCommand() + updateCommandSuffix();
  let printed = false;

  process.on('beforeExit', () => {
    if (printed) return;
    const latest = freshLatest ?? cachedLatest;
    if (latest === undefined || !isNewerVersion(latest, CURRENT_VERSION)) return;
    printed = true;
    process.stderr.write(
      chalk.yellow(`\n  Update available: v${CURRENT_VERSION} → ${latest}\n`) +
      chalk.dim(`  Run: ${updateCmd}\n`),
    );
  });

  return refresh;
}
