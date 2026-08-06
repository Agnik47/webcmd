---
name: webcmd-browser
description: Use when no deterministic Webcmd adapter command covers a live browser task requiring Playwright interaction, authenticated handoff, visible UI verification, or ad-hoc page inspection.
allowed-tools: Bash(webcmd:*), Read
---

# Webcmd Browser

Use an existing adapter command first. If none fits, run Playwright against a named browser session. This is for one-off browser work; reusable commands belong in `webcmd-adapter-author`.

## Before browser use

- Check `webcmd list -f json` with request-derived terms. If output is truncated, narrow the query; absence from truncated output proves nothing.
- If a plugin search is needed, follow `webcmd-usage`. If a matching adapter exists, prefer it over raw browser control.
- Run `webcmd doctor` before browser work. Browser commands need a connected runtime; registry and plugin discovery do not.

## Command surface

The raw surface is `tabs`, `bind --page`, `snapshot`, `run`, and `close`.

1. `webcmd browser work tabs` lists existing pages and is read-only.
2. `webcmd browser work bind --page page-123` is an explicit bind that selects one page for `work`.
3. `webcmd browser work snapshot --snapshot-mode act` inspects actionable controls. Use `--snapshot-mode tree` for fuller page structure, or `--snapshot-mode read` for readable article/content text.
4. `webcmd browser work run --stdin` runs one JavaScript program. Every run has a fresh JavaScript scope, while persistent browser state in the bound page survives between runs. Use the Playwright globals `page`, `context`, `browser`, and `console`.
5. `webcmd browser work close` detaches and closes the session when finished.

Keep related browser actions in one run and return compact JSON-compatible data. Successful runs return `snapshotDiff` automatically. Use `--no-snapshot-diff` only when code is pure read-only and its result already contains the needed state. Do not call the former semantic-snapshot extension; it is not part of Webcmd's Playwright runtime.

```bash
webcmd browser work run --stdin <<'JS'
await page.goto('https://example.com');
await page.getByRole('link', { name: 'More information' }).click();
return { title: await page.title(), url: page.url() };
JS
```

## Auth and human handoff

If a result contains `handoff.status === action_required`, stop browser writes. Give the user `handoff.action` and any `Webcmd browser:` or `handoff.viewUrl` link, then wait.

On a clear login redirect or auth wall:

1. If the site exposes a login command, run `webcmd <site> login`.
2. `already_logged_in` is verified; continue.
3. `in_progress` means no current user action. Do not ask the user, wait for confirmation, or poll.
4. `action_required` is a hard stop. Give the user its instructions and any `action_url` or `view_url`.
5. Never ask for, type, echo, store, or automate passwords, OTPs, recovery codes, cookies, credentials, or session secrets.
6. Run the returned `verify_command` or `handoff.verifyCommand` only after the user reports done; verification must succeed before retrying.
7. Without a verifier, take a fresh snapshot and verify the intended identity check or post-action state before any retry. The user's report alone is not verification.

CAPTCHA stops automation and uses the same human handoff rule. Do not solve or retry CAPTCHA programmatically.

## Behavior rules

- Treat live browser state as truth. If sitemap or memory disagrees, continue from the page and mark memory stale later.
- Use `snapshot --snapshot-mode act` for controls, `tree` for structure, and `read` for article/content text.
- After navigation, form submit, route change, login, or human handoff, take a fresh snapshot before using old observations.
- Verify writes that matter inside the run or with a follow-up snapshot. React controls, autocomplete, masks, and custom widgets can silently reject input.
- Prefer semantic Playwright locators (`getByRole`, `getByLabel`, `getByText`) before brittle CSS. Keep selectors scoped.
- Prefer response evidence over screen scraping when the page fetches the needed data. Attach listeners before the trigger in the same `run`.
- Screenshots are for genuinely visual pages: CAPTCHA, charts, icon-only controls, or layout ambiguity. Prefer snapshots for agent reasoning.
- Branch on structured errors and warnings, not prose. If a timeout warns that side effects may have occurred, inspect state before retrying a write.

## Sitemaps and adapters

If Webcmd reports sitemap context, load `webcmd-browser-sitemap`; use it as a hint, not truth. If the workflow becomes repeatable, stop browser driving and create or repair an adapter with `webcmd-adapter-author`.

For sandbox boundaries, artifacts, errors, snapshots, and timings, read [`references/browser-run-playwright.md`](references/browser-run-playwright.md).
