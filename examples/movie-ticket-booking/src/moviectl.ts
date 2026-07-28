import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import {
  createBookingAttempt,
  findBookingAttempt,
  getPreferences,
  listBookingAttempts,
  openDatabase,
  recordDistrictBookingResult,
  updateBookingAttempt,
  updatePreferences,
} from './db.js';
import type { BookingAttempt, DistrictBookingResult, Preferences } from './db.js';

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

interface Identity {
  userId: string;
  workspace: string;
}

class MoviectlError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function deriveIdentity(sessionKey: string): Identity {
  const match = /^movie-demo:user:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i
    .exec(sessionKey);
  if (!match) throw new MoviectlError('INVALID_IDENTITY', 'HERMES_SESSION_KEY is invalid');
  return {
    userId: match[1]!,
    workspace: `movie_${createHash('sha256').update(sessionKey).digest('hex').slice(0, 32)}`,
  };
}

function parsed<const T extends Record<string, { type: 'string' }>>(
  args: string[],
  options: T,
  allowPositionals = false,
): { values: Partial<Record<keyof T, string>>; positionals: string[] } {
  try {
    return parseArgs({ args, options, allowPositionals, strict: true }) as {
      values: Partial<Record<keyof T, string>>;
      positionals: string[];
    };
  } catch (error) {
    throw new MoviectlError(
      'INVALID_ARGUMENT',
      error instanceof Error ? error.message : 'invalid arguments',
    );
  }
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new MoviectlError('INVALID_ARGUMENT', `${name} is required`);
  return value.trim();
}

function positiveInteger(value: string | undefined, name: string): number {
  const parsedValue = Number(value);
  if (!Number.isSafeInteger(parsedValue) || parsedValue <= 0) {
    throw new MoviectlError('INVALID_ARGUMENT', `${name} must be a positive integer`);
  }
  return parsedValue;
}

function nonNegativeInteger(value: string | undefined, name: string): number {
  const parsedValue = Number(value);
  if (!Number.isSafeInteger(parsedValue) || parsedValue < 0) {
    throw new MoviectlError('INVALID_ARGUMENT', `${name} must be a non-negative integer`);
  }
  return parsedValue;
}

function transaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function providerRow(value: unknown): Record<string, unknown> {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new MoviectlError('INVALID_PROVIDER_RESULT', 'WebCMD returned invalid JSON data');
  }
  return row as Record<string, unknown>;
}

function yamlString(value: string): string | null {
  if (value.trimEnd() !== value) return null;
  if (/^'(?:[^']|'')*'$/.test(value)) {
    const decoded = value.slice(1, -1).replaceAll("''", "'");
    return decoded.length > 0 && decoded.trim() === decoded ? decoded : null;
  }
  if (
    !/^[A-Za-z0-9][^\r\n]*$/.test(value)
    || value.includes(': ')
    || value.includes(' #')
    || /^(?:null|true|false|~|[-+]?(?:\d+(?:\.\d*)?|\.\d+))$/i.test(value)
  ) {
    return null;
  }
  return value;
}

