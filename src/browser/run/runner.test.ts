import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserRunArtifactWriter } from './artifacts.js';
import { BrowserRunObservationStore } from './observation.js';
import { runBrowserProgram } from './runner.js';

class FakeRunPage {
  urlValue = 'https://example.test/';
  snapshot = 'button "Save"';
  screenshotBytes = Buffer.from([1, 2, 3]);
  locatorScreenshotOptions: unknown;
  closed = false;

  url() { return this.urlValue; }
  async title() { return 'Example'; }
  frames() { return []; }
  async goto(url: string) { this.urlValue = url; }
  async close() { this.closed = true; }
  isClosed() { return this.closed; }
  async waitForEvent(): Promise<unknown> {
    throw new Error('No popup configured');
  }
  async evaluate(source: unknown) {
    if (typeof source === 'string' && source.includes('__webcmd_prev_hashes')) {
      return this.snapshot;
    }
    return null;
  }
  locator() {
    return {
      screenshot: async (options: unknown) => {
        this.locatorScreenshotOptions = options;
        return Buffer.from([4, 5, 6]);
      },
      evaluate: async (
        pageFunction: (element: unknown, payload: unknown) => unknown,
        payload: unknown,
      ) => pageFunction({ tagName: 'MAIN' }, payload),
      evaluateAll: async (
        pageFunction: (elements: unknown[], payload: unknown) => unknown,
        payload: unknown,
      ) => pageFunction([{ tagName: 'MAIN' }], payload),
    };
  }
  async screenshot() { return this.screenshotBytes; }
}

const tempDirs: string[] = [];

async function outcomeWithin(
  promise: Promise<unknown>,
  timeoutMs = 250,
): Promise<
  | { status: 'resolved' }
  | { status: 'rejected'; error: unknown }
  | { status: 'hung' }
