# Background Browser Window Default Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every browser-backed Webcmd command use background window mode unless the user explicitly requests foreground mode.

**Architecture:** Collapse window-mode resolution to one precedence rule in each existing execution surface: CLI flag, then `WEBCMD_WINDOW`, then `background`. Remove per-command `defaultWindowMode` metadata so adapters cannot bypass the global rule; keep the browser launcher and session runtime unchanged.

**Tech Stack:** TypeScript, JavaScript adapters, Commander, Vitest, generated JSON manifest, Markdown skills/docs.

## Global Constraints

- Window mode precedence is `--window foreground|background`, then `WEBCMD_WINDOW=foreground|background`, then `background`.
- The rule applies to adapter commands and direct `webcmd browser` commands, including login and checkout.
- Foreground behavior must be explicitly requested; commands cannot declare their own foreground default.
- Background remains headed and non-focusing; do not change launcher or session-runtime behavior.
- Keep existing invalid-value errors for the flag and environment variable.
- Add no dependency or new configuration layer.
- Run build and tests serially because `npm run build` cleans `dist`.

---

### Task 1: Enforce the global background fallback

**Files:**
- Modify: `src/cli.ts:615-659`
- Modify: `src/cli.ts:1052-1118`
- Modify: `src/execution.ts:214-221`
- Modify: `src/execution.ts:531-540`
- Test: `src/cli.test.ts:1249-1335`
- Test: `src/cli.test.ts:1425-1435`
- Test: `src/execution.test.ts:993-1045`

**Interfaces:**
- Consumes: `--window`, `WEBCMD_WINDOW`, `BrowserWindowMode`, `BrowserBridge.connect()`, and `browserSession()`.
- Produces: `getBrowserWindowMode(command?: Command): BrowserWindowMode` and `resolveBrowserWindowMode(rawOption?: unknown): BrowserWindowMode`, both with the same precedence and `background` fallback.

- [ ] **Step 1: Write failing direct-browser tests**

Update the browser tab-targeting tests so no flag expects background, an
explicit flag selects foreground, the environment selects foreground, and the
CLI flag wins over the environment:

```ts
it('defaults direct browser commands to background window mode', async () => {
  const program = createProgram('', '');

  await program.parseAsync(['node', 'webcmd', 'browser', '--session', 'test', 'state']);

  expect(mockBrowserConnect).toHaveBeenCalledWith({
    timeout: 45,
    session: 'test',
    surface: 'browser',
    windowMode: 'background',
  });
});

it('uses WEBCMD_WINDOW as an explicit direct-browser override', async () => {
  process.env.WEBCMD_WINDOW = 'foreground';
  const program = createProgram('', '');

  await program.parseAsync(['node', 'webcmd', 'browser', '--session', 'test', 'state']);

  expect(mockBrowserConnect).toHaveBeenCalledWith({
    timeout: 45,
    session: 'test',
    surface: 'browser',
    windowMode: 'foreground',
  });
});

it('uses the direct-browser CLI flag before WEBCMD_WINDOW', async () => {
  process.env.WEBCMD_WINDOW = 'foreground';
  const program = createProgram('', '');

  await program.parseAsync([
    'node', 'webcmd', 'browser', '--session', 'test',
    '--window', 'background', 'state',
  ]);

  expect(mockBrowserConnect).toHaveBeenCalledWith({
    timeout: 45,
    session: 'test',
    surface: 'browser',
    windowMode: 'background',
  });
});

it('rejects an invalid direct-browser --window value', async () => {
  const program = createProgram('', '');

  await program.parseAsync([
    'node', 'webcmd', 'browser', '--session', 'test',
    '--window', 'sideways', 'state',
  ]);

  expect(stderrSpy.mock.calls.flat().join('')).toContain(
    '--window must be one of: foreground, background. Received: "sideways"',
  );
  expect(process.exitCode).toBeDefined();
});

it('rejects an invalid direct-browser WEBCMD_WINDOW value', async () => {
  process.env.WEBCMD_WINDOW = 'sideways';
  const program = createProgram('', '');

  await program.parseAsync(['node', 'webcmd', 'browser', '--session', 'test', 'state']);

  expect(stderrSpy.mock.calls.flat().join('')).toContain(
    'WEBCMD_WINDOW must be one of: foreground, background. Received: "sideways"',
  );
  expect(process.exitCode).toBeDefined();
});
```

