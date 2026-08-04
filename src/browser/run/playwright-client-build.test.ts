import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { BROWSER_RUN_PLAYWRIGHT_VERSION } from './types.js';

const execFileAsync = promisify(execFile);

describe('Playwright QuickJS client build', () => {
  it('pins the sandbox client to the host Playwright version', async () => {
    const [readme, packageJson] = await Promise.all([
      readFile('src/browser/run/playwright-client/README.md', 'utf8'),
      readFile('node_modules/playwright-core/package.json', 'utf8'),
    ]);

    expect(readme).toContain('v1.61.1');
    expect(readme).toContain('39e3553a4f283a41134d75d7e404484bd9e6865a');
    expect(readme).toContain('MIT');
    expect(JSON.parse(packageJson).version).toBe(BROWSER_RUN_PLAYWRIGHT_VERSION);
    await expect(execFileAsync(process.execPath, [
      'scripts/build-playwright-sandbox-client.mjs',
      '--check',
    ])).resolves.toBeDefined();
  });
});
