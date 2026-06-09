/**
 * Interactive input handling for multi-line input
 */

import * as readline from 'readline';
import chalk from 'chalk';

export interface InteractiveInputOptions {
  prompt?: string;
  hint?: string;
  /**
   * Number of consecutive empty lines to trigger completion
   * Default: 2 (press Enter twice)
   */
  emptyLinesToComplete?: number;
}

/**
 * Read multi-line input from the user interactively
 * Completes when user presses Enter twice or Ctrl+D
 */
export async function readInteractiveInput(
  options: InteractiveInputOptions = {}
): Promise<string> {
  const {
    prompt = 'Paste your input (press Enter twice when done):',
    hint = 'Tip: You can also press Ctrl+D to finish',
    emptyLinesToComplete = 2,
  } = options;

  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    let consecutiveEmptyLines = 0;

    // Check if stdin is a TTY (interactive terminal)
    if (!process.stdin.isTTY) {
      // Not interactive, read all stdin
      const chunks: Buffer[] = [];
      process.stdin.on('data', (chunk) => chunks.push(chunk));
      process.stdin.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf-8'));
      });
      process.stdin.on('error', reject);
      return;
    }

    console.log(chalk.bold(`\n${prompt}`));
    console.log(chalk.gray(hint));
    console.log();

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    rl.on('line', (line) => {
      if (line.trim() === '') {
        consecutiveEmptyLines++;
        if (consecutiveEmptyLines >= emptyLinesToComplete) {
          rl.close();
          // Remove trailing empty lines
          while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
            lines.pop();
          }
          resolve(lines.join('\n'));
          return;
        }
      } else {
        consecutiveEmptyLines = 0;
      }
      lines.push(line);
    });

    rl.on('close', () => {
      // Remove trailing empty lines
      while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
        lines.pop();
      }
      resolve(lines.join('\n'));
    });

    rl.on('error', reject);

    // Handle Ctrl+C
    rl.on('SIGINT', () => {
      rl.close();
      process.exit(130);
    });
  });
}

/**
 * Parse a yes/no answer. Only "y"/"yes" (case-insensitive) count as yes;
 * everything else (including empty) is no. Pure function for easy testing.
 */
export function parseConfirm(answer: string): boolean {
  return /^y(es)?$/i.test(answer.trim());
}

/**
 * Ask a yes/no confirmation question. Defaults to No on empty input or EOF.
 * TTY-only — callers should guard non-TTY usage (e.g. require an explicit flag).
 */
export async function confirmPrompt(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(parseConfirm(answer));
    });
  });
}

/**
 * Check if we're running in an interactive terminal
 */
export function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY);
}

/**
 * Check if there's piped input available
 */
export function hasPipedInput(): boolean {
  return !process.stdin.isTTY;
}
