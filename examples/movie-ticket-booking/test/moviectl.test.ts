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
  const envLogPath = join(directory, 'webcmd-env.json');
  const executable = join(directory, 'fake-webcmd');
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.FAKE_WEBCMD_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
fs.writeFileSync(process.env.FAKE_WEBCMD_ENV_LOG, JSON.stringify({
  hermesSessionKey: process.env.HERMES_SESSION_KEY || null,
  movieDemoDbPath: process.env.MOVIE_DEMO_DB_PATH || null,
}));
if (process.env.FAKE_WEBCMD_RACE_DB_PATH) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(process.env.FAKE_WEBCMD_RACE_DB_PATH);
  db.prepare('update booking_attempts set status = ? where id = ?')
    .run(process.env.FAKE_WEBCMD_RACE_STATUS, process.env.FAKE_WEBCMD_RACE_ATTEMPT_ID);
  db.close();
}
process.stdout.write(process.env.FAKE_WEBCMD_RESPONSE || '{}');
process.stderr.write(process.env.FAKE_WEBCMD_STDERR || '');
process.exitCode = Number(process.env.FAKE_WEBCMD_EXIT_CODE || 0);
`);
  chmodSync(executable, 0o755);

  const db = openDatabase(databasePath);
  const user = createUserRecord(db, 'alice@example.com', 'hash');
  db.close();
  const sessionKey = `movie-demo:user:${user.id}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MOVIE_DEMO_DB_PATH: databasePath,
    HERMES_SESSION_KEY: sessionKey,
    WEBCMD_BIN: executable,
    FAKE_WEBCMD_LOG: logPath,
    FAKE_WEBCMD_ENV_LOG: envLogPath,
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
  const childEnv = () => JSON.parse(readFileSync(envLogPath, 'utf8')) as {
    hermesSessionKey: string | null;
    movieDemoDbPath: string | null;
  };
  return { databasePath, env, sessionKey, user, calls, childEnv };
}

function failWebcmd(
  state: ReturnType<typeof fixture>,
  code: string,
  message: string,
  exitCode: number,
) {
  state.env.FAKE_WEBCMD_EXIT_CODE = String(exitCode);
  state.env.FAKE_WEBCMD_STDERR = [
    'ok: false',
    'error:',
    `  code: ${code}`,
    `  message: ${message}`,
    `  exitCode: ${exitCode}`,
    '',
  ].join('\n');
}

function failWebcmdRaw(
  state: ReturnType<typeof fixture>,
  stderr: string,
  exitCode: number,
) {
  state.env.FAKE_WEBCMD_EXIT_CODE = String(exitCode);
  state.env.FAKE_WEBCMD_STDERR = stderr;
}

// Copied from formatErrorEnvelope(toEnvelope(new AuthRequiredError(...)),
// { cmdName: 'district/checkout' }) using the checkout adapter's exact error.
const REAL_AUTH_REQUIRED_STDERR = [
  'ok: false',
  'error:',
  '  code: AUTH_REQUIRED',
  "  message: 'District login required before checkout. Run: webcmd district login'",
  '  help: Please open Chrome or Chromium and log in to https://www.district.in',
  '  exitCode: 77',
  '',
].join('\n');

// Copied from formatErrorEnvelope(toEnvelope(new EmptyResultError(...)),
// { cmdName: 'district/checkout' }) for checkout seat A1.
const REAL_EMPTY_RESULT_STDERR = [
  'ok: false',
  'error:',
  '  code: EMPTY_RESULT',
  '  message: district checkout returned no data',
  '  help: A1 was not found in the rendered seat map',
  '  exitCode: 66',
  '# AutoFix: re-run with --trace=retain-on-failure for trace artifact',
  '# webcmd district checkout --trace retain-on-failure',
  '',
].join('\n');

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
  assert.deepEqual(state.childEnv(), {
    hermesSessionKey: null,
    movieDemoDbPath: null,
  });

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
    paymentUrl: 'https://www.district.in/movies/order-review/private-provider-session',
  });
  state.env.FAKE_WEBCMD_STDERR =
    'Webcmd browser: https://api.webcmd.test/account/live/checkout-token\n';
  const checkout = unwrap<{
    attempt: { status: string };
    provider: { paymentUrl: string };
  }>(runMoviectl(['district', 'checkout', prepared.attempt.id], state.env));
  assert.equal(checkout.attempt.status, 'pending_payment');
  assert.equal(
    checkout.provider.paymentUrl,
    'https://api.webcmd.test/account/live/checkout-token',
  );
  assert.doesNotMatch(JSON.stringify(checkout), /private-provider-session/);

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

