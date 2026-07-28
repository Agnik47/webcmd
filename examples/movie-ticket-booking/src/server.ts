import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import {
  createLoginSession,
  createUser,
  deleteLoginSession,
  findUserBySession,
  verifyCredentials,
} from './auth.js';
import {
  createConversation,
  findConversation,
  getPreferences,
  listBookingAttempts,
  listConversations,
  openDatabase,
  touchConversation,
  updatePreferences,
  type Preferences,
  type UserRecord,
} from './db.js';
import { HermesClient, HermesHttpError } from './hermes.js';
import { PerUserQueue } from './user-queue.js';

const COOKIE = 'movie_demo_session';
const MAX_JSON_BYTES = 64 * 1024;
const PUBLIC_FILES = new Map([
  ['/', { url: new URL('../public/index.html', import.meta.url), type: 'text/html; charset=utf-8' }],
  ['/app.js', { url: new URL('../public/app.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
  ['/style.css', { url: new URL('../public/style.css', import.meta.url), type: 'text/css; charset=utf-8' }],
]);

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface AppOptions {
  db: DatabaseSync;
  hermes: Pick<HermesClient, 'createSession' | 'getMessages' | 'chat'>;
  userQueue?: PerUserQueue;
}

function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(body));
}

function cookieToken(request: IncomingMessage): string {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === COOKIE) return value.join('=');
  }
  return '';
}

function requireUser(db: DatabaseSync, request: IncomingMessage): UserRecord {
  const user = findUserBySession(db, cookieToken(request));
  if (!user) throw new HttpError(401, 'authentication required');
  return user;
}

async function readJson(request: IncomingMessage, allowEmpty = false): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_JSON_BYTES) throw new HttpError(413, 'request body is too large');
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks, bytes).toString('utf8');
  if (!raw && allowEmpty) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new HttpError(400, 'request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function loginInput(body: Record<string, unknown>): { email: string; password: string } {
  const { email, password } = body;
  if (typeof email !== 'string' || !email.includes('@') || email.length > 320) {
    throw new HttpError(400, 'valid email is required');
  }
  if (typeof password !== 'string' || password.length < 8) {
    throw new HttpError(400, 'password must contain at least 8 characters');
  }
  return { email, password };
}

