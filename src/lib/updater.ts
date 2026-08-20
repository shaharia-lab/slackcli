import { writeFile, chmod, rename, unlink, mkdtemp, rm } from 'fs/promises';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import chalk from 'chalk';
import { info, success, error as logError } from './formatter.ts';
import { getAppVersion, isRunningUnderBun } from '../version.ts';

const CONFIG_DIR = join(homedir(), '.config', 'slackcli');
const UPDATE_CACHE_FILE = join(CONFIG_DIR, 'update-check.json');
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
      return null;
    }

    return (await response.json()) as GitHubRelease;
  } catch (error) {
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

  if (updateAvailable && !silent) {
    info(`New version available: ${latestVersion} (current: v${CURRENT_VERSION})`);
    info('Run "slackcli update" to update');
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
    info('Running from source (bun) — update with `git pull`, not `slackcli update`.');
    return;
  }

  info(`Checking for updates...`);

  const release = await fetchLatestRelease();

  if (!release) {
    throw new Error('Unable to fetch latest release');
  }

  const latestVersion = release.tag_name;

  if (!isNewerVersion(latestVersion, CURRENT_VERSION)) {
    success(`Already on latest version (v${CURRENT_VERSION})`);
    return;
  }

  info(`Downloading version ${latestVersion}...`);

  const binaryName = getBinaryName();
  const asset = release.assets.find(a => a.name === binaryName);

  if (!asset) {
    throw new Error(`Binary not found for ${binaryName}`);
  }

  // Download binary
  const response = await fetch(asset.browser_download_url);

  if (!response.ok) {
    throw new Error(`Failed to download: ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // Before anything touches the disk: these bytes become the running binary.
  verifyAssetDigest(binaryName, bytes, asset.digest);

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

    success(`Updated to version ${latestVersion}`);
    info('Please restart slackcli to use the new version');
  } catch (error: any) {
    // Try to restore from backup if it exists
    logError(`Update failed: ${error.message}`);
    throw error;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

// Read cached update check result synchronously
function readUpdateCache(): UpdateCache | null {
  try {
    const data = readFileSync(UPDATE_CACHE_FILE, 'utf-8');
    return JSON.parse(data) as UpdateCache;
  } catch {
    return null;
  }
}

// Write update check result to cache
function writeUpdateCache(cache: UpdateCache): void {
  try {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    }
    writeFileSync(UPDATE_CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch {
    // Silently fail — cache is best-effort
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

// Show a one-line update notification after the command finishes (via beforeExit),
// and refresh the cache in the background if it is stale.
export function notifyIfUpdateAvailable(): void {
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
