import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { createProgram } from '../cli.js';
import { browserCommandCatalog } from './command-catalog.js';

function browserCommand(): Command {
  const browser = createProgram('', '').commands.find(command => command.name() === 'browser');
  if (!browser) throw new Error('Local browser command is not registered');
  return browser;
}

describe('browserCommandCatalog', () => {
  it('exposes only the four raw browser session commands', () => {
    expect(browserCommandCatalog.map(command => command.command)).toEqual([
      'tabs',
      'bind',
      'run',
      'close',
    ]);
  });

  it('keeps adapter authoring separate from the raw session catalog', () => {
    expect(browserCommand().commands.map(command => command.name())).toEqual([
      'tabs',
      'bind',
      'run',
      'close',
      'init',
      'verify',
    ]);
  });

  it('requires a stable page id for bind and limits run to program options', () => {
    const commands = new Map(browserCommandCatalog.map(command => [command.command, command]));
    expect(commands.get('bind')?.options).toEqual([
      expect.objectContaining({ name: 'page', required: true }),
    ]);
    expect(commands.get('run')?.options.map(option => option.name)).toEqual([
      'stdin',
      'file',
      'timeout',
      'maxOutput',
      'snapshotDiff',
    ]);
  });
});