function webcmdError(stderr: string, status: number | null): MoviectlError {
  if (!stderr.endsWith('\n') || stderr.includes('\r')) {
    return new MoviectlError('WEBCMD_FAILED', 'WebCMD command failed');
  }
  const lines = stderr.slice(0, -1).split('\n');
  if (lines[0] !== 'ok: false' || lines[1] !== 'error:') {
    return new MoviectlError('WEBCMD_FAILED', 'WebCMD command failed');
  }
  const code = /^  code: ([A-Z][A-Z0-9_]*)$/.exec(lines[2] ?? '')?.[1];
  const messageValue = /^  message: (.+)$/.exec(lines[3] ?? '')?.[1];
  const message = messageValue === undefined ? null : yamlString(messageValue);
  if (!code || message === null) {
    return new MoviectlError('WEBCMD_FAILED', 'WebCMD command failed');
  }
  let index = 4;
  let help: string | null = null;
  let helpValue: string | null = null;
  if (lines[index]?.startsWith('  help: ')) {
    helpValue = lines[index]!.slice('  help: '.length);
    help = yamlString(helpValue);
    if (help === null) return new MoviectlError('WEBCMD_FAILED', 'WebCMD command failed');
    index += 1;
  }
  const exitValue = /^  exitCode: (0|[1-9][0-9]*)$/.exec(lines[index] ?? '')?.[1];
  if (exitValue === undefined) return new MoviectlError('WEBCMD_FAILED', 'WebCMD command failed');
  const exitCode = Number(exitValue);
  index += 1;
  const trailing = lines.slice(index);
  const autoFix = [
    '# AutoFix: re-run with --trace=retain-on-failure for trace artifact',
    '# webcmd district checkout --trace retain-on-failure',
  ];
  const hasAutoFix = trailing.join('\n') === autoFix.join('\n');
  if (
    trailing.length !== 0
    && !(code === 'EMPTY_RESULT' && hasAutoFix)
  ) {
    return new MoviectlError('WEBCMD_FAILED', 'WebCMD command failed');
  }
  if (
    status === 77
    && exitCode === status
    && code === 'AUTH_REQUIRED'
    && messageValue === "'District login required before checkout. Run: webcmd district login'"
    && helpValue === 'Please open Chrome or Chromium and log in to https://www.district.in'
    && trailing.length === 0
  ) {
    return new MoviectlError('AUTH_REQUIRED', 'District login is required');
  }
  if (
    status === 66
    && exitCode === status
    && code === 'EMPTY_RESULT'
    && messageValue === 'district checkout returned no data'
    && helpValue !== null
    && /^[A-Z]+[0-9]+ was not found in the rendered seat map$/.test(helpValue)
    && hasAutoFix
  ) {
    return new MoviectlError('EMPTY_RESULT', 'District returned no data');
  }
  if (
    status === 1
    && exitCode === status
    && code === 'COMMAND_EXEC'
    && (
      /^[A-Z]+[0-9]+ is not available$/.test(message)
      || message === 'District says booking is now closed for this show'
      || message === 'District no longer offers this show session; re-run webcmd district showtimes and pick a current show'
    )
  ) {
    return new MoviectlError('COMMAND_EXEC', 'District seats are no longer available');
  }
  return new MoviectlError('WEBCMD_FAILED', 'WebCMD command failed');
}

function callWebcmd(
  identity: Identity,
  args: string[],
  env: NodeJS.ProcessEnv,
): unknown {
  if (args.some((arg) => (
    arg === '--workspace'
    || arg.startsWith('--workspace=')
    || arg === '--profile'
    || arg.startsWith('--profile=')
    || arg === '-f'
    || arg.startsWith('-f=')
    || arg === '--format'
    || arg.startsWith('--format=')
    || arg === '--trace'
    || arg.startsWith('--trace=')
    || arg === '--'
  ))) {
    throw new MoviectlError(
      'INVALID_ARGUMENT',
      'workspace, profile, and output format are fixed by moviectl',
    );
  }
  const webcmdEnv = { ...env };
  delete webcmdEnv.HERMES_SESSION_KEY;
  delete webcmdEnv.MOVIE_DEMO_DB_PATH;
  const child = spawnSync(
    env.WEBCMD_BIN || 'webcmd',
    [
      '--workspace',
      identity.workspace,
      '--profile',
      'district-default',
      'district',
      ...args,
      '-f',
      'json',
    ],
    { encoding: 'utf8', env: webcmdEnv },
  );
  if (child.error || child.status !== 0) {
    throw child.error
      ? new MoviectlError('WEBCMD_FAILED', 'WebCMD command failed')
      : webcmdError(child.stderr, child.status);
  }
  try {
    return JSON.parse(child.stdout);
  } catch {
    throw new MoviectlError('INVALID_PROVIDER_RESULT', 'WebCMD returned invalid JSON');
  }
}

function assertUser(db: DatabaseSync, userId: string): void {
  const row = db.prepare('select id from users where id = ?').get(userId);
  if (!row) throw new MoviectlError('USER_NOT_FOUND', 'movie demo user was not found');
}

