import { randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type {
  Frame as PlaywrightFrame,
  Locator as PlaywrightLocator,
  Page as PlaywrightPage,
  Request as PlaywrightRequest,
  Response as PlaywrightResponse,
} from 'playwright-core';
import {
  redactHeaders,
  redactUrl,
  redactValue,
} from '../../observation/redaction.js';
import { QuickJSHost } from './quickjs-host.js';
import {
  BrowserRunNetworkSubscriptions,
  type BrowserRunNetworkEvent,
} from './network.js';
import { BROWSER_RUN_SANDBOX_CLIENT_SOURCE } from './sandbox-client.js';
import {
  BROWSER_RUN_MAX_UPLOAD_FILE_BYTES,
  BROWSER_RUN_MAX_UPLOAD_FILES,
  BROWSER_RUN_MAX_UPLOAD_TOTAL_BYTES,
  BROWSER_RUN_MAX_RESPONSE_BODY_BYTES,
  BROWSER_RUN_PLAYWRIGHT_VERSION,
  BROWSER_RUN_PROTOCOL_VERSION,
  BrowserRunError,
  type BrowserRunScreenshotReceipt,
} from './types.js';

type RemoteType = 'page' | 'frame' | 'request' | 'response';

interface RemoteEntry {
  type: RemoteType;
  value: object;
}

interface LocatorStep {
  method: string;
  args: unknown[];
}

export interface BrowserRunRemoteDescriptor {
  $remote: {
    type: RemoteType;
    handle: string;
    state?: Record<string, unknown>;
  };
}

export interface BrowserRunBridgeOptions {
  page: PlaywrightPage;
  pageId: string;
  writeScreenshot?: (
    target: Pick<PlaywrightPage, 'screenshot'> | Pick<PlaywrightLocator, 'screenshot'>,
    options: unknown,
  ) => Promise<BrowserRunScreenshotReceipt>;
  registerPage?: (page: PlaywrightPage) => string;
}

const LOCATOR_ROOT_METHODS = new Set([
  'locator',
  'getByRole',
  'getByText',
  'getByLabel',
  'getByPlaceholder',
  'getByAltText',
  'getByTitle',
  'getByTestId',
]);

const LOCATOR_CHAIN_METHODS = new Set([
  ...LOCATOR_ROOT_METHODS,
  'filter',
  'first',
  'last',
  'nth',
]);

const LOCATOR_FILTER_KEYS = new Set([
  'has',
  'hasNot',
  'hasText',
  'hasNotText',
  'visible',
]);

const LOCATOR_TERMINAL_METHODS = new Set([
  'click',
  'dblclick',
  'hover',
  'focus',
  'fill',
  'press',
  'type',
  'clear',
  'dispatchEvent',
  'selectOption',
  'setChecked',
  'setInputFiles',
  'dragTo',
  'screenshot',
  'scrollIntoViewIfNeeded',
  'textContent',
  'innerText',
  'innerHTML',
  'inputValue',
  'getAttribute',
  'isVisible',
  'isHidden',
  'isEnabled',
  'isDisabled',
  'isEditable',
  'isChecked',
  'count',
  'allInnerTexts',
  'allTextContents',
  'evaluate',
  'evaluateAll',
  'waitFor',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unsupported(message: string, hint?: string): BrowserRunError {
  return new BrowserRunError(
    'BROWSER_RUN_API_UNSUPPORTED',
    message,
    hint ?? 'Use a supported Playwright browser automation method or a primitive webcmd browser command.',
  );
}

function invalidInput(message: string, hint?: string): BrowserRunError {
  return new BrowserRunError('BROWSER_RUN_INVALID_INPUT', message, hint);
}

interface BrowserRunFilePayload {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

function decodeUploadBytes(value: unknown): Buffer {
  if (
    !isRecord(value)
    || value.$type !== 'Bytes'
    || value.encoding !== 'base64'
    || typeof value.data !== 'string'
  ) {
    throw invalidInput(
      'Browser-run file buffer must be created with Buffer.from(), Uint8Array, or ArrayBuffer.',
    );
  }
  if (
    value.data.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)
  ) {
    throw invalidInput('Browser-run file buffer contains invalid base64 data.');
  }
  const maxEncodedLength = Math.ceil(BROWSER_RUN_MAX_UPLOAD_FILE_BYTES / 3) * 4;
  if (value.data.length > maxEncodedLength) {
    throw invalidInput(
      `Browser-run files cannot exceed ${BROWSER_RUN_MAX_UPLOAD_FILE_BYTES} bytes each.`,
    );
  }
  const decoded = Buffer.from(value.data, 'base64');
  if (decoded.toString('base64') !== value.data) {
    throw invalidInput('Browser-run file buffer contains non-canonical base64 data.');
  }
  if (decoded.byteLength > BROWSER_RUN_MAX_UPLOAD_FILE_BYTES) {
    throw invalidInput(
      `Browser-run files cannot exceed ${BROWSER_RUN_MAX_UPLOAD_FILE_BYTES} bytes each.`,
    );
  }
  return decoded;
}

function decodeUploadFile(value: unknown): BrowserRunFilePayload {
  if (!isRecord(value)) {
    throw invalidInput(
      'Browser-run uploads require in-memory {name, mimeType, buffer} payloads.',
      'Host file paths are unavailable inside browser run.',
    );
  }
  const keys = Object.keys(value);
  if (
    keys.some(key => !['name', 'mimeType', 'buffer'].includes(key))
    || typeof value.name !== 'string'
    || typeof value.mimeType !== 'string'
  ) {
    throw invalidInput(
      'Browser-run uploads require exactly {name, mimeType, buffer}.',
    );
  }
  if (
    value.name.length === 0
    || value.name.length > 255
    || /[/\\\u0000-\u001f\u007f]/.test(value.name)
    || value.name === '.'
    || value.name === '..'
  ) {
    throw invalidInput('Browser-run upload filename is invalid.');
  }
  if (
    value.mimeType.length === 0
    || value.mimeType.length > 255
    || /[\u0000-\u001f\u007f]/.test(value.mimeType)
  ) {
    throw invalidInput('Browser-run upload MIME type is invalid.');
  }
  return {
    name: value.name,
    mimeType: value.mimeType,
    buffer: decodeUploadBytes(value.buffer),
  };
}

function decodeUploadFiles(value: unknown): BrowserRunFilePayload | BrowserRunFilePayload[] {
  if (typeof value === 'string') {
    throw invalidInput(
      'Host file paths are unavailable inside browser run.',
      'Use an in-memory {name, mimeType, buffer} payload.',
    );
  }
  const inputs = Array.isArray(value) ? value : [value];
  if (inputs.length > BROWSER_RUN_MAX_UPLOAD_FILES) {
    throw invalidInput(
      `Browser run accepts at most ${BROWSER_RUN_MAX_UPLOAD_FILES} in-memory files per upload.`,
    );
  }
  const files: BrowserRunFilePayload[] = [];
  let totalBytes = 0;
  for (const input of inputs) {
    const file = decodeUploadFile(input);
    totalBytes += file.buffer.byteLength;
    if (totalBytes > BROWSER_RUN_MAX_UPLOAD_TOTAL_BYTES) {
      throw invalidInput(
        `Browser-run upload payloads cannot exceed ${BROWSER_RUN_MAX_UPLOAD_TOTAL_BYTES} bytes total.`,
      );
    }
    files.push(file);
  }
  return Array.isArray(value) ? files : files[0]!;
}

function decodeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (!isRecord(value)) return value;
  if (value.$type === 'Undefined') return undefined;
  if (
    value.$type === 'RegExp'
    && typeof value.source === 'string'
    && typeof value.flags === 'string'
  ) {
    return new RegExp(value.source, value.flags);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, decodeValue(nested)]),
  );
}

