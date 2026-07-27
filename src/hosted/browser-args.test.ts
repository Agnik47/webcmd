import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { browserCommandCatalog } from '../browser/command-catalog.js';
import { rewriteBrowserArgv } from '../cli-argv-preprocess.js';
import { createProgram } from '../cli.js';
import { CommanderStructuralError } from '../command-surface.js';
import {
  HostedBrowserHelp,
  parseHostedBrowserStructure,
  type ParsedHostedBrowserStructure,
} from './browser-args.js';

function findLocalBrowserLeaf(program: Command, commandPath: string): { browser: Command; leaf: Command } {
  const browser = program.commands.find(command => command.name() === 'browser');
  if (!browser) throw new Error('Local browser namespace is missing');
  let leaf = browser;
  for (const part of commandPath.split('/')) {
    const child = leaf.commands.find(command => command.name() === part || command.aliases().includes(part));
    if (!child) throw new Error(`Local browser command is missing: ${commandPath}`);
    leaf = child;
  }
  return { browser, leaf };
}

function flattenPositionals(values: unknown[]): string[] {
  return values.flatMap(value => {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
    return [];
  });
}

function captureLocalBrowserValues(
  commandPath: string,
  argv: string[],
): ParsedHostedBrowserStructure {
  const program = createProgram('', '');
  const contract = browserCommandCatalog.find(command => command.command === commandPath);
  if (!contract) throw new Error(`Browser contract is missing: ${commandPath}`);
  const { browser, leaf } = findLocalBrowserLeaf(program, commandPath);
  let parsed: ParsedHostedBrowserStructure | undefined;
  leaf.action((...actionArgs: unknown[]) => {
    const options = actionArgs[contract.positionals.length] as Record<string, unknown>;
    const rootOptions = program.opts<Record<string, unknown>>();
    const browserOptions = browser.opts<Record<string, unknown>>();
    parsed = {
      commandName: commandPath,
      positionals: flattenPositionals(actionArgs.slice(0, contract.positionals.length)),
      options: { ...options },
      ...(typeof browserOptions.session === 'string' ? { session: browserOptions.session } : {}),
      ...(typeof browserOptions.window === 'string' ? { window: browserOptions.window } : {}),
      ...(typeof rootOptions.profile === 'string' ? { profile: rootOptions.profile } : {}),
    };
  });
  const configure = (command: Command): void => {
    command.exitOverride().configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
    for (const child of command.commands) configure(child);
  };
  configure(program);
  program.parse(rewriteBrowserArgv(argv), { from: 'user' });
  if (!parsed) throw new Error(`Local browser action did not run: ${commandPath}`);
  return parsed;
}

function allPositionals(commandPath: string): string[] {
  const contract = browserCommandCatalog.find(command => command.command === commandPath)!;
  return contract.positionals.flatMap(position => position.variadic
    ? [`${position.name}-one`, `${position.name}-two`]
    : [`${position.name}-value`]);
}

function parseHosted(argv: string[]): ParsedHostedBrowserStructure {
  return parseHostedBrowserStructure(rewriteBrowserArgv(argv));
}

