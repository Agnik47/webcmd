---
name: webcmd-browser
description: Use when an agent needs to drive a real Chrome window via webcmd — inspect a page, fill forms, click through logged-in flows, or extract data ad-hoc. Covers the selector-first target contract, compound form fields, stale-ref handling, network capture, and the agent-native envelopes the CLI returns. Not for writing adapters — see webcmd-adapter-author for that.
allowed-tools: Bash(webcmd:*), Read, Edit, Write
---

# webcmd-browser

The first reader of this CLI is an agent, not a human. Every subcommand returns a structured envelope that tells you exactly what matched, how confident the match is, and what to do if it didn't. Lean on those envelopes — do not guess.

This skill is for **driving a live browser** to accomplish an agent task. If you are building a reusable adapter under `~/.webcmd/clis/<site>/` use `webcmd-adapter-author` instead.

---

## Adapter fallback gate

Before starting a raw browser session, filter `webcmd list -f json` at the source using request-derived terms across `site`, `name`, `description`, and `columns`; follow `webcmd-usage` for the command shape. Any truncation warning means adapter discovery is incomplete: narrow the filter and inspect again. Absence from truncated output never proves that no adapter exists.

Raw `webcmd browser` use is allowed only after both conditions hold:

1. The complete, non-truncated filtered registry result for the missing capability is exactly `[]`.
2. A complete, non-truncated `webcmd plugin search <capability> -f json` result returns no match and no error.

If plugin search returns a match, offer installation. If its output is truncated, refine the query or output and inspect again. If it errors, report the error and stop instead of opening the browser.

---

## Prerequisites

```bash
webcmd doctor
```

Until `doctor` is green, browser commands will not work. Registry and plugin discovery do not require `doctor`. Typical failures: Chrome not running, extension not installed, debug port blocked by 1Password / other extensions. The doctor output tells you which.

---

## Session lifecycle

- `webcmd browser *` commands require a `<session>` positional immediately after `browser`. Use the same session name for a multi-step flow; use a different name to isolate parallel browser work.
- Use a stable session name for any multi-command or human-paced browser workflow. Example: `webcmd browser fb-yaya-warmup open https://example.com`, then reuse `webcmd browser fb-yaya-warmup state`, `extract`, `click`, etc.
- Owned browser sessions keep a tab lease alive between calls. Release it with `webcmd browser <session> close` or let the idle timeout expire.
- `webcmd browser <session> bind --page <page-id>` binds an existing webcmd-managed Cloak tab to that session. Use this after the user manually logs in or navigates inside a visible Cloak window.
- Browser commands default to background mode.
- Pass `--window foreground` (or set `WEBCMD_WINDOW=foreground`) when the user must see or interact with the browser.

### Bind Tab

```bash
webcmd browser gmail tab list
webcmd browser gmail bind --page page-123
webcmd browser gmail state
webcmd browser gmail click "Search"
webcmd browser gmail network
webcmd browser gmail unbind
```

Binding is explicit: run `tab list`, choose the Cloak tab's `page` id or `index`, then bind that tab to the named session. It fails closed if the tab is closed or the page id/index is stale. Re-run `webcmd browser <session> bind --page <page-id>` when the user switches to a different Cloak tab.

Navigation is allowed on bound sessions because the session now represents explicit agent ownership of that Cloak tab. Tab mutation (`tab new`, `tab select`, `tab close`) works on webcmd-managed Cloak tabs.

Bound sessions use the normal Webcmd session lifecycle; `unbind` releases the Cloak session lease, and tab/window/daemon close also ends the binding.

---

## Run-first decision loop

After raw browser fallback has been selected, state the next unknown whose answer requires agent reasoning.

1. Put every known navigation, wait, read, interaction, loop, pagination step,
   verification, and safe screenshot (use `await page.screenshot()` when a
   sandbox receipt is accepted) before that unknown into one `browser run`.
2. Return only the compact result needed for the next reasoning decision.
3. Start another run only when that returned result changes the plan.

`browser run` may be the first raw browser command when the destination URL
and initial inspection are already known. Use `page.goto()` inside the run;
do not use `browser open` followed by a run that only reads the known page.

