import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createLoginSession,
  createUser,
  findUserBySession,
  verifyCredentials,
} from '../src/auth.js';
import { openDatabase } from '../src/db.js';

test('stores password and login tokens as hashes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'movie-demo-auth-'));
  const db = openDatabase(join(directory, 'app.db'));
  const user = createUser(db, ' Alice@Example.COM ', 'correct horse battery staple');

  assert.equal(user.email, 'alice@example.com');
  assert.notEqual(user.passwordHash, 'correct horse battery staple');
  assert.equal(verifyCredentials(db, 'alice@example.com', 'wrong'), null);
  assert.equal(verifyCredentials(db, 'ALICE@example.com', 'correct horse battery staple')?.id, user.id);

  const session = createLoginSession(db, user.id, 0);
  const stored = db.prepare('select token_hash from auth_sessions').get() as { token_hash: string };
  assert.notEqual(stored.token_hash, session.token);
  assert.equal(session.expiresAt, 7 * 24 * 60 * 60 * 1000);
  assert.equal(findUserBySession(db, session.token, session.expiresAt - 1)?.id, user.id);
  assert.equal(findUserBySession(db, session.token, session.expiresAt), null);
  assert.equal(findUserBySession(db, 'wrong'), null);
  db.close();
});

test('rejects duplicate normalized emails', () => {
  const directory = mkdtempSync(join(tmpdir(), 'movie-demo-auth-'));
  const db = openDatabase(join(directory, 'app.db'));
  createUser(db, 'alice@example.com', 'correct horse battery staple');
  assert.throws(
    () => createUser(db, ' ALICE@example.com ', 'another correct password'),
    /already registered/,
  );
  db.close();
});
