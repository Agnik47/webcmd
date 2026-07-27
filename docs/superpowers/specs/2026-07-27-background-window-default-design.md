# Background Browser Window Default Design

## Goal

Make every browser-backed Webcmd command use background window mode unless the
user explicitly requests foreground mode with `--window foreground` or
`WEBCMD_WINDOW=foreground`.

Background remains headed, but it must not activate or focus the browser.

## Behavior

Window mode precedence is:

1. `--window foreground|background`
2. `WEBCMD_WINDOW=foreground|background`
3. `background`

This applies equally to adapter commands and direct `webcmd browser` commands,
including login, checkout, and other interactive commands. Callers that require
visibility must pass `--window foreground`.

## Design

- Change the direct browser command fallback from `foreground` to `background`.
- Keep the adapter execution fallback at `background`.
- Remove `defaultWindowMode` from command registration and generated manifest
  metadata so individual commands cannot silently override the global default.
- Remove existing per-command foreground defaults.
- Keep current flag and environment validation unchanged.
- Update help examples and skills where foreground behavior is intentionally
  required.

No browser launcher or session-runtime behavior changes are needed.

## Testing

Add focused coverage proving:

- Adapter commands without an override use background mode.
- Direct browser commands without an override use background mode.
- `--window foreground` selects foreground mode.
- `WEBCMD_WINDOW=foreground` selects foreground mode.
- An explicit CLI flag takes precedence over the environment variable.
- Invalid flag and environment values still fail with the existing errors.

Regenerate the CLI manifest, then run the focused tests, typecheck, build, and
the full test suite serially.

## Non-Goals

- Adding true headless browsing.
- Replacing `--window <mode>` with a new flag.
- Changing background-mode focus suppression or browser lifecycle.
- Adding another configuration layer.
