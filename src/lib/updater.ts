import { writeFile, chmod, rename, unlink } from 'fs/promises';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import chalk from 'chalk';
import { info, success, error as logError } from './formatter.ts';

const CONFIG_DIR = join(homedir(), '.config', 'slackcli');
const UPDATE_CACHE_FILE = join(CONFIG_DIR, 'update-check.json');
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface UpdateCache {
  checkedAt: number;
  latestVersion: string;
}

const GITHUB_REPO = 'shaharia-lab/slackcli';
// @ts-ignore - This will be replaced at build time
const CURRENT_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';

interface GitHubRelease {
  tag_name: string;
  name: string;
  body: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
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
  const tmpPath = join(tmpdir(), `slackcli-update-${Date.now()}`);

  // Write to temp file
  await writeFile(tmpPath, new Uint8Array(buffer));
  await chmod(tmpPath, 0o755);

  // Get current binary path
  const currentBinary = process.execPath;

  info(`Installing update...`);

  try {
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