Change the existing page-id bind and unbind expectations from `foreground` to
`background`. Keep one bind-by-index test explicitly foreground by adding
`'--window', 'foreground'` to its argv and retaining its foreground
expectations.

- [ ] **Step 2: Write failing adapter-resolution tests**

Replace the `uses command defaultWindowMode` test with an environment override
test, and make the existing explicit-option test prove CLI-over-environment
precedence:

```ts
it('uses WEBCMD_WINDOW as an explicit adapter override', async () => {
  vi.stubEnv('WEBCMD_WINDOW', 'foreground');
  const mockPage = { closeWindow: vi.fn().mockResolvedValue(undefined) } as any;
  const sessionOpts: Array<{ windowMode?: string }> = [];
  vi.spyOn(capRouting, 'shouldUseBrowserSession').mockReturnValue(true);
  vi.spyOn(runtime, 'browserSession').mockImplementation(async (_Factory, fn, opts) => {
    sessionOpts.push(opts ?? {});
    return fn(mockPage);
  });
  const cmd = cli({
    site: 'test-execution',
    name: 'browser-env-window-mode',
    access: 'read',
    description: 'test browser environment window mode',
    browser: true,
    strategy: Strategy.PUBLIC,
    func: async () => [{ ok: true }],
  });

  try {
    await executeCommand(cmd, {});
    expect(sessionOpts[0]).toMatchObject({ windowMode: 'foreground' });
  } finally {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  }
});
```

In `lets browser common options override adapter window and keep-tab defaults`,
stub `WEBCMD_WINDOW=background`, retain `windowMode: 'foreground'` in the
explicit options, and unstub the environment in the existing cleanup.

Add invalid-value coverage using the same minimal browser command:

```ts
await expect(executeCommand(cmd, {}, false, {
  windowMode: 'sideways',
})).rejects.toThrow(
  '--window must be one of: foreground, background. Received: "sideways"',
);

vi.stubEnv('WEBCMD_WINDOW', 'sideways');
await expect(executeCommand(cmd, {})).rejects.toThrow(
  'WEBCMD_WINDOW must be one of: foreground, background. Received: "sideways"',
);
vi.unstubAllEnvs();
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
npx vitest run --project unit src/cli.test.ts -t "window|binds an existing|unbinds a session"
npx vitest run --project unit src/execution.test.ts -t "window"
```

Expected: direct browser tests fail because current fallback is foreground;
the adapter tests lock the already-supported explicit overrides and errors
while the fallback changes.

- [ ] **Step 4: Implement the fixed precedence**

In `src/cli.ts`, remove the configurable default parameter:

```ts
function getBrowserWindowMode(command?: Command): BrowserWindowMode {
  const optionRaw = getCommandOption(command, 'window');
  if (optionRaw !== undefined && optionRaw !== '') {
    if (optionRaw === 'foreground' || optionRaw === 'background') return optionRaw;
    throw new Error(`--window must be one of: foreground, background. Received: "${String(optionRaw)}"`);
  }
  const envRaw = process.env.WEBCMD_WINDOW;
  if (envRaw !== undefined && envRaw !== '') {
    if (envRaw === 'foreground' || envRaw === 'background') return envRaw;
    throw new Error(`WEBCMD_WINDOW must be one of: foreground, background. Received: "${envRaw}"`);
  }
  return 'background';
}
```

Update all three call sites to call `getBrowserWindowMode(...)` without
`'foreground'`:

```ts
windowMode: opts.windowMode ?? getBrowserWindowMode(),
```

```ts
const windowMode = getBrowserWindowMode(command);
```

In `src/execution.ts`, stop passing command metadata into resolution:

```ts
const windowMode = resolveBrowserWindowMode(opts.windowMode);
```

