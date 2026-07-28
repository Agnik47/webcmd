import type { Page as PlaywrightPage } from 'playwright-core';
import { generateSnapshotJs } from '../dom-snapshot.js';
import {
  redactText,
  redactUrl,
  redactValue,
} from '../../observation/redaction.js';
import { BrowserRunArtifactWriter } from './artifacts.js';
import {
  BrowserRunBridge,
  initializeBrowserRunSandboxClient,
} from './bridge.js';
import { BrowserRunObservationStore } from './observation.js';
import { QuickJSHost } from './quickjs-host.js';
import {
  BROWSER_RUN_DEFAULT_MAX_OUTPUT_CHARS,
  BROWSER_RUN_DEFAULT_MEMORY_LIMIT_BYTES,
  BROWSER_RUN_DEFAULT_TIMEOUT_MS,
  BrowserRunError,
  type BrowserRunLogEntry,
  type BrowserRunOptions,
  type BrowserRunResult,
} from './types.js';

export interface BrowserRunProgramHost {
  page: PlaywrightPage;
  pageId: string;
  observationStore?: BrowserRunObservationStore;
  artifactWriter?: BrowserRunArtifactWriter;
  registerPage?: (page: PlaywrightPage) => string;
}

function requirePositiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new BrowserRunError(
      'BROWSER_RUN_INVALID_INPUT',
      `${name} must be a positive integer.`,
    );
  }
  return resolved;
}

function normalizeExecutionError(error: unknown): Error {
  const sanitize = (value: string): string => redactUrl(redactText(value));
  if (error instanceof BrowserRunError) {
    return new BrowserRunError(
      error.code,
      sanitize(error.message),
      error.hint ? sanitize(error.hint) : undefined,
    );
  }
  if (
    error instanceof Error
    && 'code' in error
    && typeof error.code === 'string'
    && error.code.startsWith('BROWSER_RUN_')
  ) {
    const normalized = new Error(sanitize(error.message)) as Error & {
      code: string;
      hint?: string;
    };
    normalized.name = error.name;
    normalized.code = error.code;
    if (
      'hint' in error
      && typeof error.hint === 'string'
    ) {
      normalized.hint = sanitize(error.hint);
    }
    return normalized;
  }
  const message = error instanceof Error ? error.message : String(error);
  const errorKind = error instanceof Error ? error.name : '';
  if (/interrupted|execution timeout|timed out/i.test(message)) {
    return new BrowserRunError(
      'BROWSER_RUN_TIMEOUT',
      'Browser-run execution exceeded its time limit.',
      'Split the task into a smaller run or increase --timeout.',
    );
  }
  if (/out of memory|memory limit/i.test(message)) {
    return new BrowserRunError(
      'BROWSER_RUN_MEMORY_LIMIT',
      'Browser-run execution exceeded its memory limit.',
    );
  }
  if (/syntaxerror/i.test(`${errorKind}: ${message}`)) {
    return new BrowserRunError(
      'BROWSER_RUN_SYNTAX_ERROR',
      sanitize(message),
      'Fix the browser-run JavaScript syntax and retry.',
    );
  }
  const normalized = new Error(sanitize(message));
  normalized.name = error instanceof Error ? error.name : 'Error';
  return normalized;
}

function boundedLogs(
  logs: BrowserRunLogEntry[],
  remainingChars: number,
): { logs: BrowserRunLogEntry[]; truncated: boolean } {
  const kept: BrowserRunLogEntry[] = [];
  let used = 0;
  for (const log of logs) {
    const chars = JSON.stringify(log).length;
    if (used + chars > remainingChars) {
      return { logs: kept, truncated: true };
    }
    kept.push(log);
    used += chars;
  }
  return { logs: kept, truncated: false };
}

function javascriptStringLiteral(value: string): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

async function captureObservation(
  page: PlaywrightPage,
  pageId: string,
  store: BrowserRunObservationStore,
  options: Required<Pick<BrowserRunOptions, 'observe' | 'maxOutputChars'>>,
) {
  if (options.observe === 'none') {
    return store.record({
      pageId,
      url: page.url(),
      content: '',
      requestedMode: 'none',
      maxChars: options.maxOutputChars,
    });
  }
  let content: string;
  try {
    const value = await page.evaluate(generateSnapshotJs({
      viewportExpand: 0,
      maxDepth: 40,
      maxTextLength: 120,
      includeScrollInfo: true,
      bboxDedup: true,
    }) as never);
    content = typeof value === 'string' ? value : String(value ?? '');
  } catch {
    content = '[semantic observation unavailable]';
  }
  return store.record({
    pageId,
    url: page.url(),
    content,
    requestedMode: options.observe,
    maxChars: options.maxOutputChars,
  });
}

