# Playwright Recon to Adapter `IPage`

Use this after a `webcmd browser <session> run` program discovers a viable UI
or network path and before filling the adapter scaffold.

## Compatibility Boundary

Browser-run exposes a sandboxed, Playwright-style client for reconnaissance.
Adapters execute ordinary registry modules in Node and receive Webcmd's
existing `IPage` when `browser: true`.

These are different APIs. A browser-run program succeeding proves the website
path, not adapter compatibility.

Keep three artifacts separate:

| Artifact | Contains |
| --- | --- |
| Recon evidence | roles/names, selectors, endpoint URL/method/shape, auth, ordering, visible states |
| Strategy note | `PUBLIC_API`, `COOKIE_API`, `UI_SELECTOR`, `DOM_STATE`, `PAGE_FETCH`, or `INTERCEPT` and contract level |
| Adapter implementation | only current registry, pipeline, `IPage`, Node fetch, and typed errors |

## Required Compatibility Note

Write this before filling the adapter:

```md
Recon evidence:
- Playwright methods:
- stable UI or endpoint contract:
- auth/session requirement:

Adapter path:
- strategy:
- IPage/pipeline/Node/interceptor methods:
- readiness and error mapping:

Rehearsal:
- command or minimal probe:
- observed result:
- one visible value/state comparison:

Removed browser-run code:
- unsupported Playwright methods/globals:
```

If any adapter-path method is unknown or the rehearsal does not reproduce the
target result, return to strategy selection. Do not scaffold around the gap.

## Translation Table

| Browser-run recon evidence | Final adapter form |
| --- | --- |
| `page.goto(url)` | `IPage.goto(url)` or pipeline `{ navigate: url }` |
| `page.evaluate(fn, ...args)` | `IPage.evaluate(fn, ...args)`, `evaluateWithArgs`, or pipeline `evaluate` |
| public endpoint found by `waitForResponse` | `browser:false` + Node-side `fetch` |
| authenticated replayable endpoint | `browser:true`, `page.getCookies()`, then Node-side `fetch` |
| same-origin runtime-only endpoint | `page.fetchJson(...)` or `IPage.evaluate(fetch(...))` |
| irreproducible signed request naturally issued by UI | `installInterceptor` → trigger through `IPage` → `waitForCapture` → `getInterceptedRequests` |
| `getByRole` / `getByLabel` relationship | prove a stable selector or semantic anchor, then use current `IPage` click/fill/type methods or pipeline evaluation |
| locator `click`, `fill`, `press`, `selectOption` | `IPage.click`, `fillText`, `typeText`, `pressKey`, or a neighboring pipeline pattern |
| `waitForLoadState` / `waitForURL` | `IPage.goto` readiness plus `IPage.wait({selector|text|timeout})`; wait on a site condition, not a blind sleep |
| popup evidence | current `IPage.tabs/newTab/selectTab` only when the adapter truly needs the popup |
| screenshot | recon evidence, not adapter runtime by default |

`waitForResponse` itself does not have a drop-in adapter equivalent. Its
evidence must select one of direct fetch, cookie fetch, page fetch, DOM/UI, or
interceptor. Preserve subscribe-before-trigger ordering only when the final
strategy remains `INTERCEPT`.

## Rehearsal by Strategy

### `PUBLIC_API`

Replay the exact method, URL, parameters, and required non-secret headers
without browser state. Confirm status, response shape, non-empty target data,
and one value against the visible page. Final adapter uses `browser:false`.

### `COOKIE_API`

First prove the endpoint in the authenticated browser. Then make the smallest
adapter-runtime probe using only `page.getCookies()` and Node `fetch`; do not
copy Playwright request or response objects. Confirm HttpOnly cookies are
present through `getCookies`, auth failure is recognizable, and the response
matches one visible value.

### `PAGE_FETCH`

Rehearse through `page.fetchJson` or `page.evaluate` with a same-origin fetch.
Confirm why Node fetch cannot reproduce it. Keep the returned value bounded and
JSON-compatible.

### `DOM_STATE`

Translate the successful page evaluation into `IPage.evaluate` or a pipeline
`evaluate` step. Pass external args safely, prove selectors/state keys against
current HTML, and return only the fields used by the adapter.

### `UI_SELECTOR`

Use existing Webcmd primitives to prove the same selector and readiness path,
because those primitives route through the current page abstraction. Then map
the proven selector to `IPage.click`, `fillText`, `typeText`, `pressKey`,
`setChecked`, or an established neighboring adapter pattern.

For writes, rehearse on a reversible/test state where possible. Do not repeat a
purchase, publish, send, or destructive action merely to satisfy verification;
verify preconditions and a non-mutating readiness path, then perform the
authorized write once and verify its post-action state.

### `INTERCEPT`

Use only when direct, cookie, page fetch, DOM state, and stable UI output cannot
provide the result. The adapter-compatible order is:

```js
await page.installInterceptor('/api/target');
await page.click(stableSelector);
await page.waitForCapture(timeoutMs);
const captured = await page.getInterceptedRequests();
```

Prove the interceptor pattern is narrow, attach before the action, choose the
correct response deterministically, and cap returned data.

## Example Translation

Recon:

```js
const responsePromise = page.waitForResponse(
  response => response.url().includes('/api/items'),
);
await page.getByRole('button', { name: 'Search' }).click();
return await (await responsePromise).json();
```

If cookie-authenticated replay works, the adapter does not retain either
Playwright method:

```js
func: async (page, args) => {
  const cookies = await page.getCookies({ domain: '.example.com' });
  const cookie = cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
  const response = await fetch(
    `https://example.com/api/items?q=${encodeURIComponent(String(args.query))}`,
    { headers: { Cookie: cookie } },
  );
  // Validate status/shape, map typed errors, then return rows.
}
```

The recon established the endpoint, auth requirement, trigger semantics, and
response shape. The rehearsal established that the final runtime can reproduce
the data without Playwright.

## Failure Gate

Stop before final adapter code when:

- a Playwright method has no mapped current-runtime equivalent;
- replay works only because browser-run retained a request/response object;
- authentication was assumed from the recon session but not proven in adapter
  verification;
- a fast response requires ordering that the chosen implementation discarded;
- the only rehearsal is “the browser-run program worked.”
