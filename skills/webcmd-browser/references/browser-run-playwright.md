# Browser Run: Sandboxed Playwright-Style Programs

Use this reference for one decision-sized, multi-step browser flow in an
existing local Webcmd session. For one known action, use the matching primitive
command. For reusable commands, switch to `webcmd-adapter-author`.

## Invocation

```bash
webcmd browser work run --file explore.js
webcmd browser work run --stdin --timeout 45 --max-output 40000 --observe diff
webcmd browser work run --file explore.js --tab page-123
```

Exactly one of `--file` or `--stdin` is required. `--timeout` is seconds.
`--observe` is `diff`, `full`, or `none`; the default is `diff`. The file is
read by the CLI. The sandbox never receives its path.

## Program Shape

The source is the body of an async function. Top-level `await` and `return`
work. The selected page is available as the immutable global `page`;
`await browser.currentPage()` returns the same restricted object:

```js
await page.goto('https://example.com/settings');
await page.getByRole('button', { name: 'Save' }).click();
return {
  url: page.url(),
  title: await page.title(),
};
```

Keep the result JSON-compatible and small. Remote browser objects, functions,
symbols, BigInt, and circular objects cannot be returned.

`console.log`, `info`, `warn`, and `error` are captured separately. Only
explicit logs and the returned value reach the agent, plus automatic final page
metadata and a bounded semantic observation.

## Program ownership

One run owns every predictable browser operation—navigation, readiness, reads,
interactions, pagination or bounded loops, reduction, verification, and an
optional sandbox screenshot—until next reasoning decision.

```js
await page.goto('https://example.com/articles');
const matches = [];
let pagesChecked = 0;
for (;;) {
  const rows = await page.locator('article').allTextContents();
  matches.push(...rows.filter(text => text.includes('target phrase')));
  pagesChecked += 1;
  const next = page.getByRole('link', { name: 'Next' });
  if (pagesChecked >= 10 || !(await next.isVisible())) {
    break;
  }
  const nextUrl = await next.evaluate(element => element.href);
  const navigation = page.waitForURL(nextUrl);
  await next.click();
  await navigation;
}
return {
  pagesChecked,
  matches: matches.slice(0, 10),
  finalUrl: page.url(),
};
```

Stop the run when its compact result is needed to choose a new strategy. Do
not stop merely because one navigation or locator operation finished.

## Getting Pages

```js
const current = await browser.currentPage();
const main = await browser.getPage('main');
const pages = await browser.pages();
```

Only the selected page and popups created during this run are visible. Opaque
handles belong to one run and expire when it ends.

## Supported Page and Locator APIs

Page methods:

- navigation: `goto`, `reload`, `goBack`, `goForward`
- reads: `url`, `title`, `content`
- waits: `waitForLoadState`, `waitForURL`, `waitForTimeout`, `waitForSelector`,
  `waitForEvent('popup')`
- page-context code: `evaluate`
- structure: `frames`
- locator roots: `locator`, `getByRole`, `getByText`, `getByLabel`,
  `getByPlaceholder`, `getByAltText`, `getByTitle`, `getByTestId`
- network: `waitForRequest`, `waitForResponse`, `on('request'|'response')`,
  `off`
- artifact: `screenshot`

Locator chaining:

- `locator`, semantic locator roots, `filter`, `first`, `last`, `nth`
- `all()` returns the current matches as locator wrappers so a dependent loop
  can remain inside the run

Locator actions:

- `click`, `dblclick`, `hover`, `focus`
- `fill`, `clear`, `press`, `type`, `selectOption`, `check`, `uncheck`,
  `setChecked`, `setInputFiles`
- `dispatchEvent`, `dragTo`, `scrollIntoViewIfNeeded`, `waitFor`
- `screenshot`

`check()` and `uncheck()` are Playwright-compatible aliases for
`setChecked(true)` and `setChecked(false)`. `uncheck()` is for checkboxes;
change a radio group by calling `check()` on the desired radio instead.

Locator reads:

- `textContent`, `innerText`, `innerHTML`, `inputValue`, `getAttribute`
- `isVisible`, `isHidden`, `isEnabled`, `isDisabled`, `isEditable`,
  `isChecked`
- `count`, `allInnerTexts`, `allTextContents`
- page-context computation: `evaluate`, `evaluateAll`

`filter` accepts `hasText`, `hasNotText`, `visible`, and same-page/frame
locator values for `has` and `hasNot`. A locator from another page or frame is
rejected instead of leaking a host browser object into the sandbox.

Prefer semantic locators. Use CSS when accessibility semantics are absent or
when recon is proving a stable DOM relationship for an adapter.

`page.context()` and browser/context ownership APIs are deliberately denied.
The sandbox cannot launch or connect to another browser.

## In-Memory File Uploads

Create a virtual file in QuickJS and upload it in the same dependent sequence:

```js
const buffer = Buffer.from('generated report');
await page.getByLabel('Report').setInputFiles({
  name: 'report.txt',
  mimeType: 'text/plain',
  buffer,
});
```

