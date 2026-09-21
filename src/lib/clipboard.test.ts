import { describe, expect, it, mock, beforeEach, afterEach } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readClipboard, isClipboardAvailable } from './clipboard';

describe('clipboard', () => {
  describe('readClipboard', () => {
    it('should return a ClipboardResult object', async () => {
      const result = await readClipboard();

      // Result should have the correct structure
      expect(result).toHaveProperty('success');
      expect(typeof result.success).toBe('boolean');

      if (result.success) {
        expect(result).toHaveProperty('content');
        expect(typeof result.content).toBe('string');
      } else {
        expect(result).toHaveProperty('error');
        expect(typeof result.error).toBe('string');
      }
    });

    it('should handle platform-specific behavior', async () => {
      const result = await readClipboard();

      // On Linux without display, it might fail - that's expected
      if (process.platform === 'linux' && !process.env.DISPLAY) {
        // Either it works (xclip installed with display) or fails gracefully
        expect(typeof result.success).toBe('boolean');
      }

      // On macOS/Windows, it should generally work in a desktop environment
      // But in CI/headless, it might fail - that's OK
    });

    it('should not throw exceptions', async () => {
      // readClipboard should never throw - always returns a result object
      await expect(readClipboard()).resolves.toBeDefined();
    });
  });

  describe('isClipboardAvailable', () => {
    it('should return a boolean', async () => {
      const result = await isClipboardAvailable();
      expect(typeof result).toBe('boolean');
    });

    it('should not throw exceptions', async () => {
      await expect(isClipboardAvailable()).resolves.toBeDefined();
    });
  });

  describe('error messages', () => {
    it('should provide helpful error messages on Linux', async () => {
      // This test verifies the error message format when clipboard fails on Linux
      if (process.platform === 'linux') {
        const result = await readClipboard();
        if (!result.success && result.error?.includes('xclip')) {
          expect(result.error).toContain('Install with');
        }
      }
    });
  });

  // Stubs xclip/xsel on a PATH containing nothing else, so the Linux
  // fallback order and error text are asserted deterministically.
  describe.if(process.platform === 'linux')('linux fallback chain', () => {
    let binDir: string;
    let originalPath: string | undefined;

    function stub(name: string, script: string): void {
      const file = join(binDir, name);
      writeFileSync(file, `#!/bin/sh\n${script}\n`);
      chmodSync(file, 0o755);
    }

    beforeEach(() => {
      binDir = mkdtempSync(join(tmpdir(), 'slackcli-clipboard-'));
      originalPath = process.env.PATH;
      process.env.PATH = binDir;
    });

    afterEach(() => {
      process.env.PATH = originalPath;
      rmSync(binDir, { recursive: true, force: true });
    });

    it('returns xclip output without trying xsel when xclip succeeds', async () => {
      stub('xclip', 'printf "from-xclip"');
      stub('xsel', 'printf "from-xsel"');

      expect(await readClipboard()).toEqual({ success: true, content: 'from-xclip' });
    });

    it('falls back to xsel when xclip is missing', async () => {
      stub('xsel', 'printf "from-xsel"');

      expect(await readClipboard()).toEqual({ success: true, content: 'from-xsel' });
    });

    it('falls back to xsel when xclip exits non-zero', async () => {
      stub('xclip', 'echo "Error: Can\'t open display" >&2; exit 1');
      stub('xsel', 'printf "from-xsel"');

      expect(await readClipboard()).toEqual({ success: true, content: 'from-xsel' });
    });

    it('returns the install hint when neither xclip nor xsel is available', async () => {
      expect(await readClipboard()).toEqual({
        success: false,
        error:
          'Clipboard access requires xclip or xsel on Linux.\n' +
          'Install with: sudo apt install xclip (Debian/Ubuntu)\n' +
          '          or: sudo dnf install xclip (Fedora)',
      });
    });

    it('returns the install hint when both xclip and xsel fail', async () => {
      stub('xclip', 'exit 1');
      stub('xsel', 'exit 1');

      const result = await readClipboard();
      expect(result.success).toBe(false);
      expect(result.error).toContain('Clipboard access requires xclip or xsel on Linux.');
    });
  });
});
