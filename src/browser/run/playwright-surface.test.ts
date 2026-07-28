import { afterEach, describe, expect, it } from 'vitest';
import {
  BrowserRunBridge,
  initializeBrowserRunSandboxClient,
} from './bridge.js';
import { QuickJSHost } from './quickjs-host.js';

type Operation = [string, ...unknown[]];

class FakeLocator {
  constructor(
    private readonly page: FakePage,
    private readonly recipe: Operation[],
  ) {}

  private next(operation: Operation): FakeLocator {
    return new FakeLocator(this.page, [...this.recipe, operation]);
  }

  locator(selector: string, options?: unknown) {
    return this.next(['locator', selector, options]);
  }

  getByRole(role: string, options?: unknown) {
    return this.next(['getByRole', role, options]);
  }

  getByText(text: string, options?: unknown) {
    return this.next(['getByText', text, options]);
  }

  getByLabel(text: string, options?: unknown) {
    return this.next(['getByLabel', text, options]);
  }

  getByPlaceholder(text: string, options?: unknown) {
    return this.next(['getByPlaceholder', text, options]);
  }

  getByAltText(text: string, options?: unknown) {
    return this.next(['getByAltText', text, options]);
  }

  getByTitle(text: string, options?: unknown) {
    return this.next(['getByTitle', text, options]);
  }

  getByTestId(id: string | RegExp) {
    return this.next(['getByTestId', id]);
  }

  first() {
    return this.next(['first']);
  }

  last() {
    return this.next(['last']);
  }

  nth(index: number) {
    return this.next(['nth', index]);
  }

  filter(options: {
    has?: FakeLocator;
    hasNot?: FakeLocator;
    [key: string]: unknown;
  }) {
    return this.next(['filter', {
      ...options,
      has: options.has?.recipe,
      hasNot: options.hasNot?.recipe,
    }]);
  }

  async terminal(method: string, ...args: unknown[]) {
    this.page.operations.push(...this.recipe, [method, ...args]);
    if (method === 'click') this.page.urlValue = 'https://example.test/saved';
    switch (method) {
      case 'innerText': return 'Save';
      case 'innerHTML': return '<strong>Save</strong>';
      case 'textContent': return 'Save';
      case 'inputValue': return 'draft';
      case 'getAttribute': return 'button';
      case 'isVisible': return true;
      case 'isHidden': return false;
      case 'isEnabled': return true;
      case 'isDisabled': return false;
      case 'isEditable': return true;
      case 'isChecked': return false;
      case 'count': return 2;
      case 'allInnerTexts': return ['Save', 'Cancel'];
      case 'allTextContents': return ['Save', 'Cancel'];
      case 'selectOption': return ['published'];
      default: return undefined;
    }
  }

  click(options?: unknown) { return this.terminal('click', options ?? {}); }
  dblclick(options?: unknown) { return this.terminal('dblclick', options ?? {}); }
  hover(options?: unknown) { return this.terminal('hover', options ?? {}); }
  focus(options?: unknown) { return this.terminal('focus', options ?? {}); }
  fill(value: string, options?: unknown) { return this.terminal('fill', value, options ?? {}); }
  press(key: string, options?: unknown) { return this.terminal('press', key, options ?? {}); }
  type(value: string, options?: unknown) { return this.terminal('type', value, options ?? {}); }
  clear(options?: unknown) { return this.terminal('clear', options ?? {}); }
  dispatchEvent(type: string, eventInit?: unknown) {
    return this.terminal('dispatchEvent', type, eventInit ?? {});
  }
  selectOption(value: unknown, options?: unknown) { return this.terminal('selectOption', value, options ?? {}); }
  setChecked(value: boolean, options?: unknown) { return this.terminal('setChecked', value, options ?? {}); }
  setInputFiles(files: unknown, options?: unknown) {
    return this.terminal('setInputFiles', files, options ?? {});
  }
  dragTo(target: FakeLocator, options?: unknown) {
    return this.terminal('dragTo', target.recipe, options ?? {});
  }
  scrollIntoViewIfNeeded(options?: unknown) {
    return this.terminal('scrollIntoViewIfNeeded', options ?? {});
  }
  textContent(options?: unknown) { return this.terminal('textContent', options ?? {}); }
  innerText(options?: unknown) { return this.terminal('innerText', options ?? {}); }
  innerHTML(options?: unknown) { return this.terminal('innerHTML', options ?? {}); }
  inputValue(options?: unknown) { return this.terminal('inputValue', options ?? {}); }
  getAttribute(name: string, options?: unknown) {
    return this.terminal('getAttribute', name, options ?? {});
  }
  isVisible(options?: unknown) { return this.terminal('isVisible', options ?? {}); }
  isHidden(options?: unknown) { return this.terminal('isHidden', options ?? {}); }
  isEnabled(options?: unknown) { return this.terminal('isEnabled', options ?? {}); }
  isDisabled(options?: unknown) { return this.terminal('isDisabled', options ?? {}); }
  isEditable(options?: unknown) { return this.terminal('isEditable', options ?? {}); }
  isChecked(options?: unknown) { return this.terminal('isChecked', options ?? {}); }
  count() { return this.terminal('count'); }
  allInnerTexts() { return this.terminal('allInnerTexts'); }
  allTextContents() { return this.terminal('allTextContents'); }
  waitFor(options?: unknown) { return this.terminal('waitFor', options ?? {}); }