function normalizeArgs(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw unsupported('Browser-run operation arguments must be an array.');
  }
  return value.map(decodeValue);
}

interface EvaluationPayload {
  source: string;
  args: unknown[];
}

function decodeEvaluationPayload(value: unknown, apiName: string): EvaluationPayload {
  if (
    !isRecord(value)
    || typeof value.source !== 'string'
    || !Array.isArray(value.args)
  ) {
    throw unsupported(
      `${apiName} requires a function and serializable arguments.`,
    );
  }
  return {
    source: value.source,
    args: value.args.map(decodeValue),
  };
}

function normalizeLocatorRecipe(value: unknown): LocatorStep[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw unsupported('Browser-run locator recipe is missing.');
  }
  return value.map((step) => {
    if (
      !isRecord(step)
      || typeof step.method !== 'string'
      || !Array.isArray(step.args)
    ) {
      throw unsupported('Browser-run locator recipe is invalid.');
    }
    return {
      method: step.method,
      args: normalizeArgs(step.args),
    };
  });
}

export class BrowserRunBridge {
  readonly #runPrefix = randomBytes(12).toString('hex');
  readonly #entries = new Map<string, RemoteEntry>();
  readonly #handles = new WeakMap<object, string>();
  readonly #pageIds = new WeakMap<object, string>();
  readonly #pages: PlaywrightPage[] = [];
  readonly #network = new BrowserRunNetworkSubscriptions();
  readonly #networkKinds = new Map<number, BrowserRunNetworkEvent>();
  readonly #pending = new Map<Promise<unknown>, string>();
  readonly #pageId: string;
  readonly #writeScreenshot?: BrowserRunBridgeOptions['writeScreenshot'];
  readonly #registerPage?: BrowserRunBridgeOptions['registerPage'];
  #counter = 0;
  #disposed = false;
  #cancelled?: Error;

