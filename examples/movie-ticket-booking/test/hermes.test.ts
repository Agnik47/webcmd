import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import test from 'node:test';
import { HermesClient, HermesHttpError, type HermesStreamEvent } from '../src/hermes.js';

async function fixture(
  handler: (request: {
    path: string;
    method: string;
    headers: IncomingHttpHeaders;
    body: unknown;
  }) => { status?: number; body: unknown },
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const result = handler({
      path: request.url ?? '',
      method: request.method ?? '',
      headers: request.headers,
      body: raw ? JSON.parse(raw) : undefined,
    });
    response.writeHead(result.status ?? 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function streamFixture(
  chunks: Buffer[],
  contentType = 'text/event-stream; charset=utf-8',
): Promise<{
  url: string;
  seen: { path?: string; sessionKey?: string; accept?: string; body?: unknown };
  close: () => Promise<void>;
}> {
  const seen: { path?: string; sessionKey?: string; accept?: string; body?: unknown } = {};
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    seen.path = request.url;
    seen.sessionKey = request.headers['x-hermes-session-key'] as string | undefined;
    seen.accept = request.headers.accept;
    seen.body = raw ? JSON.parse(raw) : undefined;
    response.writeHead(200, { 'content-type': contentType });
    for (const chunk of chunks) response.write(chunk);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}`,
    seen,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function assertSafeStreamError(error: unknown): boolean {
  assert(error instanceof HermesHttpError);
  assert.equal(error.status, 502);
  assert.doesNotMatch(error.message, /upstream-secret/);
  return true;
}

test('sends backend authentication and the stable user key on chat', async () => {
  let seen: {
    path?: string;
    authorization?: string;
    sessionKey?: string;
    body?: unknown;
  } = {};
  const hermes = await fixture((request) => {
    seen = {
      path: request.path,
      authorization: request.headers.authorization,
      sessionKey: request.headers['x-hermes-session-key'] as string | undefined,
      body: request.body,
    };
    return {
      body: {
        object: 'hermes.session.chat.completion',
        session_id: 'hermes-1',
        message: {
          role: 'assistant',
          content: 'Dune is playing.',
          tool_calls: [{ id: 'internal-tool-call' }],
        },
        metadata: { internal: true },
      },
    };
  });

  try {
    const client = new HermesClient(hermes.url, 'hermes-secret');
    const response = await client.chat('hermes-1', 'movie-demo:user:user-1', 'Find Dune');

    assert.equal(seen.authorization, 'Bearer hermes-secret');
    assert.equal(seen.sessionKey, 'movie-demo:user:user-1');
    assert.equal(seen.path, '/api/sessions/hermes-1/chat');
    assert.deepEqual(seen.body, { input: 'Find Dune' });
    assert.deepEqual(response, {
      object: 'hermes.session.chat.completion',
      session_id: 'hermes-1',
      message: { role: 'assistant', content: 'Dune is playing.' },
    });
  } finally {
    await hermes.close();
  }
});

test('creates app-named sessions and reads their messages', async () => {
  const seen: Array<{ path: string; method: string; body: unknown }> = [];
  const hermes = await fixture((request) => {
    seen.push({ path: request.path, method: request.method, body: request.body });
    if (request.method === 'POST') {
      const { id } = request.body as { id: string };
      return { status: 201, body: { object: 'hermes.session', session: { id } } };
    }
    return {
      body: {
        object: 'list',
        session_id: 'movie_session',
        data: [
          { role: 'user', content: 'Find Dune', metadata: { internal: true } },
          { role: 'assistant', content: 'Dune is playing.', tool_calls: [{ id: 'internal-tool-call' }] },
          { role: 'assistant', content: '' },
          { role: 'tool', content: 'Internal tool result' },
        ],
      },
    };
  });

  try {
    const client = new HermesClient(hermes.url, 'hermes-secret');
    const sessionId = await client.createSession();
    const messages = await client.getMessages(sessionId);

    assert.match(sessionId, /^movie_[0-9a-f-]{36}$/);
    assert.deepEqual(seen, [
      { path: '/api/sessions', method: 'POST', body: { id: sessionId } },
      { path: `/api/sessions/${sessionId}/messages`, method: 'GET', body: undefined },
    ]);
    assert.deepEqual(messages, [
      { role: 'user', content: 'Find Dune' },
      { role: 'assistant', content: 'Dune is playing.' },
    ]);
  } finally {
    await hermes.close();
  }
});

test('drops whitespace-only messages without normalizing valid content', async () => {
  const hermes = await fixture(() => ({
    body: {
      object: 'list',
      data: [
        { role: 'user', content: ' \n\t' },
        { role: 'assistant', content: '\u00a0' },
        { role: 'user', content: '  Find Dune  ' },
        { role: 'assistant', content: '\nDune is playing.\n' },
      ],
    },
  }));

  try {
    const client = new HermesClient(hermes.url, 'hermes-secret');
    assert.deepEqual(await client.getMessages('hermes-1'), [
      { role: 'user', content: '  Find Dune  ' },
      { role: 'assistant', content: '\nDune is playing.\n' },
    ]);
  } finally {
    await hermes.close();
  }
});

test('turns Hermes failures into safe typed errors', async () => {
  const hermes = await fixture(() => ({
    status: 500,
    body: { error: { message: 'request used hermes-secret' } },
  }));

  try {
    const client = new HermesClient(hermes.url, 'hermes-secret');
    await assert.rejects(
      () => client.getMessages('hermes-1'),
      (error: unknown) => {
        assert(error instanceof HermesHttpError);
        assert.equal(error.status, 502);
        assert.equal(error.upstreamStatus, 500);
        assert.doesNotMatch(error.message, /hermes-secret/);
        return true;
      },
    );
  } finally {
    await hermes.close();
  }
});

test('rejects malformed successful Hermes responses', async () => {
  const hermes = await fixture((request) => ({
    body: request.path.endsWith('/messages')
      ? { object: 'list', data: {} }
      : {
          object: 'hermes.session.chat.completion',
          session_id: 'hermes-1',
          message: { role: 'user', content: 'Not an assistant reply' },
        },
  }));

  try {
    const client = new HermesClient(hermes.url, 'hermes-secret');
    await assert.rejects(
      () => client.getMessages('hermes-1'),
      (error: unknown) => error instanceof HermesHttpError && error.status === 502,
    );
    await assert.rejects(
      () => client.chat('hermes-1', 'movie-demo:user:user-1', 'Find Dune'),
      (error: unknown) => error instanceof HermesHttpError && error.status === 502,
    );
  } finally {
    await hermes.close();
  }
});

test('streams Hermes deltas across raw SSE chunks and returns the completed reply', async () => {
  const stream = [
    'event: assistant.delta\r\ndata: {"delta":"Du"}\r\n\r\n',
    'event: assistant.delta\ndata: {"delta":"ne 😀"}\n\n',
    ': keepalive\r\n\r\n',
    'event: ignored\ndata: {"ignored":true}\n\n',
    'event: tool.started\ndata: {}\n\n',
    'event: tool.completed\ndata: {}\n\n',
    'event: assistant.completed\ndata: {"session_id":"hermes-1","content":"Dune 😀 is playing."}\n\n',
    'event: run.completed\ndata: {}\n\n',
    'event: done\ndata: {}',
  ].join('');
  const bytes = Buffer.from(stream);
  const emoji = Buffer.from('😀');
  const emojiOffset = bytes.indexOf(emoji);
  assert.notEqual(emojiOffset, -1);
  const hermes = await streamFixture([
    bytes.subarray(0, emojiOffset + 2),
    bytes.subarray(emojiOffset + 2, emojiOffset + emoji.length),
    bytes.subarray(emojiOffset + emoji.length),
  ]);

  try {
    const client = new HermesClient(hermes.url, 'hermes-secret');
    const events: HermesStreamEvent[] = [];
    const response = await client.chatStream(
      'hermes-1',
      'movie-demo:user:user-1',
      'Find Dune',
      (event) => events.push(event),
    );

    assert.equal(hermes.seen.path, '/api/sessions/hermes-1/chat/stream');
    assert.equal(hermes.seen.sessionKey, 'movie-demo:user:user-1');
    assert.equal(hermes.seen.accept, 'text/event-stream');
    assert.deepEqual(hermes.seen.body, { input: 'Find Dune' });
    assert.deepEqual(events, [
      { type: 'assistant.delta', delta: 'Du' },
      { type: 'assistant.delta', delta: 'ne 😀' },
      { type: 'activity', active: true },
      { type: 'activity', active: false },
    ]);
    assert.deepEqual(response.message, {
      role: 'assistant',
      content: 'Dune 😀 is playing.',
    });
  } finally {
    await hermes.close();
  }
});

test('rejects invalid Hermes SSE streams without surfacing upstream text', async () => {
  const cases = [
    { name: 'a non-SSE response', contentType: 'application/json', body: '{"message":"upstream-secret"}' },
    { name: 'an error event', body: 'event: error\ndata: {"message":"upstream-secret"}\n\n' },
    { name: 'done before completion', body: 'event: done\ndata: {}' },
    { name: 'malformed event JSON', body: 'event: assistant.delta\ndata: {bad json}\n\n' },
  ];

  for (const streamCase of cases) {
    const hermes = await streamFixture([Buffer.from(streamCase.body)], streamCase.contentType);
    try {
      const client = new HermesClient(hermes.url, 'hermes-secret');
      await assert.rejects(
        () => client.chatStream('hermes-1', 'movie-demo:user:user-1', 'Find Dune', () => {}),
        assertSafeStreamError,
        streamCase.name,
      );
    } finally {
      await hermes.close();
    }
  }
});
