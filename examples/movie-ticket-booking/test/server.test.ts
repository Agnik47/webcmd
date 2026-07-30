import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createBookingAttempt,
  openDatabase,
  recordDistrictBookingResult,
} from '../src/db.js';
import { HermesClient } from '../src/hermes.js';
import { createApp, readServerConfig } from '../src/server.js';

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

function testApp(secureCookies = false) {
  const directory = mkdtempSync(join(tmpdir(), 'movie-demo-server-'));
  const db = openDatabase(join(directory, 'app.db'));
  let sessionNumber = 0;
  const app = createApp({
    db,
    secureCookies,
    hermes: {
      createSession: async () => `movie_fixture_${++sessionNumber}`,
      getMessages: async () => [],
      chat: async () => ({
        object: 'hermes.session.chat.completion',
        session_id: 'movie_fixture',
        message: { role: 'assistant', content: 'ok' },
      }),
      chatStream: async (_sessionId, _sessionKey, _message, onEvent) => {
        onEvent({ type: 'assistant.delta', delta: 'ok' });
        return {
          object: 'hermes.session.chat.completion',
          session_id: 'movie_fixture',
          message: { role: 'assistant', content: 'ok' },
        };
      },
    },
  });
  return { db, app };
}

function parseSse(body: string): Array<{ event: string; data: any }> {
  return body.split('\n\n').flatMap((block) => {
    const lines = block.split('\n');
    const event = lines.find((line) => line.startsWith('event:'))?.slice('event:'.length).trim();
    if (!event) return [];
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n');
    return [{ event, data: JSON.parse(data) }];
  });
}

async function within<T>(promise: Promise<T>, milliseconds = 1_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timed out waiting for test event')), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test('serves a minimal unauthenticated health check', async () => {
  const { db, app } = testApp();
  const baseUrl = await listen(app);
  try {
    const { response, body } = await request(baseUrl, '/healthz');
    assert.equal(response.status, 200);
    assert.deepEqual(body, { ok: true });
  } finally {
    await close(app);
    db.close();
  }
});

test('adds Secure only to deployment session cookies', async () => {
  for (const [secureCookies, expected] of [[false, false], [true, true]] as const) {
    const { db, app } = testApp(secureCookies);
    const baseUrl = await listen(app);
    try {
      const { response } = await request(baseUrl, '/api/register', {
        method: 'POST',
        body: {
          email: `${secureCookies ? 'secure' : 'local'}@example.com`,
          password: 'correct horse battery staple',
        },
      });
      const cookie = response.headers.getSetCookie()[0] ?? '';
      assert.equal(/;\s*Secure(?:;|$)/i.test(cookie), expected);
      assert.match(cookie, /;\s*HttpOnly(?:;|$)/i);
      assert.match(cookie, /;\s*SameSite=Lax(?:;|$)/i);
    } finally {
      await close(app);
      db.close();
    }
  }
});

test('validates deployment server configuration', () => {
  assert.deepEqual(readServerConfig({}), {
    host: '127.0.0.1',
    port: 3000,
    secureCookies: false,
    dbPath: 'movie-demo.db',
  });
  assert.deepEqual(readServerConfig({
    HOST: '0.0.0.0',
    PORT: '8080',
    COOKIE_SECURE: 'true',
    MOVIE_DEMO_DB_PATH: '/var/lib/movie-booking/movie-demo.db',
  }), {
    host: '0.0.0.0',
    port: 8080,
    secureCookies: true,
    dbPath: '/var/lib/movie-booking/movie-demo.db',
  });
  assert.throws(() => readServerConfig({ HOST: ' ' }), /HOST/);
  assert.throws(() => readServerConfig({ PORT: '0' }), /PORT/);
  assert.throws(() => readServerConfig({ PORT: '65536' }), /PORT/);
  assert.throws(() => readServerConfig({ PORT: 'abc' }), /PORT/);
  assert.throws(() => readServerConfig({ COOKIE_SECURE: 'yes' }), /COOKIE_SECURE/);
});