```ts
function resolveBrowserWindowMode(rawOption?: unknown): BrowserWindowMode {
  return normalizeWindowMode('--window', rawOption)
    ?? normalizeWindowMode('WEBCMD_WINDOW', process.env.WEBCMD_WINDOW)
    ?? 'background';
}
```

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npx vitest run --project unit src/cli.test.ts -t "window|binds an existing|unbinds a session"
npx vitest run --project unit src/execution.test.ts -t "window"
npm run typecheck
```

Expected: all commands exit 0; direct browser and adapter calls share the
approved precedence.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts src/cli.test.ts src/execution.ts src/execution.test.ts
git commit -m "feat: default browser windows to background"
```

---

### Task 2: Remove per-command window defaults

**Files:**
- Modify: `src/registry.ts:83-85,154-164`
- Modify: `src/manifest-types.ts:43-48`
- Modify: `src/build-manifest.ts:126-139`
- Modify: `src/discovery.ts:205-222`
- Modify: `src/hosted/client.ts:420-436`
- Modify: `src/commands/auth.ts:153-164,230-241`
- Test: `src/build-manifest.test.ts:480-500`
- Test: `src/commands/auth.test.ts:60-75,135-152`
- Modify: `clis/_shared/site-auth.js:82-95`
- Test: `clis/_shared/site-auth.test.js:13-42`
- Modify: `clis/amazon-in/checkout.js:379`
- Modify: `clis/blinkit/checkout.js:13`
- Modify: `clis/blinkit/place-order.js:38`
- Modify: `clis/district/checkout.js:267`
- Modify: `clis/district/seats.js:143`
- Modify: `clis/district/set-location.js:35`
- Modify: `clis/district/showtimes.js:354`
- Modify: `clis/mercury/check-login.js:14`
- Modify: `clis/mercury/reimbursement-draft.js:26`
- Modify: `clis/practo/book-confirm.js:14`
- Modify: `clis/practo/cancel.js:14`
- Regenerate: `cli-manifest.json`

**Interfaces:**
- Consumes: `CliOptions`, `CliCommand`, `ManifestEntry`, local manifest discovery, and hosted manifest validation.
- Produces: command and manifest schemas with no `defaultWindowMode` property.

- [ ] **Step 1: Add a failing manifest invariant test**

Add beside the local handoff manifest contract in
`src/build-manifest.test.ts`:

```ts
it('does not publish per-command browser window defaults', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'cli-manifest.json'), 'utf8'),
  ) as ManifestEntry[];

  expect(
    manifest.filter((entry) => Object.hasOwn(entry, 'defaultWindowMode')),
  ).toEqual([]);
});
```

- [ ] **Step 2: Run the invariant test and verify RED**

Run:

```bash
npx vitest run --project unit src/build-manifest.test.ts -t "browser window defaults"
```

Expected: FAIL and print the manifest entries that still publish
`defaultWindowMode`.

- [ ] **Step 3: Remove the metadata from core schemas and loaders**

Delete `defaultWindowMode` from:

```ts
// src/registry.ts
BaseCliCommand
cli() command normalization

// src/manifest-types.ts
ManifestEntry

// src/build-manifest.ts
the object returned for each manifest entry

// src/discovery.ts
the lazy InternalCliCommand mapping

// src/hosted/client.ts
the accepted hosted manifest keys and string-field validation list
```

After Task 1, no resolver consumes this property, so do not replace it with
another command-level setting.

- [ ] **Step 4: Remove all command declarations and test expectations**

Delete each `defaultWindowMode` line from the adapter and auth files listed in
this task. Update auth tests to assert only behavior that remains:

```ts
expect(executeCommandMock.mock.calls[0]?.[0]).toMatchObject({
  site: 'alpha',
  name: 'whoami',
  navigateBefore: false,
  siteSession: 'ephemeral',
});
```

```ts
expect(login).toMatchObject({
  access: 'write',
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
});
```

Do not add `windowMode: 'background'` to individual commands. The global
resolver owns the default.

- [ ] **Step 5: Regenerate the manifest**

Run:

```bash
npm run build-manifest
```

Expected: exits 0 and removes every generated `defaultWindowMode` property
from `cli-manifest.json`.

- [ ] **Step 6: Verify metadata removal**

Run:

```bash
rg -n "defaultWindowMode" src clis cli-manifest.json
npx vitest run --project unit src/build-manifest.test.ts src/commands/auth.test.ts
npx vitest run --project adapter clis/_shared/site-auth.test.js
npm run typecheck
```

