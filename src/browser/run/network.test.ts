import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BrowserRunBridge,
  initializeBrowserRunSandboxClient,
} from './bridge.js';
import { QuickJSHost } from './quickjs-host.js';
import {
  BrowserRunNetworkSubscriptions,
  type BrowserRunNetworkPage,
} from './network.js';

class FakeRequest {
  constructor(
    readonly requestUrl: string,
    readonly requestMethod = 'GET',
  ) {}

  url() { return this.requestUrl; }
  method() { return this.requestMethod; }
  resourceType() { return 'fetch'; }
  headers() {
    return {
      accept: 'application/json',
      authorization: 'Bearer secret',
      cookie: 'session=secret',
    };
  }
  async allHeaders() { return this.headers(); }
  postData() { return null; }
  failure() { return null; }
}

class FakeResponse {
  constructor(
    readonly responseUrl: string,
    readonly requestValue: FakeRequest,
    readonly bodyValue: Buffer = Buffer.from('{"items":[1]}'),
  ) {}

  url() { return this.responseUrl; }
  status() { return 200; }
  ok() { return true; }
  headers() {
    return {
      'content-type': 'application/json',
      'set-cookie': 'session=secret',
    };
  }
  async allHeaders() { return this.headers(); }
  request() { return this.requestValue; }
  async body() { return this.bodyValue; }
}

class FakeNetworkPage extends EventEmitter {
  nextResponse?: FakeResponse;

  url() { return 'https://example.test/'; }
  async title() { return 'Example'; }
  frames() { return []; }
  locator() {
    return {
      click: async () => {
        const request = new FakeRequest('https://example.test/api/search');
        this.emit('request', request);
        this.emit(
          'response',
          this.nextResponse ?? new FakeResponse(request.url(), request),
        );
      },
    };
  }
}

const hosts = new Set<QuickJSHost>();

async function sandboxFor(page: FakeNetworkPage) {
  const bridge = new BrowserRunBridge({
    page: page as never,
    pageId: 'page-1',
  });
  const host = await QuickJSHost.create({
    onHostCall: (operation, args) => bridge.dispatch(operation, args),
  });
  hosts.add(host);
  await initializeBrowserRunSandboxClient(host);
  return { bridge, host };
}

afterEach(() => {
  for (const host of hosts) host.dispose();
  hosts.clear();
});

describe('BrowserRunNetworkSubscriptions', () => {
  it('queues events in order and removes its listener on stop', async () => {
    const page = new FakeNetworkPage();
    const subscriptions = new BrowserRunNetworkSubscriptions();
    const id = subscriptions.start(page as BrowserRunNetworkPage, 'response');
    const first = new FakeResponse(
      'https://example.test/first',
      new FakeRequest('https://example.test/first'),
    );
    const second = new FakeResponse(
      'https://example.test/second',
      new FakeRequest('https://example.test/second'),
    );

    page.emit('response', first);
    page.emit('response', second);

    await expect(subscriptions.next(id)).resolves.toBe(first);
    await expect(subscriptions.next(id)).resolves.toBe(second);
    expect(page.listenerCount('response')).toBe(1);
    subscriptions.stop(id);
    expect(page.listenerCount('response')).toBe(0);
  });

  it('fails closed instead of allowing an unbounded event queue', async () => {
    const page = new FakeNetworkPage();
    const subscriptions = new BrowserRunNetworkSubscriptions(2);
    const id = subscriptions.start(page as BrowserRunNetworkPage, 'request');

    page.emit('request', new FakeRequest('https://example.test/one'));
    page.emit('request', new FakeRequest('https://example.test/two'));
    page.emit('request', new FakeRequest('https://example.test/three'));

    await expect(subscriptions.next(id)).rejects.toMatchObject({
      code: 'BROWSER_RUN_OUTPUT_LIMIT',
    });
    expect(page.listenerCount('request')).toBe(0);
    subscriptions.stop(id);
  });
});

describe('browser-run network surface', () => {
  it('arms waitForResponse before the triggering click and evaluates the predicate in QuickJS', async () => {
    const page = new FakeNetworkPage();
    const { host } = await sandboxFor(page);

    const result = await host.executeScript(`
      (async () => {
        const page = await browser.currentPage();
        const responsePromise = page.waitForResponse(
          response => response.url().includes("/api/search")
            && response.request().method() === "GET"
        );
        await page.locator("button").click();
        const response = await responsePromise;
        return {
          status: response.status(),
          body: await response.json()
        };
      })()
    `);

    expect(result).toEqual({ status: 200, body: { items: [1] } });
    expect(page.listenerCount('response')).toBe(0);
  });

  it('redacts sensitive request and response headers', async () => {
    const page = new FakeNetworkPage();
    const { host } = await sandboxFor(page);

    const result = await host.executeScript(`
      (async () => {
        const page = await browser.currentPage();
        const pending = page.waitForRequest("/api/search");
        await page.locator("button").click();
        const request = await pending;
        return await request.allHeaders();
      })()
    `);

    expect(result).toEqual({
      accept: 'application/json',
      authorization: '[REDACTED]',
      cookie: '[REDACTED]',
    });
  });

  it('rejects oversized bodies without returning their contents', async () => {
    const page = new FakeNetworkPage();
    const { host } = await sandboxFor(page);
    const response = new FakeResponse(
      'https://example.test/large',
      new FakeRequest('https://example.test/large'),
      Buffer.alloc(1024 * 1024 + 1, 65),
    );
    page.nextResponse = response;

    const result = host.executeScript(`
      (async () => {
        const page = await browser.currentPage();
        const pending = page.waitForResponse("/large");
        await page.locator("button").click();
        return (await pending).text();
      })()
    `);

    await expect(result).rejects.toMatchObject({
      code: 'BROWSER_RUN_OUTPUT_LIMIT',
    });
  });
});
