import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
}

export interface Conversation {
  id: string;
  userId: string;
  hermesSessionId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface Preferences {
  city: string;
  languages: string[];
  formats: string[];
  seatPosition: string;
  budgetPaise: number;
}

export interface BookingAttempt {
  id: string;
  userId: string;
  conversationId: string | null;
  status: BookingAttemptStatus;
  movie: string;
  cinema: string;
  showTime: string;
  showTarget: string;
  formatId: string;
  contentId: string;
  seats: string[];
  amountPaise: number;
  districtBookingId: string;
  createdAt: number;
  updatedAt: number;
}

export type BookingAttemptStatus =
  | 'pending'
  | 'awaiting_confirmation'
  | 'pending_payment'
  | 'failed'
  | 'expired'
  | 'cancelled'
  | 'confirmed';
export type GenericBookingAttemptStatus = Exclude<BookingAttemptStatus, 'confirmed'>;

export type NewBookingAttempt = Omit<
  BookingAttempt,
  'id' | 'userId' | 'createdAt' | 'updatedAt' | 'districtBookingId' | 'status'
> & { districtBookingId?: string; status: GenericBookingAttemptStatus };

export type BookingAttemptUpdate = {
  status?: GenericBookingAttemptStatus;
  districtBookingId?: string;
};

export interface DistrictBookingResult {
  status: 'pending' | 'confirmed' | 'failed' | 'expired';
  bookingId?: string;
}

const EMPTY_PREFERENCES: Preferences = {
  city: '',
  languages: [],
  formats: [],
  seatPosition: '',
  budgetPaise: 0,
};

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`
    create table if not exists users (
      id text primary key,
      email text not null unique,
      password_hash text not null,
      created_at integer not null
    );
    create table if not exists auth_sessions (
      token_hash text primary key,
      user_id text not null references users(id) on delete cascade,
      expires_at integer not null,
      created_at integer not null
    );
    create table if not exists conversations (
      id text primary key,
      user_id text not null references users(id) on delete cascade,
      hermes_session_id text not null unique,
      title text not null,
      created_at integer not null,
      updated_at integer not null
    );
    create table if not exists user_preferences (
      user_id text primary key references users(id) on delete cascade,
      city text not null default '',
      languages_json text not null default '[]',
      formats_json text not null default '[]',
      seat_position text not null default '',
      budget_paise integer not null default 0,
      updated_at integer not null
    );
    create table if not exists booking_attempts (
      id text primary key,
      user_id text not null references users(id) on delete cascade,
      conversation_id text references conversations(id) on delete set null,
      status text not null,
      movie text not null,
      cinema text not null,
      show_time text not null,
      show_target text not null,
      format_id text not null default '',
      content_id text not null default '',
      seats_json text not null,
      amount_paise integer not null,
      district_booking_id text not null default '',
      created_at integer not null,
      updated_at integer not null
    );
  `);
  return db;
}

export function createUserRecord(db: DatabaseSync, email: string, passwordHash: string): UserRecord {
  const record = {
    id: randomUUID(),
    email: normalizeEmail(email),
    passwordHash,
  };
  db.prepare(`
    insert into users (id, email, password_hash, created_at)
    values (?, ?, ?, ?)
  `).run(record.id, record.email, record.passwordHash, Date.now());
  return record;
}

export function findUserByEmail(db: DatabaseSync, email: string): UserRecord | null {
  const row = db.prepare(`
    select id, email, password_hash
    from users
    where email = ?
  `).get(normalizeEmail(email)) as { id: string; email: string; password_hash: string } | undefined;
  return row ? { id: row.id, email: row.email, passwordHash: row.password_hash } : null;
}

