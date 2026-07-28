import { redactText } from '../../observation/redaction.js';
import type {
  BrowserRunObservation,
  BrowserRunObserveMode,
} from './types.js';

interface ObservationBaseline {
  url: string;
  content: string;
}

export interface BrowserRunObservationInput {
  pageId: string;
  url: string;
  content: string;
  requestedMode: BrowserRunObserveMode;
  maxChars: number;
}

export interface BrowserRunObservationOutput {
  observation: BrowserRunObservation;
  truncated: boolean;
}

function lineDiff(previous: string, current: string): string {
  const before = new Set(previous.split('\n'));
  const after = new Set(current.split('\n'));
  const removed = [...before]
    .filter((line) => !after.has(line))
    .map((line) => `- ${line}`);
  const added = [...after]
    .filter((line) => !before.has(line))
    .map((line) => `+ ${line}`);
  return [...removed, ...added].join('\n');
}

function bound(value: string, maxChars: number): {
  value: string;
  truncated: boolean;
} {
  if (value.length <= maxChars) return { value, truncated: false };
  return {
    value: value.slice(0, Math.max(0, maxChars)),
    truncated: true,
  };
}

/**
 * Stores semantic observation baselines outside the sandbox.
 *
 * Baselines are keyed by Webcmd page id and reset after navigation so a diff
 * is never presented against an unrelated document.
 */
export class BrowserRunObservationStore {
  readonly #baselines = new Map<string, ObservationBaseline>();

  record(input: BrowserRunObservationInput): BrowserRunObservationOutput {
    if (input.requestedMode === 'none') {
      return {
        observation: { mode: 'none' },
        truncated: false,
      };
    }

    const content = redactText(input.content, {
      maxStringLength: Math.max(input.maxChars * 2, input.maxChars),
    });
    const previous = this.#baselines.get(input.pageId);
    this.#baselines.set(input.pageId, {
      url: input.url,
      content,
    });

    const useFull = input.requestedMode === 'full'
      || !previous
      || previous.url !== input.url;
    if (useFull) {
      const result = bound(content, input.maxChars);
      return {
        observation: { mode: 'full', content: result.value },
        truncated: result.truncated,
      };
    }

    const result = bound(lineDiff(previous.content, content), input.maxChars);
    return {
      observation: { mode: 'diff', changed: result.value },
      truncated: result.truncated,
    };
  }

  clear(pageId?: string): void {
    if (pageId) this.#baselines.delete(pageId);
    else this.#baselines.clear();
  }
}