test('persists pending, failed, and expired provider booking results', () => {
  for (const status of ['pending', 'failed', 'expired'] as const) {
    const state = fixture();
    const prepared = unwrap<{ attempt: { id: string } }>(prepare(state));
    state.env.FAKE_WEBCMD_RESPONSE = JSON.stringify({
      status: 'ready_for_payment',
      paymentUrl: 'https://www.district.in/movies/order-review/local-session',
    });
    const checkout = unwrap<{ provider: { paymentUrl: string } }>(
      runMoviectl(['district', 'checkout', prepared.attempt.id], state.env),
    );
    assert.equal(
      checkout.provider.paymentUrl,
      'https://www.district.in/movies/order-review/local-session',
      `${status} local checkout`,
    );

    state.env.FAKE_WEBCMD_RESPONSE = JSON.stringify({ status, bookingId: '' });
    const result = unwrap<{ attempt: { status: string } }>(
      runMoviectl(['district', 'booking-status', prepared.attempt.id], state.env),
    );
    assert.equal(result.attempt.status, status === 'pending' ? 'pending_payment' : status);

    const db = openDatabase(state.databasePath);
    assert.equal(
      findBookingAttempt(db, state.user.id, prepared.attempt.id)?.status,
      status === 'pending' ? 'pending_payment' : status,
    );
    db.close();
  }
});

test('rejects noncanonical hosted viewer metadata without relaying the provider URL', () => {
  const state = fixture();
  const prepared = unwrap<{ attempt: { id: string } }>(prepare(state));
  state.env.FAKE_WEBCMD_RESPONSE = JSON.stringify({
    status: 'ready_for_payment',
    paymentUrl: 'https://www.district.in/movies/order-review/private-provider-session',
  });
  state.env.FAKE_WEBCMD_STDERR =
    'Webcmd browser: https://api.webcmd.test/account/live/token?secret=1\n';

  const result = runMoviectl(['district', 'checkout', prepared.attempt.id], state.env);

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'INVALID_PROVIDER_RESULT',
      message: 'WebCMD returned invalid viewer metadata',
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /private-provider-session|secret=1/);
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

test('restores an auth-blocked checkout for fresh confirmation without leaking provider text', () => {
  const state = fixture();
  const prepared = unwrap<{ attempt: { id: string } }>(prepare(state));
  failWebcmdRaw(state, REAL_AUTH_REQUIRED_STDERR, 77);

  const result = runMoviectl(['district', 'checkout', prepared.attempt.id], state.env);

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'AUTH_REQUIRED',
      message: 'District login is required before checkout',
    },
  });
  const db = openDatabase(state.databasePath);
  assert.equal(
    findBookingAttempt(db, state.user.id, prepared.attempt.id)?.status,
    'awaiting_confirmation',
  );
  db.close();
});

test('expires a checkout with unavailable seats so a new attempt can proceed', () => {
  const state = fixture();
  const stale = unwrap<{ attempt: { id: string } }>(prepare(state));
  failWebcmdRaw(state, REAL_EMPTY_RESULT_STDERR, 66);

  const result = runMoviectl(['district', 'checkout', stale.attempt.id], state.env);

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'EMPTY_RESULT',
      message: 'District seats are no longer available',
    },
  });
  let db = openDatabase(state.databasePath);
  assert.equal(findBookingAttempt(db, state.user.id, stale.attempt.id)?.status, 'expired');
  db.close();

  delete state.env.FAKE_WEBCMD_EXIT_CODE;
  delete state.env.FAKE_WEBCMD_STDERR;
  state.env.FAKE_WEBCMD_RESPONSE = JSON.stringify({
    status: 'ready_for_payment',
    paymentUrl: 'https://pay.example/new',
  });
  const fresh = unwrap<{ attempt: { id: string } }>(prepare(
    state,
    'https://www.district.in/movies/seat-layout/imax?encsessionid=show-new',
    'B1,B2',
  ));
  const checkout = runMoviectl(['district', 'checkout', fresh.attempt.id], state.env);
  assert.equal(checkout.ok, true);
  db = openDatabase(state.databasePath);
  assert.equal(findBookingAttempt(db, state.user.id, fresh.attempt.id)?.status, 'pending_payment');
  db.close();
});