  async evaluate(
    pageFunction: (element: { tagName: string }, payload: unknown) => unknown,
    payload: unknown,
  ) {
    this.page.operations.push(...this.recipe, ['evaluate', payload]);
    return pageFunction({ tagName: 'IMG' }, payload);
  }

  async evaluateAll(
    pageFunction: (elements: { tagName: string }[], payload: unknown) => unknown,
    payload: unknown,
  ) {
    this.page.operations.push(...this.recipe, ['evaluateAll', payload]);
    return pageFunction([{ tagName: 'IMG' }, { tagName: 'SVG' }], payload);
  }
}

class FakeFrame {
  constructor(
    readonly frameName: string,
    readonly frameUrl: string,
    private readonly parentPage: FakePage,
  ) {}

  name() { return this.frameName; }
  url() { return this.frameUrl; }
  page() { return this.parentPage; }
  locator(selector: string, options?: unknown) {
    return new FakeLocator(this.parentPage, [['frame', this.frameName], ['locator', selector, options]]);
  }
  getByRole(role: string, options?: unknown) {
    return new FakeLocator(this.parentPage, [['frame', this.frameName], ['getByRole', role, options]]);
  }
  getByText(text: string, options?: unknown) {
    return new FakeLocator(this.parentPage, [['frame', this.frameName], ['getByText', text, options]]);
  }
  getByLabel(text: string, options?: unknown) {
    return new FakeLocator(this.parentPage, [['frame', this.frameName], ['getByLabel', text, options]]);
  }
  getByPlaceholder(text: string, options?: unknown) {
    return new FakeLocator(this.parentPage, [['frame', this.frameName], ['getByPlaceholder', text, options]]);
  }
  getByAltText(text: string, options?: unknown) {
    return new FakeLocator(this.parentPage, [['frame', this.frameName], ['getByAltText', text, options]]);
  }
  getByTitle(text: string, options?: unknown) {
    return new FakeLocator(this.parentPage, [['frame', this.frameName], ['getByTitle', text, options]]);
  }
  getByTestId(id: string | RegExp) {
    return new FakeLocator(this.parentPage, [['frame', this.frameName], ['getByTestId', id]]);
  }
  async evaluate(_source: unknown, payload?: { source?: string; args?: unknown[] }) {
    this.parentPage.evaluatePayload = payload;
    return 'Frame!';
  }
  async content() { return '<p>frame</p>'; }
  async waitForLoadState(state?: string, options?: unknown) {
    this.parentPage.operations.push(['frame.waitForLoadState', state, options]);
  }
  async waitForURL(url: unknown, options?: unknown) {
    this.parentPage.operations.push(['frame.waitForURL', url, options]);
  }
}

class FakePage {
  urlValue = 'https://example.test/';
  operations: Operation[] = [];
  evaluatePayload: unknown;
  readonly listeners = new Map<string, Set<(value: unknown) => void>>();
  readonly childFrame = new FakeFrame('child', 'https://frame.test/', this);
  popup?: FakePage;