describe('hosted browser canonical Commander values', () => {
  it('states the background default in hosted browser help', () => {
    try {
      parseHostedBrowserStructure(['browser', '--help']);
      throw new Error('Expected hosted browser help');
    } catch (error) {
      expect(error).toBeInstanceOf(HostedBrowserHelp);
      expect((error as HostedBrowserHelp).output).toContain(
        'Browser window mode: foreground or background (default: background)',
      );
    }
  });

  it('matches the actual local action boundary for every catalogued browser leaf', () => {
    for (const contract of browserCommandCatalog) {
      const argv = ['browser', 'work', ...contract.command.split('/'), ...allPositionals(contract.command)];
      expect({ command: contract.command, parsed: parseHosted(argv) }).toEqual({
        command: contract.command,
        parsed: captureLocalBrowserValues(contract.command, argv),
      });
    }
  });

  it.each([
    {
      name: 'negative numeric required option value',
      command: 'scroll',
      tail: ['down', '--amount', '-5'],
    },
    {
      name: 'dash-leading string option value',
      command: 'state',
      tail: ['--source', '-dash'],
    },
    {
      name: 'equals option form',
      command: 'eval',
      tail: ['return 1', '--frame=-2'],
    },
    {
      name: 'repeated string option uses the last value',
      command: 'scroll',
      tail: ['down', '--amount', '10', '--amount=-5'],
    },
    {
      name: 'repeated boolean flags remain boolean',
      command: 'screenshot',
      tail: ['shot.png', '--full-page', '--full-page', '--width=10', '--height', '20'],
    },
    {
      name: 'negative boolean option grammar',
      command: 'verify',
      tail: ['site/command', '--no-fixture', '--no-fixture'],
    },
    {
      name: 'dash-leading positional after separator',
      command: 'eval',
      tail: ['--', '-script'],
    },
    {
      name: 'variadic dash-leading positionals after separator',
      command: 'upload',
      tail: ['input[type=file]', '--', '-one.txt', '-two.txt'],
    },
    {
      name: 'trailing namespace window is hoisted',
      command: 'state',
      tail: ['--window', 'background'],
    },
    {
      name: 'equals namespace window before leaf',
      command: 'state',
      prefix: ['--window=foreground'],
      tail: [],
    },
    {
      name: 'repeated namespace window uses the last value',
      command: 'state',
      prefix: ['--window', 'foreground', '--window=background'],
      tail: [],
    },
    {
      name: 'string and boolean observation options retain canonical types',
      command: 'network',
      tail: ['--since', '-5', '--follow', '--failed', '--max-body=-10'],
    },
  ])('$name', ({ command, prefix = [], tail }) => {
    const argv = ['browser', 'work', ...prefix, ...command.split('/'), ...tail];
    expect(parseHosted(argv)).toEqual(captureLocalBrowserValues(command, argv));
  });

  it.each([
    ['ordinary unknown option', ['browser', 'work', 'state', '--unknown']],
    ['ordinary missing option value', ['browser', 'work', 'state', '--source']],
    ['ordinary excess positional', ['browser', 'work', 'state', 'extra']],
    ['missing required positional', ['browser', 'work', 'eval']],
    ['help wins over unknown', ['browser', 'work', 'state', '--unknown', '--help']],
    ['option missing value beats help', ['browser', 'work', 'state', '--help', '--source']],
    ['invalid structurally-coerced screenshot dimension', ['browser', 'work', 'screenshot', '--width=-10']],
    ['site-session is not a browser namespace option', ['browser', 'work', '--site-session', 'persistent', 'state']],
    ['keep-tab is not a browser namespace option', ['browser', 'work', 'state', '--keep-tab', 'true']],
  ])('retains exact local structural outcome: %s', (_name, argv) => {
    const commandPath = argv.includes('eval') ? 'eval' : argv.includes('screenshot') ? 'screenshot' : 'state';
    const capture = (run: () => unknown): { kind: string; output?: string; exitCode?: number } => {
      try {
        run();
        return { kind: 'success' };
      } catch (error) {
        if (error instanceof HostedBrowserHelp) return { kind: 'help', output: error.output, exitCode: 0 };
        if (error instanceof CommanderStructuralError) {
          return { kind: 'structural', output: error.output, exitCode: error.exitCode };
        }
        const commander = error as { code?: unknown; exitCode?: unknown };
        return {
          kind: commander.code === 'commander.helpDisplayed' ? 'help' : 'structural',
          exitCode: typeof commander.exitCode === 'number' ? commander.exitCode : 1,
        };
      }
    };
    const local = capture(() => captureLocalBrowserValues(commandPath, argv));
    const hosted = capture(() => parseHosted(argv));
    expect({ kind: hosted.kind, exitCode: hosted.exitCode }).toEqual({ kind: local.kind, exitCode: local.exitCode });
    if (hosted.kind === 'structural') expect(hosted.output).toBeDefined();
  });
});
