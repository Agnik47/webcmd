import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/db.js';
import { HermesClient } from '../src/hermes.js';
import { createApp } from '../src/server.js';

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function request(
  baseUrl: string,
  path: string,
  options: { method?: string; cookie?: string; body?: unknown } = {},
): Promise<{ response: Response; body: any }> {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.cookie = options.cookie;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, body: await response.json() };
}

async function register(baseUrl: string, email: string): Promise<string> {
  const { response } = await request(baseUrl, '/api/register', {
    method: 'POST',
    body: { email, password: 'correct horse battery staple' },
  });
  assert.equal(response.status, 201);
  const cookie = response.headers.getSetCookie()[0]?.split(';', 1)[0];
  assert(cookie);
  return cookie;
}

test('returns 404 when a user requests another user conversation', async () => {
  const hermesServer = createServer(async (incoming, outgoing) => {
    for await (const _ of incoming) { /* consume */ }
    const sessionId = incoming.url?.split('/')[3];
    outgoing.writeHead(incoming.method === 'POST' && incoming.url === '/api/sessions' ? 201 : 200, {
      'content-type': 'application/json',
    });
    outgoing.end(JSON.stringify(
      incoming.url === '/api/sessions'
        ? { object: 'hermes.session', session: { id: 'movie_fixture' } }
        : incoming.url?.endsWith('/messages')
          ? { object: 'list', data: [] }
          : {
              object: 'hermes.session.chat.completion',
              session_id: sessionId,
              message: { role: 'assistant', content: 'ok' },
            },
    ));
  });
  const hermesUrl = await listen(hermesServer);
  const directory = mkdtempSync(join(tmpdir(), 'movie-demo-server-'));
  const db = openDatabase(join(directory, 'app.db'));
  const app = createApp({ db, hermes: new HermesClient(hermesUrl, 'hermes-secret') });
  const baseUrl = await listen(app);

  try {
    const aliceCookie = await register(baseUrl, 'alice@example.com');
    const bobCookie = await register(baseUrl, 'bob@example.com');
    const created = await request(baseUrl, '/api/conversations', {
      method: 'POST',
      cookie: aliceCookie,
    });
    assert.equal(created.response.status, 201);
    const conversationId = created.body.id as string;

    const messages = await request(baseUrl, `/api/conversations/${conversationId}/messages`, {
      cookie: bobCookie,
    });
    assert.equal(messages.response.status, 404);

    const chat = await request(baseUrl, `/api/conversations/${conversationId}/chat`, {
      method: 'POST',
      cookie: bobCookie,
      body: { message: 'Find Dune' },
    });
    assert.equal(chat.response.status, 404);
  } finally {
    await close(app);
    db.close();
    await close(hermesServer);
  }
});

test('serializes complete Hermes turns for one user', async () => {
  let arrivals = 0;
  let firstArrived!: () => void;
  let releaseFirst!: () => void;
  const arrived = new Promise<void>((resolve) => { firstArrived = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const hermesServer = createServer(async (incoming, outgoing) => {
    let body = '';
    for await (const chunk of incoming) body += chunk;
    if (incoming.url === '/api/sessions') {
      outgoing.writeHead(201, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify({ object: 'hermes.session', session: { id: 'movie_fixture' } }));
      return;
    }
    arrivals += 1;
    if (arrivals === 1) {
      firstArrived();
      await blocked;
    }
    outgoing.writeHead(200, { 'content-type': 'application/json' });
    outgoing.end(JSON.stringify({
      object: 'hermes.session.chat.completion',
      session_id: 'movie_fixture',
      message: { role: 'assistant', content: (JSON.parse(body) as { input: string }).input },
    }));
  });
  const hermesUrl = await listen(hermesServer);
  const directory = mkdtempSync(join(tmpdir(), 'movie-demo-server-'));
  const db = openDatabase(join(directory, 'app.db'));
  const app = createApp({ db, hermes: new HermesClient(hermesUrl, 'hermes-secret') });
  const baseUrl = await listen(app);

  try {
    const cookie = await register(baseUrl, 'alice@example.com');
    const created = await request(baseUrl, '/api/conversations', {
      method: 'POST',
      cookie,
    });
    const path = `/api/conversations/${created.body.id as string}/chat`;
    const first = request(baseUrl, path, {
      method: 'POST',
      cookie,
      body: { message: 'first' },
    });
    await arrived;
    const second = request(baseUrl, path, {
      method: 'POST',
      cookie,
      body: { message: 'second' },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(arrivals, 1);

    releaseFirst();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    assert.equal(firstResponse.response.status, 200);
    assert.equal(secondResponse.response.status, 200);
    assert.equal(arrivals, 2);
  } finally {
    await close(app);
    db.close();
    await close(hermesServer);
  }
});
