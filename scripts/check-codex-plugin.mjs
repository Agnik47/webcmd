import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (relativePath) =>
  JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));

const packageJson = readJson('package.json');
const manifest = readJson('.codex-plugin/plugin.json');
const marketplace = readJson('.agents/plugins/marketplace.json');
const marketplacePlugin = marketplace.plugins?.[0];

assert.equal(manifest.name, 'webcmd');
assert.equal(manifest.version, packageJson.version);
assert.equal(manifest.skills, './skills/');
assert.equal(manifest.author?.name, 'AgentRHQ');
assert.equal(manifest.interface?.developerName, 'AgentRHQ');
assert.equal(marketplace.name, 'webcmd');
assert.equal(marketplace.plugins?.length, 1);
assert.equal(marketplacePlugin?.name, 'webcmd');
assert.deepEqual(marketplacePlugin?.source, {
  source: 'url',
  url: './',
});

const expectedSkills = [
  'smart-search',
  'webcmd-adapter-author',
  'webcmd-autofix',
  'webcmd-browser',
  'webcmd-browser-sitemap',
  'webcmd-sitemap-author',
  'webcmd-usage',
];
const actualSkills = fs
  .readdirSync(path.join(root, 'skills'), { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isDirectory() &&
      fs.existsSync(path.join(root, 'skills', entry.name, 'SKILL.md')),
  )
  .map((entry) => entry.name)
  .sort();

assert.deepEqual(actualSkills, expectedSkills);
console.log(`Codex plugin metadata valid: ${actualSkills.length} skills`);
