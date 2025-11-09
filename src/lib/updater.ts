import { writeFile, chmod, rename, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { info, success, error as logError } from './formatter.ts';

const GITHUB_REPO = 'shaharia-lab/slackcli';
const CURRENT_VERSION = '0.1.1';

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

  if (platform === 'linux') return 'slackcli-linux';
  if (platform === 'darwin') return 'slackcli-macos';
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

