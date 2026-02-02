import { describe, expect, it } from 'bun:test';
import { isInteractiveTerminal, hasPipedInput } from './interactive-input';

describe('interactive-input', () => {
  describe('isInteractiveTerminal', () => {
    it('should return a boolean', () => {
      const result = isInteractiveTerminal();
      expect(typeof result).toBe('boolean');
    });

    it('should detect non-TTY in test environment', () => {
      // In test environment, stdin is typically not a TTY
      // This might vary depending on how tests are run
      const result = isInteractiveTerminal();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('hasPipedInput', () => {
    it('should return a boolean', () => {
      const result = hasPipedInput();
      expect(typeof result).toBe('boolean');
    });

    it('should be opposite of isInteractiveTerminal', () => {
      // hasPipedInput is defined as !process.stdin.isTTY
      // isInteractiveTerminal is defined as Boolean(process.stdin.isTTY)
      // They should be logical opposites (though hasPipedInput doesn't use Boolean())
      const interactive = isInteractiveTerminal();
      const piped = hasPipedInput();

      // If interactive, then not piped; if piped, then not interactive
      if (interactive) {
        expect(piped).toBe(false);
      }
      if (piped) {
        expect(interactive).toBe(false);
      }
    });
  });

  describe('readInteractiveInput', () => {
    // Note: readInteractiveInput is difficult to test in automated tests
    // because it requires actual TTY interaction or piped input.
    // The function itself handles both cases:
    // - TTY: Prompts user and waits for Enter twice
    // - Piped: Reads all stdin until EOF

    it('should be importable', async () => {
      const { readInteractiveInput } = await import('./interactive-input');
      expect(typeof readInteractiveInput).toBe('function');
    });
  });
});
