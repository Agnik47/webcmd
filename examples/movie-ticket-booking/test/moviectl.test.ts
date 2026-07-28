import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createBookingAttempt,
  createUserRecord,
  findBookingAttempt,
  openDatabase,
} from '../src/db.js';
import { deriveIdentity, runMoviectl } from '../src/moviectl.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'moviectl-'));
  const databasePath = join(directory, 'movie-demo.db');
  const logPath = join(directory, 'webcmd-argv.jsonl');
  const executable = join(directory, 'fake-webcmd');
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.FAKE_WEBCMD_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write(process.env.FAKE_WEBCMD_RESPONSE || '{}');
`);
  chmodSync(executable, 0o755);

  const db = openDatabase(databasePath);
  const user = createUserRecord(db, 'alice@example.com', 'hash');
  db.close();
  const sessionKey = `movie-demo:user:${user.id}`;
  const env = {
    ...process.env,
    MOVIE_DEMO_DB_PATH: databasePath,
    HERMES_SESSION_KEY: sessionKey,
    WEBCMD_BIN: executable,
    FAKE_WEBCMD_LOG: logPath,
    FAKE_WEBCMD_RESPONSE: JSON.stringify([{ movie: 'Dune' }]),
  };
  const calls = () => {
    try {
      return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
    } catch {
      return [];
    }
  };
  return { databasePath, env, sessionKey, user, calls };
}

function unwrap<T>(result: Awaited<ReturnType<typeof runMoviectl>>): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data as T;
}

function prepare(
  state: ReturnType<typeof fixture>,
  show = 'https://www.district.in/movies/seat-layout/imax?encsessionid=show-1',
  seats = 'A1,A2',
) {
  return runMoviectl([
    'district',
    'prepare-checkout',
    show,
    '--movie',
    'Dune',
    '--cinema',
    'PVR Phoenix',
    '--show-time',
    '2026-07-28T19:00:00+05:30',
    '--format-id',
    'imax',
    '--content-id',
    'dune-2',
    '--seats',
    seats,
    '--amount-paise',
    '80000',
  ], state.env);
}

test('derives a stable workspace and fixes WebCMD identity arguments', () => {
  const key = 'movie-demo:user:550e8400-e29b-41d4-a716-446655440000';
  assert.equal(
    deriveIdentity(key).workspace,
    `movie_${createHash('sha256').update(key).digest('hex').slice(0, 32)}`,
  );
  assert.throws(() => deriveIdentity('alice'));

  const state = fixture();
  const result = runMoviectl(
    ['district', 'showtimes', 'Dune', '--city', 'Mumbai'],
    state.env,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(state.calls()[0], [
    '--workspace',
    deriveIdentity(state.sessionKey).workspace,
    '--profile',
    'district-default',
    'district',
    'showtimes',
    'Dune',
    '--city',
    'Mumbai',
    '-f',
    'json',
  ]);

  const override = runMoviectl(
    ['district', 'showtimes', 'Dune', '--workspace', 'attacker'],
    state.env,
  );
  assert.deepEqual(override, {
    ok: false,
    error: {
      code: 'INVALID_ARGUMENT',
      message: 'workspace, profile, and output format are fixed by moviectl',
    },
  });
  assert.equal(state.calls().length, 1);

  for (const trace of [['--trace', 'on'], ['--trace=on']]) {
    const traced = runMoviectl(['district', 'login', ...trace], state.env);
    assert.equal(traced.ok, false);
    if (!traced.ok) assert.equal(traced.error.code, 'INVALID_ARGUMENT');
  }
  assert.equal(state.calls().length, 1);
});

test('enforces confirmation, payment, and provider-confirmed transitions', () => {
  const state = fixture();
  const prepared = unwrap<{ attempt: { id: string; status: string } }>(prepare(state));
  assert.equal(prepared.attempt.status, 'awaiting_confirmation');

  let db = openDatabase(state.databasePath);
  assert.equal(findBookingAttempt(db, state.user.id, prepared.attempt.id)?.status, 'awaiting_confirmation');
  db.close();

  state.env.FAKE_WEBCMD_RESPONSE = JSON.stringify({
    status: 'ready_for_payment',
    paymentUrl: 'https://pay.example/temporary',
  });
  const checkout = unwrap<{
    attempt: { status: string };
    provider: { paymentUrl: string };
  }>(runMoviectl(['district', 'checkout', prepared.attempt.id], state.env));
  assert.equal(checkout.attempt.status, 'pending_payment');
  assert.equal(checkout.provider.paymentUrl, 'https://pay.example/temporary');

  db = openDatabase(state.databasePath);
  const pending = findBookingAttempt(db, state.user.id, prepared.attempt.id);
  assert.equal(pending?.status, 'pending_payment');
  assert.equal('paymentUrl' in (pending ?? {}), false);
  db.close();

  const callsAfterCheckout = state.calls().length;
  const second = unwrap<{ attempt: { id: string } }>(prepare(
    state,
    'https://www.district.in/movies/seat-layout/imax?encsessionid=show-2',
    'B3,B4',
  ));
  const duplicate = runMoviectl(['district', 'checkout', second.attempt.id], state.env);
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.error.code, 'CHECKOUT_PENDING');
  assert.equal(state.calls().length, callsAfterCheckout);

  state.env.FAKE_WEBCMD_RESPONSE = JSON.stringify({ status: 'confirmed', bookingId: '' });
  const unverified = runMoviectl(['district', 'booking-status', prepared.attempt.id], state.env);
  assert.equal(unverified.ok, false);
  if (!unverified.ok) assert.equal(unverified.error.code, 'INVALID_PROVIDER_RESULT');
  db = openDatabase(state.databasePath);
  assert.equal(findBookingAttempt(db, state.user.id, prepared.attempt.id)?.status, 'pending_payment');
  db.close();

  state.env.FAKE_WEBCMD_RESPONSE = JSON.stringify({ status: 'confirmed', bookingId: 'DBX123456' });
  const confirmed = unwrap<{ attempt: { status: string; districtBookingId: string } }>(
    runMoviectl(['district', 'booking-status', prepared.attempt.id], state.env),
  );
  assert.equal(confirmed.attempt.status, 'confirmed');
  assert.equal(confirmed.attempt.districtBookingId, 'DBX123456');
});

test('normalizes and validates seats before persistence', () => {
  const state = fixture();
  const prepared = unwrap<{ attempt: { seats: string[] } }>(prepare(state, undefined, 'a1,a2'));
  assert.deepEqual(prepared.attempt.seats, ['A1', 'A2']);

  for (const seats of [', ,', 'A-1,A2', 'a1,A1']) {
    const result = prepare(state, undefined, seats);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'INVALID_ARGUMENT');
  }
});

test('rejects checkout outside awaiting confirmation before WebCMD runs', () => {
  const state = fixture();
  const db = openDatabase(state.databasePath);
  const attempt = createBookingAttempt(db, state.user.id, {
    conversationId: null,
    status: 'pending',
    movie: 'Dune',
    cinema: 'PVR Phoenix',
    showTime: '2026-07-28T19:00:00+05:30',
    showTarget: 'show-1',
    formatId: 'imax',
    contentId: 'dune-2',
    seats: ['A1', 'A2'],
    amountPaise: 80000,
  });
  db.close();

  const result = runMoviectl(['district', 'checkout', attempt.id], state.env);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'INVALID_STATE');
  assert.equal(state.calls().length, 0);
});