The restricted `Buffer` supports `from` with UTF-8, base64, arrays,
`ArrayBuffer`, and typed-array inputs; `isBuffer`; and `toString` with UTF-8 or
base64. It is not Node's `Buffer` and provides no filesystem access.

`setInputFiles` accepts only in-memory `{name, mimeType, buffer}` payloads or
arrays of them. Host file paths are rejected. Use the separate `browser upload`
primitive when the user explicitly supplies an existing local path.

## Page Evaluation

The function body runs in the web page, not in Node:

```js
const heading = await page.evaluate(
  selector => document.querySelector(selector)?.textContent?.trim() || null,
  'main h1',
);
return { heading };
```

There is no sandbox-global `fetch`. A page-origin `fetch` may be called inside
`page.evaluate` when browser policy allows it.

Locator evaluation is available when the computation needs the matched
element or the whole matched collection. Reduce the result inside the browser
instead of returning large DOM bodies:

```js
const images = await page.locator('main img').evaluateAll(elements =>
  elements.map(element => ({
    alt: element.getAttribute('alt') || '',
    src: element.getAttribute('src') || '',
  })).filter(image => image.alt || image.src),
);
return { images: images.slice(0, 50) };
```

## Frames and Popups

`page.frames()` returns frame descriptors synchronously:

```js
const child = page.frames().find(frame => frame.url().includes('/embed'));
if (!child) return { found: false };
return { found: true, text: await child.getByText('Total').innerText() };
```

Frames support `name`, `url`, all documented locator factories, `evaluate`,
`content`, `waitForLoadState`, `waitForURL`, and `waitForSelector`.

Arm popup waits before the click:

```js
const popupPromise = page.waitForEvent('popup');
await page.getByRole('link', { name: 'Open report' }).click();
const popup = await popupPromise;
return { popupUrl: popup.url() };
```

The popup then appears in `await browser.pages()`.

## Network Reconnaissance

Arm the waiter before its triggering action:

```js
const responsePromise = page.waitForResponse(
  response =>
    response.url().includes('/api/search')
    && response.request().method() === 'GET',
);
await page.getByRole('button', { name: 'Search' }).click();
const response = await responsePromise;
return {
  status: response.status(),
  body: await response.json(),
};
```

Predicates run inside QuickJS and may be a function, RegExp, or URL substring.
Subscriptions are passive; they cannot rewrite, fulfill, abort, or mutate
requests.

Request methods:

- `url`, `method`, `resourceType`
- `headers`, `allHeaders`
- `postData`, `failure`

Response methods:

- `url`, `status`, `ok`
- `headers`, `allHeaders`
- `request`, `body`, `text`, `json`

Authorization, cookie, set-cookie, and related secret headers are redacted.
Response bodies are capped at 1 MiB. Return only fields needed for the next
decision.

## Screenshot Receipts

```js
const pageShot = await page.screenshot({ fullPage: true });
const mainShot = await page.locator('main').screenshot();
return { pageShot, mainShot };
```

Both `page.screenshot()` and `locator.screenshot()` return an artifact receipt
containing the actual stored path. Webcmd writes the bytes beneath its own
cache directory. An agent-provided directory does not grant host write
authority and is not honored as an arbitrary output location.

## Unsupported methods

The client implements the high-frequency surface above, not every Playwright
method. Calling a missing page, frame, or locator method raises
`BROWSER_RUN_API_UNSUPPORTED` and names the attempted API, such as
`locator.someMethod`. This is a compatibility diagnostic; use a browser
primitive only for a genuinely unsupported isolated operation, not as a reason
to split the rest of a supported decision-sized flow.

## Isolation and Limits

Every invocation gets a fresh QuickJS runtime, timers, listeners, and handle
registry. It has no:

- `process`, `require`, `module`, Node imports, filesystem, or environment
- child process or IPC
- global `fetch`, `XMLHttpRequest`, or `WebSocket`
- raw CDP endpoint
- browser launch/connect/context ownership

Local commands within one Cloak profile execute serially. This prevents a run,
primitive command, popup, or tab bind from driving shared profile state at the
same time; separate profiles remain independent.

| Limit | Default |
| --- | --- |
| wall time | 30 seconds |
| QuickJS memory | 128 MiB |
| source | 256 KiB UTF-8 |
| result + logs | 65,536 characters |
| response body | 1 MiB |
| upload files per call | 8 |
| upload file size | 10 MiB each |
| upload total size | 20 MiB |
| observation | diff |

## Adapter Boundary

Treat a successful program as evidence:

- semantic role/name and stable DOM relationship
- endpoint URL, method, headers, and response shape
- auth/session requirements
- ordering and readiness conditions
- visible success, empty, and failure states

Do not paste the program into `func(page,args)`. Adapter `page` is Webcmd
`IPage`, not this Playwright-style client. Load `webcmd-adapter-author` and
implement the observed behavior with the existing adapter APIs.