The target is not one task-wide program. It is a small number of substantial
programs separated by genuine reasoning decisions.

| Situation | Use |
| --- | --- |
| Known URL plus known inspection or action | One run beginning with `page.goto()` |
| Pagination, candidate search, retries, or bounded loops with a known stop condition | One run containing the loop |
| Several dependent form or navigation operations | One run containing action, wait, and verification |
| One isolated inspect, click, fill, keypress, read, wait, or host-path screenshot | Matching primitive |
| Output is genuinely required to decide what operation comes next | Primitive reconnaissance, then one run |
| Existing host file upload | `browser upload` primitive |
| Reusable site command | `webcmd-adapter-author`, not browser-run source |

Use the browser screenshot primitive only for an isolated screenshot or when
the caller requires an exact host path. Otherwise, capture a known screenshot
inside its run with `await page.screenshot()` when a sandbox receipt is
accepted.

### Do not alternate open and one-operation run

Wrong:

```text
browser open URL
browser run { one page.evaluate() }
browser open NEXT_URL
browser run { one page.evaluate() }
```

This is `open -> one-operation run` and saves no agent decision. If the run
would contain only one `page.evaluate()` that `eval`, `get`, `find`, or
`state` can perform, keep the isolated primitive. If navigation and reading
are both known, own both inside one run.

Do not issue one run per pagination page, candidate, revision, or search
iteration when the loop and stopping condition are already known.

### Recon-to-run locator translation

Numeric refs are primitive-command handles; translate the evidence behind a
ref into a run locator:

| Recon evidence | Run locator |
| --- | --- |
| `attrs.id` | `page.locator('#stable-id')` |
| role + accessible name | `page.getByRole('button', { name: 'Save' })` |
| associated label | `page.getByLabel('Email')` |
| placeholder | `page.getByPlaceholder('Search')` |
| test ID | `page.getByTestId('submit')` |
| stable attribute relationship | `page.locator('form#search input[name=q]')` |

Prefer semantic locators, then stable IDs or attributes. A numeric ref is not
a reason to avoid `browser run`.

### Known destination: start with run

```bash
webcmd browser research run --stdin <<'JS'
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
  matches: matches.slice(0, 10),
  pagesChecked,
  finalUrl: page.url(),
};
JS
```

Navigation, pagination, reduction, and verification are known before the next
decision, so they belong to one invocation. Return the compact evidence, not
every page body.

### Reconnaissance-to-run form example

```bash
webcmd browser work state
webcmd browser work run --stdin <<'JS'
const page = await browser.currentPage();
const email = page.getByLabel('Email');
await email.fill('agent@example.com');
if (await email.inputValue() !== 'agent@example.com') {
  throw new Error('email did not stick');
}
await page.getByLabel('Country').selectOption({ label: 'Canada' });
await page.getByRole('button', { name: 'Submit' }).click();
await page.getByText('Form submitted successfully!').waitFor();
return { submitted: true, url: page.url() };
JS
```

Use a quoted heredoc so the shell cannot expand program contents. Keep an
isolated screenshot or an exact host-path receipt as a primitive; otherwise,
capture a known screenshot with `await page.screenshot()` inside the run when a
sandbox receipt is accepted. Inspect after a run only when its evidence is
unexpected or insufficient and changes the next plan. Read
[`references/browser-run-playwright.md`](./references/browser-run-playwright.md)
for the full supported API.

`browser run` is reconnaissance and ad-hoc automation. Its Playwright-style
objects are not the adapter `IPage` API, so never paste the program into an
adapter.

---

## Critical rules

