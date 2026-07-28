import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-ignore -- exercise the browser JavaScript module directly.
import { createRequestEpoch, requiresAuthReset } from '../public/app.js';

test('invalidates an async result captured before the session changes', async () => {
  const requests = createRequestEpoch();
  const captured = requests.capture();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const result = blocked.then(() => requests.isCurrent(captured) ? 'applied' : 'discarded');

  requests.advance();
  release();

  assert.equal(await result, 'discarded');
});

test('resets authenticated requests on 401 but preserves login errors', () => {
  assert.equal(requiresAuthReset('/api/preferences', 401), true);
  assert.equal(requiresAuthReset('/api/login', 401), false);
  assert.equal(requiresAuthReset('/api/register', 401), false);
  assert.equal(requiresAuthReset('/api/preferences', 500), false);
});