test('rejects explicitly empty deployment server settings', () => {
  assert.throws(() => readServerConfig({ HOST: '' }), /HOST/);
  assert.throws(() => readServerConfig({ PORT: '' }), /PORT/);
  assert.throws(() => readServerConfig({ COOKIE_SECURE: '' }), /COOKIE_SECURE/);
});

test('keeps HTTP connections alive beyond the GCP backend timeout', () => {
  const { db, app } = testApp();
  try {
    assert.equal(app.keepAliveTimeout, 620_000);
  } finally {
    db.close();
  }
});

test('serves only the three built frontend assets with their correct content types', async () => {
  const { db, app } = testApp();
  const baseUrl = await listen(app);

  try {
    for (const [path, contentType] of [
      ['/', 'text/html; charset=utf-8'],
      ['/app.js', 'text/javascript; charset=utf-8'],
      ['/style.css', 'text/css; charset=utf-8'],
    ]) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('content-type'), contentType, path);
      if (path === '/') assert.match(await response.text(), /data-app="movie-booking"/);
    }

    for (const path of [
      '/?cache=1',
      '/app.js?cache=1',
      '/style.css?cache=1',
      '/../app.js',
      '/api/../app.js',
      '/api/%2e%2e/app.js',
    ]) {
      const status = await new Promise<number>((resolve, reject) => {
        const outgoing = httpRequest(baseUrl, { path }, (incoming) => {
          incoming.resume();
          resolve(incoming.statusCode ?? 0);
        });
        outgoing.on('error', reject);
        outgoing.end();
      });
      assert.equal(status, 404, path);
    }
  } finally {
    await close(app);
    db.close();
  }
});

test('treats malformed cookie encoding as unauthenticated', async () => {
  const { db, app } = testApp();
  const baseUrl = await listen(app);

  try {
    const { response } = await request(baseUrl, '/api/bootstrap', {
      cookie: 'movie_demo_session=%E0%A4%A',
    });
    assert.equal(response.status, 401);
  } finally {
    await close(app);
    db.close();
  }
});

test('returns client errors for invalid and duplicate registration', async () => {
  const { db, app } = testApp();
  const baseUrl = await listen(app);

  try {
    const shortPassword = await request(baseUrl, '/api/register', {
      method: 'POST',
      body: { email: 'alice@example.com', password: 'short' },
    });
    assert.equal(shortPassword.response.status, 400);

    await register(baseUrl, 'alice@example.com');
    const duplicate = await request(baseUrl, '/api/register', {
      method: 'POST',
      body: { email: ' ALICE@example.com ', password: 'another correct password' },
    });
    assert.equal(duplicate.response.status, 400);
  } finally {
    await close(app);
    db.close();
  }
});

test('resumes the most recently chatted conversation', async () => {
  const { db, app } = testApp();
  const baseUrl = await listen(app);

  try {
    const cookie = await register(baseUrl, 'alice@example.com');
    const first = await request(baseUrl, '/api/conversations', { method: 'POST', cookie });
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
    const second = await request(baseUrl, '/api/conversations', { method: 'POST', cookie });

    const beforeChat = await request(baseUrl, '/api/bootstrap', { cookie });
    assert.deepEqual(
      beforeChat.body.conversations.map((conversation: { id: string }) => conversation.id),
      [second.body.id, first.body.id],
    );

    const chat = await request(baseUrl, `/api/conversations/${first.body.id as string}/chat`, {
      method: 'POST',
      cookie,
      body: { message: 'Resume this chat' },
    });
    assert.equal(chat.response.status, 200);
    assert.equal(chat.body.conversation.title, 'Resume this chat');

    const bootstrap = await request(baseUrl, '/api/bootstrap', { cookie });
    assert.deepEqual(
      bootstrap.body.conversations.map((conversation: { id: string; title: string }) => ({
        id: conversation.id,
        title: conversation.title,
      })),
      [
        { id: first.body.id, title: 'Resume this chat' },
        { id: second.body.id, title: 'New chat' },
      ],
    );
  } finally {
    await close(app);
    db.close();
  }
});

