import { InvalidArgumentError } from 'commander';
import type {
  HostedArgumentContract,
  HostedBrowserCommandContract,
  HostedSessionPolicy,
} from '../hosted/contract.js';

type ArgumentMetadata = {
  required?: boolean;
  default?: unknown;
};

function option(
  name: string,
  description: string,
  metadata: ArgumentMetadata = {},
): HostedArgumentContract {
  return {
    name,
    type: 'string',
    description,
    positional: false,
    required: metadata.required === true,
    variadic: false,
    ...(metadata.default !== undefined ? { default: metadata.default } : {}),
  };
}

function flag(name: string, description: string): HostedArgumentContract {
  return { name, type: 'boolean', description, positional: false, required: false, variadic: false };
}

function command(
  commandPath: string,
  description: string,
  action: string,
  positionals: HostedArgumentContract[] = [],
  options: HostedArgumentContract[] = [],
  sessionPolicy: HostedSessionPolicy,
): HostedBrowserCommandContract {
  return { command: commandPath, aliases: [], description, action, positionals, options, sessionPolicy };
}

/** Exact local Commander flags for every catalogued browser option. */
export function browserOptionFlags(option: HostedArgumentContract, commandPath?: string): string {
  const longName = option.name.replace(/[A-Z]/g, character => `-${character.toLowerCase()}`);
  if (option.type === 'boolean') return `--${longName}`;
  const valueName = option.name === 'page' ? 'id'
    : option.name === 'file' ? 'path'
      : option.name === 'timeout' && commandPath === 'run' ? 'seconds'
        : option.name === 'maxOutput' ? 'characters'
          : option.name;
  return `--${longName} <${valueName}>`;
}

/** Shared positive-integer parser for browser-run limits. */
export function browserOptionValueParser(
  commandPath: string,
  optionName: string,
): ((value: string) => unknown) | undefined {
  if (commandPath !== 'run' || !['timeout', 'maxOutput'].includes(optionName)) return undefined;
  return (value: string): number => {
    if (!/^\d+$/.test(value) || Number.parseInt(value, 10) <= 0) {
      throw new InvalidArgumentError(`--${optionName === 'maxOutput' ? 'max-output' : optionName} must be a positive integer (got "${value}")`);
    }
    return Number.parseInt(value, 10);
  };
}

export const browserCommandCatalog: readonly HostedBrowserCommandContract[] = [
  command('tabs', 'List pages in the existing browser session', 'tabs', [], [], 'require-existing'),
  command('bind', 'Bind this session to an existing page', 'bind', [], [
    option('page', 'Stable page id returned by tabs', { required: true }),
  ], 'require-existing'),
  command('run', 'Run JavaScript with Playwright', 'run', [], [
    flag('stdin', 'Read the program from stdin'),
    option('file', 'Read the program from a file'),
    option('timeout', 'Execution timeout in seconds'),
    option('maxOutput', 'Maximum returned characters'),
    flag('snapshotDiff', 'Return the before/after semantic diff'),
  ], 'create-or-reuse'),
  command('close', 'Close or detach this browser session', 'close-window', [], [], 'close-existing'),
] as const;
