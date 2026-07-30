import assert from 'node:assert/strict';
import test from 'node:test';
import * as client from '../frontend/src/client.js';
import {
  applyChatResponse,
  bookingDetails,
  bookingStatusLabel,
  createApi,
  createChatStream,
  createRequestEpoch,
  failedTurnForConversation,
  isComposerDisabled,
  isPendingConversation,
  preferencePayload,
  requiresAuthReset,
  rememberFailedTurn,
  safeTranscriptUrl,
  shouldFollowOutput,
  shouldSubmitComposer,
  transcriptParts,
} from '../frontend/src/client.js';

function streamResponse(chunks: Uint8Array[], contentType = 'text/event-stream; charset=utf-8'): Response {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), { headers: { 'content-type': contentType } });
}

test('exposes a status only while Hermes is thinking', () => {
  assert.equal(client.thinkingStatus?.(true), 'Hermes is thinking');
  assert.equal(client.thinkingStatus?.(false), '');
});

test('keeps a delayed reply pending when reselecting its active conversation', () => {
  assert.equal(client.shouldIgnoreConversationReselection?.(true, 'active', 'active'), true);
  assert.equal(client.shouldIgnoreConversationReselection?.(true, 'active', 'other'), false);
  assert.equal(client.shouldIgnoreConversationReselection?.(false, 'active', 'active'), false);
});

test('identifies only the conversation with the active turn', () => {
  assert.equal(isPendingConversation('chat-1', 'chat-1'), true);
  assert.equal(isPendingConversation('chat-1', 'chat-2'), false);
  assert.equal(isPendingConversation(undefined, 'chat-1'), false);
});

test('restores a failed local turn only after returning to its conversation', () => {
  const failedTurns = rememberFailedTurn(
    {},
    'chat-a',
    [{ role: 'user', content: 'Find Dune' }],
    'I found a partial result',
    'Hermes request failed',
  );

  assert.equal(failedTurnForConversation(failedTurns, 'chat-b'), undefined);
  assert.deepEqual(failedTurnForConversation(failedTurns, 'chat-a'), {
    messages: [
      { role: 'user', content: 'Find Dune' },
      { role: 'assistant', content: 'I found a partial result' },
    ],
    error: 'Hermes request failed',
  });
});

test('follows streamed output only while the reader is near the bottom', () => {
  assert.equal(shouldFollowOutput({
    scrollTop: 700,
    clientHeight: 300,
    scrollHeight: 1040,
  }), true);
  assert.equal(shouldFollowOutput({
    scrollTop: 200,
    clientHeight: 300,
    scrollHeight: 1040,
  }), false);
});

test('disables message submission until the active transcript is loaded', () => {
  assert.equal(isComposerDisabled({
    conversationId: 'chat-a',
    pending: false,
    transcriptPending: false,
  }), false);
  assert.equal(isComposerDisabled({
    conversationId: 'chat-a',
    pending: false,
    transcriptPending: true,
  }), true);
  assert.equal(isComposerDisabled({
    conversationId: 'chat-a',
    pending: true,
    transcriptPending: false,
  }), true);
  assert.equal(isComposerDisabled({
    conversationId: '',
    pending: false,
    transcriptPending: false,
  }), true);
});

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

test('decodes fragmented chat SSE events while ignoring comments and unknown events', async () => {
  const source = [
    ': connected\r\n\r\n',
    'event: assistant.delta\r\ndata: {"delta":"Du"}\r\n\r\n',
    'event: ignored\ndata: {"ignored":true}\n\n',
    'event: activity\ndata: {"active":true}\n\n',
    ': keepalive\n\n',
    'event: assistant.delta\ndata: {"delta":"ne 😀"}\n\n',
    'event: activity\ndata: {"active":false}\n\n',
    'event: chat.completed\ndata: {"message":{"role":"assistant","content":"Dune 😀 is playing."},"conversation":{"id":"first","title":"Find Dune"},"bookings":[{"cinema":"PVR","showTime":"7 PM","seats":["A1"],"status":"pending"}]}\n\n',
  ].join('');
  const bytes = new TextEncoder().encode(source);
  const emoji = new TextEncoder().encode('😀');
  const emojiOffset = bytes.findIndex((_, index) => emoji.every((byte, offset) => bytes[index + offset] === byte));
  assert.notEqual(emojiOffset, -1);
  let request: { path: string; init?: RequestInit } | undefined;
  const stream = createChatStream(
    async (path, init) => {
      request = { path: String(path), init };
      return streamResponse([
        bytes.slice(0, emojiOffset + 2),
        bytes.slice(emojiOffset + 2, emojiOffset + emoji.length),
        bytes.slice(emojiOffset + emoji.length),
      ]);
    },
    () => true,
    () => assert.fail('unexpected authorization reset'),
  );
  const events: client.ChatStreamEvent[] = [];

  await stream('/api/conversations/first/chat/stream', 'Find Dune', 1, (event) => events.push(event));

  assert.equal(request?.path, '/api/conversations/first/chat/stream');
  assert.equal(request?.init?.method, 'POST');
  assert.equal(request?.init?.headers && new Headers(request.init.headers).get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(String(request?.init?.body)), { message: 'Find Dune' });
  assert.deepEqual(events, [
    { type: 'assistant.delta', delta: 'Du' },
    { type: 'activity', active: true },
    { type: 'assistant.delta', delta: 'ne 😀' },
    { type: 'activity', active: false },
    {
      type: 'chat.completed',
      response: {
        message: { role: 'assistant', content: 'Dune 😀 is playing.' },
        conversation: { id: 'first', title: 'Find Dune' },
        bookings: [{ cinema: 'PVR', showTime: '7 PM', seats: ['A1'], status: 'pending' }],
      },
    },
  ]);
});

