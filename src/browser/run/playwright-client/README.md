# Playwright QuickJS client

This is the client-only subset of Playwright that runs in Webcmd's QuickJS sandbox. It has no Node APIs and communicates only through injected globals.

## Provenance

- Upstream: `microsoft/playwright` tag `v1.61.1`, commit `39e3553a4f283a41134d75d7e404484bd9e6865a`, MIT license.
- Copied upstream paths: `packages/playwright-core/src/client`, `packages/playwright-core/src/protocol/{serializers,validator,validatorPrimitives}.ts`, and `packages/isomorphic`.
- Inspired by dev-browser commit `73fe10f045b9c872f963fe6168de4328857e38cf` (MIT), which established the QuickJS platform seam.

## Local patches

- `bundle-entry.ts` constructs `Connection` with `quickjsPlatform` and sends protocol JSON through `__webcmdTransportSend`.
- `quickjs-platform.ts` replaces filesystem, encoding, artifact, and transport access with injected globals: `__webcmdEncodeBase64`, `__webcmdDecodeBase64`, `__webcmdEncodeText`, `__webcmdDecodeText`, `__webcmdTransportSend`, and `__webcmdWriteArtifact`.
- `vendor/client/stream.ts` is a QuickJS stub; the normal Playwright client object graph stays intact without importing Node streams.
- `vendor/isomorphic/time.ts` falls back to QuickJS's native `Date` when the browser `performance` global is absent.
- Vendored TypeScript files are marked `@ts-nocheck`: the checked bundle is esbuild's transpiled artifact, while their upstream monorepo type aliases are intentionally not part of Webcmd's host compilation.

Build with `node scripts/build-playwright-sandbox-client.mjs`; CI-style verification is `node scripts/build-playwright-sandbox-client.mjs --check`.