1. **Inspect when output is needed to decide.** Use `state` or `find` before an action only when the page or target is unknown; a known URL plus known inspection or action starts with `page.goto()` in a run. Never hard-code a ref or selector from memory across sessions — indices are per-snapshot.
2. **Prefer site adapters before raw browser driving.** Complete the adapter fallback gate above. If `webcmd <site> <command>` already covers the task, use that adapter command first (`webcmd facebook notifications`, `webcmd reddit read`, `webcmd chatgpt model <level>`, etc.). Use `webcmd browser ...` only for gaps, debugging, or one-off UI flows the adapter does not expose.
3. **Prefer numeric refs for isolated primitives.** For `browser run`, translate recon evidence into a semantic locator, stable ID, or stable attribute relationship using the table above.
4. **Read `match_level` after every write.** `exact` = all good. `stable` = the element is the same but some soft attrs drifted — your action still applied. `reidentified` = the original ref was gone and the CLI found a unique replacement; double-check you hit the right element.
5. **Use the `compound` field for form controls.** Do not regex-guess a date format, do not `state` twice to get the full `<select>` options list. The compound envelope has the format string, full option list up to 50, `options_total` for overflow, and `accept`/`multiple` for `<input type=file>`.
6. **Verify writes that matter.** For an isolated primitive, use `get value`. In a run, call `inputValue`, `isChecked`, or another targeted read before returning. Autocomplete widgets, controlled inputs, and masked fields can silently eat characters.
7. **Inspect only at genuine decision boundaries.** Use `state → primitive → state` when the result determines the next action. Known write chains plus verification belong in one run; inspect after that run only when its evidence is unexpected or insufficient and changes the next plan. A `reidentified` result may remain a genuine reconnaissance boundary. Never reuse refs across a page transition.
8. **Use `&&` only for isolated primitives.** A known multi-action segment belongs in `browser run`, not a shell chain.
9. **`eval` is read-only.** Use `browser run` for multi-action mutation and structured primitives for isolated mutation.
10. **Prefer `network` to screen-scraping.** If a page you care about fetches its data from a JSON API, the API is almost always more reliable than scraping the rendered DOM. Capture once, inspect the shape, then `--detail <key>` the body you need.
11. **Return only the decision result from `browser run`.** Keep large DOM,
    response, and screenshot payloads out of the return value. The host already
    supplies final page metadata and a bounded semantic observation.

---

## Sitemaps

If `browser open` or `browser analyze` returns `sitemap.available: true`, switch to `webcmd-browser-sitemap` before continuing a multi-step site flow. The sitemap is prior context for pages, actions, workflows, APIs, and pitfalls; it is not truth. If the browser state disagrees with the sitemap, trust the browser and mark the sitemap stale via `webcmd-sitemap-author`.

---

## Target contract (`<target>` for click / type / select / get text|value|attributes)

```
<target> ::= <numeric-ref> | <css-selector>
```

- **Numeric ref** — the `[N]` index from `state` or `find`. Cheap, resilient to soft DOM drift.
- **CSS selector** — anything `querySelectorAll` accepts. Must be unambiguous on write ops, or pair with `--nth <n>`.

### Envelope on success

```json
{ "clicked": true, "target": "3", "matches_n": 1, "match_level": "exact" }
```

```json
{ "value": "kalevin@example.com", "matches_n": 1, "match_level": "stable" }
```

### match_level

| level | meaning | you should |
|-------|---------|------------|
| `exact` | Fingerprint agreed on tag + strong IDs with at most one soft drift | Proceed. |
| `stable` | Tag + strong IDs still agree, soft signals (aria-label, role, text) drifted | Proceed, but if *what* you typed/clicked matters, re-check with `get value` or `state`. |
| `reidentified` | Original ref was gone; a unique live element matched the fingerprint and was re-tagged with the old ref | Double-check you hit the right element before chaining more writes. |

### Structured error codes

Branch on these, not on the human message:

| code | meaning |
|------|---------|
| `not_found` | Numeric ref is no longer in the DOM. Re-`state`. |
| `stale_ref` | Ref exists but the element at that ref changed identity. Re-`state`. |
| `invalid_selector` | CSS was rejected by `querySelectorAll`. Fix the selector. |
| `selector_not_found` | CSS matches 0 elements. Try `find` with a looser selector. |
| `selector_ambiguous` | CSS matches >1 and no `--nth`. Add `--nth` or narrow the selector. |
| `selector_nth_out_of_range` | `--nth` beyond match count. |
| `option_not_found` | `select` couldn't find an option matching that label/value. Error envelope includes `available: string[]` of the real option labels. |
| `not_a_select` | `select` was called on a non-`<select>` element. |

