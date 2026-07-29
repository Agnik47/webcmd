import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { createProgram } from '../cli.js';
import { commanderNamespaceHelpData } from '../help.js';
import {
  buildHostedContract,
  type HostedArgumentContract,
} from '../hosted/contract.js';
import { browserCommandCatalog, browserOptionFlags } from './command-catalog.js';

type StructuredArgument = {
  name: string;
  flags?: string;
  help?: string;
  required?: boolean;
  variadic?: boolean;
  default?: unknown;
  choices?: string[];
  takes_value?: 'required' | 'optional';
};

type StructuredBrowserCommand = {
  name: string;
  aliases?: string[];
  description: string;
  positionals: StructuredArgument[];
  command_options: StructuredArgument[];
};

function browserCommand(): Command {
  const browser = createProgram('', '').commands.find(command => command.name() === 'browser');
  if (!browser) throw new Error('Local browser command is not registered');
  return browser;
}

function localBrowserCommands(): StructuredBrowserCommand[] {
  const help = commanderNamespaceHelpData(browserCommand());
  return help.commands as StructuredBrowserCommand[];
}

function normalizeArgument(
  argument: StructuredArgument,
  positional: boolean,
): HostedArgumentContract {
  return {
    name: argument.name,
    type: positional || argument.takes_value ? 'string' : 'boolean',
    description: argument.help ?? '',
    positional,
    required: positional && argument.required === true,
    variadic: argument.variadic === true,
    ...(argument.default !== undefined ? { default: argument.default } : {}),
    ...(argument.choices?.length ? { choices: [...argument.choices] } : {}),
  };
}

function normalizeLocalCommand(command: StructuredBrowserCommand) {
  return {
    command: command.name.replaceAll(' ', '/'),
    aliases: [...(command.aliases ?? [])],
    description: command.description,
    positionals: command.positionals.map(argument => normalizeArgument(argument, true)),
    options: command.command_options.map(argument => normalizeArgument(argument, false)),
  };
}

describe('browserCommandCatalog', () => {
  it('catalogues the exact local Commander browser leaf set and metadata', () => {
    const local = localBrowserCommands().map(normalizeLocalCommand);
    const catalogPaths = new Set(browserCommandCatalog.map(command => command.command));
    const localPaths = new Set(local.map(command => command.command));

    expect({
      uncatalogued: [...localPaths].filter(command => !catalogPaths.has(command)).sort(),
      stale: [...catalogPaths].filter(command => !localPaths.has(command)).sort(),
    }).toEqual({ uncatalogued: [], stale: [] });

    expect(browserCommandCatalog.map(({ sessionPolicy: _sessionPolicy, action: _action, ...command }) => command))
      .toEqual(local);
  });

  it('preserves the exact local Commander flag grammar for every browser option', () => {
    const local = new Map(localBrowserCommands().map(command => [
      command.name.replaceAll(' ', '/'),
      command.command_options.map(option => option.flags),
    ]));

    expect(Object.fromEntries(browserCommandCatalog.map(command => [
      command.command,
      command.options.map(option => browserOptionFlags(option, command.command)),
    ]))).toEqual(Object.fromEntries(local));
  });

  it('marks bind and run as local-only and gives every hosted command an action', () => {
    expect(browserCommandCatalog.filter(command => command.sessionPolicy === 'local-only').map(command => command.command))
      .toEqual(['bind', 'run']);
    expect(browserCommandCatalog.find(command => command.command === 'bind')).not.toHaveProperty('action');
    expect(browserCommandCatalog.find(command => command.command === 'run')).not.toHaveProperty('action');
    expect(browserCommandCatalog.filter(command => !['bind', 'run'].includes(command.command)).every(command => command.action))
      .toBe(true);
  });

  it('classifies lifecycle commands from their actual local behavior', () => {
    const policies = Object.fromEntries(browserCommandCatalog.map(command => [command.command, command.sessionPolicy]));

    expect(policies.open).toBe('create-or-reuse');
    expect(policies.close).toBe('close-existing');
    expect(policies.unbind).toBe('close-existing');
    expect(policies.state).toBe('require-existing');
  });

  it('is the production browser surface emitted by buildHostedContract', () => {
    const contract = buildHostedContract([], [], '1.0.0');

    expect(contract.browserCommands).toEqual(browserCommandCatalog);
    expect(contract.browserCommands.filter(command => !command.action).map(command => command.command))
      .toEqual(['bind', 'run']);
  });
});
