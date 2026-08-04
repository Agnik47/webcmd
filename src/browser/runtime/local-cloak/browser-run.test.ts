import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { dispatchCloakAction } from './actions.js';
import { CloakSessionManager, type LaunchPersistentContext } from './session-manager.js';

let browser: Browser;
let context: BrowserContext;
let initialPage: Page;
let manager: CloakSessionManager;
let launchPersistentContext: ReturnType<typeof vi.fn<LaunchPersistentContext>>;

const command = (id: string, action: 'run' | 'tabs' | 'bind' | 'close-window', extra: Record<string, unknown> = {}) => ({
  id,
  action,
  profileId: 'default',
  session: 'work',
  surface: 'browser' as const,
  ...extra,
});

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

beforeEach(async () => {
  context = await browser.newContext();
  initialPage = await context.newPage();
  launchPersistentContext = vi.fn<LaunchPersistentContext>().mockResolvedValue(context);
  manager = new CloakSessionManager({
    baseDir: '/tmp/webcmd-browser-run-test',
    launchPersistentContext,
  });
});

afterEach(async () => {
  await context.close();
});

afterAll(async () => {
  await browser.close();
});

describe('local Cloak browser run', () => {
  it('reuses the lease and keeps page state without keeping sandbox variables', async () => {
    const first = await dispatchCloakAction(manager, command('run-1', 'run', {
      source: `
        globalThis.onlyThisRun = 'gone';
        await page.setContent('<p id="state">persisted</p>');
        return await page.locator('#state').innerText();
      `,
      snapshotDiff: true,
    }));
    const second = await dispatchCloakAction(manager, command('run-2', 'run', {
      source: `
        return {
          state: await page.locator('#state').innerText(),
          variable: typeof globalThis.onlyThisRun,
        };
      `,
    }));

    expect(first).toMatchObject({ ok: true, data: { result: 'persisted' } });
    expect(first.page).toBeDefined();
    expect(first.data).toMatchObject({
      timings: {
        quickjs_boot_ms: expect.any(Number),
        client_bundle_init_ms: expect.any(Number),
        program_ms: expect.any(Number),
        browser_wait_ms: expect.any(Number),
        snapshot_ms: expect.any(Number),
      },
    });
    expect(Object.values((first.data as { timings: Record<string, number> }).timings)
      .every(value => value >= 0)).toBe(true);
    expect(second).toMatchObject({
      ok: true,
      page: first.page,
      data: { result: { state: 'persisted', variable: 'undefined' } },
    });
    expect(launchPersistentContext).toHaveBeenCalledTimes(1);
    expect(initialPage.isClosed()).toBe(false);
  });

  it('lists without creating a runtime', async () => {
    const unstartedLaunch = vi.fn();
    const unstarted = new CloakSessionManager({
      baseDir: '/tmp/webcmd-browser-run-test-unstarted',
      launchPersistentContext: unstartedLaunch,
    });

    await expect(dispatchCloakAction(unstarted, command('tabs', 'tabs', { op: 'list' })))
      .resolves.toMatchObject({ ok: true, data: [] });
    expect(unstartedLaunch).not.toHaveBeenCalled();
  });

  it('binds a session to the requested page and releases every page in that session', async () => {
    const original = await dispatchCloakAction(manager, command('run-original', 'run', {
      source: "await page.setContent('<p>original</p>'); return 'original';",
    }));
    const created = await dispatchCloakAction(manager, command('new-tab', 'tabs', {
      op: 'new',
      session: 'manual',
    }));
    const boundPage = context.pages().find(page => page !== initialPage)!;
    await boundPage.setContent('<p>bound</p>');
    const bound = await dispatchCloakAction(manager, command('bind', 'bind', { page: created.page }));
    const rerun = await dispatchCloakAction(manager, command('run-bound', 'run', {
      source: 'return await page.locator("p").innerText();',
    }));
    const closed = await dispatchCloakAction(manager, command('close', 'close-window'));
    const tabs = await dispatchCloakAction(manager, command('tabs-after-close', 'tabs', { op: 'list' }));

    expect(original).toMatchObject({ ok: true, page: expect.any(String) });
    expect(bound).toMatchObject({ ok: true, page: created.page });
    expect(rerun).toMatchObject({ ok: true, page: created.page, data: { result: 'bound' } });
    expect(closed).toMatchObject({ ok: true, data: { closed: true } });
    expect(tabs).toMatchObject({ ok: true, data: [] });
  });
});