function runProfile(db: DatabaseSync, userId: string, args: string[]): Preferences {
  const command = parsed(args.slice(0, 1), {}, true).positionals[0];
  if (command === 'get' && args.length === 1) return getPreferences(db, userId);
  if (command !== 'update') {
    throw new MoviectlError('INVALID_ARGUMENT', 'profile requires get or update');
  }
  const { values } = parsed(args.slice(1), {
    city: { type: 'string' },
    languages: { type: 'string' },
    formats: { type: 'string' },
    'seat-position': { type: 'string' },
    'budget-paise': { type: 'string' },
  });
  const current = getPreferences(db, userId);
  const commaList = (value: string | undefined) => value === undefined
    ? undefined
    : value.split(',').map((item) => item.trim()).filter(Boolean);
  const preferences = {
    city: values.city?.trim() ?? current.city,
    languages: commaList(values.languages) ?? current.languages,
    formats: commaList(values.formats) ?? current.formats,
    seatPosition: values['seat-position']?.trim() ?? current.seatPosition,
    budgetPaise: values['budget-paise'] === undefined
      ? current.budgetPaise
      : nonNegativeInteger(values['budget-paise'], 'budget-paise'),
  };
  return transaction(db, () => updatePreferences(db, userId, preferences));
}

function prepareCheckout(db: DatabaseSync, userId: string, args: string[]): BookingAttempt {
  const { values, positionals } = parsed(args, {
    'conversation-id': { type: 'string' },
    movie: { type: 'string' },
    cinema: { type: 'string' },
    'show-time': { type: 'string' },
    'format-id': { type: 'string' },
    'content-id': { type: 'string' },
    seats: { type: 'string' },
    'amount-paise': { type: 'string' },
  }, true);
  if (positionals.length !== 1) {
    throw new MoviectlError('INVALID_ARGUMENT', 'prepare-checkout requires one show URL or ID');
  }
  const seats = required(values.seats, 'seats')
    .split(',')
    .map((seat) => seat.trim().toUpperCase())
    .filter(Boolean);
  if (!seats.length) throw new MoviectlError('INVALID_ARGUMENT', 'seats is required');
  if (seats.length > 10) {
    throw new MoviectlError('INVALID_ARGUMENT', 'seats must contain 10 seats or fewer');
  }
  if (seats.some((seat) => !/^[A-Z]+[0-9]+$/.test(seat))) {
    throw new MoviectlError('INVALID_ARGUMENT', 'seats must use row+number labels like I22');
  }
  if (new Set(seats).size !== seats.length) {
    throw new MoviectlError('INVALID_ARGUMENT', 'seats must not contain duplicates');
  }
  return transaction(db, () => createBookingAttempt(db, userId, {
    conversationId: values['conversation-id']?.trim() || null,
    status: 'awaiting_confirmation',
    movie: required(values.movie, 'movie'),
    cinema: required(values.cinema, 'cinema'),
    showTime: required(values['show-time'], 'show-time'),
    showTarget: required(positionals[0], 'show'),
    formatId: required(values['format-id'], 'format-id'),
    contentId: required(values['content-id'], 'content-id'),
    seats,
    amountPaise: positiveInteger(values['amount-paise'], 'amount-paise'),
  }));
}

function checkout(
  db: DatabaseSync,
  identity: Identity,
  args: string[],
  env: NodeJS.ProcessEnv,
) {
  const { positionals } = parsed(args, {}, true);
  if (positionals.length !== 1) {
    throw new MoviectlError('INVALID_ARGUMENT', 'checkout requires one attempt ID');
  }
  const attempt = transaction(db, () => {
    const current = findBookingAttempt(db, identity.userId, positionals[0]!);
    if (!current || current.status !== 'awaiting_confirmation') {
      throw new MoviectlError('INVALID_STATE', 'checkout requires an awaiting confirmation attempt');
    }
    if (listBookingAttempts(db, identity.userId).some(
      (candidate) => candidate.status === 'pending_payment',
    )) {
      throw new MoviectlError('CHECKOUT_PENDING', 'another checkout is unresolved');
    }
    return updateBookingAttempt(db, identity.userId, current.id, { status: 'pending_payment' })!;
  });
  let providerResult: unknown;
  try {
    providerResult = callWebcmd(identity, [
      'checkout',
      attempt.showTarget,
      '--seats',
      attempt.seats.join(','),
      '--format-id',
      attempt.formatId,
      '--content-id',
      attempt.contentId,
    ], env);
  } catch (error) {
    if (error instanceof MoviectlError && error.code === 'AUTH_REQUIRED') {
      transaction(db, () => {
        const recovered = updateBookingAttempt(
          db,
          identity.userId,
          attempt.id,
          { status: 'awaiting_confirmation' },
          'pending_payment',
        );
        if (!recovered) {
          throw new MoviectlError('INVALID_STATE', 'checkout state changed during recovery');
        }
      });
      throw new MoviectlError('AUTH_REQUIRED', 'District login is required before checkout');
    }
    if (
      error instanceof MoviectlError
      && (error.code === 'EMPTY_RESULT' || error.code === 'COMMAND_EXEC')
    ) {
      transaction(db, () => {
        const recovered = updateBookingAttempt(
          db,
          identity.userId,
          attempt.id,
          { status: 'expired' },
          'pending_payment',
        );
        if (!recovered) {
          throw new MoviectlError('INVALID_STATE', 'checkout state changed during recovery');
        }
      });
      throw new MoviectlError(error.code, 'District seats are no longer available');
    }
    throw error;
  }
  const provider = providerRow(providerResult);
  if (typeof provider.paymentUrl !== 'string' || !provider.paymentUrl.trim()) {
    throw new MoviectlError('INVALID_PROVIDER_RESULT', 'District checkout returned no payment URL');
  }
  return { attempt, provider };
}

