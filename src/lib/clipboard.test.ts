import { describe, expect, it, mock, beforeEach, afterEach } from 'bun:test';
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
});
