import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { ManifestEntry } from './manifest-types.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webcmd-plugin-manifest-'));
  roots.push(root);
  for (const [relative, source] of Object.entries(files)) {
    const file = path.join(root, 'plugins', relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  }
  return root;
}

function command(site: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    site,
    name,
    description: `${name} description`,
    access: 'read',
    aliases: ['find'],
    example: `webcmd ${site} ${name}`,
    domain: 'example.com',
    strategy: 'public',
    browser: false,
    args: [{ name: 'limit', type: 'int', default: 10, required: false, help: 'Limit' }],
    columns: ['id'],
    tags: ['search'],
    keywords: ['lookup'],
    defaultFormat: 'json',
    navigateBefore: false,
    siteSession: 'ephemeral',
    freshPage: false,
    ...overrides,
  };
}

describe('plugin command manifest', () => {
  it('scans flat command modules and emits deterministic plugin source paths', async () => {
    const root = fixture({
      'zeta/search.js': 'cli({ site: "zeta", name: "search" });',
      'alpha/list.js': 'cli({ site: "alpha", name: "list" });',
      'alpha/helper.js': 'export const helper = true;',
      'alpha/test/ignored.test.js': 'cli({ site: "alpha", name: "ignored" });',
    });
    const modules = new Map([
      [pathToFileURL(path.join(root, 'plugins/zeta/search.js')).href, { zeta: command('zeta', 'search') }],
      [pathToFileURL(path.join(root, 'plugins/alpha/list.js')).href, { alpha: command('alpha', 'list', { aliases: undefined }) }],
    ]);
    const { scanPluginCommandModules } = await import('./build-plugin-command-manifest.js');

    const entries = await scanPluginCommandModules(path.join(root, 'plugins'), href => Promise.resolve(modules.get(href)));

    expect(entries.map(entry => `${entry.site}/${entry.name}`)).toEqual(['alpha/list', 'zeta/search']);
    expect(entries.map(entry => entry.sourceFile)).toEqual(['plugins/alpha/list.js', 'plugins/zeta/search.js']);
    expect(entries.map(entry => entry.modulePath)).toEqual(['plugins/alpha/list.js', 'plugins/zeta/search.js']);
  });

  it('rejects duplicate canonical keys and aliases', async () => {
    const root = fixture({
      'alpha/one.js': 'cli({ site: "alpha", name: "one" });',
      'alpha/two.js': 'cli({ site: "alpha", name: "two" });',
    });
    const modules = new Map([
      [pathToFileURL(path.join(root, 'plugins/alpha/one.js')).href, { one: command('alpha', 'one', { aliases: ['shared'] }) }],
      [pathToFileURL(path.join(root, 'plugins/alpha/two.js')).href, { two: command('alpha', 'two', { aliases: ['shared'] }) }],
    ]);
    const { scanPluginCommandModules } = await import('./build-plugin-command-manifest.js');

    await expect(scanPluginCommandModules(path.join(root, 'plugins'), href => Promise.resolve(modules.get(href))))
      .rejects.toThrow('duplicate plugin command or alias alpha/shared');
  });

  it('preserves executable metadata and reports a changed argument default', async () => {
    const root = fixture({ 'alpha/search.js': 'cli({ site: "alpha", name: "search" });' });
    const runtime = command('alpha', 'search');
    const moduleHref = pathToFileURL(path.join(root, 'plugins/alpha/search.js')).href;
    const { findPluginCommandParityIssues, scanPluginCommandModules } = await import('./build-plugin-command-manifest.js');
    const entries = await scanPluginCommandModules(path.join(root, 'plugins'), async href => href === moduleHref ? { runtime } : {});
    const frozen = [{ ...entries[0], modulePath: 'alpha/search.js', sourceFile: 'alpha/search.js' }] as ManifestEntry[];

    expect(findPluginCommandParityIssues(entries, frozen)).toEqual([]);

    const changed = structuredClone(entries);
    changed[0]!.args![0]!.default = 20;
    expect(findPluginCommandParityIssues(changed, frozen)).toEqual([
      'alpha/search executable metadata differs from frozen core manifest',
    ]);
  });
});