test('normalizes and caps the generated conversation title', async () => {
  const { db, app } = testApp();
  const baseUrl = await listen(app);

  try {
    const cookie = await register(baseUrl, 'alice@example.com');
    const conversation = await request(baseUrl, '/api/conversations', { method: 'POST', cookie });
    const chat = await request(
      baseUrl,
      `/api/conversations/${conversation.body.id as string}/chat`,
      {
        method: 'POST',
        cookie,
        body: {
          message: '  Find   tickets\nfor Dune Part Two at PVR Phoenix this Saturday evening please  ',
        },
      },
    );

    assert.equal(
      chat.body.conversation.title,
      'Find tickets for Dune Part Two at PVR Phoenix this Saturday',
    );
  } finally {
    await close(app);
    db.close();
  }
});

test('does not split the final character when capping a conversation title', async () => {
  const { db, app } = testApp();
  const baseUrl = await listen(app);

  try {
    const cookie = await register(baseUrl, 'alice@example.com');
    const conversation = await request(baseUrl, '/api/conversations', { method: 'POST', cookie });
    const prefix = 'A'.repeat(59);
    const chat = await request(
      baseUrl,
      `/api/conversations/${conversation.body.id as string}/chat`,
      {
        method: 'POST',
        cookie,
        body: { message: `${prefix}😀😀` },
      },
    );

    assert.equal(chat.body.conversation.title, `${prefix}😀`);
  } finally {
    await close(app);
    db.close();
  }
});

test('preserves a non-default conversation title after chat', async () => {
  const { db, app } = testApp();
  const baseUrl = await listen(app);

  try {
    const cookie = await register(baseUrl, 'alice@example.com');
    const conversation = await request(baseUrl, '/api/conversations', {
      method: 'POST',
      cookie,
      body: { title: 'Pinned plan' },
    });
    const chat = await request(
      baseUrl,
      `/api/conversations/${conversation.body.id as string}/chat`,
      {
        method: 'POST',
        cookie,
        body: { message: 'Replace this title' },
      },
    );

    assert.equal(chat.body.conversation.title, 'Pinned plan');
  } finally {
    await close(app);
    db.close();
  }
});

test('keeps the default title when chat fails', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'movie-demo-server-'));
  const db = openDatabase(join(directory, 'app.db'));
  const app = createApp({
    db,
    hermes: {
      createSession: async () => 'movie_fixture',
      getMessages: async () => [],
      chat: async () => { throw new Error('Hermes unavailable'); },
      chatStream: async () => { throw new Error('Hermes unavailable'); },
    },
  });
  const baseUrl = await listen(app);

  try {
    const cookie = await register(baseUrl, 'alice@example.com');
    const conversation = await request(baseUrl, '/api/conversations', { method: 'POST', cookie });
    const chat = await request(
      baseUrl,
      `/api/conversations/${conversation.body.id as string}/chat`,
      {
        method: 'POST',
        cookie,
        body: { message: 'Do not use this title yet' },
      },
    );
    assert.equal(chat.response.status, 500);

    const bootstrap = await request(baseUrl, '/api/bootstrap', { cookie });
    assert.equal(bootstrap.body.conversations[0].title, 'New chat');
  } finally {
    await close(app);
    db.close();
  }
});