> {
  return Promise.race([
    promise.then(
      () => ({ status: 'resolved' as const }),
      error => ({ status: 'rejected' as const, error }),
    ),
    new Promise<{ status: 'hung' }>(resolve => (
      setTimeout(() => resolve({ status: 'hung' }), timeoutMs)
    )),
  ]);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('runBrowserProgram', () => {
  it('publishes the browser-run package subpath', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { exports?: Record<string, string> };

    expect(packageJson.exports?.['./browser/run'])
      .toBe('./dist/src/browser/run/index.js');
  });

  it('returns result, logs, final page metadata, and the first full observation', async () => {
    const page = new FakeRunPage();
    const output = await runBrowserProgram({
      page: page as never,
      pageId: 'page-1',
      observationStore: new BrowserRunObservationStore(),
    }, `
      const page = await browser.currentPage();
      console.log("ready");
      return { title: await page.title() };
    `);

    expect(output).toEqual({
      ok: true,
      result: { title: 'Example' },
      logs: [{ level: 'log', args: ['ready'] }],
      page: {
        id: 'page-1',
        url: 'https://example.test/',
        title: 'Example',
      },
      observation: {
        mode: 'full',
        content: 'button "Save"',
      },
      limits: {
        outputTruncated: false,
        observationTruncated: false,
      },
    });
  });

  it('returns a compact diff on a later run for the same document', async () => {
    const page = new FakeRunPage();
    const observationStore = new BrowserRunObservationStore();
    const input = {
      page: page as never,
      pageId: 'page-1',
      observationStore,
    };

    await runBrowserProgram(input, 'return null;');
    page.snapshot = 'button "Save"\nstatus "Saved"';
    const output = await runBrowserProgram(input, 'return null;');

    expect(output.observation).toEqual({
      mode: 'diff',
      changed: '+ status "Saved"',
    });
  });

  it('terminates infinite guest code with a typed timeout', async () => {
    const page = new FakeRunPage();
    await expect(runBrowserProgram({
      page: page as never,
      pageId: 'page-1',
    }, 'while (true) {}', {
      timeoutMs: 25,
      observe: 'none',
    })).rejects.toMatchObject({
      code: 'BROWSER_RUN_TIMEOUT',
    });
  });

  it('compiles source as a function body without allowing wrapper escape', async () => {
    const page = new FakeRunPage();

    await expect(runBrowserProgram({
      page: page as never,
      pageId: 'page-1',
    }, '})(); }); new Promise(() => {}) //', {
      timeoutMs: 25,
      observe: 'none',
    })).rejects.toMatchObject({
      code: 'BROWSER_RUN_SYNTAX_ERROR',
    });
  });

  it('returns a wall timeout without closing the selected page or awaiting its in-flight operation', async () => {
    const page = new FakeRunPage();
    page.goto = async () => await new Promise<void>(() => {});
    page.close = async () => {
      page.closed = true;
    };

    const outcome = await outcomeWithin(runBrowserProgram({
      page: page as never,
      pageId: 'page-1',
    }, `
      const page = await browser.currentPage();
      await page.goto("https://slow.example/");
    `, {
      timeoutMs: 25,
      observe: 'none',
    }));

    expect(outcome).toMatchObject({
      status: 'rejected',
      error: {
        code: 'BROWSER_RUN_TIMEOUT',
      },
    });
    expect(page.closed).toBe(false);
  });

  it('returns a wall timeout without closing or awaiting an in-flight popup', async () => {
    const page = new FakeRunPage();
    const popup = new FakeRunPage();
    page.waitForEvent = async () => popup;
    popup.goto = async () => await new Promise<void>(() => {});
    popup.close = async () => {
      popup.closed = true;
      await new Promise<void>(() => {});
    };

    const outcome = await outcomeWithin(runBrowserProgram({
      page: page as never,
      pageId: 'page-1',
      registerPage: () => 'page-popup',
    }, `
      const page = await browser.currentPage();
      const popup = await page.waitForEvent("popup");
      await popup.goto("https://slow.example/");
    `, {
      timeoutMs: 25,
      observe: 'none',
    }));

    expect(outcome).toMatchObject({
      status: 'rejected',
      error: {
      code: 'BROWSER_RUN_TIMEOUT',
      },
    });
    expect(page.closed).toBe(false);
    expect(popup.closed).toBe(false);
  });

  it('bounds console capture before logs accumulate in the host', async () => {
    const page = new FakeRunPage();
    const output = await runBrowserProgram({
      page: page as never,
      pageId: 'page-1',
    }, `
      for (let index = 0; index < 100; index += 1) {
        console.log("x".repeat(100));
      }
      return null;
    `, {
      maxOutputChars: 200,
      observe: 'none',
    });

    expect(JSON.stringify(output.logs).length).toBeLessThanOrEqual(200);
    expect(output.limits.outputTruncated).toBe(true);
  });

  it('redacts credentials from page metadata and execution errors', async () => {
    const page = new FakeRunPage();
    page.urlValue = 'https://alice:secret@example.test/path?token=secret';

    const output = await runBrowserProgram({
      page: page as never,
      pageId: 'page-1',
    }, 'return null;', {
      observe: 'none',
    });
    expect(output.page.url).toBe(
      'https://[REDACTED]@example.test/path?token=[REDACTED]',
    );

    await expect(runBrowserProgram({
      page: page as never,
      pageId: 'page-1',
    }, `
      throw new Error(
        "failed https://alice:secret@example.test/path?token=secret"
      );
    `, {
      observe: 'none',
    })).rejects.toMatchObject({
      message: expect.not.stringContaining('secret'),
    });
  });

  it('redacts credentials from the returned result', async () => {
    const page = new FakeRunPage();
    const output = await runBrowserProgram({
      page: page as never,
      pageId: 'page-1',
    }, `
      return {
        token: "secret123",
        authorization: "Bearer abc123",
        nested: { apiKey: "key456", value: "safe" }
      };
    `, {
      observe: 'none',
    });

    expect(output.result).toEqual({
      token: '[REDACTED]',
      authorization: '[REDACTED]',
      nested: {
        apiKey: '[REDACTED]',
        value: 'safe',
      },
    });
  });

  it('rejects non-serializable and oversized returned values', async () => {
    const page = new FakeRunPage();
    await expect(runBrowserProgram({
      page: page as never,
      pageId: 'page-1',
    }, 'return 1n;', {
      observe: 'none',
    })).rejects.toMatchObject({
      code: 'BROWSER_RUN_SERIALIZATION_ERROR',
    });

    await expect(runBrowserProgram({
      page: page as never,
      pageId: 'page-1',
    }, 'return "x".repeat(100);', {
      maxOutputChars: 20,
      observe: 'none',
    })).rejects.toMatchObject({
      code: 'BROWSER_RUN_OUTPUT_LIMIT',
    });
  });

  it('applies redaction and result limits to locator evaluation values', async () => {
    const page = new FakeRunPage();
    const redacted = await runBrowserProgram({
      page: page as never,
      pageId: 'page-1',
    }, `
      return await page.locator("main").evaluate(() => ({
        token: "secret123",
        authorization: "Bearer abc123",
        safe: "visible"
      }));
    `, {
      observe: 'none',
    });

    expect(redacted.result).toEqual({
      token: '[REDACTED]',
      authorization: '[REDACTED]',
      safe: 'visible',
    });

    await expect(runBrowserProgram({
      page: page as never,
      pageId: 'page-1',
    }, `
      return await page.locator("main").evaluateAll(
        () => "x".repeat(100)
      );
    `, {
      maxOutputChars: 20,
      observe: 'none',
    })).rejects.toMatchObject({
      code: 'BROWSER_RUN_OUTPUT_LIMIT',
    });

    await expect(runBrowserProgram({
      page: page as never,
      pageId: 'page-1',
    }, `
      return await page.locator("main").evaluate(() => 1n);
    `, {
      observe: 'none',
    })).rejects.toMatchObject({
      code: 'BROWSER_RUN_SERIALIZATION_ERROR',
    });
  });

  it('writes screenshot bytes under the host-selected artifact directory', async () => {
    const page = new FakeRunPage();
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webcmd-run-'));
    tempDirs.push(baseDir);
    const output = await runBrowserProgram({
      page: page as never,
      pageId: 'page-1',
      artifactWriter: new BrowserRunArtifactWriter({ baseDir }),
    }, `
      const page = await browser.currentPage();
      return await page.screenshot();
    `, {
      observe: 'none',
    });

    expect(output.result).toMatchObject({
      kind: 'screenshot',
      contentType: 'image/png',
      byteSize: 3,
    });
    const receipt = output.result as { path: string };
    expect(receipt.path.startsWith(baseDir + path.sep)).toBe(true);
    expect(fs.readFileSync(receipt.path)).toEqual(Buffer.from([1, 2, 3]));
  });

  it('writes locator screenshots without honoring agent-selected host paths', async () => {
    const page = new FakeRunPage();
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webcmd-run-'));
    const requestedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webcmd-requested-'));
    tempDirs.push(baseDir, requestedDir);
    const requestedPath = path.join(requestedDir, 'agent-selected.png');
    const output = await runBrowserProgram({
      page: page as never,
      pageId: 'page-1',
      artifactWriter: new BrowserRunArtifactWriter({ baseDir }),
    }, `
      return await page.locator("main").screenshot({
        path: ${JSON.stringify(requestedPath)}
      });
    `, {
      observe: 'none',
    });

    expect(output.result).toMatchObject({
      kind: 'screenshot',
      contentType: 'image/png',
      byteSize: 3,
    });
    const receipt = output.result as { path: string };
    expect(receipt.path.startsWith(baseDir + path.sep)).toBe(true);
    expect(fs.readFileSync(receipt.path)).toEqual(Buffer.from([4, 5, 6]));
    expect(fs.existsSync(requestedPath)).toBe(false);
    expect(page.locatorScreenshotOptions).toEqual({
      type: 'png',
      path: undefined,
    });
  });
});
