#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';

const root = process.cwd();
const sites = process.argv.slice(2);
const sharedRuntime = /((?:\.\.\/)+)_shared\/(?:common|desktop-commands|search-adapter|site-auth)\.js/g;

if (sites.length === 0) fail('Usage: node scripts/migrate-cli-sites.mjs <site...>');
for (const site of sites) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(site)) fail(`Invalid site name: ${site}`);
  if (!fs.existsSync(path.join(root, 'clis', site))) fail(`clis/${site} does not exist`);
  if (site !== 'pypi' && fs.existsSync(path.join(root, 'plugins', site))) {
    fail(`plugins/${site} already exists`);
  }
}

const manifest = readJson(path.join(root, 'cli-manifest.json'), []);
for (const site of sites) migrate(site, manifest.filter(entry => entry.site === site));

function migrate(site, commands) {
  const source = path.join(root, 'clis', site);
  const plugin = path.join(root, 'plugins', site);
  const files = walk(source);
  const destinations = new Map(files.map(file => [file, destination(file, source, plugin)]));

  fs.mkdirSync(plugin, { recursive: true });
  for (const file of files) {
    const target = destinations.get(file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let content = fs.readFileSync(file);
    if (/\.[cm]?js$/.test(file)) {
      let sourceText = content.toString().replace(sharedRuntime, '@agentrhq/webcmd/plugin-runtime');
      if (/\.test\.[cm]?js$/.test(file)) sourceText = rewriteTestImports(sourceText, file, target, destinations);
      content = Buffer.from(sourceText);
    }
    fs.writeFileSync(target, content);
  }
  fs.rmSync(source, { recursive: true, force: true });

  const description = `Webcmd commands for ${site}`;
  writeJson(path.join(plugin, 'package.json'), {
    name: `webcmd-plugin-${site}`,
    version: '0.1.0',
    type: 'module',
    description,
    peerDependencies: { '@agentrhq/webcmd': '>=0.6.0' },
  });
  writeJson(path.join(plugin, 'webcmd-plugin.json'), {
    name: site,
    version: '0.1.0',
    description,
    webcmd: '>=0.6.0',
    author: { name: 'WebCMD Agent', handle: 'agentrhq' },
  });
  fs.writeFileSync(path.join(plugin, 'README.md'), readme(site, description, commands));

  for (const baseline of ['silent-column-drop-baseline.json', 'typed-error-lint-baseline.json']) {
    const file = path.join(root, 'scripts', baseline);
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, before.replaceAll(`clis/${site}/`, `plugins/${site}/`));
  }
  console.log(`Migrated ${site}: ${commands.length} command(s)`);
}

function destination(file, source, plugin) {
  const relative = path.relative(source, file);
  return /\.test\.[cm]?js$/.test(file)
    ? path.join(plugin, 'test', path.basename(relative))
    : path.join(plugin, relative);
}

function rewriteTestImports(source, oldFile, newFile, destinations) {
  return source.replace(/(['"])(\.\.?\/[^'"]+)\1/g, (match, quote, specifier) => {
    const oldTarget = path.resolve(path.dirname(oldFile), specifier);
    const newTarget = destinations.get(oldTarget);
    if (!newTarget) return match;
    let relative = path.relative(path.dirname(newFile), newTarget).replaceAll(path.sep, '/');
    if (!relative.startsWith('.')) relative = `./${relative}`;
    return `${quote}${relative}${quote}`;
  });
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}

function readme(site, description, commands) {
  const rows = commands
    .slice()
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map(command => `| \`webcmd ${site} ${command.name}\` | ${String(command.description ?? '').replaceAll('|', '\\|')} |`);
  return `# webcmd-plugin-${site}\n\n${description}.\n\n## Install\n\n\`\`\`bash\nwebcmd plugin install github:agentrhq/webcmd/plugins/${site}\n\`\`\`\n\n## Commands\n\n| Command | Description |\n| --- | --- |\n${rows.join('\n')}\n`;
}

function readJson(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
