import { writeFile, chmod, rename, unlink, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import chalk from 'chalk';
import { getLogger } from '@logtape/logtape';
import { info, success, error as logError } from './formatter.ts';
import { getAppVersion, isRunningUnderBun } from '../version.ts';

const logger = getLogger(['slackcli', 'updater']);

const DEFAULT_CONFIG_DIR = join(homedir(), '.config', 'slackcli');
let configDir = DEFAULT_CONFIG_DIR;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface UpdateCache {
  checkedAt: number;
  latestVersion: string;
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

// Fetch latest release from GitHub
export async function fetchLatestRelease(): Promise<GitHubRelease | null> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'SlackCLI',
        },
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
      error: err instanceof Error ? err.message : String(err),
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
  const release = await fetchLatestRelease();

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
    info(`Run "${getUpdateCommand()}" to update`);
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

  const release = await fetchLatestRelease();

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
      error: err instanceof Error ? err.message : String(err),
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
    logger.error('Self-update install failed: {error}', { error: error?.message ?? String(error) });
    logError(`Update failed: ${error.message}`);
    throw error;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

// Read cached update check result synchronously
function readUpdateCache(): UpdateCache | null {
  try {
    const data = readFileSync(updateCacheFile(), 'utf-8');
    return JSON.parse(data) as UpdateCache;
  } catch {
    return null;
  }
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
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Detect if the binary was installed via Homebrew
export function isInstalledViaHomebrew(): boolean {
  const execPath = process.execPath;
  return execPath.includes('homebrew') || execPath.includes('Cellar') || execPath.includes('linuxbrew');
}

// Return the appropriate update command for this installation
export function getUpdateCommand(): string {
  return isInstalledViaHomebrew() ? 'brew upgrade slackcli' : 'slackcli update';
}

// True when the invoked command is `update` (or one of its subcommands).
// argv is process.argv-shaped: runtime, script, then the user's arguments.
export function isUpdateCommand(argv: string[]): boolean {
  const command = argv.slice(2).find(arg => !arg.startsWith('-'));
  return command === 'update';
}

// Show a one-line update notification after the command finishes (via beforeExit),
// and refresh the cache in the background if it is stale.
export function notifyIfUpdateAvailable(argv: string[] = process.argv): void {
  // `update` and `update check` report versions themselves; a banner read from
  // the pre-update version and cache would contradict them (#276).
  if (isUpdateCommand(argv)) {
    return;
  }

  // Local `bun run` / source checkout — not a release binary; skip self-update nags.
  if (isRunningUnderBun()) {
    return;
  }

  const cache = readUpdateCache();
  const now = Date.now();

  // Trigger a background cache refresh if missing or older than 24h
  if (!cache || (now - cache.checkedAt) > CHECK_INTERVAL_MS) {
    fetchLatestRelease()
      .then(release => {
        if (release) {
          writeUpdateCache({ checkedAt: now, latestVersion: release.tag_name });
        }
      })
      .catch(() => {});
  }

  // Nothing to show if cache is empty or already on latest
  if (!cache || !isNewerVersion(cache.latestVersion, CURRENT_VERSION)) {
    return;
  }

  const updateCmd = getUpdateCommand();
  let printed = false;

  process.on('beforeExit', () => {
    if (printed) return;
    printed = true;
    process.stderr.write(
      chalk.yellow(`\n  Update available: v${CURRENT_VERSION} → ${cache.latestVersion}\n`) +
      chalk.dim(`  Run: ${updateCmd}\n`),
    );
  });
}
