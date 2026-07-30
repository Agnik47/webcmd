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
  updateConversation,
  updatePreferences,
  type Preferences,
  type UserRecord,
} from './db.js';
import { HermesClient, HermesHttpError } from './hermes.js';
import { PerUserQueue } from './user-queue.js';

const COOKIE = 'movie_demo_session';
const MAX_JSON_BYTES = 64 * 1024;
const PUBLIC_FILES = new Map([
  ['/', { url: new URL('../dist/index.html', import.meta.url), type: 'text/html; charset=utf-8' }],
  ['/app.js', { url: new URL('../dist/app.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
  ['/style.css', { url: new URL('../dist/style.css', import.meta.url), type: 'text/css; charset=utf-8' }],
]);

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface AppOptions {
  db: DatabaseSync;
  hermes: Pick<HermesClient, 'createSession' | 'getMessages' | 'chat' | 'chatStream'>;
  userQueue?: PerUserQueue;
  secureCookies?: boolean;
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

function sessionCookieAttributes(secureCookies: boolean): string {
  return `Path=/; HttpOnly; SameSite=Lax${secureCookies ? '; Secure' : ''}`;
}

function loginResponse(db: DatabaseSync, user: UserRecord, secureCookies: boolean): {
  body: { user: { id: string; email: string } };
  cookie: string;
} {
  const { token } = createLoginSession(db, user.id);
  return {
    body: { user: { id: user.id, email: user.email } },
    cookie: `${COOKIE}=${encodeURIComponent(token)}; ${sessionCookieAttributes(secureCookies)}; Max-Age=604800`,
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

function finalizeTurn(
  db: DatabaseSync,
  userId: string,
  conversationId: string,
  message: string,
) {
  if (findConversation(db, userId, conversationId)?.title === 'New chat') {
    const title = message.replace(/\s+/gu, ' ').trim();
    updateConversation(
      db,
      userId,
      conversationId,
      [...title].slice(0, 60).join('').trimEnd(),
    );
  }
  return {
    conversation: touchConversation(db, userId, conversationId),
    bookings: listBookingAttempts(db, userId),
  };
}

export function createApp({ db, hermes, userQueue = new PerUserQueue(), secureCookies = false }: AppOptions) {
  const pendingTurns = new Map<string, number>();
  const runTurn = async <T>(
    userId: string,
    conversationId: string,
    task: () => Promise<T>,
  ): Promise<T> => {
    const key = `${userId}:${conversationId}`;
    pendingTurns.set(key, (pendingTurns.get(key) ?? 0) + 1);
    try {
      return await userQueue.run(userId, task);
    } finally {
      const remaining = (pendingTurns.get(key) ?? 1) - 1;
      if (remaining) pendingTurns.set(key, remaining);
      else pendingTurns.delete(key);
    }
  };

  return createServer({ keepAliveTimeout: 620_000 }, async (request, response) => {
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
      if (method === 'GET' && path === '/healthz') {
        send(response, 200, { ok: true });
        return;
      }
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
        const login = loginResponse(db, user, secureCookies);
        send(response, 201, login.body, { 'set-cookie': login.cookie });
        return;
      }

      if (method === 'POST' && path === '/api/login') {
        const input = loginInput(await readJson(request));
        const user = verifyCredentials(db, input.email, input.password);
        if (!user) throw new HttpError(401, 'invalid email or password');
        const login = loginResponse(db, user, secureCookies);
        send(response, 200, login.body, { 'set-cookie': login.cookie });
        return;
      }

      if (method === 'POST' && path === '/api/logout') {
        const token = cookieToken(request);
        if (token) deleteLoginSession(db, token);
        send(response, 200, { ok: true }, {
          'set-cookie': `${COOKIE}=; ${sessionCookieAttributes(secureCookies)}; Max-Age=0`,
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

      const conversationRoute = path.match(/^\/api\/conversations\/([^/]+)\/(messages|chat(?:\/stream)?)$/);
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
          const readMessages = () => hermes.getMessages(conversation.hermesSessionId);
          const turnKey = `${user.id}:${conversation.id}`;
          send(response, 200, await (
            pendingTurns.has(turnKey) ? userQueue.run(user.id, readMessages) : readMessages()
          ));
          return;
        }

        if (method === 'POST' && conversationRoute[2] === 'chat') {
          const body = await readJson(request);
          if (typeof body.message !== 'string' || !body.message.trim()) {
            throw new HttpError(400, 'message is required');
          }
          const result = await runTurn(user.id, conversation.id, async () => {
            const chat = await hermes.chat(
              conversation.hermesSessionId,
              `movie-demo:user:${user.id}`,
              body.message as string,
            );
            return {
              ...chat,
              ...finalizeTurn(db, user.id, conversation.id, body.message as string),
            };
          });
          send(response, 200, result);
          return;
        }

        if (method === 'POST' && conversationRoute[2] === 'chat/stream') {
          const body = await readJson(request);
          if (typeof body.message !== 'string' || !body.message.trim()) {
            throw new HttpError(400, 'message is required');
          }
          response.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          });
          response.write(': connected\n\n');
          const writeSse = (event: string, data: unknown): void => {
            if (response.destroyed || response.writableEnded) return;
            response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          };
          try {
            await runTurn(user.id, conversation.id, async () => {
              const chat = await hermes.chatStream(
                conversation.hermesSessionId,
                `movie-demo:user:${user.id}`,
                body.message as string,
                (event) => {
                  if (event.type === 'assistant.delta') {
                    writeSse(event.type, { delta: event.delta });
                  } else {
                    writeSse(event.type, { active: event.active });
                  }
                },
              );
              writeSse('chat.completed', {
                message: chat.message,
                ...finalizeTurn(db, user.id, conversation.id, body.message as string),
              });
            });
          } catch {
            writeSse('error', { error: 'Hermes request failed' });
          } finally {
            response.end();
          }
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

export function readServerConfig(env: NodeJS.ProcessEnv = process.env): {
  host: string;
  port: number;
  secureCookies: boolean;
  dbPath: string;
} {
  const host = env.HOST ?? '127.0.0.1';
  if (!host.trim()) throw new Error('HOST must not be blank');

  const port = Number(env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  if (env.COOKIE_SECURE !== undefined && env.COOKIE_SECURE !== 'true' && env.COOKIE_SECURE !== 'false') {
    throw new Error('COOKIE_SECURE must be true or false');
  }

  return {
    host,
    port,
    secureCookies: env.COOKIE_SECURE === 'true',
    dbPath: env.MOVIE_DEMO_DB_PATH ?? 'movie-demo.db',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = readServerConfig();
  const db = openDatabase(config.dbPath);
  const app = createApp({ db, hermes: new HermesClient(), secureCookies: config.secureCookies });
  app.listen(config.port, config.host);
}
