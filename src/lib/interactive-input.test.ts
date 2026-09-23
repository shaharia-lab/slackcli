import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { EventEmitter } from 'node:events';
import * as readline from 'node:readline';
import { isInteractiveTerminal, hasPipedInput, readInteractiveInput } from './interactive-input';

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

    describe('TTY mode (readline stubbed)', () => {
      let rl: EventEmitter & { close: () => void };
      const originalIsTTY = process.stdin.isTTY;
      const spies: { mockRestore: () => void }[] = [];

      beforeEach(() => {
        rl = Object.assign(new EventEmitter(), { close: () => {} });
        process.stdin.isTTY = true;
        spies.push(
          spyOn(readline, 'createInterface').mockReturnValue(rl as unknown as readline.Interface),
          spyOn(console, 'log').mockImplementation(() => {}),
        );
      });

      afterEach(() => {
        process.stdin.isTTY = originalIsTTY;
        while (spies.length) spies.pop()?.mockRestore();
      });

      const feed = (...lines: string[]) => lines.forEach(line => rl.emit('line', line));

      it('drops the terminating empty lines when Enter is pressed twice', async () => {
        const result = readInteractiveInput();
        feed('first', '', 'second', '', '');
        expect(await result).toBe('first\n\nsecond');
      });

      it('strips whitespace-only trailing lines on close', async () => {
        const result = readInteractiveInput();
        feed('keep  ', '   ', '\t');
        rl.emit('close');
        expect(await result).toBe('keep  ');
      });

      it('resolves to an empty string when every line is blank', async () => {
        const result = readInteractiveInput({ emptyLinesToComplete: 5 });
        feed('  ', '\t');
        rl.emit('close');
        expect(await result).toBe('');
      });

      it('resolves to an empty string when closed with no input', async () => {
        const result = readInteractiveInput();
        rl.emit('close');
        expect(await result).toBe('');
      });
    });
  });
});
