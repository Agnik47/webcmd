# Browser Run Details

## Sandbox boundaries

`run` evaluates the supplied JavaScript in a fresh sandbox. Browser state in the bound session persists, but JavaScript variables and handles do not. `page`, `context`, and `browser` are normal Playwright globals; use the vendored Playwright client as the API reference. Return only JSON-compatible data.

## Artifact paths

Artifacts written by Playwright must use a relative logical filename. Webcmd returns an artifact receipt with its locator; it does not grant host-path write access.

## Errors

`BROWSER_RUN_*` errors name invalid input, unsupported Playwright calls, timeouts, output limits, or serialization failures. A timeout can include `BROWSER_RUN_SIDE_EFFECTS_MAY_HAVE_OCCURRED`; inspect the page state before retrying a write.

## Snapshot behavior

`page.snapshotForAI()` returns the current semantic snapshot inside a program. `--snapshot-diff` asks Webcmd to capture bounded before/after snapshots; a failed post-run snapshot becomes a warning, not a successful result change.

## Timing

Run results include timing fields such as `quickjs_boot_ms`, `client_bundle_init_ms`, `program_ms`, `browser_wait_ms`, and `snapshot_ms`. `--timeout <seconds>` limits the complete run; `--max-output <characters>` bounds returned data and logs.
