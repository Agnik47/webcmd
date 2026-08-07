#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plugins = read('plugin-command-manifest.json');
const core = read('cli-manifest.json');
const frozen = read('test/fixtures/core-cli-manifest-v0.5.3.json');
const coreKeys = new Set(core.map(key));
const pluginByKey = new Map(plugins.map(entry => [key(entry), entry]));
const fields = [
  'aliases', 'access', 'domain', 'strategy', 'browser', 'args', 'columns', 'tags', 'keywords',
  'defaultFormat', 'pipeline', 'navigateBefore', 'siteSession', 'freshPage',
];
const issues = [];

for (const expected of frozen) {
  const command = key(expected);
  if (coreKeys.has(command)) continue;
  const actual = pluginByKey.get(command);
  if (!actual) {
    issues.push(`${command} is missing from plugin-command-manifest.json`);
    continue;
  }
  if (JSON.stringify(pick(actual)) !== JSON.stringify(pick(expected))) {
    issues.push(`${command} executable metadata differs from frozen core manifest`);
  }
}

if (issues.length) {
  console.error(`Plugin parity failed (${issues.length} issue(s)):`);
  for (const issue of issues) console.error(`  - ${issue}`);
  process.exit(1);
}
console.log(`OK - plugin parity preserved for ${frozen.length - coreKeys.size} migrated command(s).`);

function read(relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
}

function key(entry) {
  return `${entry.site}/${entry.name}`;
}

function pick(entry) {
  return Object.fromEntries(fields.map(field => [field, entry[field]]));
}
