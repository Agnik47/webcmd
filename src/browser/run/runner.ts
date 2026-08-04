import fs from 'node:fs';
import type {
  Browser as PlaywrightBrowser,
  BrowserContext as PlaywrightBrowserContext,
  Page as PlaywrightPage,
} from 'playwright-core';
import { generateSnapshotJs } from '../dom-snapshot.js';
import {
  redactText,
  redactUrl,
  redactValue,
} from '../../observation/redaction.js';
import { BrowserRunObservationStore } from './observation.js';
import { PlaywrightTransport } from './playwright-transport.js';
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
  browser: PlaywrightBrowser;
  context: PlaywrightBrowserContext;
  page: PlaywrightPage;
  pageId: string;
  observationStore?: BrowserRunObservationStore;
  registerPage?: (page: PlaywrightPage) => string;
}

const PLAYWRIGHT_CLIENT_SOURCE = fs.readFileSync(
  new URL('./generated/playwright-client.js', import.meta.url),
  'utf8',
);

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
  const unsupported = message.match(/BROWSER_RUN_API_UNSUPPORTED:\s*(.*)/s)
    ?? message.match(/(File paths? are unavailable in the QuickJS sandbox[^.]*)/i);
  if (unsupported) {
    return new BrowserRunError(
      'BROWSER_RUN_API_UNSUPPORTED',
      sanitize(unsupported[1] ?? message),
    );
  }
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
  const observationStore = input.observationStore
    ?? new BrowserRunObservationStore();
  let host!: QuickJSHost;
  const transport = new PlaywrightTransport(input, message => (
    host.deliverTransport(message)
  ));
  try {
    host = await QuickJSHost.create({
      memoryLimitBytes,
      maxStackSizeBytes: 2 * 1024 * 1024,
      cpuTimeoutMs: timeoutMs,
      globals: {
        __webcmdMaxLogChars: maxOutputChars,
      },
      onTransportSend: message => transport.send(message),
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
  } catch (error) {
    await transport.dispose(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
  const knownPages = new Set(input.context.pages());
  const registerNewPage = (page: PlaywrightPage) => {
    if (knownPages.has(page)) return;
    knownPages.add(page);
    input.registerPage?.(page);
  };
  input.context.on('page', registerNewPage);

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timeoutCancellation: Promise<void> | undefined;
  let wallTimedOut = false;
  let execution: Promise<unknown> | undefined;
  try {
    await host.executeScript(`
      (() => {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        globalThis.__webcmdEncodeBase64 = bytes => {
          let output = '';
          for (let index = 0; index < bytes.length; index += 3) {
            const chunk = (bytes[index] << 16)
              | ((bytes[index + 1] || 0) << 8)
              | (bytes[index + 2] || 0);
            output += alphabet[(chunk >>> 18) & 63] + alphabet[(chunk >>> 12) & 63]
              + (index + 1 < bytes.length ? alphabet[(chunk >>> 6) & 63] : '=')
              + (index + 2 < bytes.length ? alphabet[chunk & 63] : '=');
          }
          return output;
        };
        globalThis.__webcmdDecodeBase64 = value => {
          const output = [];
          for (let index = 0; index < value.length; index += 4) {
            const a = alphabet.indexOf(value[index]);
            const b = alphabet.indexOf(value[index + 1]);
            const c = value[index + 2] === '=' ? 64 : alphabet.indexOf(value[index + 2]);
            const d = value[index + 3] === '=' ? 64 : alphabet.indexOf(value[index + 3]);
            const chunk = (a << 18) | (b << 12) | ((c & 63) << 6) | (d & 63);
            output.push((chunk >>> 16) & 255);
            if (c !== 64) output.push((chunk >>> 8) & 255);
            if (d !== 64) output.push(chunk & 255);
          }
          return new Uint8Array(output);
        };
        globalThis.__webcmdEncodeText = value => {
          const encoded = encodeURIComponent(String(value));
          const output = [];
          for (let index = 0; index < encoded.length; index += 1) {
            if (encoded[index] === '%') {
              output.push(parseInt(encoded.slice(index + 1, index + 3), 16));
              index += 2;
            } else {
              output.push(encoded.charCodeAt(index));
            }
          }
          return new Uint8Array(output);
        };
        globalThis.__webcmdDecodeText = bytes => {
          let encoded = '';
          for (const byte of bytes) encoded += '%' + byte.toString(16).padStart(2, '0');
          return decodeURIComponent(encoded);
        };
      })()
    `, { filename: 'browser-run-platform.js' });
    await host.executeScript(PLAYWRIGHT_CLIENT_SOURCE, {
      filename: 'playwright-client.js',
    });
    await host.executeScript(`
      (() => {
        const connection = __WebcmdPlaywrightClient.createConnection();
        const unsupported = api => {
          const error = new Error(
            'BROWSER_RUN_API_UNSUPPORTED: ' + api + ' is unavailable in browser run.'
          );
          error.name = 'BrowserRunError';
          throw error;
        };
        globalThis.__webcmdTransportReceive = message => {
          connection.dispatch(JSON.parse(message));
        };
        globalThis.__webcmdWriteArtifact = () => unsupported('Host filesystem access');
        __WebcmdPlaywrightClient.quickjsPlatform.fs().promises.readFile = () => (
          unsupported('Host filesystem reads')
        );
        globalThis.__webcmdInitializePlaywright = async pageGuid => {
          const playwright = await connection.initializePlaywright();
          const suppliedBrowser = playwright._preLaunchedBrowser();
          const browserType = suppliedBrowser.browserType();
          browserType.connect = () => unsupported('BrowserType.connect');
          const selectedPage = connection.getObjectWithKnownName(pageGuid);
          if (!selectedPage) throw new Error('Selected Playwright page is unavailable.');
          const selectedContext = selectedPage.context();
          const selectedBrowser = selectedContext.browser();
          globalThis.page = selectedPage;
          globalThis.context = selectedContext;
          globalThis.browser = selectedBrowser;
        };
        let rejectRun;
        globalThis.__webcmdCancelPlaywright = message => {
          connection.close(message);
          rejectRun?.(new Error(message));
        };
        globalThis.__webcmdRun = async source => {
          const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
          let value;
          try {
            const cancellation = new Promise((_resolve, reject) => {
              rejectRun = reject;
            });
            value = await Promise.race([new AsyncFunction(source)(), cancellation]);
          } finally {
            rejectRun = undefined;
          }
          try {
            const serialized = JSON.stringify(value);
            if (serialized === undefined) throw new TypeError('Result is not JSON serializable.');
            return serialized;
          } catch (cause) {
            const error = new Error('Browser-run result is not JSON serializable.');
            error.name = 'BrowserRunError';
            error.code = 'BROWSER_RUN_SERIALIZATION_ERROR';
            throw error;
          }
        };
      })()
    `, { filename: 'browser-run-bootstrap.js' });
    await host.callFunction('__webcmdInitializePlaywright', transport.pageGuid);
    execution = host.executeScript(`
      __webcmdRun(${javascriptStringLiteral(source)})
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
        timeoutCancellation = transport.cancel(timeoutError).then(async () => {
          await host.callFunction(
            '__webcmdCancelPlaywright',
            timeoutError.message,
          ).catch(() => undefined);
        });
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
      await timeoutCancellation;
      await execution?.catch(() => undefined);
    }
    throw normalizeExecutionError(error);
  } finally {
    if (timeout) clearTimeout(timeout);
    const completionError = new BrowserRunError(
      'BROWSER_RUN_CANCELLED',
      'Browser-run execution has ended.',
    );
    host.cancelPending(completionError);
    await transport.cancel(completionError);
    await host.callFunction(
      '__webcmdCancelPlaywright',
      completionError.message,
    ).catch(() => undefined);
    await transport.dispose(completionError);
    host.dispose();
    input.context.off('page', registerNewPage);
  }
}