Expected: `rg` prints nothing; tests and typecheck exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/registry.ts src/manifest-types.ts src/build-manifest.ts \
  src/build-manifest.test.ts src/discovery.ts src/hosted/client.ts \
  src/commands/auth.ts src/commands/auth.test.ts clis cli-manifest.json
git commit -m "refactor: remove command window defaults"
```

---

### Task 3: Explain the new default and verify the complete change

**Files:**
- Modify: `src/cli.ts:951-960`
- Test: `src/cli.test.ts:580-615`
- Modify: `src/command-surface.ts:73-82`
- Test: `src/command-surface.test.ts:155-180`
- Modify: `docs/troubleshooting.mdx:104-112`
- Modify: `skills/webcmd-usage/SKILL.md:101-110`
- Modify: `skills/webcmd-browser/SKILL.md:40-46`

**Interfaces:**
- Consumes: Commander help metadata and bundled Webcmd skill guidance.
- Produces: help and documentation that state background is the default and show `--window foreground` as the explicit visibility opt-in.

- [ ] **Step 1: Write failing help-contract tests**

Extend the browser structured-help assertion in `src/cli.test.ts`:

```ts
expect(data.namespace_options).toEqual(expect.arrayContaining([
  expect.objectContaining({
    name: 'window',
    flags: '--window <mode>',
    help: 'Browser window mode: foreground or background (default: background)',
    takes_value: 'required',
  }),
]));
```

Extend `configureCommandSurface` coverage in
`src/command-surface.test.ts`:

```ts
if (browser) {
  expect(command.options.find((option) => option.long === '--window')?.description)
    .toBe('Browser window mode: foreground or background (default: background)');
}
```

- [ ] **Step 2: Run help-contract tests and verify RED**

Run:

```bash
npx vitest run --project unit src/cli.test.ts -t "browser namespace structured help"
npx vitest run --project unit src/command-surface.test.ts -t "registers browser globals"
```

Expected: both fail because current help omits the default.

- [ ] **Step 3: Update help and examples**

Use the same wording on both CLI surfaces:

```ts
'Browser window mode: foreground or background (default: background)'
```

In the direct-browser help examples, replace the redundant background example:

```text
$ webcmd browser work open https://x.com --window foreground
```

- [ ] **Step 4: Update bundled guidance**

Make the environment table and browser skill explicit:

```markdown
| `WEBCMD_WINDOW` | `background` | Explicitly override browser window mode with `foreground` or `background`. |
```

```markdown
- Browser commands default to background mode.
- Pass `--window foreground` (or set `WEBCMD_WINDOW=foreground`) when the user must see or interact with the browser.
```

In `docs/troubleshooting.mdx`, describe `WEBCMD_WINDOW` as an optional override
and state that the default is `background`. Keep the existing adapter-author
instructions that already pass `--window foreground` during visual debugging.

- [ ] **Step 5: Run focused help and smoke checks**

Run:

```bash
npx vitest run --project unit src/cli.test.ts -t "browser namespace structured help"
npx vitest run --project unit src/command-surface.test.ts -t "registers browser globals"
npm run dev -- browser --help
npm run dev -- twitter whoami --help
```

Expected: tests exit 0; both help outputs state `default: background`; the
browser example uses `--window foreground`.

- [ ] **Step 6: Run the full verification gate serially**

Run, one command at a time:

```bash
npm run typecheck
npm run build
npm run check:hosted-contract
npm test
```

Expected: every command exits 0. Do not overlap build and tests.

- [ ] **Step 7: Inspect the final diff**

Run:

```bash
git diff --check
git diff --stat HEAD~2
rg -n "defaultWindowMode" src clis cli-manifest.json
```

Expected: no whitespace errors, only the planned files changed, and `rg`
prints nothing.

- [ ] **Step 8: Commit**

```bash
git add src/cli.ts src/cli.test.ts src/command-surface.ts \
  src/command-surface.test.ts docs/troubleshooting.mdx \
  skills/webcmd-usage/SKILL.md skills/webcmd-browser/SKILL.md
git commit -m "docs: explain background window default"
```
