import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyChatResponse,
  bookingDetails,
  bookingStatusLabel,
  createApi,
  createRequestEpoch,
  preferencePayload,
  requiresAuthReset,
  safeTranscriptUrl,
  transcriptParts,
} from '../frontend/src/client.js';

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
  const api = createApi(() => response, requests.isCurrent, (message) => resets.push(message));
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
    (message) => resets.push(message),
  );

  await assert.rejects(api('/api/preferences', {}, requests.capture()), /authentication required/);
  requests.advance();
  await assert.rejects(api('/api/bootstrap', {}, requests.capture(), ''), /authentication required/);

  assert.deepEqual(resets, ['Your session expired. Please log in again.', '']);
});

test('segments only validated HTTPS transcript URLs as links', () => {
  const valid = 'https://api.webcmd.test/account/live/checkout-token';
  assert.equal(safeTranscriptUrl(valid), valid);
  for (const unsafe of [
    'http://api.webcmd.test/account/live/token',
    'javascript:alert(1)',
    'data:text/html,unsafe',
    'https://user:pass@api.webcmd.test/account/live/token',
  ]) {
    assert.equal(safeTranscriptUrl(unsafe), null, unsafe);
  }

  assert.deepEqual(
    transcriptParts(`Pay here: ${valid} not http://unsafe.example`),
    [
      { text: 'Pay here: ' },
      { text: valid, href: valid },
      { text: ' not ' },
      { text: 'http://unsafe.example' },
    ],
  );
});

test('serializes preference fields and booking labels for the API and UI', () => {
  assert.deepEqual(preferencePayload({
    city: ' Bengaluru ',
    languages: 'Hindi, English, ',
    formats: '2D, IMAX',
    seatPosition: ' Back centre ',
    budget: '750.50',
  }), {
    city: 'Bengaluru',
    languages: ['Hindi', 'English'],
    formats: ['2D', 'IMAX'],
    seatPosition: 'Back centre',
    budgetPaise: 75050,
  });
  assert.equal(bookingStatusLabel('awaiting_confirmation'), 'Awaiting confirmation');
  assert.equal(bookingDetails({
    cinema: 'PVR Phoenix',
    showTime: '7:00 PM',
    seats: ['A1', 'A2'],
  }), 'PVR Phoenix · 7:00 PM · A1, A2');
});

test('applies current chat state while ignoring stale session and selection responses', () => {
  const requests = createRequestEpoch();
  const selections = createRequestEpoch();
  const messages: string[] = [];
  const response = {
    message: { role: 'assistant' as const, content: 'confirmed' },
    conversation: { id: 'first', title: 'Resume this chat' },
    bookings: [{ status: 'confirmed' }],
  };

  assert.deepEqual(
    applyChatResponse(
      response,
      () => requests.isCurrent(requests.capture()),
      (message) => messages.push(message.content),
      () => {},
      [{ id: 'second', title: 'New chat' }, { id: 'first', title: 'New chat' }],
      () => selections.isCurrent(selections.capture()),
    ),
    [
      { id: 'first', title: 'Resume this chat' },
      { id: 'second', title: 'New chat' },
    ],
  );
  assert.deepEqual(messages, ['confirmed']);

  const staleSession = requests.capture();
  requests.advance();
  assert.equal(applyChatResponse(
    response,
    () => requests.isCurrent(staleSession),
    () => assert.fail('stale response appended'),
    () => {},
    [],
    () => true,
  ), null);

  const staleSelection = selections.capture();
  selections.advance();
  assert.equal(applyChatResponse(
    response,
    () => true,
    () => assert.fail('old conversation appended'),
    () => {},
    [],
    () => selections.isCurrent(staleSelection),
  ), null);
});