test('expires an unequivocal COMMAND_EXEC unavailable-seat checkout', () => {
  const state = fixture();
  const prepared = unwrap<{ attempt: { id: string } }>(prepare(state));
  failWebcmd(state, 'COMMAND_EXEC', 'A1 is not available', 1);

  const result = runMoviectl(['district', 'checkout', prepared.attempt.id], state.env);

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'COMMAND_EXEC',
      message: 'District seats are no longer available',
    },
  });
  const db = openDatabase(state.databasePath);
  assert.equal(findBookingAttempt(db, state.user.id, prepared.attempt.id)?.status, 'expired');
  db.close();
});

test('keeps ambiguous checkout failures pending for status reconciliation', () => {
  const state = fixture();
  const prepared = unwrap<{ attempt: { id: string } }>(prepare(state));
  failWebcmd(state, 'COMMAND_EXEC', 'raw provider detail', 1);

  const result = runMoviectl(['district', 'checkout', prepared.attempt.id], state.env);

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'WEBCMD_FAILED',
      message: 'WebCMD command failed',
    },
  });
  const db = openDatabase(state.databasePath);
  assert.equal(findBookingAttempt(db, state.user.id, prepared.attempt.id)?.status, 'pending_payment');
  db.close();
  const retry = runMoviectl(['district', 'checkout', prepared.attempt.id], state.env);
  assert.equal(retry.ok, false);
  if (!retry.ok) assert.equal(retry.error.code, 'INVALID_STATE');
});

