import { afterEach, describe, expect, it } from 'vitest';
import {
  BrowserRunBridge,
  initializeBrowserRunSandboxClient,
} from './bridge.js';
import { QuickJSHost } from './quickjs-host.js';
import {
  BROWSER_RUN_PLAYWRIGHT_VERSION,
  BROWSER_RUN_PROTOCOL_VERSION,
} from './types.js';

type FakePage = {
  url(): string;
  title(): Promise<string>;
};

function fakePage(url = 'https://example.test/'): FakePage {
  return {
    url: () => url,
    title: async () => 'Example',
  };
}

const hosts = new Set<QuickJSHost>();

async function sandboxFor(page: FakePage = fakePage()) {
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

describe('BrowserRunBridge', () => {
  it('fails closed when protocol or Playwright versions differ', async () => {
    const bridge = new BrowserRunBridge({
      page: fakePage() as never,
      pageId: 'page-1',
    });

    await expect(bridge.dispatch('handshake', [{
      protocolVersion: BROWSER_RUN_PROTOCOL_VERSION + 1,
      playwrightVersion: BROWSER_RUN_PLAYWRIGHT_VERSION,
    }])).rejects.toMatchObject({
      code: 'BROWSER_RUN_PROTOCOL_MISMATCH',
    });
    await expect(bridge.dispatch('handshake', [{
      protocolVersion: BROWSER_RUN_PROTOCOL_VERSION,
      playwrightVersion: '0.0.0',
    }])).rejects.toMatchObject({
      code: 'BROWSER_RUN_PROTOCOL_MISMATCH',
    });
  });

  it('returns only the selected page through currentPage, getPage, and pages', async () => {
    const { host } = await sandboxFor();

    await expect(host.executeScript(`
      (async () => {
        const current = await browser.currentPage();
        const main = await browser.getPage("main");
        const pages = await browser.pages();
        return {
          currentUrl: current.url(),
          mainTitle: await main.title(),
          pageCount: pages.length,
          samePage: current === pages[0]
        };
      })()
    `)).resolves.toEqual({
      currentUrl: 'https://example.test/',
      mainTitle: 'Example',
      pageCount: 1,
      samePage: true,
    });
  });

  it('does not expose the temporary host call or a mutable browser API', async () => {
    const { host } = await sandboxFor();

    await expect(host.executeScript(`({
      hostCall: typeof __webcmdHostCall,
      browserFrozen: Object.isFrozen(browser),
      browserPrototype: Object.getPrototypeOf(browser)
    })`)).resolves.toEqual({
      hostCall: 'undefined',
      browserFrozen: true,
      browserPrototype: null,
    });
  });

  it('rejects unknown page names and forged object handles', async () => {
    const { bridge, host } = await sandboxFor();

    await expect(host.executeScript(`
      (async () => browser.getPage("another-session"))()
    `)).rejects.toMatchObject({
      code: 'BROWSER_RUN_API_UNSUPPORTED',
    });

    await expect(bridge.dispatch('page.call', [{
      handle: 'forged:page:1',
      method: 'title',
      args: [],
    }])).rejects.toMatchObject({
      code: 'BROWSER_RUN_API_UNSUPPORTED',
    });
  });

  it('rejects malformed nested locator filter capabilities as invalid input', async () => {
    const locator = {
      filter: () => locator,
      count: async () => 1,
    };
    const page = {
      ...fakePage(),
      locator: () => locator,
    };
    const bridge = new BrowserRunBridge({
      page: page as never,
      pageId: 'page-1',
    });
    const descriptor = await bridge.dispatch('browser.currentPage', []);
    const handle = (descriptor as { $remote: { handle: string } }).$remote.handle;

    await expect(bridge.dispatch('locator.call', [{
      originType: 'page',
      originHandle: handle,
      recipe: [
        { method: 'locator', args: ['main'] },
        {
          method: 'filter',
          args: [{ has: { $locatorRecipe: 'not-a-recipe' } }],
        },
      ],
      method: 'count',
      args: [],
    }])).rejects.toMatchObject({
      code: 'BROWSER_RUN_INVALID_INPUT',
      message: expect.stringContaining('same-origin locator capability'),
    });
  });

  it('invalidates every handle on disposal', async () => {
    const bridge = new BrowserRunBridge({
      page: fakePage() as never,
      pageId: 'page-1',
    });
    const descriptor = await bridge.dispatch('browser.currentPage', []);
    const handle = (descriptor as { $remote: { handle: string } }).$remote.handle;
    bridge.dispose();

    await expect(bridge.dispatch('page.call', [{
      handle,
      method: 'title',
      args: [],
    }])).rejects.toMatchObject({
      code: 'BROWSER_RUN_API_UNSUPPORTED',
    });
  });
});