function loginResponse(db: DatabaseSync, user: UserRecord): {
  body: { user: { id: string; email: string } };
  cookie: string;
} {
  const { token } = createLoginSession(db, user.id);
  return {
    body: { user: { id: user.id, email: user.email } },
    cookie: `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
  };
}

function preferencesInput(body: Record<string, unknown>): Preferences {
  const { city, languages, formats, seatPosition, budgetPaise } = body;
  if (
    typeof city !== 'string'
    || !Array.isArray(languages) || !languages.every((value) => typeof value === 'string')
    || !Array.isArray(formats) || !formats.every((value) => typeof value === 'string')
    || typeof seatPosition !== 'string'
    || !Number.isSafeInteger(budgetPaise) || (budgetPaise as number) < 0
  ) {
    throw new HttpError(400, 'invalid preferences');
  }
  return {
    city,
    languages: languages as string[],
    formats: formats as string[],
    seatPosition,
    budgetPaise: budgetPaise as number,
  };
}

export function createApp({ db, hermes, userQueue = new PerUserQueue() }: AppOptions) {
  return createServer(async (request, response) => {
    try {
      const method = request.method ?? 'GET';
      const rawUrl = request.url ?? '/';

      if (method === 'GET') {
        const file = PUBLIC_FILES.get(rawUrl);
        if (file) {
          response.writeHead(200, { 'content-type': file.type });
          response.end(await readFile(file.url));
          return;
        }
      }

      const path = new URL(rawUrl, 'http://localhost').pathname;
      if (method === 'GET') {
        if (!path.startsWith('/api/')) throw new HttpError(404, 'not found');
      }

      if (method === 'POST' && path === '/api/register') {
        const input = loginInput(await readJson(request));
        let user: UserRecord;
        try {
          user = createUser(db, input.email, input.password);
        } catch (error) {
          if (/email is already registered/.test(String(error))) {
            throw new HttpError(400, 'email is already registered');
          }
          throw error;
        }
        const login = loginResponse(db, user);
        send(response, 201, login.body, { 'set-cookie': login.cookie });
        return;
      }

      if (method === 'POST' && path === '/api/login') {
        const input = loginInput(await readJson(request));
        const user = verifyCredentials(db, input.email, input.password);
        if (!user) throw new HttpError(401, 'invalid email or password');
        const login = loginResponse(db, user);
        send(response, 200, login.body, { 'set-cookie': login.cookie });
        return;
      }

      if (method === 'POST' && path === '/api/logout') {
        const token = cookieToken(request);
        if (token) deleteLoginSession(db, token);
        send(response, 200, { ok: true }, {
          'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
        });
        return;
      }

      const user = requireUser(db, request);

      if (method === 'GET' && path === '/api/bootstrap') {
        send(response, 200, {
          user: { id: user.id, email: user.email },
          preferences: getPreferences(db, user.id),
          conversations: listConversations(db, user.id),
          bookings: listBookingAttempts(db, user.id),
        });
        return;
      }

      if (path === '/api/conversations' && method === 'GET') {
        send(response, 200, listConversations(db, user.id));
        return;
      }

      if (path === '/api/conversations' && method === 'POST') {
        const body = await readJson(request, true);
        if (body.title !== undefined && typeof body.title !== 'string') {
          throw new HttpError(400, 'title must be a string');
        }
        const hermesSessionId = await hermes.createSession();
        const conversation = createConversation(
          db,
          user.id,
          hermesSessionId,
          typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 200) : undefined,
        );
        send(response, 201, conversation);
        return;
      }

      if (path === '/api/preferences' && method === 'GET') {
        send(response, 200, getPreferences(db, user.id));
        return;
      }

      if (path === '/api/preferences' && (method === 'PUT' || method === 'PATCH')) {
        send(response, 200, updatePreferences(db, user.id, preferencesInput(await readJson(request))));
        return;
      }

      const conversationRoute = path.match(/^\/api\/conversations\/([^/]+)\/(messages|chat)$/);
      if (conversationRoute) {
        let conversationId: string;
        try {
          conversationId = decodeURIComponent(conversationRoute[1]);
        } catch {
          throw new HttpError(404, 'not found');
        }
        const conversation = findConversation(db, user.id, conversationId);
        if (!conversation) throw new HttpError(404, 'not found');

        if (method === 'GET' && conversationRoute[2] === 'messages') {
          send(response, 200, await hermes.getMessages(conversation.hermesSessionId));
          return;
        }

        if (method === 'POST' && conversationRoute[2] === 'chat') {
          const body = await readJson(request);
          if (typeof body.message !== 'string' || !body.message.trim()) {
            throw new HttpError(400, 'message is required');
          }
          const result = await userQueue.run(user.id, async () => {
            const chat = await hermes.chat(
              conversation.hermesSessionId,
              `movie-demo:user:${user.id}`,
              body.message as string,
            );
            touchConversation(db, user.id, conversation.id);
            return { ...chat, bookings: listBookingAttempts(db, user.id) };
          });
          send(response, 200, result);
          return;
        }
      }

      throw new HttpError(404, 'not found');
    } catch (error) {
      if (response.headersSent) return;
      if (error instanceof HttpError || error instanceof HermesHttpError) {
        send(response, error.status, { error: error.message });
        return;
      }
      send(response, 500, { error: 'internal server error' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = openDatabase(process.env.MOVIE_DEMO_DB_PATH ?? 'movie-demo.db');
  const app = createApp({ db, hermes: new HermesClient() });
  app.listen(Number(process.env.PORT ?? 3000), '127.0.0.1');
}