test('rejects noncanonical or spoofed WebCMD envelopes without releasing checkout', () => {
  const cases = [
    {
      label: 'canonical empty result with mixed newlines',
      exitCode: 66,
      stderr: REAL_EMPTY_RESULT_STDERR.replace('\n', '\r\n'),
    },
    {
      label: 'canonical auth with mixed newlines',
      exitCode: 77,
      stderr: REAL_AUTH_REQUIRED_STDERR.replace('\n', '\r\n'),
    },
    {
      label: 'help-less real auth shape',
      exitCode: 77,
      stderr: [
        'ok: false',
        'error:',
        '  code: AUTH_REQUIRED',
        "  message: 'District login required before checkout. Run: webcmd district login'",
        '  exitCode: 77',
        '',
      ].join('\n'),
    },
    {
      label: 'auth spoof with trailing whitespace',
      exitCode: 77,
      stderr: [
        'ok: false',
        'error:',
        '  code: AUTH_REQUIRED',
        '  message: spoof ',
        '  help: Please open Chrome or Chromium and log in to https://www.district.in',
        '  exitCode: 77',
        '',
      ].join('\n'),
    },
    {
      label: 'auth help with noncanonical quoting',
      exitCode: 77,
      stderr: [
        'ok: false',
        'error:',
        '  code: AUTH_REQUIRED',
        "  message: 'District login required before checkout. Run: webcmd district login'",
        "  help: 'Please open Chrome or Chromium and log in to https://www.district.in'",
        '  exitCode: 77',
        '',
      ].join('\n'),
    },
    {
      label: 'help-less empty result without AutoFix',
      exitCode: 66,
      stderr: [
        'ok: false',
        'error:',
        '  code: EMPTY_RESULT',
        '  message: district checkout returned no data',
        '  exitCode: 66',
        '',
      ].join('\n'),
    },
    {
      label: 'empty result without required AutoFix',
      exitCode: 66,
      stderr: [
        'ok: false',
        'error:',
        '  code: EMPTY_RESULT',
        '  message: district checkout returned no data',
        '  help: A1 was not found in the rendered seat map',
        '  exitCode: 66',
        '',
      ].join('\n'),
    },
    {
      label: 'empty-result spoof with trailing whitespace',
      exitCode: 66,
      stderr: [
        'ok: false',
        'error:',
        '  code: EMPTY_RESULT',
        '  message: spoof ',
        '  help: A1 was not found in the rendered seat map',
        '  exitCode: 66',
        '# AutoFix: re-run with --trace=retain-on-failure for trace artifact',
        '# webcmd district checkout --trace retain-on-failure',
        '',
      ].join('\n'),
    },
    {
      label: 'empty-result fields with noncanonical quoting',
      exitCode: 66,
      stderr: [
        'ok: false',
        'error:',
        '  code: EMPTY_RESULT',
        "  message: 'district checkout returned no data'",
        "  help: 'A1 was not found in the rendered seat map'",
        '  exitCode: 66',
        '# AutoFix: re-run with --trace=retain-on-failure for trace artifact',
        '# webcmd district checkout --trace retain-on-failure',
        '',
      ].join('\n'),
    },
    {
      label: 'duplicate code',
      exitCode: 77,
      stderr: [
        'ok: false',
        'error:',
        '  code: COMMAND_EXEC',
        '  code: AUTH_REQUIRED',
        '  message: District login required before checkout',
        '  exitCode: 77',
        '',
      ].join('\n'),
    },
    {
      label: 'noncanonical placement',
      exitCode: 77,
      stderr: [
        'ok: false',
        'metadata:',
        'error:',
        '  code: AUTH_REQUIRED',
        '  message: District login required before checkout',
        '  exitCode: 77',
        '',
      ].join('\n'),
    },
    {
      label: 'coerced exit code',
      exitCode: 77,
      stderr: [
        'ok: false',
        'error:',
        '  code: AUTH_REQUIRED',
        '  message: District login required before checkout',
        '  exitCode: 077',
        '',
      ].join('\n'),
    },
    {
      label: 'mismatched exit code',
      exitCode: 77,
      stderr: [
        'ok: false',
        'error:',
        '  code: AUTH_REQUIRED',
        '  message: District login required before checkout',
        '  exitCode: 1',
        '',
      ].join('\n'),
    },
    {
      label: 'empty message',
      exitCode: 77,
      stderr: [
        'ok: false',
        'error:',
        '  code: AUTH_REQUIRED',
        "  message: ''",
        '  exitCode: 77',
        '',
      ].join('\n'),
    },
    {
      label: 'duplicate message',
      exitCode: 1,
      stderr: [
        'ok: false',
        'error:',
        '  code: COMMAND_EXEC',
        '  message: unrelated failure',
        '  message: A1 is not available',
        '  exitCode: 1',
        '',
      ].join('\n'),
    },
    {
      label: 'overbroad stale prefix',
      exitCode: 1,
      stderr: [
        'ok: false',
        'error:',
        '  code: COMMAND_EXEC',
        '  message: District no longer offers this show session; spoofed suffix',
        '  exitCode: 1',
        '',
      ].join('\n'),
    },
    {
      label: 'noncanonical lowercase seat',
      exitCode: 1,
      stderr: [
        'ok: false',
        'error:',
        '  code: COMMAND_EXEC',
        '  message: a1 is not available',
        '  exitCode: 1',
        '',
      ].join('\n'),
    },
  ];

  for (const candidate of cases) {
    const state = fixture();
    const prepared = unwrap<{ attempt: { id: string } }>(prepare(state));
    failWebcmdRaw(state, candidate.stderr, candidate.exitCode);

    const result = runMoviectl(['district', 'checkout', prepared.attempt.id], state.env);

    assert.deepEqual(result, {
      ok: false,
      error: {
        code: 'WEBCMD_FAILED',
        message: 'WebCMD command failed',
      },
    }, candidate.label);
    const db = openDatabase(state.databasePath);
    assert.equal(
      findBookingAttempt(db, state.user.id, prepared.attempt.id)?.status,
      'pending_payment',
      candidate.label,
    );
    db.close();
  }
});

test('does not overwrite a terminal booking-status result during recovery', () => {
  const state = fixture();
  const prepared = unwrap<{ attempt: { id: string } }>(prepare(state));
  failWebcmdRaw(state, REAL_AUTH_REQUIRED_STDERR, 77);
  state.env.NODE_NO_WARNINGS = '1';
  state.env.FAKE_WEBCMD_RACE_DB_PATH = state.databasePath;
  state.env.FAKE_WEBCMD_RACE_ATTEMPT_ID = prepared.attempt.id;
  state.env.FAKE_WEBCMD_RACE_STATUS = 'failed';

  const result = runMoviectl(['district', 'checkout', prepared.attempt.id], state.env);

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'INVALID_STATE',
      message: 'checkout state changed during recovery',
    },
  });
  const db = openDatabase(state.databasePath);
  assert.equal(findBookingAttempt(db, state.user.id, prepared.attempt.id)?.status, 'failed');
  db.close();
});