test('returns the authenticated booking snapshot completed during a Hermes turn', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'movie-demo-server-'));
  const db = openDatabase(join(directory, 'app.db'));
  let userId = '';
  const app = createApp({
    db,
    hermes: {
      createSession: async () => 'movie_fixture',
      getMessages: async () => [],
      chat: async () => {
        const attempt = createBookingAttempt(db, userId, {
          conversationId: null,
          status: 'pending_payment',
          movie: 'Dune',
          cinema: 'PVR Phoenix',
          showTime: '2026-07-28T19:00:00+05:30',
          showTarget: 'show-1',
          formatId: 'imax',
          contentId: 'dune-2',
          seats: ['A1', 'A2'],
          amountPaise: 80000,
        });
        recordDistrictBookingResult(db, userId, attempt.id, {
          status: 'confirmed',
          bookingId: 'DBX123456',
        });
        return {
          object: 'hermes.session.chat.completion',
          session_id: 'movie_fixture',
          message: { role: 'assistant' as const, content: 'District confirmed DBX123456' },
        };
      },
      chatStream: async () => {
        throw new Error('not used');
      },
    },
  });
  const baseUrl = await listen(app);

  try {
    const cookie = await register(baseUrl, 'alice@example.com');
    const bootstrap = await request(baseUrl, '/api/bootstrap', { cookie });
    userId = bootstrap.body.user.id as string;
    const conversation = await request(baseUrl, '/api/conversations', {
      method: 'POST',
      cookie,
    });
    const chat = await request(
      baseUrl,
      `/api/conversations/${conversation.body.id as string}/chat`,
      {
        method: 'POST',
        cookie,
        body: { message: "I've paid" },
      },
    );

    assert.equal(chat.response.status, 200);
    assert.deepEqual(
      chat.body.bookings.map((booking: { status: string; districtBookingId: string }) => ({
        status: booking.status,
        districtBookingId: booking.districtBookingId,
      })),
      [{ status: 'confirmed', districtBookingId: 'DBX123456' }],
    );
  } finally {
    await close(app);
    db.close();
  }
});