  constructor(options: BrowserRunBridgeOptions) {
    this.#pageId = options.pageId;
    this.#writeScreenshot = options.writeScreenshot;
    this.#registerPage = options.registerPage;
    this.#pages.push(options.page);
    this.#pageIds.set(options.page, options.pageId);
  }

  dispatch(operation: string, args: unknown[]): Promise<unknown> {
    if (this.#disposed) {
      return Promise.reject(
        unsupported('The browser-run bridge has already been disposed.'),
      );
    }
    if (this.#cancelled) return Promise.reject(this.#cancelled);

    const pending = this.#dispatch(operation, args);
    this.#pending.set(pending, operation);
    return pending.finally(() => {
      this.#pending.delete(pending);
    });
  }

  hasPendingBrowserOperations(): boolean {
    return [...this.#pending.values()].some(operation => (
      operation === 'page.call'
      || operation === 'frame.call'
      || operation === 'locator.call'
      || operation === 'request.call'
      || operation === 'response.call'
    ));
  }

  cancel(error: Error): void {
    if (this.#disposed || this.#cancelled) return;
    this.#cancelled = error;
    this.#network.dispose();
    this.#networkKinds.clear();
  }

  async #dispatch(operation: string, args: unknown[]): Promise<unknown> {
    switch (operation) {
      case 'handshake':
        return this.#handshake(args[0]);
      case 'browser.currentPage':
        return this.#pageDescriptor(this.#pages[0]!);
      case 'browser.getPage':
        return this.#getPage(args[0]);
      case 'browser.pages':
        return this.#pages.map((page) => this.#pageDescriptor(page));
      case 'page.call':
        return this.#pageCall(args[0]);
      case 'frame.call':
        return this.#frameCall(args[0]);
      case 'locator.call':
        return this.#locatorCall(args[0]);
      case 'network.start':
        return this.#networkStart(args[0]);
      case 'network.next':
        return this.#networkNext(args[0]);
      case 'network.stop':
        return this.#networkStop(args[0]);
      case 'request.call':
        return this.#requestCall(args[0]);
      case 'response.call':
        return this.#responseCall(args[0]);
      case 'unsupported':
        throw unsupported(
          `Unsupported Playwright API: ${String(args[0])}`,
          'Use a supported Page, Frame, or Locator method. Browser/context ownership stays with Webcmd.',
        );
      default:
        throw unsupported(`Unsupported browser-run operation: ${operation}`);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#network.dispose();
    this.#networkKinds.clear();
    this.#pending.clear();
    this.#entries.clear();
    this.#pages.length = 0;
  }

  #handshake(value: unknown): { protocolVersion: number; playwrightVersion: string } {
    if (
      !isRecord(value)
      || value.protocolVersion !== BROWSER_RUN_PROTOCOL_VERSION
      || value.playwrightVersion !== BROWSER_RUN_PLAYWRIGHT_VERSION
    ) {
      throw new BrowserRunError(
        'BROWSER_RUN_PROTOCOL_MISMATCH',
        'Browser-run client and host versions do not match.',
        'Update Webcmd so the CLI, daemon, sandbox client, and Playwright host use the same release.',
      );
    }
    return {
      protocolVersion: BROWSER_RUN_PROTOCOL_VERSION,
      playwrightVersion: BROWSER_RUN_PLAYWRIGHT_VERSION,
    };
  }

