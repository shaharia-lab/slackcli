/**
 * Cross-platform clipboard reading utility
 */

import { spawn } from 'child_process';

export interface ClipboardResult {
  success: boolean;
  content?: string;
  error?: string;
}

/**
 * Read content from the system clipboard
 * Works on macOS, Windows, and Linux (with xclip/xsel installed)
 */
export async function readClipboard(): Promise<ClipboardResult> {
  const platform = process.platform;

  try {
    let command: string;
    let args: string[];

    switch (platform) {
      case 'darwin':
        // macOS
        command = 'pbpaste';
        args = [];
        break;

      case 'win32':
        // Windows - use PowerShell
        command = 'powershell';
        args = ['-NoProfile', '-Command', 'Get-Clipboard'];
        break;

      case 'linux':
        // Linux - try xclip first, then xsel
        const xclipResult = await tryCommand('xclip', ['-selection', 'clipboard', '-o']);
        if (xclipResult.success) {
          return xclipResult;
        }

        const xselResult = await tryCommand('xsel', ['--clipboard', '--output']);
        if (xselResult.success) {
          return xselResult;
        }

        return {
          success: false,
          error:
            'Clipboard access requires xclip or xsel on Linux.\n' +
            'Install with: sudo apt install xclip (Debian/Ubuntu)\n' +
            '          or: sudo dnf install xclip (Fedora)',
        };

      default:
        return {
          success: false,
          error: `Unsupported platform: ${platform}`,
        };
    }

    return await tryCommand(command, args);
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Unknown clipboard error',
    };
  }
}

/**
 * Try to execute a command and capture its output
 */
async function tryCommand(command: string, args: string[]): Promise<ClipboardResult> {
  return new Promise((resolve) => {
    let resolved = false;
    const proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    const timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill();
        resolve({
          success: false,
          error: 'Clipboard read timed out',
        });
      }
    }, 5000);

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('error', (err: any) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutId);
        if (err.code === 'ENOENT') {
          resolve({
            success: false,
            error: `Command not found: ${command}`,
          });
        } else {
          resolve({
            success: false,
            error: err.message,
          });
        }
      }
    });

    proc.on('close', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutId);
        if (code === 0) {
          resolve({
            success: true,
            content: stdout,
          });
        } else {
          resolve({
            success: false,
            error: stderr || `Command exited with code ${code}`,
          });
        }
      }
    });
  });
}

/**
 * Check if clipboard access is available on this system
 */
export async function isClipboardAvailable(): Promise<boolean> {
  const result = await readClipboard();
  // Even if clipboard is empty, success means it's available
  return result.success || !result.error?.includes('not found');
}