test('rejects unauthenticated streaming chat before sending SSE headers', async () => {
  const { db, app } = testApp();
  const baseUrl = await listen(app);

  try {
    const response = await fetch(`${baseUrl}/api/conversations/missing/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Find Dune' }),
    });

    assert.equal(response.status, 401);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
    assert.deepEqual(await response.json(), { error: 'authentication required' });
  } finally {
    await close(app);
    db.close();
  }
});

test('relays safe Hermes events and authoritative streamed completion state', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'movie-demo-server-'));
  const db = openDatabase(join(directory, 'app.db'));
  let userId = '';
  let seenSessionKey = '';
  const app = createApp({
    db,
    hermes: {
      createSession: async () => 'movie_fixture',
      getMessages: async () => [],
      chat: async () => {
        throw new Error('not used');
      },
      chatStream: async (sessionId, sessionKey, message, onEvent) => {
        assert.equal(sessionId, 'movie_fixture');
        assert.equal(message, 'Find Dune');
        seenSessionKey = sessionKey;
        onEvent({ type: 'assistant.delta', delta: 'Du' });
        onEvent({ type: 'activity', active: true });
        onEvent({ type: 'activity', active: false });
        const attempt = createBookingAttempt(db, userId, {
          conversationId: null,
          status: 'pending_payment',
          movie: 'Dune',
          cinema: 'PVR Phoenix',
          showTime: '2026-07-30T19:00:00+05:30',
          showTarget: 'show-1',
          formatId: 'imax',
          contentId: 'dune-2',
          seats: ['A1', 'A2'],
          amountPaise: 80000,
        });
        recordDistrictBookingResult(db, userId, attempt.id, {
          status: 'confirmed',
          bookingId: 'DBX123456',
        });
        return {
          object: 'hermes.session.chat.completion',
          session_id: sessionId,
          message: { role: 'assistant', content: 'Dune is playing.' },
        };
      },
    },
  });
  const baseUrl = await listen(app);

  try {
    const cookie = await register(baseUrl, 'alice@example.com');
    const bootstrap = await request(baseUrl, '/api/bootstrap', { cookie });
    userId = bootstrap.body.user.id as string;
    const conversation = await request(baseUrl, '/api/conversations', { method: 'POST', cookie });
    const response = await fetch(
      `${baseUrl}/api/conversations/${conversation.body.id as string}/chat/stream`,
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'Find Dune' }),
      },
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
    const raw = await response.text();
    assert.match(raw, /^: connected\n\n/);
    const events = parseSse(raw);
    assert.deepEqual(events.slice(0, 3), [
      { event: 'assistant.delta', data: { delta: 'Du' } },
      { event: 'activity', data: { active: true } },
      { event: 'activity', data: { active: false } },
    ]);
    assert.equal(events.length, 4);
    assert.equal(events[3].event, 'chat.completed');
    assert.deepEqual(Object.keys(events[3].data).sort(), ['bookings', 'conversation', 'message']);
    assert.deepEqual(events[3].data.message, { role: 'assistant', content: 'Dune is playing.' });
    assert.equal(events[3].data.conversation.title, 'Find Dune');
    assert.deepEqual(
      events[3].data.bookings.map((booking: { status: string; districtBookingId: string }) => ({
        status: booking.status,
        districtBookingId: booking.districtBookingId,
      })),
      [{ status: 'confirmed', districtBookingId: 'DBX123456' }],
    );
    assert.equal(seenSessionKey, `movie-demo:user:${userId}`);
  } finally {
    await close(app);
    db.close();
  }
});

test('emits one safe stream error without finalizing a failed turn', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'movie-demo-server-'));
  const db = openDatabase(join(directory, 'app.db'));
  const app = createApp({
    db,
    hermes: {
      createSession: async () => 'movie_fixture',
      getMessages: async () => [],
      chat: async () => {
        throw new Error('not used');
      },
      chatStream: async () => {
        throw new Error('upstream secret');
      },
    },
  });
  const baseUrl = await listen(app);

  try {
    const cookie = await register(baseUrl, 'alice@example.com');
    const conversation = await request(baseUrl, '/api/conversations', { method: 'POST', cookie });
    const response = await fetch(
      `${baseUrl}/api/conversations/${conversation.body.id as string}/chat/stream`,
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'Do not finalize this' }),
      },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(parseSse(await response.text()), [
      { event: 'error', data: { error: 'Hermes request failed' } },
    ]);
    const bootstrap = await request(baseUrl, '/api/bootstrap', { cookie });
    assert.equal(bootstrap.body.conversations[0].title, 'New chat');
    assert.equal(bootstrap.body.conversations[0].updatedAt, conversation.body.updatedAt);
  } finally {
    await close(app);
    db.close();
  }
});

test('preserves the synchronous chat JSON response', async () => {
  const { db, app } = testApp();
  const baseUrl = await listen(app);

  try {
    const cookie = await register(baseUrl, 'alice@example.com');
    const conversation = await request(baseUrl, '/api/conversations', { method: 'POST', cookie });
    const chat = await request(baseUrl, `/api/conversations/${conversation.body.id as string}/chat`, {
      method: 'POST',
      cookie,
      body: { message: 'Find Dune' },
    });

    assert.equal(chat.response.status, 200);
    assert.deepEqual(Object.keys(chat.body).sort(), [
      'bookings',
      'conversation',
      'message',
      'object',
      'session_id',
    ]);
    assert.equal(chat.body.object, 'hermes.session.chat.completion');
    assert.equal(chat.body.session_id, 'movie_fixture');
    assert.deepEqual(chat.body.message, { role: 'assistant', content: 'ok' });
    assert.equal(chat.body.conversation.title, 'Find Dune');
    assert.deepEqual(chat.body.bookings, []);
  } finally {
    await close(app);
    db.close();
  }
});

test('decodes JSON after joining split UTF-8 request chunks', async () => {
  const { db, app } = testApp();
  const baseUrl = await listen(app);

  try {
    const cookie = await register(baseUrl, 'alice@example.com');
    const body = Buffer.from(JSON.stringify({ title: 'Café night' }));
    const split = body.indexOf(Buffer.from('é')) + 1;
    const url = new URL('/api/conversations', baseUrl);
    const result = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const outgoing = httpRequest(url, {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          'content-length': body.length,
        },
      }, async (incoming) => {
        let raw = '';
        for await (const chunk of incoming) raw += chunk;
        resolve({ status: incoming.statusCode ?? 0, body: JSON.parse(raw) });
      });
      outgoing.on('error', reject);
      outgoing.setNoDelay(true);
      outgoing.write(body.subarray(0, split));
      setTimeout(() => outgoing.end(body.subarray(split)), 10);
    });

    assert.equal(result.status, 201);
    assert.equal(result.body.title, 'Café night');
  } finally {
    await close(app);
    db.close();
  }
});

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

    const stream = await request(baseUrl, `/api/conversations/${conversationId}/chat/stream`, {
      method: 'POST',
      cookie: bobCookie,
      body: { message: 'Find Dune' },
    });
    assert.equal(stream.response.status, 404);
    assert.match(stream.response.headers.get('content-type') ?? '', /^application\/json/);
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

test('serializes same-user streaming turns through terminal completion', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'movie-demo-server-'));
  const db = openDatabase(join(directory, 'app.db'));
  let arrivals = 0;
  let firstArrived!: () => void;
  let releaseFirst!: () => void;
  const arrived = new Promise<void>((resolve) => { firstArrived = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const app = createApp({
    db,
    hermes: {
      createSession: async () => 'movie_fixture',
      getMessages: async () => [],
      chat: async () => {
        throw new Error('not used');
      },
      chatStream: async (sessionId, _sessionKey, message, onEvent) => {
        arrivals += 1;
        onEvent({ type: 'assistant.delta', delta: message });
        if (arrivals === 1) {
          firstArrived();
          await blocked;
        }
        return {
          object: 'hermes.session.chat.completion',
          session_id: sessionId,
          message: { role: 'assistant', content: `${message} complete` },
        };
      },
    },
  });
  const baseUrl = await listen(app);

  try {
    const cookie = await register(baseUrl, 'alice@example.com');
    const conversation = await request(baseUrl, '/api/conversations', { method: 'POST', cookie });
    const path = `${baseUrl}/api/conversations/${conversation.body.id as string}/chat/stream`;
    const firstResponse = await fetch(path, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'first' }),
    });
    await within(arrived);
    const secondResponsePromise = fetch(path, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'second' }),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(arrivals, 1);

    releaseFirst();
    const secondResponse = await secondResponsePromise;
    const [firstEvents, secondEvents] = await Promise.all([
      firstResponse.text().then(parseSse),
      secondResponse.text().then(parseSse),
    ]);
    assert.equal(arrivals, 2);
    assert.equal(firstEvents.at(-1)?.event, 'chat.completed');
    assert.equal(firstEvents.at(-1)?.data.message.content, 'first complete');
    assert.equal(secondEvents.at(-1)?.event, 'chat.completed');
    assert.equal(secondEvents.at(-1)?.data.message.content, 'second complete');
  } finally {
    releaseFirst();
    await close(app);
    db.close();
  }
});

test('continues accepted Hermes finalization after the streaming client disconnects', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'movie-demo-server-'));
  const db = openDatabase(join(directory, 'app.db'));
  let userId = '';
  let conversationId = '';
  let sessionNumber = 0;
  let releaseStream!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseStream = resolve; });
  const app = createApp({
    db,
    hermes: {
      createSession: async () => `movie_fixture_${++sessionNumber}`,
      getMessages: async () => [],
      chat: async () => {
        throw new Error('not used');
      },
      chatStream: async (sessionId, _sessionKey, _message, onEvent) => {
        onEvent({ type: 'assistant.delta', delta: 'Du' });
        await blocked;
        const attempt = createBookingAttempt(db, userId, {
          conversationId,
          status: 'pending_payment',
          movie: 'Dune',
          cinema: 'PVR Phoenix',
          showTime: '2026-07-30T19:00:00+05:30',
          showTarget: 'show-1',
          formatId: 'imax',
          contentId: 'dune-2',
          seats: ['A1', 'A2'],
          amountPaise: 80000,
        });
        recordDistrictBookingResult(db, userId, attempt.id, {
          status: 'confirmed',
          bookingId: 'DBX123456',
        });
        return {
          object: 'hermes.session.chat.completion',
          session_id: sessionId,
          message: { role: 'assistant', content: 'Dune is playing.' },
        };
      },
    },
  });
  const baseUrl = await listen(app);

  try {
    const cookie = await register(baseUrl, 'alice@example.com');
    const bootstrap = await request(baseUrl, '/api/bootstrap', { cookie });
    userId = bootstrap.body.user.id as string;
    const first = await request(baseUrl, '/api/conversations', { method: 'POST', cookie });
    conversationId = first.body.id as string;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
    const second = await request(baseUrl, '/api/conversations', { method: 'POST', cookie });

    await new Promise<void>((resolve, reject) => {
      const body = JSON.stringify({ message: 'Find Dune' });
      const outgoing = httpRequest(
        new URL(`/api/conversations/${conversationId}/chat/stream`, baseUrl),
        {
          method: 'POST',
          headers: {
            cookie,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
        },
        (incoming) => {
          let raw = '';
          incoming.setEncoding('utf8');
          incoming.on('data', (chunk) => {
            raw += chunk;
            if (raw.includes('event: assistant.delta')) {
              incoming.destroy();
              outgoing.destroy();
              resolve();
            }
          });
          incoming.on('end', () => reject(new Error('stream ended before the first assistant delta')));
        },
      );
      outgoing.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNRESET') resolve();
        else reject(error);
      });
      outgoing.end(body);
    });

    releaseStream();
    const messages = await request(
      baseUrl,
      `/api/conversations/${conversationId}/messages`,
      { cookie },
    );
    assert.equal(messages.response.status, 200);
    const after = await request(baseUrl, '/api/bootstrap', { cookie });
    assert.deepEqual(
      after.body.conversations.map((conversation: { id: string; title: string }) => ({
        id: conversation.id,
        title: conversation.title,
      })),
      [
        { id: conversationId, title: 'Find Dune' },
        { id: second.body.id, title: 'New chat' },
      ],
    );
    assert.deepEqual(
      after.body.bookings.map((booking: { status: string; districtBookingId: string }) => ({
        status: booking.status,
        districtBookingId: booking.districtBookingId,
      })),
      [{ status: 'confirmed', districtBookingId: 'DBX123456' }],
    );
  } finally {
    releaseStream();
    await close(app);
    db.close();
  }
});

test('waits for a pending user turn before reading its completed transcript', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'movie-demo-server-'));
  const db = openDatabase(join(directory, 'app.db'));
  let transcript: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  let readStarted = false;
  let chatArrived!: () => void;
  let readArrived!: () => void;
  let releaseChat!: () => void;
  const arrived = new Promise<void>((resolve) => { chatArrived = resolve; });
  const readReachedApp = new Promise<void>((resolve) => { readArrived = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseChat = resolve; });
  const app = createApp({
    db,
    hermes: {
      createSession: async () => 'movie_fixture',
      getMessages: async () => {
        readStarted = true;
        return transcript;
      },
      chat: async () => {
        chatArrived();
        await blocked;
        transcript = [
          { role: 'user', content: 'Find Dune' },
          { role: 'assistant', content: 'Dune is playing.' },
        ];
        return {
          object: 'hermes.session.chat.completion',
          session_id: 'movie_fixture',
          message: transcript[1],
        };
      },
      chatStream: async () => {
        throw new Error('not used');
      },
    },
  });
  app.prependListener('request', (incoming) => {
    if (incoming.url?.endsWith('/messages')) readArrived();
  });
  const baseUrl = await listen(app);

  try {
    const cookie = await register(baseUrl, 'alice@example.com');
    const created = await request(baseUrl, '/api/conversations', { method: 'POST', cookie });
    const conversationPath = `/api/conversations/${created.body.id as string}`;
    const chat = request(baseUrl, `${conversationPath}/chat`, {
      method: 'POST',
      cookie,
      body: { message: 'Find Dune' },
    });
    await arrived;

    const messages = request(baseUrl, `${conversationPath}/messages`, { cookie });
    await readReachedApp;
    assert.equal(readStarted, false);

    releaseChat();
    const [chatResponse, messagesResponse] = await Promise.all([chat, messages]);
    assert.equal(chatResponse.response.status, 200);
    assert.equal(messagesResponse.response.status, 200);
    assert.deepEqual(messagesResponse.body, transcript);
  } finally {
    releaseChat();
    await close(app);
    db.close();
  }
});