test('requires exactly one chat completion event', async () => {
  const encode = (source: string) => [new TextEncoder().encode(source)];
  const stream = createChatStream(
    async () => streamResponse(encode('event: assistant.delta\ndata: {"delta":"Dune"}\n\n')),
    () => true,
    () => assert.fail('unexpected authorization reset'),
  );

  await assert.rejects(
    () => stream('/api/conversations/first/chat/stream', 'Find Dune', 1, () => {}),
    /chat completion/i,
  );

  const duplicated = createChatStream(
    async () => streamResponse(encode([
      'event: chat.completed\ndata: {"message":{"role":"assistant","content":"Dune"},"conversation":{"id":"first","title":"Find Dune"},"bookings":[]}\n\n',
      'event: chat.completed\ndata: {"message":{"role":"assistant","content":"Dune"},"conversation":{"id":"first","title":"Find Dune"},"bookings":[]}\n\n',
    ].join(''))),
    () => true,
    () => assert.fail('unexpected authorization reset'),
  );
  await assert.rejects(
    () => duplicated('/api/conversations/first/chat/stream', 'Find Dune', 1, () => {}),
    /duplicate chat completion/i,
  );
});

test('rejects an SSE error with its safe public message only', async () => {
  const stream = createChatStream(
    async () => streamResponse([new TextEncoder().encode(
      'event: error\ndata: {"error":"Hermes request failed","message":"internal upstream details"}\n\n',
    )]),
    () => true,
    () => assert.fail('unexpected authorization reset'),
  );

  await assert.rejects(
    () => stream('/api/conversations/first/chat/stream', 'Find Dune', 1, () => {}),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.equal(error.message, 'Hermes request failed');
      return true;
    },
  );
});

test('uses existing JSON errors and only resets current stream requests on 401', async () => {
  const requests = createRequestEpoch();
  const resets: string[] = [];
  const failing = createChatStream(
    async () => Response.json({ error: 'message is required' }, { status: 400 }),
    requests.isCurrent,
    (message) => resets.push(message),
  );
  await assert.rejects(
    () => failing('/api/conversations/first/chat/stream', '', requests.capture(), () => {}),
    /message is required/,
  );

  const unauthorized = createChatStream(
    async () => Response.json({ error: 'authentication required' }, { status: 401 }),
    requests.isCurrent,
    (message) => resets.push(message),
  );
  await assert.rejects(
    () => unauthorized('/api/conversations/first/chat/stream', 'Find Dune', requests.capture(), () => {}),
    /authentication required/,
  );
  const stale = requests.capture();
  requests.advance();
  await assert.rejects(
    () => unauthorized('/api/conversations/first/chat/stream', 'Find Dune', stale, () => {}),
    /authentication required/,
  );

  assert.deepEqual(resets, ['Your session expired. Please log in again.']);
});

test('submits only an unmodified Enter outside IME composition', () => {
  assert.equal(shouldSubmitComposer({ key: 'Enter', shiftKey: false, isComposing: false }), true);
  assert.equal(shouldSubmitComposer({ key: 'Enter', shiftKey: true, isComposing: false }), false);
  assert.equal(shouldSubmitComposer({ key: 'Enter', shiftKey: false, isComposing: true }), false);
  assert.equal(shouldSubmitComposer({ key: 'a', shiftKey: false, isComposing: false }), false);
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

test('applies current chat state without writing a background reply into another transcript', () => {
  const requests = createRequestEpoch();
  const selections = createRequestEpoch();
  const messages: string[] = [];
  const response = {
    message: { role: 'assistant' as const, content: 'confirmed' },
    conversation: { id: 'first', title: 'Resume this chat' },
    bookings: [{ cinema: 'PVR', showTime: '7 PM', seats: ['A1'], status: 'confirmed' }],
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
  const rendered: client.Booking[] = [];
  assert.deepEqual(applyChatResponse(
    response,
    () => true,
    () => assert.fail('old conversation appended'),
    (bookings) => rendered.push(...bookings),
    [{ id: 'second', title: 'New chat' }],
    () => selections.isCurrent(staleSelection),
  ), [
    { id: 'first', title: 'Resume this chat' },
    { id: 'second', title: 'New chat' },
  ]);
  assert.deepEqual(rendered, [{ cinema: 'PVR', showTime: '7 PM', seats: ['A1'], status: 'confirmed' }]);
});