Error envelope always includes `error.code` and `error.message`. Target errors (`selector_not_found`, `selector_ambiguous`, etc.) often add `error.candidates: string[]` with suggested selectors. `option_not_found` adds `error.available: string[]` instead.

---

## Command reference

### Inspect

| command | purpose |
|---------|---------|
| `browser state` | Snapshot: text tree with `[N]` refs, scroll hints, hidden-interactive hints, `compounds (N):` sidecar for date/select/file refs. |
| `browser state --source ax` | Opt-in accessibility-tree snapshot. Use when custom controls, portals, or iframe contents are hard to identify in normal `state`. AX refs can recover stale React re-renders by role/name/nth and can route same-origin iframe refs. Cross-origin iframe refs are best-effort because Chrome may not expose attachable OOPIF targets to extensions. |
| `browser state --compare-sources` | Metrics-only DOM vs AX comparison for deciding whether AX should become default. It prints counts and sizes, not page text, so it is safer to share for validation. |
| `browser find --css <sel> [--limit N] [--text-max N]` | Run a CSS query and return one entry per match with `{nth, ref, tag, role, text, attrs, visible, compound?}`. Allocates refs for matches the prior snapshot didn't tag. Cheap alternative to `state` when you already know the selector. |
| `browser find --role button --name Save` | Semantic locator query. Also supports `--label`, `--text`, and `--testid`. Use before raw CSS when a control has accessible labels. |
| `browser frames` | List cross-origin iframe targets. Pass the index to `--frame` on `eval`. |
| `browser screenshot [path]` | Viewport PNG. No path → base64 to stdout. Prefer `state` when you just need structure. |
| `browser screenshot --annotate [path]` | Visual ref map. Refreshes DOM refs and overlays visible `[N]` labels so the screenshot maps back to `browser click <ref>` targets. Use for icon-only controls, visual layouts, charts, or when text state is ambiguous. |

### Get (read-only)

| command | returns |
|---------|---------|
| `browser get title` | plain text |
| `browser get url` | plain text |
| `browser get text <target> [--nth N]` | `{value, matches_n, match_level}` |
| `browser get value <target> [--nth N]` | `{value, matches_n, match_level}` |
| `browser get attributes <target> [--nth N]` | `{value: {attr: val, ...}, matches_n, match_level}` |
| `browser get text --role option --name Travel` | Semantic locator read without a prior `state` call. Same flags as `browser find`. |
| `browser get html [--selector <css>] [--as html\|json] [--depth N] [--children-max N] [--text-max N] [--max N]` | Raw HTML, or structured tree. JSON tree nodes have `{tag, attrs, text, children[], compound?}`. Truncation reported via `truncated: {depth?, children_dropped?, text_truncated?}`. |

### Interact