  url() { return this.urlValue; }
  async title() { return 'Example'; }
  async content() { return '<main>Example</main>'; }
  async goto(url: string, options?: unknown) {
    this.operations.push(['goto', url, options]);
    this.urlValue = url;
    return null;
  }
  async reload(options?: unknown) {
    this.operations.push(['reload', options]);
    return null;
  }
  async goBack(options?: unknown) {
    this.operations.push(['goBack', options]);
    return null;
  }
  async goForward(options?: unknown) {
    this.operations.push(['goForward', options]);
    return null;
  }
  async waitForLoadState(state?: string, options?: unknown) {
    this.operations.push(['waitForLoadState', state, options]);
  }
  async waitForURL(url: unknown, options?: unknown) {
    this.operations.push(['waitForURL', url, options]);
  }
  async evaluate(_source: unknown, payload?: { source?: string; args?: unknown[] }) {
    this.evaluatePayload = payload;
    return payload?.args?.[0] === '!' ? 'Example!' : 'evaluated';
  }
  frames() { return [new FakeFrame('main', this.urlValue, this), this.childFrame]; }
  async waitForEvent(name: string, _options?: unknown) {
    if (name !== 'popup' || !this.popup) throw new Error(`No ${name}`);
    return this.popup;
  }
  on(event: string, listener: (value: unknown) => void) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }
  off(event: string, listener: (value: unknown) => void) {
    this.listeners.get(event)?.delete(listener);
  }

  locator(selector: string, options?: unknown) {
    return new FakeLocator(this, [['locator', selector, options]]);
  }
  getByRole(role: string, options?: unknown) {
    return new FakeLocator(this, [['getByRole', role, options]]);
  }
  getByText(text: string, options?: unknown) {
    return new FakeLocator(this, [['getByText', text, options]]);
  }
  getByLabel(text: string, options?: unknown) {
    return new FakeLocator(this, [['getByLabel', text, options]]);
  }
  getByPlaceholder(text: string, options?: unknown) {
    return new FakeLocator(this, [['getByPlaceholder', text, options]]);
  }
  getByAltText(text: string, options?: unknown) {
    return new FakeLocator(this, [['getByAltText', text, options]]);
  }
  getByTitle(text: string, options?: unknown) {
    return new FakeLocator(this, [['getByTitle', text, options]]);
  }
  getByTestId(id: string | RegExp) {
    return new FakeLocator(this, [['getByTestId', id]]);
  }
}

const hosts = new Set<QuickJSHost>();

async function runInSandbox(page: FakePage, source: string): Promise<unknown> {
  const bridge = new BrowserRunBridge({
    page: page as never,
    pageId: 'page-1',
  });
  const host = await QuickJSHost.create({
    onHostCall: (operation, args) => bridge.dispatch(operation, args),
  });
  hosts.add(host);
  await initializeBrowserRunSandboxClient(host);
  return host.executeScript(`(async () => { ${source} })()`, {
    filename: 'user-script.js',
  });
}

afterEach(() => {
  for (const host of hosts) host.dispose();
  hosts.clear();
});

