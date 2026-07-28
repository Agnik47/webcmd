import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-ignore -- exercise the browser JavaScript module directly.
import { createApi, createRequestEpoch, requiresAuthReset } from '../public/app.js';

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

test('discards an old unauthorized response before it can reset a new session', async () => {
  const requests = createRequestEpoch();
  let respond!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => { respond = resolve; });
  const resets: string[] = [];
  const api = createApi(() => response, requests.isCurrent, (message: string) => resets.push(message));
  const pending = api('/api/preferences', {}, requests.capture());

  requests.advance();
  respond(Response.json({ error: 'authentication required' }, { status: 401 }));

  await assert.rejects(pending, /authentication required/);
  assert.deepEqual(resets, []);
});

test('resets a current unauthorized request and keeps initial bootstrap neutral', async () => {
  const requests = createRequestEpoch();
  const resets: string[] = [];
  const api = createApi(
    async () => Response.json({ error: 'authentication required' }, { status: 401 }),
    requests.isCurrent,
    (message: string) => resets.push(message),
  );

  await assert.rejects(api('/api/preferences', {}, requests.capture()), /authentication required/);
  requests.advance();
  await assert.rejects(api('/api/bootstrap', {}, requests.capture(), ''), /authentication required/);

  assert.deepEqual(resets, ['Your session expired. Please log in again.', '']);
});
