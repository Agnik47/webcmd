import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const demoRoot = join(import.meta.dirname, '..');
const skillPath = join(demoRoot, 'hermes', 'skills', 'movie-ticket-booking', 'SKILL.md');
const soulPath = join(demoRoot, 'hermes', 'SOUL.md');

test('Hermes movie-booking profile keeps the confirmation and payment boundary explicit', () => {
  const skill = readFileSync(skillPath, 'utf8');
  const soul = readFileSync(soulPath, 'utf8');
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/);

  assert.ok(frontmatter, 'SKILL.md must start with YAML frontmatter');
  assert.match(frontmatter[1], /^name:\s*\S+/m);
  assert.match(frontmatter[1], /^description:\s*\S+/m);
  assert.match(`${skill}\n${soul}`, /District-only/i);
  assert.match(skill, /prepare-checkout/);
  assert.match(skill, /checkout/);
  assert.match(skill, /booking-status/);
  assert.match(skill, /explicit yes/i);
  assert.match(skill, /"I've paid".*not proof/is);
  assert.doesNotMatch(
    `${skill}\n${soul}\n${readFileSync(import.meta.filename, 'utf8')}`,
    new RegExp(['book', 'my', 'show'].join(''), 'i'),
  );
  assert.ok(soul.split('\n').length - 1 < 60, 'SOUL.md must stay under 60 lines');
});