  #getPage(nameOrId: unknown): BrowserRunRemoteDescriptor {
    const requested = nameOrId === undefined || nameOrId === null || nameOrId === ''
      ? 'main'
      : String(nameOrId);
    const page = requested === 'main'
      ? this.#pages[0]
      : this.#pages.find((candidate) => this.#pageIds.get(candidate) === requested);
    if (!page) {
      throw unsupported(
        `Page "${requested}" is not part of this browser-run lease.`,
        'Use browser.currentPage(), browser.getPage("main"), or browser.pages().',
      );
    }
    return this.#pageDescriptor(page);
  }

  #pageDescriptor(page: PlaywrightPage): BrowserRunRemoteDescriptor {
    const handle = this.#register('page', page);
    const frames = typeof page.frames === 'function'
      ? page.frames().map((frame) => this.#frameDescriptor(frame))
      : [];
    return {
      $remote: {
        type: 'page',
        handle,
        state: {
          id: this.#pageIds.get(page) ?? this.#pageId,
          url: redactUrl(page.url()),
          frames,
        },
      },
    };
  }

  #frameDescriptor(frame: PlaywrightFrame): BrowserRunRemoteDescriptor {
    return {
      $remote: {
        type: 'frame',
        handle: this.#register('frame', frame),
        state: {
          name: frame.name(),
          url: redactUrl(frame.url()),
        },
      },
    };
  }

  #requestDescriptor(request: PlaywrightRequest): BrowserRunRemoteDescriptor {
    return {
      $remote: {
        type: 'request',
        handle: this.#register('request', request),
        state: {
          url: redactUrl(request.url()),
          method: request.method(),
          resourceType: request.resourceType(),
          headers: redactHeaders(request.headers()),
          postData: redactValue(request.postData()),
          failure: redactValue(request.failure()),
        },
      },
    };
  }

  #responseDescriptor(response: PlaywrightResponse): BrowserRunRemoteDescriptor {
    return {
      $remote: {
        type: 'response',
        handle: this.#register('response', response),
        state: {
          url: redactUrl(response.url()),
          status: response.status(),
          ok: response.ok(),
          headers: redactHeaders(response.headers()),
          request: this.#requestDescriptor(response.request()),
        },
      },
    };
  }

  async #pageCall(input: unknown): Promise<unknown> {
    if (!isRecord(input)) throw unsupported('Invalid page operation payload.');
    const page = this.#requireHandle(input.handle, 'page') as PlaywrightPage;
    const method = input.method;
    const args = normalizeArgs(input.args ?? []);

    let value: unknown;
    switch (method) {
      case 'title':
      case 'content':
        value = await page[method]();
        break;
      case 'goto':
        await page.goto(args[0] as string, args[1] as never);
        value = null;
        break;
      case 'reload':
      case 'goBack':
      case 'goForward':
        await page[method](args[0] as never);
        value = null;
        break;
      case 'waitForLoadState':
        await page.waitForLoadState(args[0] as never, args[1] as never);
        break;
      case 'waitForURL':
        await page.waitForURL(args[0] as never, args[1] as never);
        break;
      case 'evaluate':
        value = await this.#evaluate(page, args[0]);
        break;
      case 'waitForEvent': {
        if (args[0] !== 'popup') {
          throw unsupported(
            `Unsupported Playwright Page event: ${String(args[0])}`,
            'The initial browser-run surface supports page.waitForEvent("popup").',
          );
        }
        const popup = await page.waitForEvent('popup', args[1] as never);
        this.#addPage(popup);
        value = this.#pageDescriptor(popup);
        break;
      }
      case 'screenshot':
        if (!this.#writeScreenshot) {
          throw unsupported('page.screenshot() is unavailable for this browser-run host.');
        }
        value = await this.#writeScreenshot(page, args[0]);
        break;
      default:
        throw unsupported(`Unsupported Playwright Page method: ${String(method)}`);
    }

    return {
      value,
      state: this.#pageDescriptor(page).$remote.state,
    };
  }

  async #frameCall(input: unknown): Promise<unknown> {
    if (!isRecord(input)) throw unsupported('Invalid frame operation payload.');
    const frame = this.#requireHandle(input.handle, 'frame') as PlaywrightFrame;
    const method = input.method;
    const args = normalizeArgs(input.args ?? []);

    let value: unknown;
    switch (method) {
      case 'content':
        value = await frame.content();
        break;
      case 'evaluate':
        value = await this.#evaluate(frame, args[0]);
        break;
      case 'waitForLoadState':
        await frame.waitForLoadState(args[0] as never, args[1] as never);
        break;
      case 'waitForURL':
        await frame.waitForURL(args[0] as never, args[1] as never);
        break;
      default:
        throw unsupported(`Unsupported Playwright Frame method: ${String(method)}`);
    }

    return {
      value,
      state: {
        name: frame.name(),
        url: redactUrl(frame.url()),
      },
    };
  }

  async #locatorCall(input: unknown): Promise<unknown> {
    if (!isRecord(input)) throw unsupported('Invalid locator operation payload.');
    const originType = input.originType;
    if (originType !== 'page' && originType !== 'frame') {
      throw unsupported('Browser-run locator origin is invalid.');
    }
    const origin = this.#requireHandle(
      input.originHandle,
      originType,
    ) as PlaywrightPage | PlaywrightFrame;
    const recipe = normalizeLocatorRecipe(input.recipe);
    const method = input.method;
    if (typeof method !== 'string' || !LOCATOR_TERMINAL_METHODS.has(method)) {
      throw unsupported(`Unsupported Playwright Locator method: ${String(method)}`);
    }
    const locator = this.#replayLocator(origin, recipe);
    const args = normalizeArgs(input.args ?? []);

    let value: unknown;
    if (method === 'dragTo') {
      const targetRecipe = normalizeLocatorRecipe(args[0]);
      const target = this.#replayLocator(origin, targetRecipe);
      value = await locator.dragTo(target, args[1] as never);
    } else if (method === 'setInputFiles') {
      value = await locator.setInputFiles(
        decodeUploadFiles(args[0]) as never,
        args[1] as never,
      );
    } else if (method === 'evaluate' || method === 'evaluateAll') {
      value = await this.#evaluateLocator(locator, method, args[0]);
    } else if (method === 'screenshot') {
      if (!this.#writeScreenshot) {
        throw unsupported('locator.screenshot() is unavailable for this browser-run host.');
      }
      value = await this.#writeScreenshot(locator, args[0]);
    } else {
      const callable = (locator as unknown as Record<string, unknown>)[method];
      if (typeof callable !== 'function') {
        throw unsupported(`Playwright Locator method is unavailable: ${method}`);
      }
      value = await callable.apply(locator, args);
    }

    const page = originType === 'page'
      ? origin as PlaywrightPage
      : (origin as PlaywrightFrame).page();
    return {
      value,
      pageState: this.#pageDescriptor(page).$remote.state,
      frameState: originType === 'frame'
        ? {
            name: (origin as PlaywrightFrame).name(),
            url: redactUrl((origin as PlaywrightFrame).url()),
          }
        : undefined,
    };
  }

  #networkStart(input: unknown): number {
    if (!isRecord(input)) throw unsupported('Invalid network subscription payload.');
    const page = this.#requireHandle(input.pageHandle, 'page') as PlaywrightPage;
    const event = input.event;
    if (event !== 'request' && event !== 'response') {
      throw unsupported(
        `Unsupported Playwright network event: ${String(event)}`,
        'The initial browser-run network surface supports request and response events.',
      );
    }
    const id = this.#network.start(page, event);
    this.#networkKinds.set(id, event);
    return id;
  }

  async #networkNext(input: unknown): Promise<BrowserRunRemoteDescriptor> {
    if (!isRecord(input) || typeof input.id !== 'number') {
      throw unsupported('Invalid network subscription id.');
    }
    const kind = this.#networkKinds.get(input.id);
    if (!kind) throw unsupported('Network subscription is unknown or expired.');
    const value = await this.#network.next(input.id);
    return kind === 'request'
      ? this.#requestDescriptor(value as PlaywrightRequest)
      : this.#responseDescriptor(value as PlaywrightResponse);
  }

  #networkStop(input: unknown): null {
    if (!isRecord(input) || typeof input.id !== 'number') return null;
    this.#network.stop(input.id);
    this.#networkKinds.delete(input.id);
    return null;
  }

  async #requestCall(input: unknown): Promise<unknown> {
    if (!isRecord(input)) throw unsupported('Invalid request operation payload.');
    const request = this.#requireHandle(
      input.handle,
      'request',
    ) as PlaywrightRequest;
    if (input.method !== 'allHeaders') {
      throw unsupported(`Unsupported Playwright Request method: ${String(input.method)}`);
    }
    return redactHeaders(await request.allHeaders());
  }

  async #responseCall(input: unknown): Promise<unknown> {
    if (!isRecord(input)) throw unsupported('Invalid response operation payload.');
    const response = this.#requireHandle(
      input.handle,
      'response',
    ) as PlaywrightResponse;
    switch (input.method) {
      case 'allHeaders':
        return redactHeaders(await response.allHeaders());
      case 'body': {
        const body = await this.#boundedResponseBody(response);
        return [...body];
      }
      case 'text': {
        const body = await this.#boundedResponseBody(response);
        return body.toString('utf8');
      }
      case 'json': {
        const body = await this.#boundedResponseBody(response);
        try {
          return JSON.parse(body.toString('utf8')) as unknown;
        } catch {
          throw new BrowserRunError(
            'BROWSER_RUN_SERIALIZATION_ERROR',
            'The response body is not valid JSON.',
          );
        }
      }
      default:
        throw unsupported(`Unsupported Playwright Response method: ${String(input.method)}`);
    }
  }

  async #boundedResponseBody(response: PlaywrightResponse): Promise<Buffer> {
    const body = await response.body();
    if (body.byteLength > BROWSER_RUN_MAX_RESPONSE_BODY_BYTES) {
      throw new BrowserRunError(
        'BROWSER_RUN_OUTPUT_LIMIT',
        `Response body exceeds the ${BROWSER_RUN_MAX_RESPONSE_BODY_BYTES}-byte browser-run limit.`,
        'Inspect headers or a smaller endpoint response instead of returning the full body.',
      );
    }
    return body;
  }

  #replayLocator(
    origin: PlaywrightPage | PlaywrightFrame,
    recipe: LocatorStep[],
  ): PlaywrightLocator {
    let current: PlaywrightPage | PlaywrightFrame | PlaywrightLocator = origin;
    for (let index = 0; index < recipe.length; index += 1) {
      const step = recipe[index]!;
      const allowed = index === 0 ? LOCATOR_ROOT_METHODS : LOCATOR_CHAIN_METHODS;
      if (!allowed.has(step.method)) {
        throw unsupported(`Unsupported Playwright locator chain method: ${step.method}`);
      }
      const callable = (current as unknown as Record<string, unknown>)[step.method];
      if (typeof callable !== 'function') {
        throw unsupported(`Playwright locator chain method is unavailable: ${step.method}`);
      }
      const args = step.method === 'filter'
        ? [this.#decodeLocatorFilter(origin, step.args[0])]
        : step.args;
      current = callable.apply(current, args) as PlaywrightLocator;
    }
    return current as PlaywrightLocator;
  }

  #decodeLocatorFilter(
    origin: PlaywrightPage | PlaywrightFrame,
    value: unknown,
  ): Record<string, unknown> {
    if (!isRecord(value)) {
      throw invalidInput('locator.filter() requires an options object.');
    }
    const options: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (!LOCATOR_FILTER_KEYS.has(key)) {
        throw invalidInput(`Unsupported locator.filter() option: ${key}`);
      }
      if (key === 'has' || key === 'hasNot') {
        if (
          !isRecord(nested)
          || Object.keys(nested).length !== 1
          || !('$locatorRecipe' in nested)
        ) {
          throw invalidInput(
            `locator.filter(${key}) requires a same-origin locator capability.`,
          );
        }
        try {
          options[key] = this.#replayLocator(
            origin,
            normalizeLocatorRecipe(nested.$locatorRecipe),
          );
        } catch (error) {
          if (error instanceof BrowserRunError) {
            throw invalidInput(
              `locator.filter(${key}) requires a valid same-origin locator capability.`,
            );
          }
          throw error;
        }
        continue;
      }
      if (
        (key === 'hasText' || key === 'hasNotText')
        && typeof nested !== 'string'
        && !(nested instanceof RegExp)
      ) {
        throw invalidInput(`locator.filter(${key}) requires a string or RegExp.`);
      }
      if (key === 'visible' && typeof nested !== 'boolean') {
        throw invalidInput('locator.filter(visible) requires a boolean.');
      }
      options[key] = nested;
    }
    return options;
  }

  async #evaluate(
    target: Pick<PlaywrightPage, 'evaluate'> | Pick<PlaywrightFrame, 'evaluate'>,
    value: unknown,
  ): Promise<unknown> {
    const payload = decodeEvaluationPayload(value, 'page.evaluate()');
    return target.evaluate(
      ({ source, args }) => {
        const pageFunction = globalThis.eval(`(${source})`) as (...items: unknown[]) => unknown;
        return pageFunction(...args);
      },
      payload,
    );
  }

  async #evaluateLocator(
    locator: PlaywrightLocator,
    method: 'evaluate' | 'evaluateAll',
    value: unknown,
  ): Promise<unknown> {
    const payload = decodeEvaluationPayload(value, `locator.${method}()`);
    const pageFunction = (
      elementOrElements: unknown,
      input: EvaluationPayload,
    ): unknown => {
      const callable = globalThis.eval(`(${input.source})`) as (
        value: unknown,
        ...items: unknown[]
      ) => unknown;
      return callable(elementOrElements, ...input.args);
    };
    if (method === 'evaluate') {
      return locator.evaluate(pageFunction as never, payload as never);
    }
    return locator.evaluateAll(pageFunction as never, payload as never);
  }

  #addPage(page: PlaywrightPage): void {
    if (this.#pages.includes(page)) return;
    this.#pages.push(page);
    this.#pageIds.set(
      page,
      this.#registerPage?.(page) ?? `popup-${this.#pages.length - 1}`,
    );
  }

  #register(type: RemoteType, value: object): string {
    const existing = this.#handles.get(value);
    if (existing) return existing;
    const handle = `${this.#runPrefix}:${type}:${++this.#counter}`;
    this.#handles.set(value, handle);
    this.#entries.set(handle, { type, value });
    return handle;
  }

  #requireHandle(handle: unknown, type: RemoteType): object {
    if (typeof handle !== 'string') {
      throw unsupported('Browser-run object handle is missing.');
    }
    const entry = this.#entries.get(handle);
    if (!entry || entry.type !== type) {
      throw unsupported('Browser-run object handle is unknown, expired, or has the wrong type.');
    }
    return entry.value;
  }
}

export async function initializeBrowserRunSandboxClient(
  host: QuickJSHost,
): Promise<void> {
  host.installHostCall();
  await host.executeScript(BROWSER_RUN_SANDBOX_CLIENT_SOURCE, {
    filename: 'webcmd-browser-run-client.js',
  });
}
