---
name: webcmd-browser
description: Use when no deterministic Webcmd adapter command covers a live browser task and Playwright interaction is required.
allowed-tools: Bash(webcmd:*), Read
---

# Webcmd Browser

Use an existing adapter command first. Otherwise, run Playwright against a named session. The raw surface is `tabs`, `bind --page`, `snapshot`, `run`, and `close`.

1. `webcmd browser work tabs` lists existing pages and is read-only.
2. `webcmd browser work bind --page page-123` is an explicit bind that selects one page for `work`.
3. `webcmd browser work snapshot --snapshot-mode act` inspects actionable controls. Use `--snapshot-mode tree` for fuller page structure, or `--snapshot-mode read` for readable article/content text.
4. `webcmd browser work run --stdin` runs one JavaScript program. Every run has a fresh JavaScript scope, while persistent browser state in the bound page survives between runs. Use the normal Playwright globals `page`, `context`, `browser`, and `console` directly.
5. `webcmd browser work close` detaches and closes the session when finished.

Keep related browser actions in one run and return a compact JSON-compatible result. Successful runs return `snapshotDiff` automatically. Use `--no-snapshot-diff` only when the code is pure read-only and the result already contains the needed state. Do not call the former semantic-snapshot extension; it is not part of Webcmd's Playwright runtime.

```bash
webcmd browser work run --stdin <<'JS'
await page.goto('https://example.com');
await page.getByRole('link', { name: 'More information' }).click();
return { title: await page.title(), url: page.url() };
JS
```

For sandbox boundaries, artifacts, errors, snapshots, and timings, read [`references/browser-run-playwright.md`](references/browser-run-playwright.md).