| command | notes |
|---------|-------|
| `browser click <target> [--nth N]` | Returns `{clicked, target, matches_n, match_level}`. |
| `browser click --role button --name Submit` | Semantic click. Write actions require a unique match; ambiguous locators return candidates instead of clicking the first match. |
| `browser hover [target] [--role R --name N] [--nth N]` | Moves the mouse over an element. Use for hover menus/tooltips before taking `state` or clicking submenu items. Returns `{hovered, target, matches_n, match_level}`. |
| `browser focus [target] [--role R --name N] [--nth N]` | Focuses an element without typing. Useful before `keys` or when a page reacts to focus/blur. Returns `{focused, target, matches_n, match_level}`. |
| `browser dblclick [target] [--role R --name N] [--nth N]` | Double-clicks an element via native mouse events when available. Returns `{dblclicked, target, matches_n, match_level}`. |
| `browser check [target] [--role R --name N] [--nth N]` | Ensures checkbox/radio/aria-checked control is checked. Returns `{checked, changed, target, matches_n, match_level, kind}`. Prefer this over blind `click` when target state matters. |
| `browser uncheck [target] [--role R --name N] [--nth N]` | Ensures checkbox/aria-checked control is unchecked. Radio buttons cannot be unchecked directly; select another radio in the group instead. |
| `browser upload [target] <file...> [--role R --name N] [--nth N]` | Attaches local file path(s) to an `input[type=file]` via CDP. With semantic flags, omit `target` and pass files as positionals. Returns `{uploaded, files, file_names, target, matches_n, match_level, multiple?, accept?}`. |
| `browser drag [source] [target] [--from-role R --from-name N] [--to-role R --to-name N] [--from-nth N] [--to-nth N]` | Mouse-based drag from one resolved element center to another. Works for mouse-listener drag libraries; native HTML5 `dataTransfer` drops may need a site-specific fallback. Returns `{dragged, source, target, source_matches_n, target_matches_n, ...}`. |
| `browser type [target] <text> [--role R --name N] [--nth N]` | Clicks first, then types. With semantic flags, omit `target` and pass text as the only positional. Returns `{typed, text, target, matches_n, match_level, autocomplete}`. `autocomplete: true` means a combobox/datalist popup appeared after typing — you almost always need `keys Enter` or a follow-up `click` on the suggestion to commit the value. |
| `browser fill [target] <text> [--role R --name N] [--nth N]` | Exact replacement for input, textarea, and contenteditable targets. With semantic flags, omit `target` and pass text as the only positional. Returns `{filled, verified, text, actual, matches_n, match_level}`. Use this when you need raw text set and verified, not keyboard/autocomplete behavior. Pipeline form supports `{ fill: { ref, text, submit: true } }`. |
| `browser select [target] <option> [--role R --name N] [--nth N]` | Matches native `<select>` option by label first, then value. With semantic flags, omit `target` and pass option as the only positional. Use `compound` from `find`/`state` to see exactly what labels are available. |
| `browser keys <key>` | `Enter`, `Escape`, `Tab`, `Control+a`, etc. Runs against the focused element. |
| `browser scroll <direction> [--amount px]` | `up` / `down`. Default amount `500`. |

### Wait

```bash
browser wait selector "<css>" [--timeout ms]    # wait until the selector matches
browser wait text "<substring>" [--timeout ms]  # wait until the text appears
browser wait download [pattern] [--timeout ms]  # wait for a Chrome download whose filename/URL/mime contains pattern
browser wait time <seconds>                     # hard sleep, last resort
```

Default timeout `10000` ms. SPA routes, login redirects, and lazy-loaded lists need `wait` before `state`/`get`.

`browser wait download` uses the CloakBrowser runtime download lifecycle. Pass a
narrow filename or URL substring such as `receipt.pdf` when possible; an empty
pattern waits for the next/recent download in the timeout window. The command
reports `{downloaded, filename, url, state, elapsedMs}` on success and a JSON
error envelope on timeout/failure.

### Extract

- **`web fetch-browser --url <url>`** — One-shot Markdown reader for arbitrary pages. It expands relevant same-origin iframes by default, so old iframe-shell sites work better than with a top-document-only scrape. Use `--frames all-same-origin` when completeness matters more than Markdown noise. For AJAX shell pages use `webcmd web fetch-browser --url <url> --wait-for "<selector>" --wait-until networkidle --diagnose`; diagnostics show frame URLs, empty containers, and API-like XHRs. If the value you need is table/API data, switch to `browser network` or a dedicated adapter instead of relying on Markdown.
- **`browser eval <js> [--frame N]`** — Run an expression in the page (or in a cross-origin frame via `--frame`). Wrap in an IIFE and return JSON. Read-only: no `document.forms[0].submit()`, no clicks, no navigations. If the result is a string, stdout is the raw string; otherwise it's JSON.
- **`browser extract [--selector <css>] [--chunk-size N] [--start N]`** — Markdown extraction of long-form content with a continuation cursor. Returns `{url, title, selector, total_chars, chunk_size, start, end, next_start_char, content}`. Loop on `next_start_char` until it is `null`. Auto-scopes to `<main>`/`<article>`/`<body>` if you don't pass `--selector`.

### Network

```bash
browser network                        # shape preview + cache key list
browser network --detail <key>         # full body for one cached entry
browser network --filter "field1,field2"  # keep only entries whose body shape contains ALL fields as path segments
browser network --all                  # include static resources (usually noise)
browser network --raw                  # full bodies inline — large; use sparingly
browser network --ttl <ms>             # cache TTL (default 24h)
```

