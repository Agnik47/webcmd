import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import test from 'node:test';
import { HermesClient, HermesHttpError } from '../src/hermes.js';

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
        message: { role: 'assistant', content: 'Dune is playing.' },
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
    assert.equal(response.message.content, 'Dune is playing.');
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
        data: [{ role: 'assistant', content: 'Hello' }],
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
    assert.deepEqual(messages, [{ role: 'assistant', content: 'Hello' }]);
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
          message: { role: 'assistant' },
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