describe('browser-run Playwright surface', () => {
  it('replays semantic locator chains and actions on the selected page', async () => {
    const page = new FakePage();
    const result = await runInSandbox(page, `
      const page = await browser.getPage("main");
      const save = page.getByRole("button", { name: "Save" }).first();
      await save.click();
      return { text: await save.innerText(), url: page.url() };
    `);

    expect(result).toEqual({
      text: 'Save',
      url: 'https://example.test/saved',
    });
    expect(page.operations).toEqual([
      ['getByRole', 'button', { name: 'Save' }],
      ['first'],
      ['click', {}],
      ['getByRole', 'button', { name: 'Save' }],
      ['first'],
      ['innerText', {}],
    ]);
  });

  it('supports navigation, page reads, waits, and page-context evaluation', async () => {
    const page = new FakePage();
    const result = await runInSandbox(page, `
      const page = await browser.currentPage();
      await page.goto("https://example.test/next", { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("load");
      await page.waitForURL(/\\/next$/);
      const evaluated = await page.evaluate((value) => document.title + value, "!");
      return {
        url: page.url(),
        title: await page.title(),
        content: await page.content(),
        evaluated
      };
    `);

    expect(result).toEqual({
      url: 'https://example.test/next',
      title: 'Example',
      content: '<main>Example</main>',
      evaluated: 'Example!',
    });
    expect(page.evaluatePayload).toMatchObject({
      args: ['!'],
    });
    expect((page.evaluatePayload as { source: string }).source)
      .toContain('document.title');
    expect(page.operations).toEqual([
      ['goto', 'https://example.test/next', { waitUntil: 'domcontentloaded' }],
      ['waitForLoadState', 'load', {}],
      ['waitForURL', /\/next$/, {}],
    ]);
  });

  it('exposes the selected page as a global', async () => {
    const page = new FakePage();

    await expect(runInSandbox(page, `
      return await globalThis.page.title();
    `)).resolves.toBe('Example');
  });

  it('uploads an in-memory file through the sandbox bridge', async () => {
    const page = new FakePage();
    const result = await runInSandbox(page, `
      const buffer = Buffer.from("Wufoo π document");
      await page.locator("#file").setInputFiles({
        name: "document.txt",
        mimeType: "text/plain",
        buffer
      });
      return {
        isBuffer: Buffer.isBuffer(buffer),
        text: buffer.toString(),
        base64: buffer.toString("base64")
      };
    `);

    expect(result).toEqual({
      isBuffer: true,
      text: 'Wufoo π document',
      base64: Buffer.from('Wufoo π document').toString('base64'),
    });
    expect(page.operations).toEqual([
      ['locator', '#file', undefined],
      ['setInputFiles', {
        name: 'document.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Wufoo π document'),
      }, {}],
    ]);
  });

  it('rejects host file paths in browser run', async () => {
    const page = new FakePage();

    await expect(runInSandbox(page, `
      await page.locator("#file").setInputFiles("/etc/passwd");
    `)).rejects.toMatchObject({
      code: 'BROWSER_RUN_INVALID_INPUT',
    });
  });

  it('rejects more than eight in-memory files', async () => {
    const page = new FakePage();

    await expect(runInSandbox(page, `
      const files = Array.from({ length: 9 }, (_, index) => ({
        name: "file-" + index + ".txt",
        mimeType: "text/plain",
        buffer: Buffer.from("x")
      }));
      await page.locator("#file").setInputFiles(files);
    `)).rejects.toMatchObject({
      code: 'BROWSER_RUN_INVALID_INPUT',
    });
  });

  it('supports page.waitForTimeout inside the sandbox', async () => {
    const page = new FakePage();
    const elapsed = await runInSandbox(page, `
      const page = await browser.currentPage();
      const started = Date.now();
      await page.waitForTimeout(10);
      return Date.now() - started;
    `);

    expect(elapsed).toBeGreaterThanOrEqual(5);
  });

  it('supports the initial locator action and read matrix', async () => {
    const page = new FakePage();
    const result = await runInSandbox(page, `
      const page = await browser.currentPage();
      const field = page.locator("input").nth(1);
      await field.focus();
      await field.fill("draft");
      await field.press("Enter");
      await field.type("!");
      await field.hover();
      await field.dblclick();
      await field.setChecked(true);
      await field.scrollIntoViewIfNeeded();
      await field.waitFor({ state: "visible" });
      const target = page.getByText("Drop");
      await field.dragTo(target);
      return {
        text: await field.textContent(),
        inner: await field.innerText(),
        value: await field.inputValue(),
        role: await field.getAttribute("role"),
        visible: await field.isVisible(),
        enabled: await field.isEnabled(),
        checked: await field.isChecked(),
        count: await field.count(),
        all: await field.allTextContents(),
        selected: await page.getByLabel("Status").selectOption("published")
      };
    `);

    expect(result).toEqual({
      text: 'Save',
      inner: 'Save',
      value: 'draft',
      role: 'button',
      visible: true,
      enabled: true,
      checked: false,
      count: 2,
      all: ['Save', 'Cancel'],
      selected: ['published'],
    });
    expect(page.operations).toContainEqual(['fill', 'draft', {}]);
    expect(page.operations).toContainEqual(['dragTo', [
      ['getByText', 'Drop', undefined],
    ], {}]);
  });

  it('supports high-frequency locator evaluation, roots, reads, and interactions', async () => {
    const page = new FakePage();
    const result = await runInSandbox(page, `
      const images = page.getByAltText("Example");
      const links = page.getByTitle("Details");
      await links.clear();
      await links.dispatchEvent("input", { bubbles: true });
      return {
        one: await images.evaluate(
          (element, suffix) => element.tagName + suffix,
          "!"
        ),
        many: await images.evaluateAll(
          (elements, prefix) => elements.map(element => prefix + element.tagName),
          "#"
        ),
        html: await links.innerHTML(),
        texts: await links.allInnerTexts(),
        hidden: await links.isHidden(),
        disabled: await links.isDisabled(),
        editable: await links.isEditable()
      };
    `);

    expect(result).toEqual({
      one: 'IMG!',
      many: ['#IMG', '#SVG'],
      html: '<strong>Save</strong>',
      texts: ['Save', 'Cancel'],
      hidden: false,
      disabled: false,
      editable: true,
    });
    expect(page.operations).toContainEqual([
      'getByTitle',
      'Details',
      undefined,
    ]);
    expect(page.operations).toContainEqual([
      'dispatchEvent',
      'input',
      { bubbles: true },
    ]);
    const evaluate = page.operations.find(operation => operation[0] === 'evaluate');
    expect(evaluate?.[1]).toMatchObject({
      source: expect.stringContaining('element.tagName'),
      args: ['!'],
    });
    const evaluateAll = page.operations.find(
      operation => operation[0] === 'evaluateAll',
    );
    expect(evaluateAll?.[1]).toMatchObject({
      source: expect.stringContaining('elements.map'),
      args: ['#'],
    });
  });

  it('supports scalar and same-origin locator filters plus all()', async () => {
    const page = new FakePage();
    const result = await runInSandbox(page, `
      const row = page.getByRole("row").filter({
        hasText: "Ready",
        has: page.getByRole("button", { name: "Open" })
      });
      const items = await row.all();
      await items[1].click();
      return {
        count: items.length,
        awaitedLocatorIsSame: (await items[0]) === items[0]
      };
    `);

    expect(result).toEqual({
      count: 2,
      awaitedLocatorIsSame: true,
    });
    const filterStep = [
      'filter',
      {
        hasText: 'Ready',
        has: [['getByRole', 'button', { name: 'Open' }]],
        hasNot: undefined,
      },
    ];
    expect(page.operations).toEqual([
      ['getByRole', 'row', undefined],
      filterStep,
      ['count'],
      ['getByRole', 'row', undefined],
      filterStep,
      ['nth', 1],
      ['click', {}],
    ]);
  });

  it('rejects invalid and cross-origin locator filters', async () => {
    const page = new FakePage();

    await expect(runInSandbox(page, `
      page.locator("main").filter(null);
    `)).rejects.toThrow('requires an options object');

    await expect(runInSandbox(page, `
      page.locator("main").filter({
        has: page.frames()[1].locator("button")
      });
    `)).rejects.toThrow('same page or frame');
  });

  it('waits for page and frame selectors and returns usable locators', async () => {
    const page = new FakePage();
    const result = await runInSandbox(page, `
      const ready = await page.waitForSelector("#ready", { state: "visible" });
      const frameReady = await page.frames()[1].waitForSelector(".ready");
      return {
        pageReady: await ready.isVisible(),
        frameReady: await frameReady.isVisible()
      };
    `);

    expect(result).toEqual({
      pageReady: true,
      frameReady: true,
    });
    expect(page.operations).toEqual([
      ['locator', '#ready', undefined],
      ['waitFor', { state: 'visible' }],
      ['frame', 'child'],
      ['locator', '.ready', undefined],
      ['waitFor', {}],
      ['locator', '#ready', undefined],
      ['isVisible', {}],
      ['frame', 'child'],
      ['locator', '.ready', undefined],
      ['isVisible', {}],
    ]);
  });

  it('supports Playwright check and uncheck locator aliases', async () => {
    const page = new FakePage();

    await runInSandbox(page, `
      const consent = page.getByLabel("Email");
      await consent.check({ force: true });
      await consent.uncheck({ timeout: 250 });
    `);

    expect(page.operations).toEqual([
      ['getByLabel', 'Email', undefined],
      ['setChecked', true, { force: true }],
      ['getByLabel', 'Email', undefined],
      ['setChecked', false, { timeout: 250 }],
    ]);
  });

  it('exposes frames synchronously and returns popups as run-owned pages', async () => {
    const page = new FakePage();
    page.popup = new FakePage();
    page.popup.urlValue = 'https://popup.test/';

    const result = await runInSandbox(page, `
      const page = await browser.currentPage();
      const frames = page.frames();
      const popup = await page.waitForEvent("popup");
      return {
        frameName: frames[1].name(),
        frameUrl: frames[1].url(),
        frameValue: await frames[1].evaluate(() => document.title),
        frameAlt: await frames[1].getByAltText("Diagram").innerText(),
        frameTitle: await frames[1].getByTitle("Details").innerText(),
        popupUrl: popup.url(),
        pageCount: (await browser.pages()).length
      };
    `);

    expect(result).toEqual({
      frameName: 'child',
      frameUrl: 'https://frame.test/',
      frameValue: 'Frame!',
      frameAlt: 'Save',
      frameTitle: 'Save',
      popupUrl: 'https://popup.test/',
      pageCount: 2,
    });
  });

  it('returns a typed correction for denied context and browser ownership APIs', async () => {
    const page = new FakePage();

    await expect(runInSandbox(page, `
      const page = await browser.currentPage();
      return page.context();
    `)).rejects.toMatchObject({
      code: 'BROWSER_RUN_API_UNSUPPORTED',
    });
  });

  it('names unknown page, frame, and locator methods', async () => {
    const page = new FakePage();

    await expect(runInSandbox(page, `
      await page.locator("img").methodThatDoesNotExist();
    `)).rejects.toMatchObject({
      code: 'BROWSER_RUN_API_UNSUPPORTED',
      message: expect.stringContaining('locator.methodThatDoesNotExist'),
    });

    await expect(runInSandbox(page, `
      await page.methodThatDoesNotExist();
    `)).rejects.toMatchObject({
      code: 'BROWSER_RUN_API_UNSUPPORTED',
      message: expect.stringContaining('page.methodThatDoesNotExist'),
    });

    await expect(runInSandbox(page, `
      const frame = page.frames()[1];
      await frame.methodThatDoesNotExist();
    `)).rejects.toMatchObject({
      code: 'BROWSER_RUN_API_UNSUPPORTED',
      message: expect.stringContaining('frame.methodThatDoesNotExist'),
    });
  });

  it('does not make guarded browser surfaces thenable', async () => {
    const page = new FakePage();

    await expect(runInSandbox(page, `
      const locator = page.locator("img");
      return {
        pageThen: page.then,
        locatorThen: locator.then,
        awaitedPageIsSame: (await page) === page,
        awaitedLocatorIsSame: (await locator) === locator
      };
    `)).resolves.toEqual({
      awaitedPageIsSame: true,
      awaitedLocatorIsSame: true,
    });
  });

  it('preserves the guarded page through fluent network listener methods', async () => {
    const page = new FakePage();
    const result = await runInSandbox(page, `
      const listener = () => {};
      const fromOn = page.on("request", listener);
      const fromOff = fromOn.off("request", listener);
      return {
        onSame: fromOn === page,
        offSame: fromOff === page
      };
    `);

    expect(result).toEqual({
      onSame: true,
      offSame: true,
    });

    await expect(runInSandbox(page, `
      const fluentPage = page.off("request", () => {});
      await fluentPage.methodThatDoesNotExist();
    `)).rejects.toMatchObject({
      code: 'BROWSER_RUN_API_UNSUPPORTED',
      message: expect.stringContaining('page.methodThatDoesNotExist'),
    });
  });
});
