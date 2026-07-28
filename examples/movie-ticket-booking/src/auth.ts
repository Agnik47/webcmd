import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  createUserRecord,
  findUserByEmail,
  type UserRecord,
} from './db.js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function passwordHash(password: string): string {
  if (password.length < 8) throw new Error('password must contain at least 8 characters');
  const salt = randomBytes(16);
  const digest = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${digest.toString('hex')}`;
}

function passwordMatches(password: string, encoded: string): boolean {
  const [algorithm, saltHex, digestHex] = encoded.split('$');
  if (algorithm !== 'scrypt' || !saltHex || !digestHex) return false;
  const expected = Buffer.from(digestHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createUser(db: DatabaseSync, email: string, password: string): UserRecord {
  try {
    return createUserRecord(db, email, passwordHash(password));
  } catch (error) {
    if (/unique constraint failed: users\.email/i.test(String(error))) {
      throw new Error('email is already registered');
    }
    throw error;
  }
}

export function verifyCredentials(db: DatabaseSync, email: string, password: string): UserRecord | null {
  const user = findUserByEmail(db, email);
  return user && passwordMatches(password, user.passwordHash) ? user : null;
}

export function createLoginSession(
  db: DatabaseSync,
  userId: string,
  now = Date.now(),
): { token: string; expiresAt: number } {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = now + SESSION_TTL_MS;
  db.prepare(`
    insert into auth_sessions (token_hash, user_id, expires_at, created_at)
    values (?, ?, ?, ?)
  `).run(tokenHash(token), userId, expiresAt, now);
  return { token, expiresAt };
}

export function findUserBySession(
  db: DatabaseSync,
  token: string,
  now = Date.now(),
): UserRecord | null {
  const row = db.prepare(`
    select users.id, users.email, users.password_hash
    from auth_sessions
    join users on users.id = auth_sessions.user_id
    where auth_sessions.token_hash = ? and auth_sessions.expires_at > ?
  `).get(tokenHash(token), now) as {
    id: string;
    email: string;
    password_hash: string;
  } | undefined;
  return row ? { id: row.id, email: row.email, passwordHash: row.password_hash } : null;
}

export function deleteLoginSession(db: DatabaseSync, token: string): void {
  db.prepare('delete from auth_sessions where token_hash = ?').run(tokenHash(token));
}
