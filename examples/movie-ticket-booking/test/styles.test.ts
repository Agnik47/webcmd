import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../dist/style.css', import.meta.url), 'utf8');

test('pins the transcript and composer to stable chat grid rows', () => {
  assert.match(css, /\.chat-pane\{[^}]*grid-template-areas:"header""banner""transcript""composer"/);
  assert.match(css, /\.chat-header\{[^}]*grid-area:header/);
  assert.match(css, /\.banner-slot\{[^}]*grid-area:banner/);
  assert.match(css, /\.transcript\{[^}]*grid-area:transcript/);
  assert.match(css, /\.composer-wrap\{[^}]*grid-area:composer/);
});

test('gives mobile form controls a 44px minimum touch height', () => {
  const mobile = css.slice(
    css.indexOf('@media (width<=820px)'),
    css.indexOf('@media (width<=700px)'),
  );
  assert.match(mobile, /button,input,textarea\{min-height:44px\}/);
});
