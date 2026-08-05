import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = path.resolve('scripts/migrate-cli-sites.mjs');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webcmd-migrate-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'clis', 'example'), { recursive: true });
  fs.mkdirSync(path.join(root, 'plugins', 'sibling'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'clis', 'example', 'search.js'), `
    import { requireSearchQuery } from '../_shared/common.js';
    cli({ site: 'example', name: 'search', description: 'Search examples' });
  `);
  fs.writeFileSync(path.join(root, 'clis', 'example', 'helper.js'), 'export const helper = true;\n');
  fs.writeFileSync(path.join(root, 'clis', 'example', 'fixture.html'), '<main>fixture</main>\n');
  fs.writeFileSync(path.join(root, 'clis', 'example', 'search.test.js'), `
    import { search } from './search.js';
    import { requireSearchQuery } from '../_shared/common.js';
  `);
  fs.writeFileSync(path.join(root, 'plugins', 'sibling', 'keep.txt'), 'unchanged\n');
  fs.writeFileSync(path.join(root, 'cli-manifest.json'), JSON.stringify([{
    site: 'example', name: 'search', description: 'Search examples', sourceFile: 'example/search.js',
  }]));
  fs.writeFileSync(path.join(root, 'scripts', 'silent-column-drop-baseline.json'), JSON.stringify([{
    command: 'example/search', file: 'clis/example/search.js', missing: ['url'],
  }]));
  fs.writeFileSync(path.join(root, 'scripts', 'typed-error-lint-baseline.json'), JSON.stringify([{
    rule: 'silent-clamp', command: 'example/search', file: 'clis/example/search.js', line: 1, text: 'x', occurrence: 0,
  }]));
  return root;
}

describe('migrate-cli-sites', () => {
  it('moves one site into a self-contained plugin without touching siblings', () => {
    const root = fixture();

    execFileSync(process.execPath, [script, 'example'], { cwd: root });

    const plugin = path.join(root, 'plugins', 'example');
    expect(fs.existsSync(path.join(root, 'clis', 'example'))).toBe(false);
    expect(fs.readFileSync(path.join(plugin, 'helper.js'), 'utf8')).toContain('helper');
    expect(fs.readFileSync(path.join(plugin, 'fixture.html'), 'utf8')).toContain('fixture');
    expect(fs.readFileSync(path.join(plugin, 'search.js'), 'utf8')).toContain("from '@agentrhq/webcmd/plugin-runtime'");
    expect(fs.readFileSync(path.join(plugin, 'test', 'search.test.js'), 'utf8')).toContain("from '../search.js'");
    expect(fs.readFileSync(path.join(plugin, 'test', 'search.test.js'), 'utf8')).toContain("from '@agentrhq/webcmd/plugin-runtime'");
    expect(JSON.parse(fs.readFileSync(path.join(plugin, 'package.json'), 'utf8'))).toEqual({
      name: 'webcmd-plugin-example',
      version: '0.1.0',
      type: 'module',
      description: 'Webcmd commands for example',
      peerDependencies: { '@agentrhq/webcmd': '>=0.6.0' },
    });
    expect(JSON.parse(fs.readFileSync(path.join(plugin, 'webcmd-plugin.json'), 'utf8'))).toEqual({
      name: 'example',
      version: '0.1.0',
      description: 'Webcmd commands for example',
      webcmd: '>=0.6.0',
      author: { name: 'WebCMD Agent', handle: 'agentrhq' },
    });
    expect(fs.readFileSync(path.join(plugin, 'README.md'), 'utf8')).toContain('| `webcmd example search` | Search examples |');
    expect(fs.readFileSync(path.join(root, 'plugins', 'sibling', 'keep.txt'), 'utf8')).toBe('unchanged\n');
    expect(fs.readFileSync(path.join(root, 'scripts', 'silent-column-drop-baseline.json'), 'utf8')).toContain('plugins/example/search.js');
    expect(fs.readFileSync(path.join(root, 'scripts', 'typed-error-lint-baseline.json'), 'utf8')).toContain('plugins/example/search.js');
  });

  it('refuses an existing plugin collision before moving anything', () => {
    const root = fixture();
    fs.mkdirSync(path.join(root, 'plugins', 'example'));

    const result = spawnSync(process.execPath, [script, 'example'], { cwd: root, encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('plugins/example already exists');
    expect(fs.existsSync(path.join(root, 'clis', 'example', 'search.js'))).toBe(true);
  });

  it('allows the planned PyPI merge and preserves existing plugin-only files', () => {
    const root = fixture();
    fs.renameSync(path.join(root, 'clis', 'example'), path.join(root, 'clis', 'pypi'));
    fs.mkdirSync(path.join(root, 'plugins', 'pypi'));
    fs.writeFileSync(path.join(root, 'plugins', 'pypi', 'releases.js'), 'plugin only\n');

    execFileSync(process.execPath, [script, 'pypi'], { cwd: root });

    expect(fs.readFileSync(path.join(root, 'plugins', 'pypi', 'releases.js'), 'utf8')).toBe('plugin only\n');
    expect(fs.existsSync(path.join(root, 'plugins', 'pypi', 'search.js'))).toBe(true);
  });
});
