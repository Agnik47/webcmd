import { classifyAdapter } from '../help.js';
import { Strategy } from '../registry.js';

export type HostedAvailability =
  | { mode: 'hosted' }
  | { mode: 'local-only'; reason: 'desktop-app' | 'local-tool' | 'browser-bind' };

export interface HostedAvailabilityMetadata {
  strategy?: Strategy | string;
  domain?: string;
}

export function deriveHostedAvailability(command: HostedAvailabilityMetadata): HostedAvailability {
  if (String(command.strategy).toLowerCase() === Strategy.LOCAL) {
    return { mode: 'local-only', reason: 'local-tool' };
  }
  if (classifyAdapter(command.domain) === 'app') {
    return { mode: 'local-only', reason: 'desktop-app' };
  }
  return { mode: 'hosted' };
}

export function deriveBrowserAvailability(command: string): HostedAvailability {
  if (command === 'bind') {
    return { mode: 'local-only', reason: 'browser-bind' };
  }
  if (command === 'run') {
    return { mode: 'local-only', reason: 'local-tool' };
  }
  return { mode: 'hosted' };
}