function bookingStatus(
  db: DatabaseSync,
  identity: Identity,
  args: string[],
  env: NodeJS.ProcessEnv,
) {
  const { positionals } = parsed(args, {}, true);
  if (positionals.length !== 1) {
    throw new MoviectlError('INVALID_ARGUMENT', 'booking-status requires one attempt ID');
  }
  const attempt = findBookingAttempt(db, identity.userId, positionals[0]!);
  if (!attempt || attempt.status !== 'pending_payment') {
    throw new MoviectlError('INVALID_STATE', 'booking-status requires a pending payment attempt');
  }
  const provider = providerRow(callWebcmd(identity, ['booking-status'], env));
  const status = provider.status;
  if (!['pending', 'confirmed', 'failed', 'expired'].includes(String(status))) {
    throw new MoviectlError('INVALID_PROVIDER_RESULT', 'District returned an unknown booking status');
  }
  const result: DistrictBookingResult = {
    status: status as DistrictBookingResult['status'],
    bookingId: typeof provider.bookingId === 'string' ? provider.bookingId : undefined,
  };
  if (result.status === 'confirmed' && !result.bookingId?.trim()) {
    throw new MoviectlError(
      'INVALID_PROVIDER_RESULT',
      'District confirmation requires a booking ID',
    );
  }
  const updated = result.status === 'pending'
    ? attempt
    : transaction(db, () => recordDistrictBookingResult(
      db,
      identity.userId,
      attempt.id,
      result,
    )!);
  return { attempt: updated, provider };
}

function runDistrict(
  db: DatabaseSync,
  identity: Identity,
  args: string[],
  env: NodeJS.ProcessEnv,
): unknown {
  const command = parsed(args.slice(0, 1), {}, true).positionals[0];
  const rest = args.slice(1);
  if (command === 'prepare-checkout') return { attempt: prepareCheckout(db, identity.userId, rest) };
  if (command === 'checkout') return checkout(db, identity, rest, env);
  if (command === 'booking-status') return bookingStatus(db, identity, rest, env);
  if (!['search', 'showtimes', 'login', 'seats'].includes(command ?? '')) {
    throw new MoviectlError('INVALID_ARGUMENT', 'unsupported District command');
  }
  return callWebcmd(identity, [command!, ...rest], env);
}

export function runMoviectl(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Result<unknown> {
  let db: DatabaseSync | undefined;
  try {
    const command = parsed(argv.slice(0, 1), {}, true).positionals[0];
    if (!command) throw new MoviectlError('INVALID_ARGUMENT', 'command is required');
    const databasePath = required(env.MOVIE_DEMO_DB_PATH, 'MOVIE_DEMO_DB_PATH');
    const identity = deriveIdentity(env.HERMES_SESSION_KEY ?? '');
    db = openDatabase(databasePath);
    assertUser(db, identity.userId);
    const data = command === 'profile'
      ? runProfile(db, identity.userId, argv.slice(1))
      : command === 'district'
        ? runDistrict(db, identity, argv.slice(1), env)
        : (() => { throw new MoviectlError('INVALID_ARGUMENT', 'unsupported command'); })();
    return { ok: true, data };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error instanceof MoviectlError ? error.code : 'INTERNAL_ERROR',
        message: error instanceof MoviectlError ? error.message : 'moviectl failed',
      },
    };
  } finally {
    db?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runMoviectl(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}