function mapConversation(row: Record<string, unknown>): Conversation {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    hermesSessionId: String(row.hermes_session_id),
    title: String(row.title),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function createConversation(
  db: DatabaseSync,
  userId: string,
  hermesSessionId: string,
  title = 'New chat',
): Conversation {
  const now = Date.now();
  const id = randomUUID();
  db.prepare(`
    insert into conversations (id, user_id, hermes_session_id, title, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?)
  `).run(id, userId, hermesSessionId, title, now, now);
  return { id, userId, hermesSessionId, title, createdAt: now, updatedAt: now };
}

export function listConversations(db: DatabaseSync, userId: string): Conversation[] {
  const rows = db.prepare(`
    select *
    from conversations
    where user_id = ?
    order by updated_at desc
  `).all(userId) as Record<string, unknown>[];
  return rows.map(mapConversation);
}

export function findConversation(
  db: DatabaseSync,
  userId: string,
  conversationId: string,
): Conversation | null {
  const row = db.prepare(`
    select *
    from conversations
    where id = ? and user_id = ?
  `).get(conversationId, userId) as Record<string, unknown> | undefined;
  return row ? mapConversation(row) : null;
}

export function updateConversation(
  db: DatabaseSync,
  userId: string,
  conversationId: string,
  title: string,
): Conversation | null {
  db.prepare(`
    update conversations
    set title = ?, updated_at = ?
    where id = ? and user_id = ?
  `).run(title, Date.now(), conversationId, userId);
  return findConversation(db, userId, conversationId);
}

export function deleteConversation(db: DatabaseSync, userId: string, conversationId: string): boolean {
  return db.prepare('delete from conversations where id = ? and user_id = ?')
    .run(conversationId, userId).changes > 0;
}

export function getPreferences(db: DatabaseSync, userId: string): Preferences {
  const row = db.prepare(`
    select city, languages_json, formats_json, seat_position, budget_paise
    from user_preferences
    where user_id = ?
  `).get(userId) as {
    city: string;
    languages_json: string;
    formats_json: string;
    seat_position: string;
    budget_paise: number;
  } | undefined;
  if (!row) return { ...EMPTY_PREFERENCES };
  return {
    city: row.city,
    languages: JSON.parse(row.languages_json) as string[],
    formats: JSON.parse(row.formats_json) as string[],
    seatPosition: row.seat_position,
    budgetPaise: row.budget_paise,
  };
}

export function updatePreferences(db: DatabaseSync, userId: string, preferences: Preferences): Preferences {
  db.prepare(`
    insert into user_preferences (
      user_id, city, languages_json, formats_json, seat_position, budget_paise, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?)
    on conflict(user_id) do update set
      city = excluded.city,
      languages_json = excluded.languages_json,
      formats_json = excluded.formats_json,
      seat_position = excluded.seat_position,
      budget_paise = excluded.budget_paise,
      updated_at = excluded.updated_at
  `).run(
    userId,
    preferences.city,
    JSON.stringify(preferences.languages),
    JSON.stringify(preferences.formats),
    preferences.seatPosition,
    preferences.budgetPaise,
    Date.now(),
  );
  return getPreferences(db, userId);
}

export function deletePreferences(db: DatabaseSync, userId: string): boolean {
  return db.prepare('delete from user_preferences where user_id = ?').run(userId).changes > 0;
}

function mapBookingAttempt(row: Record<string, unknown>): BookingAttempt {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    conversationId: row.conversation_id === null ? null : String(row.conversation_id),
    status: String(row.status) as BookingAttemptStatus,
    movie: String(row.movie),
    cinema: String(row.cinema),
    showTime: String(row.show_time),
    showTarget: String(row.show_target),
    formatId: String(row.format_id),
    contentId: String(row.content_id),
    seats: JSON.parse(String(row.seats_json)) as string[],
    amountPaise: Number(row.amount_paise),
    districtBookingId: String(row.district_booking_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function assertGenericStatus(status: string | undefined): void {
  if (status === 'confirmed') throw new Error('confirmed status requires a District provider result');
}

export function createBookingAttempt(
  db: DatabaseSync,
  userId: string,
  attempt: NewBookingAttempt,
): BookingAttempt {
  assertGenericStatus(attempt.status);
  if (attempt.conversationId !== null && !findConversation(db, userId, attempt.conversationId)) {
    throw new Error('conversation does not belong to user');
  }
  const now = Date.now();
  const id = randomUUID();
  const districtBookingId = attempt.districtBookingId ?? '';
  db.prepare(`
    insert into booking_attempts (
      id, user_id, conversation_id, status, movie, cinema, show_time, show_target,
      format_id, content_id, seats_json, amount_paise, district_booking_id, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, userId, attempt.conversationId, attempt.status, attempt.movie, attempt.cinema,
    attempt.showTime, attempt.showTarget, attempt.formatId, attempt.contentId,
    JSON.stringify(attempt.seats), attempt.amountPaise, districtBookingId, now, now,
  );
  return {
    id, userId, ...attempt, districtBookingId, createdAt: now, updatedAt: now,
  };
}

export function findBookingAttempt(
  db: DatabaseSync,
  userId: string,
  attemptId: string,
): BookingAttempt | null {
  const row = db.prepare(`
    select * from booking_attempts
    where id = ? and user_id = ?
  `).get(attemptId, userId) as Record<string, unknown> | undefined;
  return row ? mapBookingAttempt(row) : null;
}

export function listBookingAttempts(db: DatabaseSync, userId: string): BookingAttempt[] {
  const rows = db.prepare(`
    select * from booking_attempts
    where user_id = ?
    order by created_at desc
  `).all(userId) as Record<string, unknown>[];
  return rows.map(mapBookingAttempt);
}

export function updateBookingAttempt(
  db: DatabaseSync,
  userId: string,
  attemptId: string,
  update: BookingAttemptUpdate,
): BookingAttempt | null {
  assertGenericStatus(update.status);
  db.prepare(`
    update booking_attempts
    set status = coalesce(?, status), district_booking_id = coalesce(?, district_booking_id), updated_at = ?
    where id = ? and user_id = ?
  `).run(update.status ?? null, update.districtBookingId ?? null, Date.now(), attemptId, userId);
  return findBookingAttempt(db, userId, attemptId);
}

export function recordDistrictBookingResult(
  db: DatabaseSync,
  userId: string,
  attemptId: string,
  result: DistrictBookingResult,
): BookingAttempt | null {
  const attempt = findBookingAttempt(db, userId, attemptId);
  if (!attempt) return null;
  if (attempt.status !== 'pending_payment') {
    throw new Error('District booking status requires a pending payment attempt');
  }
  if (result.status === 'pending') return attempt;
  const bookingId = result.bookingId?.trim() ?? '';
  if (result.status === 'confirmed' && !bookingId) {
    throw new Error('confirmed District result requires a booking ID');
  }
  db.prepare(`
    update booking_attempts
    set status = ?, district_booking_id = ?, updated_at = ?
    where id = ? and user_id = ?
  `).run(
    result.status,
    result.status === 'confirmed' ? bookingId : attempt.districtBookingId,
    Date.now(),
    attemptId,
    userId,
  );
  return findBookingAttempt(db, userId, attemptId);
}

export function deleteBookingAttempt(db: DatabaseSync, userId: string, attemptId: string): boolean {
  return db.prepare('delete from booking_attempts where id = ? and user_id = ?')
    .run(attemptId, userId).changes > 0;
}
