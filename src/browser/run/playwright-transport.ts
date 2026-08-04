import { createRequire } from 'node:module';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { BrowserRunError } from './types.js';

interface DispatcherConnection {
  onmessage: (message: Record<string, unknown>) => void;
  dispatch(message: Record<string, unknown>): Promise<void>;
  _dispatcherByGuid: Map<string, { _type: string }>;
}

interface RootDispatcher {
  stopPendingOperations(error: Error): Promise<void>;
  _dispose(): void;
}

interface PlaywrightServer {
  DispatcherConnection: new () => DispatcherConnection;
  RootDispatcher: new (
    connection: DispatcherConnection,
    createPlaywright: (scope: unknown, params: { sdkLanguage: string }) => Promise<unknown>,
  ) => RootDispatcher;
  PlaywrightDispatcher: new (
    scope: unknown,
    playwright: unknown,
    options: Record<string, unknown>,
  ) => unknown;
  createPlaywright(options: Record<string, unknown>): unknown;
}

interface PlaywrightClientObject {
  _connection?: { toImpl?: (object: unknown) => unknown };
  _guid?: string;
}

const { server } = createRequire(import.meta.url)(
  'playwright-core/lib/coreBundle',
) as { server: PlaywrightServer };

const DENIED_METHODS = new Map<string, Set<string>>([
  ['Browser', new Set([
    'close',
    'killForTests',
    'newContext',
    'newContextForReuse',
    'startServer',
    'stopServer',
  ])],
  ['BrowserContext', new Set(['close'])],
  ['Page', new Set(['close'])],
  ['Playwright', new Set(['newRequest'])],
]);

function implementation<T>(object: T): unknown {
  const client = object as T & PlaywrightClientObject;
  const value = client._connection?.toImpl?.(object);
  if (!value) {
    throw new BrowserRunError(
      'BROWSER_RUN_API_UNSUPPORTED',
      'The supplied browser connection cannot be shared with browser run.',
    );
  }
  return value;
}

export class PlaywrightTransport {
  readonly pageGuid: string;
  readonly #connection: DispatcherConnection;
  readonly #root: RootDispatcher;
  readonly #deliver: (message: string) => void;
  #disposed = false;

  constructor(
    input: { browser: Browser; context: BrowserContext; page: Page },
    deliver: (message: string) => void,
  ) {
    if (
      !input.browser.contexts().includes(input.context)
      || !input.context.pages().includes(input.page)
    ) {
      throw new BrowserRunError(
        'BROWSER_RUN_API_UNSUPPORTED',
        'The supplied page is outside the supplied browser context.',
      );
    }

    const browser = implementation(input.browser);
    implementation(input.context);
    const page = implementation(input.page) as { guid?: string };
    this.pageGuid = page.guid
      ?? (input.page as Page & PlaywrightClientObject)._guid
      ?? '';
    this.#deliver = deliver;
    this.#connection = new server.DispatcherConnection();
    this.#connection.onmessage = message => {
      if (!this.#disposed) this.#deliver(JSON.stringify(message));
    };
    this.#root = new server.RootDispatcher(
      this.#connection,
      async (scope, { sdkLanguage }) => new server.PlaywrightDispatcher(
        scope,
        server.createPlaywright({ sdkLanguage, isServer: true }),
        {
          denyLaunch: true,
          preLaunchedBrowser: browser,
          sharedBrowser: true,
        },
      ),
    );
  }

  send(message: string): void {
    if (this.#disposed) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(message) as Record<string, unknown>;
    } catch {
      throw new BrowserRunError(
        'BROWSER_RUN_API_UNSUPPORTED',
        'Browser-run sent an invalid Playwright protocol message.',
      );
    }

    const dispatcher = typeof parsed.guid === 'string'
      ? this.#connection._dispatcherByGuid.get(parsed.guid)
      : undefined;
    const method = typeof parsed.method === 'string' ? parsed.method : '';
    if (
      dispatcher?._type === 'BrowserType'
      || dispatcher?._type === 'Android'
      || dispatcher?._type === 'Electron'
      || DENIED_METHODS.get(dispatcher?._type ?? '')?.has(method)
    ) {
      this.#unsupported(parsed.id, `${dispatcher?._type}.${method}`);
      return;
    }
    void this.#connection.dispatch(parsed);
  }

  cancel(error: Error): void {
    if (this.#disposed) return;
    void this.#root.stopPendingOperations(error);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#connection.onmessage = () => undefined;
    this.#root._dispose();
  }

  #unsupported(id: unknown, api: string): void {
    queueMicrotask(() => {
      if (this.#disposed) return;
      this.#deliver(JSON.stringify({
        id,
        error: {
          error: {
            name: 'BrowserRunError',
            message: `BROWSER_RUN_API_UNSUPPORTED: ${api} is unavailable in browser run.`,
            stack: '',
          },
        },
      }));
    });
  }
}