export async function runBrowserProgram(
  input: BrowserRunProgramHost,
  source: string,
  options: BrowserRunOptions = {},
): Promise<BrowserRunResult> {
  const timeoutMs = requirePositiveInteger(
    options.timeoutMs,
    BROWSER_RUN_DEFAULT_TIMEOUT_MS,
    'timeoutMs',
  );
  const maxOutputChars = requirePositiveInteger(
    options.maxOutputChars,
    BROWSER_RUN_DEFAULT_MAX_OUTPUT_CHARS,
    'maxOutputChars',
  );
  const memoryLimitBytes = requirePositiveInteger(
    options.memoryLimitBytes,
    BROWSER_RUN_DEFAULT_MEMORY_LIMIT_BYTES,
    'memoryLimitBytes',
  );
  const observe = options.observe ?? 'diff';
  if (!['diff', 'full', 'none'].includes(observe)) {
    throw new BrowserRunError(
      'BROWSER_RUN_INVALID_INPUT',
      'observe must be diff, full, or none.',
    );
  }

  const logs: BrowserRunLogEntry[] = [];
  const redactionOptions = {
    maxDepth: 8,
    maxArrayItems: 100,
    maxObjectFields: 100,
    maxStringLength: maxOutputChars,
  };
  let capturedLogChars = 0;
  let logOutputTruncated = false;
  const artifactWriter = input.artifactWriter ?? new BrowserRunArtifactWriter();
  const observationStore = input.observationStore
    ?? new BrowserRunObservationStore();
  const bridge = new BrowserRunBridge({
    page: input.page,
    pageId: input.pageId,
    writeScreenshot: (page, screenshotOptions) => (
      artifactWriter.writeScreenshot(page, screenshotOptions)
    ),
    registerPage: input.registerPage,
  });
  const cancellation = new Promise<never>(() => {});
  const host = await QuickJSHost.create({
    memoryLimitBytes,
    maxStackSizeBytes: 2 * 1024 * 1024,
    cpuTimeoutMs: timeoutMs,
    globals: {
      __webcmdMaxLogChars: maxOutputChars,
    },
    onHostCall: (operation, args) => (
      operation === 'runtime.waitForCancellation'
        ? cancellation
        : bridge.dispatch(operation, args)
    ),
    onConsole: (level, args) => {
      const entry: BrowserRunLogEntry = {
        level,
        args: redactValue(args, redactionOptions) as unknown[],
      };
      const chars = JSON.stringify(entry).length;
      if (capturedLogChars + chars > maxOutputChars) {
        logOutputTruncated = true;
        return;
      }
      logs.push(entry);
      capturedLogChars += chars;
    },
  });

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let wallTimedOut = false;
  let execution: Promise<unknown> | undefined;
  try {
    await initializeBrowserRunSandboxClient(host);
    execution = host.executeScript(`
      (() => {
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        const program = new AsyncFunction(${javascriptStringLiteral(source)});
        return __webcmdRaceRun(program).then(__webcmdSerializeResult);
      })()
    `, {
      filename: 'browser-run.js',
    });
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        wallTimedOut = true;
        const timeoutError = new BrowserRunError(
          'BROWSER_RUN_TIMEOUT',
          `Browser-run execution exceeded ${timeoutMs}ms.`,
          'Split the task into a smaller run or increase --timeout.',
        );
        host.cancelPending(timeoutError);
        reject(timeoutError);
      }, timeoutMs);
    });
    execution.catch(() => {});
    const serialized = await Promise.race([execution, deadline]);
    if (typeof serialized !== 'string') {
      throw new BrowserRunError(
        'BROWSER_RUN_SERIALIZATION_ERROR',
        'Browser-run returned an invalid serialized result.',
      );
    }
    if (serialized.length > maxOutputChars) {
      throw new BrowserRunError(
        'BROWSER_RUN_OUTPUT_LIMIT',
        `Browser-run result exceeds the ${maxOutputChars}-character output limit.`,
        'Return a smaller value or increase --max-output.',
      );
    }
    const result = redactValue(
      JSON.parse(serialized) as unknown,
      redactionOptions,
    );
    const resultChars = JSON.stringify(result).length;
    if (resultChars > maxOutputChars) {
      throw new BrowserRunError(
        'BROWSER_RUN_OUTPUT_LIMIT',
        `Browser-run result exceeds the ${maxOutputChars}-character output limit.`,
        'Return a smaller value or increase --max-output.',
      );
    }
    const unfinishedBrowserOperations = bridge.hasPendingBrowserOperations();
    const completedError = new BrowserRunError(
      'BROWSER_RUN_CANCELLED',
      'Browser-run execution has ended.',
    );
    host.cancelPending(completedError);
    bridge.cancel(completedError);
    if (unfinishedBrowserOperations) {
      throw new BrowserRunError(
        'BROWSER_RUN_CANCELLED',
        'Browser-run ended with an unfinished browser operation.',
        'Await every Playwright operation before returning from browser run.',
      );
    }
    const bounded = boundedLogs(logs, Math.max(0, maxOutputChars - resultChars));
    const title = await input.page.title().catch(() => '');
    const observation = await captureObservation(
      input.page,
      input.pageId,
      observationStore,
      { observe, maxOutputChars },
    );
    return {
      ok: true,
      result,
      logs: bounded.logs,
      page: {
        id: input.pageId,
        url: redactUrl(input.page.url()),
        title,
      },
      observation: observation.observation,
      limits: {
        outputTruncated: logOutputTruncated || bounded.truncated,
        observationTruncated: observation.truncated,
      },
    };
  } catch (error) {
    if (wallTimedOut) {
      bridge.cancel(
        error instanceof Error
          ? error
          : new BrowserRunError(
              'BROWSER_RUN_TIMEOUT',
              'Browser-run execution exceeded its time limit.',
            ),
      );
      await execution?.catch(() => {});
    }
    throw normalizeExecutionError(error);
  } finally {
    if (timeout) clearTimeout(timeout);
    const completionError = new BrowserRunError(
      'BROWSER_RUN_CANCELLED',
      'Browser-run execution has ended.',
    );
    host.cancelPending(completionError);
    bridge.cancel(completionError);
    bridge.dispose();
    host.dispose();
  }
}