List entries look like `{key, method, status, url, ct, size, shape, body_truncated?}`. Detail envelope is `{key, url, method, status, ct, size, shape, body, body_truncated?, body_full_size?, body_truncation_reason}`. Cache lives in `~/.webcmd/cache/browser-network/` so you can re-inspect without re-triggering the request.

Default output keeps JSON/XML/plain-text and JS-like API responses, then drops obvious static assets and telemetry by URL. If an expected endpoint is missing, run `browser network --all` once and check whether an unusual content type or URL filter hid it.

### Sandboxed Playwright-style programs

```bash
webcmd browser <session> run --file <program.js>
webcmd browser <session> run --stdin \
  [--timeout <seconds>] [--max-output <characters>] \
  [--observe diff|full|none] [--tab <page-id>]
```

Exactly one of `--file` or `--stdin` is required. This command is local-only.
See [`references/browser-run-playwright.md`](./references/browser-run-playwright.md)
for the supported Page, Frame, Locator, network, result, and isolation contract.

### Tabs & session

| command | purpose |
|---------|---------|
| `browser tab list` | JSON array of `{index, page, url, title, active}`. The `page` string is the tab identity you pass as `<targetId>` to `tab select` / `tab close`, or to `--tab <targetId>` on any subcommand. (`--tab`'s placeholder is historical — the value is always `page`.) |
| `browser tab new [url]` | Open a new tab. Prints the new `page` string. |
| `browser tab select [targetId]` | Make a tab the default. All subcommands accept `--tab <targetId>` to target one without changing the default. |
| `browser tab close [targetId]` | Close by `page`. |
| `browser back` | History back on the active tab. |
| `browser close` | Release the current owned browser session when done. |
| `browser <session> bind --page <page-id>` | Bind an existing Cloak tab to the named browser session. |
| `browser <session> bind --index <n>` | Bind an existing Cloak tab by index from `tab list`. |
| `browser <session> unbind` | Release the named Cloak browser session lease. |

---

## Compound form controls

Every date/time, select, and file input carries a `compound` field. Use it — do not regex attributes.

### Date family

```json
{
  "control": "date",
  "format": "YYYY-MM-DD",
  "current": "2026-04-21",
  "min": "2026-01-01",
  "max": "2026-12-31"
}
```

`control` is one of `date | time | datetime-local | month | week`. `format` is a concrete template string — type into the field using that exact format, or `select` by label if the site wraps the native input in a custom widget.

### Select

```json
{
  "control": "select",
  "multiple": false,
  "current": "United States",
  "options": [
    { "label": "United States", "value": "us", "selected": true },
    { "label": "Canada", "value": "ca" }
  ],
  "options_total": 137
}
```

`options[]` is capped at 50 entries. **`current` is always correct** even when
the selected option is past the cap — it is computed by scanning every option,
not from the truncated list. If `options_total > options.length`, or options
load dynamically, inspect the live `<option>` set in a bounded `browser run`.
Select only a unique observed label/value. Return compact matching candidates
at the decision boundary when the requested option is absent or ambiguous.

### File

```json
{
  "control": "file",
  "multiple": true,
  "current": ["report.pdf", "cover.png"],
  "accept": "application/pdf,image/*"
}
```

Do not invent file paths. A user-supplied host path uses `browser upload`.
Generated in-memory content uses `setInputFiles()` inside `browser run`. A user
file choice without a path requires a visible human handoff; respect `accept`
when telling the user what to upload.

## Cost guide

- Use `state` at discovery and decision boundaries, not after every known write.
- Use `find` or a targeted `get` for one compact follow-up query.
- Use one primitive only for an isolated known action.
- Use one `browser run` for every known multi-operation segment and return only
  its decision result.
- Use screenshots only for visual evidence, CAPTCHA, charts, or required
  receipts. Avoid unbounded HTML and raw network bodies.

---

## Recipes

### Authentication and human handoff

If a failure returns `handoff.status === action_required`, stop browser writes and AutoFix. Give the user `handoff.action` and any `Webcmd browser:` or `handoff.viewUrl` link, then wait. After the user reports done, run `handoff.verifyCommand` when present; verification must succeed before retrying.

1. On a clear login redirect or auth wall, stop browser writes.
2. If the site exposes a login command, run `webcmd <site> login`. `already_logged_in` is verified; `in_progress` means no current user action, so do not ask the user or wait for confirmation, and do not poll; `action_required` is a hard stop.
3. For `action_required`, give the user its instructions and any returned `action_url` or `view_url`. If Webcmd returned no URL, use the current visible browser.
4. Never ask for or type passwords, OTPs, recovery codes, cookies, or session secrets.
5. Run the returned `verify_command` (normally `webcmd <site> whoami`) or `handoff.verifyCommand` only after the user reports done; verification must succeed before retrying.
6. Without a verifier, take fresh browser state and verify the intended post-action state before any retry, especially for write commands. The user's report alone is not verification.
7. If login remains `in_progress`, perform a later explicit `whoami` or task retry when work next needs auth state. Use `webcmd auth refresh` only when an explicit auth-state refresh is needed.

For a CAPTCHA or user takeover, stop automation, give the user any viewer URL Webcmd returned, and apply the same verification policy above. Keep CAPTCHA outside automated retries.

### Pick from a long dropdown

Use only an observed option value or label from `state`, `find`, or a live DOM
inspection inside the run. Never invent or guess a value. If the requested
choice is absent or ambiguous, stop at that decision boundary and return
compact matching candidates instead of waiting on a guessed `selectOption`.

```bash
webcmd browser form state                          # sidebar shows [12] <select name=country>
webcmd browser form find --css "select[name=country]"
# the compound.options_total is 137, but compound.current is "" — unselected.
# Translate the find evidence to this stable locator before the run.
webcmd browser form run --stdin <<'JS'
const selector = 'select[name=country]';
const requestedLabel = 'Uruguay';
const country = page.locator('select[name=country]');
const candidates = await page.evaluate((css, requested) => {
  const select = document.querySelector(css);
  if (!(select instanceof HTMLSelectElement)) return [];
  const wanted = requested.trim().toLocaleLowerCase();
  return Array.from(select.options)
    .map(option => ({ label: option.text.trim(), value: option.value }))
    .filter(option => option.label.toLocaleLowerCase() === wanted)
    .slice(0, 10);
}, selector, requestedLabel);
if (candidates.length !== 1) {
  return { selectionRequired: true, requestedLabel, candidates };
}
await country.selectOption(candidates[0].value);
const value = await country.inputValue();
if (value !== candidates[0].value) {
  throw new Error(`country selection did not stick: ${value}`);
}
return { label: candidates[0].label, value };
JS
```

Live inspection, a unique known selection, and verification belong to one
invocation. A missing or ambiguous result is the next reasoning boundary.

### Pick from a custom React dropdown

Use this for Radix, shadcn, Material UI, Mercury-style category fields, and
other controls that are not native `<select>`.

Use primitives only for reconnaissance until stable trigger and option semantics
are known. Then use one `browser run` to open, wait, select, verify, and return
compact evidence. Keep a boundary only if opening the widget reveals genuinely
unknown semantics.

```bash
webcmd browser mercury state --source ax  # reconnaissance: identify Category and Analytics semantics
webcmd browser mercury run --stdin <<'JS'
const trigger = page.getByRole('combobox', { name: 'Category' });
await trigger.click();
const option = page.getByRole('option', { name: 'Analytics' });
await option.waitFor();
await option.click();
const selected = await trigger.innerText();
if (selected !== 'Analytics') {
  throw new Error(`category selection did not stick: ${selected}`);
}
return { selected };
JS
```

Do not use `browser select` on these widgets. `browser select` is only for
native `<select>` elements.

### Scrape a list via network instead of DOM

**Unsupported-run-surface exception.** The host cache listing and `--detail`
commands are not available inside `browser run`. `browser open` populates the
host cache; `browser network` output is the genuine decision boundary used to
choose a key, and `--detail` follows only after that decision. Do not treat
`page.waitForResponse` as equivalent to unknown-endpoint host-cache
reconnaissance.

```bash
webcmd browser hn open "https://news.ycombinator.com"
webcmd browser hn network --filter "title,score"
# -> find the /topstories entry, note its key
webcmd browser hn network --detail topstories-a1b2
```

### Cross-origin iframe

```bash
webcmd browser checkout frames
# -> [{"index": 0, "url": "https://checkout.stripe.com/...", ...}]
webcmd browser checkout eval "(() => document.querySelector('input[name=cardnumber]')?.value)()" --frame 0
```

`browser state --source ax` may omit cross-origin iframe contents or fail to
route actions into them when Chrome does not expose an attachable OOPIF target
to the extension. In that case use `browser frames` + `browser eval --frame`, a
normal DOM `state`, or navigate/bind directly to the iframe URL when possible.

---

## Pitfalls

- **Do not submit forms via `eval "document.forms[0].submit()"`** — modern sites intercept with JS handlers and silently drop the call. Click an isolated submit button via its ref. `browser open` is only an isolated navigation exception; known navigation plus inspection belongs in `page.goto()` inside a run, and known write chains plus verification belong in one run.
- **Do not reuse refs across a page transition.** `wait` for the new state, then re-`state`. Old refs will either 404 or (worse) `reidentify` onto a similarly-shaped element on the new page.
- **`match_level: reidentified` is a warning, not an error.** The action went through, but a `reidentified` result may remain a genuine reconnaissance boundary. If you are chaining more writes that all depend on that being the right element, verify with a `get text` or `get value` before continuing.
- **Budget-aware commands silently cap.** `get html --as json` with default budgets will return `truncated: {...}`. If your downstream logic needs the whole subtree, raise `--depth` / `--children-max` or tighten the selector.
- **`autocomplete: true` on a `type` response is not an error.** It means a suggestion popup is open and your value isn't committed yet. Typically `keys Enter` to accept the first suggestion, or `click` the one you want.
- **`network --filter` is AND-semantics on path segments.** `--filter "title,score"` keeps entries whose body shape contains *both* `title` and `score` as path segments, at any depth. It is not a regex.
- **Screenshots are for humans, not for agents.** Use `state` + `find` unless the page is genuinely visual (captcha, chart). Screenshots burn tokens and rarely add signal an agent can act on.
- **Using `browser run` for one operation supported by a primitive adds code without saving a decision.** Keep the isolated primitive and its specialized envelope.
- **A browser-run program is not adapter source.** Playwright-style reconnaissance objects are intentionally different from adapter `IPage`.

---

## Troubleshooting

| symptom | fix |
|---------|-----|
| `webcmd doctor` red: "Browser not connected" | Start Chrome with `--remote-debugging-port=9222`, or build the Webcmd Browser Bridge and load the repository's `extension/` directory as an unpacked extension. |
| `attach failed: chrome-extension://...` | Disable 1Password / other CDP-hungry extensions temporarily. |
| `selector_not_found` right after `state` | Page mutated. `wait selector "..."` then retry. |
| `stale_ref` across every command | You are reusing refs from a prior page. Re-`state`. |
| `click` succeeds but nothing happens | The element is probably a decorative wrapper stealing clicks from the real target. `find --css "..."` with a narrower selector and retry on the inner element. |
| `type` appears to finish but value is wrong | Autocomplete, masked input, or React controlled re-render. Verify with `get value`. Add `keys Enter` or re-type. |
| `webcmd list -f json` output is truncated | Adapter discovery is incomplete. Filter at the source with request-derived terms and narrow until the complete result is `[]`; do not start browser fallback yet. |
| Giant `get html` output | Pass `--selector` + `--as json --depth 3 --children-max 20 --text-max 200`. |
| Network cache seems stale | Bump `--ttl` down, or let it expire. The cache lives at `~/.webcmd/cache/browser-network/`. |

---

## See also

- `webcmd-adapter-author` — turning what you just figured out into a reusable `~/.webcmd/clis/<site>/<command>.js`.
- `webcmd-browser-sitemap` — consuming site sitemap context while driving a browser task.
- `webcmd-sitemap-author` — creating or updating sitemap knowledge when you discover a durable path or stale entry.
- `webcmd-autofix` — when an existing adapter breaks, this skill walks you through `--trace retain-on-failure` evidence and filing a fix.
- `references/browser-run-playwright.md` — sandboxed multi-step browser programs.
