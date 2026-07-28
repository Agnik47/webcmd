import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createBookingAttempt,
  createConversation,
  createUserRecord,
  deleteBookingAttempt,
  deleteConversation,
  deletePreferences,
  findBookingAttempt,
  findConversation,
  getPreferences,
  listBookingAttempts,
  listConversations,
  openDatabase,
  updateBookingAttempt,
  updateConversation,
  updatePreferences,
} from '../src/db.js';

test('creates conversations and preferences scoped to one user', () => {
  const directory = mkdtempSync(join(tmpdir(), 'movie-demo-db-'));
  const db = openDatabase(join(directory, 'app.db'));
  const alice = createUserRecord(db, 'alice@example.com', 'hash-a');
  const bob = createUserRecord(db, 'bob@example.com', 'hash-b');

  createConversation(db, alice.id, 'hermes-a', 'Movie night');
  createConversation(db, bob.id, 'hermes-b', 'Other movie');
  assert.deepEqual(listConversations(db, alice.id).map((row) => row.hermesSessionId), ['hermes-a']);

  updatePreferences(db, alice.id, {
    city: 'Mumbai',
    languages: ['Hindi', 'English'],
    formats: ['IMAX'],
    seatPosition: 'back-centre',
    budgetPaise: 80000,
  });
  assert.deepEqual(getPreferences(db, alice.id), {
    city: 'Mumbai',
    languages: ['Hindi', 'English'],
    formats: ['IMAX'],
    seatPosition: 'back-centre',
    budgetPaise: 80000,
  });
  assert.equal(getPreferences(db, bob.id).city, '');
  db.close();
});

test('keeps conversation and booking-attempt CRUD scoped to their owner', () => {
  const directory = mkdtempSync(join(tmpdir(), 'movie-demo-db-'));
  const db = openDatabase(join(directory, 'app.db'));
  const alice = createUserRecord(db, 'alice@example.com', 'hash-a');
  const bob = createUserRecord(db, 'bob@example.com', 'hash-b');
  const conversation = createConversation(db, alice.id, 'hermes-a');

  assert.equal(updateConversation(db, alice.id, conversation.id, 'Movie night')?.title, 'Movie night');
  assert.equal(findConversation(db, bob.id, conversation.id), null);
  assert.equal(deleteConversation(db, bob.id, conversation.id), false);

  const attempt = createBookingAttempt(db, alice.id, {
    conversationId: conversation.id,
    status: 'pending',
    movie: 'Example Movie',
    cinema: 'Example Cinema',
    showTime: '2026-07-28T19:00:00+05:30',
    showTarget: 'show-1',
    formatId: 'imax',
    contentId: 'movie-1',
    seats: ['A1', 'A2'],
    amountPaise: 80000,
  });
  assert.deepEqual(listBookingAttempts(db, alice.id).map((row) => row.id), [attempt.id]);
  assert.equal(findBookingAttempt(db, bob.id, attempt.id), null);
  assert.equal(updateBookingAttempt(db, bob.id, attempt.id, { status: 'failed' }), null);
  assert.equal(updateBookingAttempt(db, alice.id, attempt.id, { status: 'confirmed', districtBookingId: 'district-1' })?.status, 'confirmed');
  assert.equal(deleteBookingAttempt(db, bob.id, attempt.id), false);
  assert.equal(deleteBookingAttempt(db, alice.id, attempt.id), true);

  updatePreferences(db, alice.id, { city: 'Mumbai', languages: [], formats: [], seatPosition: '', budgetPaise: 0 });
  assert.equal(deletePreferences(db, alice.id), true);
  assert.equal(deleteConversation(db, alice.id, conversation.id), true);
  db.close();
});
