import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const output = 'src/browser/run/generated/playwright-client.js';
const check = process.argv.includes('--check');
const directory = check ? await mkdtemp(join(tmpdir(), 'webcmd-playwright-client-')) : 'src/browser/run/generated';
const outfile = check ? join(directory, 'playwright-client.js') : output;

await build({
  entryPoints: ['src/browser/run/playwright-client/bundle-entry.ts'],
  bundle: true,
  format: 'iife',
  globalName: '__WebcmdPlaywrightClient',
  platform: 'neutral',
  target: 'es2022',
  minify: false,
  sourcemap: false,
  banner: { js: '/* Webcmd Playwright QuickJS client: Playwright v1.61.1 (39e3553a4f283a41134d75d7e404484bd9e6865a) */' },
  outfile,
  alias: {
    '@isomorphic': './src/browser/run/playwright-client/vendor/isomorphic',
    '@protocol/channels': './src/browser/run/playwright-client/vendor/protocol/channels.d.ts',
  },
});

if (check) {
  try {
    const [built, committed] = await Promise.all([readFile(outfile), readFile(output)]);
    if (!built.equals(committed)) throw new Error('Generated Playwright QuickJS client is out of date. Run node scripts/build-playwright-sandbox-client.mjs.');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
