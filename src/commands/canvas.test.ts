import { describe, expect, it } from 'bun:test';
import { createCanvasCommand } from './canvas.ts';

describe('canvas command', () => {
  it('registers a delete subcommand', () => {
    const canvas = createCanvasCommand();
    const del = canvas.commands.find((command) => command.name() === 'delete');

    expect(del).toBeDefined();
  });

  it('exposes a --yes flag on canvas delete', () => {
    const canvas = createCanvasCommand();
    const del = canvas.commands.find((command) => command.name() === 'delete');

    expect(del?.options.some((option) => option.long === '--yes')).toBe(true);
  });

  it('exposes a --json flag on canvas delete', () => {
    const canvas = createCanvasCommand();
    const del = canvas.commands.find((command) => command.name() === 'delete');

    expect(del?.options.some((option) => option.long === '--json')).toBe(true);
  });
});
