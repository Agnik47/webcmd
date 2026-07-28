# Hermes Movie Ticket Booking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a runnable local authenticated movie-ticket booking demo in which Hermes recommends and books District tickets through hosted WebCMD, hands payment to the user, verifies the provider result, and exposes booking history.

**Architecture:** A dependency-light TypeScript app owns authentication, app SQLite state, conversation ownership, and a process-local FIFO queue per user. One local Hermes `movie-booking` profile owns the conversational workflow; its skill calls a deterministic `moviectl` wrapper that derives the hosted WebCMD workspace from `HERMES_SESSION_KEY`. District owns payment and is the only source of confirmed booking status.

**Tech Stack:** Node.js 22.5+, TypeScript, `node:http`, `node:crypto`, `node:sqlite`, `node:test`, Hermes API server, WebCMD hosted mode, District adapter, Mintlify MDX.

## Global Constraints

- Work only in `/Users/ankitranjan/Work/webcmd/.worktrees/hermes-movie-booking-demo` on `feat/hermes-movie-booking-demo`.
- BookMyShow must not appear in runtime code, skill behavior, or public guide.
- The app and Hermes run locally; WebCMD browser execution uses hosted mode.
- Use one shared Hermes profile named `movie-booking`.
- Derive one stable Hermes session key and one opaque WebCMD workspace per app user.
- Run one in-memory FIFO Hermes turn at a time per authenticated user; add no global limiter or persistent queue.
- Never store District credentials, OTPs, cookies, card data, or payment credentials.
- Checkout requires explicit confirmation; only District may produce `confirmed`.
- Use Node built-ins in the example; add no framework, ORM, auth service, or queue dependency.
- Keep Hermes product-specific source in the example; do not modify `/Users/ankitranjan/Work/hermes-agent`.
- Do not modify `/Users/ankitranjan/Work/webcmd-cloud` until a publishable WebCMD version containing the new District command exists.

---

## File Map

### District capability

- `clis/district/_lib.js`: pure booking-page status classifier shared with tests.
- `clis/district/booking-status.js`: persistent-browser command that reports `pending`, `confirmed`, `failed`, or `expired`.
- `clis/district/booking-status.test.ts`: classifier and command-registration tests.
- `cli-manifest.json`: generated command manifest.
- `hosted-contract.json`: generated hosted command contract.

### Local example

- `examples/movie-ticket-booking/package.json`: standalone scripts and Node version requirement.
- `examples/movie-ticket-booking/tsconfig.json`: example-only TypeScript build.
- `examples/movie-ticket-booking/src/db.ts`: schema, app users, sessions, conversations, preferences, and booking attempts.
- `examples/movie-ticket-booking/src/auth.ts`: password hashing and cookie/session helpers.
- `examples/movie-ticket-booking/src/user-queue.ts`: per-user FIFO promise chain.
- `examples/movie-ticket-booking/src/hermes.ts`: authenticated Hermes session client.
- `examples/movie-ticket-booking/src/moviectl.ts`: trusted CLI wrapper for app state and WebCMD.
- `examples/movie-ticket-booking/src/server.ts`: HTTP API and static-file server.
- `examples/movie-ticket-booking/public/index.html`: application shell.
- `examples/movie-ticket-booking/public/app.js`: login, chat, preferences, and history interactions.
- `examples/movie-ticket-booking/public/style.css`: accessible responsive presentation.
- `examples/movie-ticket-booking/test/*.test.ts`: built-in Node tests.

### Hermes profile source

- `examples/movie-ticket-booking/hermes/SOUL.md`: narrow profile policy.
- `examples/movie-ticket-booking/hermes/skills/movie-ticket-booking/SKILL.md`: complete District booking workflow.

### Documentation

- `docs/guides/movie-ticket-booking.mdx`: public reproducible guide.
- `docs/docs.json`: Guides navigation entry.
- `examples/movie-ticket-booking/README.md`: concise local runbook referenced by the guide.

---

### Task 1: Add typed District booking-status capability

**Files:**
- Modify: `clis/district/_lib.js`
- Create: `clis/district/booking-status.js`
- Create: `clis/district/booking-status.test.ts`
- Regenerate: `cli-manifest.json`
- Regenerate: `hosted-contract.json`

**Interfaces:**
- Produces: `classifyBookingPage({ url, text }): { status, bookingId, message }`.
- Produces: `webcmd district booking-status [--timeout 5] -f json`.
- Status values: `pending | confirmed | failed | expired`.
- `confirmed` is valid only when a booking/order reference is present.

- [ ] **Step 1: Write classifier tests**

```ts
import { describe, expect, it } from 'vitest';
import { classifyBookingPage } from './_lib.js';

describe('classifyBookingPage', () => {
  it('requires a reference before reporting confirmation', () => {
    expect(classifyBookingPage({
      url: 'https://www.district.in/movies/booking-confirmation',
      text: 'Booking confirmed Booking ID DBX123456',
    })).toMatchObject({ status: 'confirmed', bookingId: 'DBX123456' });
    expect(classifyBookingPage({
      url: 'https://www.district.in/movies/booking-confirmation',
      text: 'Booking confirmed',
    }).status).toBe('pending');
  });

  it.each([
    ['Payment failed. Please try again.', 'failed'],
    ['Your booking session has expired.', 'expired'],
    ['Review your booking Pay now ₹640', 'pending'],
  ])('maps %s to %s', (text, status) => {
    expect(classifyBookingPage({ url: 'https://www.district.in/movies/order-review/x', text }).status)
      .toBe(status);
  });
});
```

- [ ] **Step 2: Run the test and verify the missing export**

Run:

```bash
npx vitest run --project adapter clis/district/booking-status.test.ts
```

Expected: FAIL because `classifyBookingPage` is not exported.

- [ ] **Step 3: Implement the pure classifier**

Add to `clis/district/_lib.js`:

```js
export function classifyBookingPage({ url, text }) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  const bookingId = (
    normalized.match(/(?:booking|order|confirmation)\s*(?:id|number|no\.?)\s*[:#-]?\s*([A-Z0-9-]{6,})/i)
    || []
  )[1] || '';
  if (/booking session.*expired|session has expired|booking expired/i.test(normalized)) {
    return { status: 'expired', bookingId: '', message: normalized.slice(0, 240) };
  }
  if (/payment failed|booking failed|transaction failed|payment was unsuccessful/i.test(normalized)) {
    return { status: 'failed', bookingId: '', message: normalized.slice(0, 240) };
  }
  if (bookingId && /booking confirmed|payment successful|booking successful|your tickets?/i.test(normalized)) {
    return { status: 'confirmed', bookingId, message: normalized.slice(0, 240) };
  }
  return {
    status: 'pending',
    bookingId: '',
    message: normalized.slice(0, 240) || `District has not reported a final result at ${url}`,
  };
}
```

- [ ] **Step 4: Add the browser command**

Create `clis/district/booking-status.js` with:

```js
import { cli, Strategy } from '@agentrhq/webcmd/registry';
import { classifyBookingPage, validateTimeout, waitFor } from './_lib.js';

cli({
  site: 'district',
  name: 'booking-status',
  access: 'read',
  description: 'Check the current District movie checkout or confirmation result',
  domain: 'www.district.in',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  args: [{
    name: 'timeout',
    type: 'int',
    default: 5,
    help: 'Seconds to wait for District to show a final or pending state',
  }],
  columns: ['status', 'bookingId', 'message', 'pageUrl'],
  func: async (page, args) => {
    const timeout = validateTimeout(args.timeout, { def: 5, min: 1, max: 60 });
    const observed = await waitFor(page, 'district booking status', timeout, `
      (() => {
        const text = document.body ? document.body.innerText.replace(/\\s+/g, ' ').trim() : '';
        return { ok: Boolean(text), text, pageUrl: location.href, message: text.slice(0, 240) };
      })()
    `);
    return { ...classifyBookingPage({ url: observed.pageUrl, text: observed.text }), pageUrl: observed.pageUrl };
  },
});
```

- [ ] **Step 5: Verify tests and generated contracts**

Run:

```bash
npx vitest run --project adapter clis/district/booking-status.test.ts
npm run build-manifest
npm run check:hosted-contract
```

Expected: classifier tests PASS and both generated artifacts contain `district/booking-status`.

- [ ] **Step 6: Commit**

```bash
git add clis/district/_lib.js clis/district/booking-status.js clis/district/booking-status.test.ts cli-manifest.json hosted-contract.json
git commit -m "feat(district): add booking status command"
```

---

### Task 2: Create the example database, authentication, and FIFO queue

**Files:**
- Create: `examples/movie-ticket-booking/package.json`
- Create: `examples/movie-ticket-booking/tsconfig.json`
- Create: `examples/movie-ticket-booking/src/db.ts`
- Create: `examples/movie-ticket-booking/src/auth.ts`
- Create: `examples/movie-ticket-booking/src/user-queue.ts`
- Create: `examples/movie-ticket-booking/test/db.test.ts`
- Create: `examples/movie-ticket-booking/test/auth.test.ts`
- Create: `examples/movie-ticket-booking/test/user-queue.test.ts`

**Interfaces:**
- Produces: `openDatabase(path): DatabaseSync`.
- Produces: `createUser`, `verifyCredentials`, `createLoginSession`, `findUserBySession`.
- Produces: conversation, preference, and booking-attempt CRUD functions.
- Produces: `PerUserQueue.run<T>(userId, task): Promise<T>`.

- [ ] **Step 1: Add a standalone zero-runtime-dependency package**

```json
{
  "name": "webcmd-movie-ticket-booking-demo",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.5.0" },
  "scripts": {
    "dev": "tsx src/server.ts",
    "moviectl": "tsx src/moviectl.ts",
    "test": "node --import tsx --test test/*.test.ts",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/node": "^25.5.2",
    "tsx": "^4.19.3",
    "typescript": "^6.0.2"
  }
}
```

- [ ] **Step 2: Write failing auth, database, and ordering tests**

```ts
test('same user is FIFO while different users overlap', async () => {
  const queue = new PerUserQueue();
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = queue.run('alice', async () => { events.push('a1-start'); await gate; events.push('a1-end'); });
  const second = queue.run('alice', async () => { events.push('a2'); });
  const bob = queue.run('bob', async () => { events.push('b1'); });
  await bob;
  assert.deepEqual(events, ['a1-start', 'b1']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['a1-start', 'b1', 'a1-end', 'a2']);
});
```

Also assert:

```ts
assert.notEqual(user.passwordHash, 'correct horse');
assert.equal(verifyCredentials(db, email, 'wrong'), null);
assert.equal(findUserBySession(db, rawToken)?.id, user.id);
assert.equal(findUserBySession(db, 'wrong'), null);
```

- [ ] **Step 3: Run tests and verify failures**

Run:

```bash
npm --prefix examples/movie-ticket-booking install
npm --prefix examples/movie-ticket-booking test
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 4: Implement the schema and access functions**

Use `DatabaseSync` with:

```ts
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');
```

Create exactly these tables: `users`, `auth_sessions`, `conversations`,
`user_preferences`, and `booking_attempts`. Store money as integer paise and
JSON arrays as text. All ownership reads include `user_id = ?`.

- [ ] **Step 5: Implement password and login-token handling**

Use `randomBytes(16)` salt plus `scryptSync(password, salt, 64)` and compare
with `timingSafeEqual`. Generate 32-byte login tokens, store only their SHA-256
hash, and set seven-day expiry timestamps.

- [ ] **Step 6: Implement the minimal per-user queue**

Use one `Map<string, Promise<void>>`; chain each new task after the previous
tail, release it in `finally`, and delete the entry when its own tail becomes
idle. Do not add cancellation, priorities, persistence, or a global semaphore.

- [ ] **Step 7: Run tests and typecheck**

```bash
npm --prefix examples/movie-ticket-booking test
npm --prefix examples/movie-ticket-booking run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add examples/movie-ticket-booking/package.json examples/movie-ticket-booking/package-lock.json examples/movie-ticket-booking/tsconfig.json examples/movie-ticket-booking/src/db.ts examples/movie-ticket-booking/src/auth.ts examples/movie-ticket-booking/src/user-queue.ts examples/movie-ticket-booking/test
git commit -m "feat(example): add movie demo identity and persistence"
```

---

### Task 3: Add the Hermes client and authenticated HTTP application

**Files:**
- Create: `examples/movie-ticket-booking/src/hermes.ts`
- Create: `examples/movie-ticket-booking/src/server.ts`
- Create: `examples/movie-ticket-booking/test/hermes.test.ts`
- Create: `examples/movie-ticket-booking/test/server.test.ts`

**Interfaces:**
- Consumes: database/auth functions and `PerUserQueue` from Task 2.
- Produces: `HermesClient.createSession`, `getMessages`, and `chat`.
- Produces HTTP routes: `/api/register`, `/api/login`, `/api/logout`,
  `/api/bootstrap`, `/api/conversations`, `/api/conversations/:id/messages`,
  `/api/preferences`.

- [ ] **Step 1: Write a fake-Hermes client test**

Start a local `node:http` fixture that records headers and assert:

```ts
await client.chat('hermes-1', 'movie-demo:user:user-1', 'Find Dune');
assert.equal(seen.authorization, 'Bearer hermes-secret');
assert.equal(seen['x-hermes-session-key'], 'movie-demo:user:user-1');
assert.equal(seen.path, '/api/sessions/hermes-1/chat');
```

- [ ] **Step 2: Write server ownership and queue tests**

Register Alice and Bob, create an Alice conversation, and assert Bob receives
404 for both messages and chat. Submit two Alice chat requests against a
blocking fake Hermes server and assert the second reaches Hermes only after the
first completes.

- [ ] **Step 3: Run tests and verify failures**

```bash
npm --prefix examples/movie-ticket-booking test
```

Expected: FAIL because `hermes.ts` and `server.ts` do not exist.

- [ ] **Step 4: Implement `HermesClient`**

Use backend-only Basic/Bearer authentication configured by
`HERMES_API_URL` and `API_SERVER_KEY`. Create app-generated Hermes IDs with
`movie_${crypto.randomUUID()}`. Send the stable key only as a backend header.
Convert non-2xx Hermes responses into typed local HTTP errors without exposing
the API key.

- [ ] **Step 5: Implement the HTTP routes**

Use JSON request bodies capped at 64 KiB, HTTP-only SameSite=Lax cookies, and
ownership-filtered database reads. The chat route wraps the complete Hermes
turn in `userQueue.run(user.id, ...)`.

`GET /api/bootstrap` returns:

```ts
{
  user: { id, email },
  preferences,
  conversations,
  bookings
}
```

- [ ] **Step 6: Run tests and typecheck**

```bash
npm --prefix examples/movie-ticket-booking test
npm --prefix examples/movie-ticket-booking run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add examples/movie-ticket-booking/src/hermes.ts examples/movie-ticket-booking/src/server.ts examples/movie-ticket-booking/test/hermes.test.ts examples/movie-ticket-booking/test/server.test.ts
git commit -m "feat(example): add authenticated Hermes chat server"
```

---

### Task 4: Implement the deterministic `moviectl` wrapper

**Files:**
- Create: `examples/movie-ticket-booking/src/moviectl.ts`
- Create: `examples/movie-ticket-booking/test/moviectl.test.ts`

**Interfaces:**
- Consumes: `MOVIE_DEMO_DB_PATH`, `HERMES_SESSION_KEY`, optional
  `WEBCMD_BIN`, and the database functions from Task 2.
- Produces: JSON-only `profile`, `district`, `prepare-checkout`, `checkout`,
  and `booking-status` commands.
- Derives: `movie_${sha256(sessionKey).slice(0, 32)}` workspace.

- [ ] **Step 1: Write identity and fake-WebCMD tests**

Assert:

```ts
assert.equal(deriveIdentity('movie-demo:user:550e8400-e29b-41d4-a716-446655440000').workspace,
  'movie_' + createHash('sha256').update('movie-demo:user:550e8400-e29b-41d4-a716-446655440000').digest('hex').slice(0, 32));
assert.throws(() => deriveIdentity('alice'));
```

Use a temporary executable that records argv and returns JSON. Assert the argv
contains:

```text
--workspace movie_<hash> --profile district-default district showtimes ... -f json
```

and that no CLI argument can override the workspace.

- [ ] **Step 2: Write booking-state tests**

Assert:

- `prepare-checkout` writes `awaiting_confirmation`.
- `checkout` only accepts that state and records `pending_payment`.
- A second checkout on an unresolved attempt is rejected before WebCMD runs.
- `booking-status` records `confirmed` only when WebCMD returns both
  `status=confirmed` and a non-empty `bookingId`.

- [ ] **Step 3: Run tests and verify failures**

```bash
npm --prefix examples/movie-ticket-booking test
```

Expected: FAIL because `moviectl.ts` does not exist.

- [ ] **Step 4: Implement argument parsing and JSON envelopes**

Use `parseArgs`, `spawnSync` with an argument array, and this envelope:

```ts
type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };
```

Never use `exec`, `shell: true`, or a model-supplied workspace/profile.

- [ ] **Step 5: Implement booking transitions**

Use a transaction for every state transition. Store the exact show URL/ID,
format/content IDs, seats, quoted amount, movie, cinema, and showtime in the
attempt. Return the hosted `paymentUrl` to stdout but do not write it into
booking history.

- [ ] **Step 6: Run tests and typecheck**

```bash
npm --prefix examples/movie-ticket-booking test
npm --prefix examples/movie-ticket-booking run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add examples/movie-ticket-booking/src/moviectl.ts examples/movie-ticket-booking/test/moviectl.test.ts
git commit -m "feat(example): add trusted movie booking wrapper"
```

---

### Task 5: Write and verify the Hermes profile skill

**Files:**
- Create: `examples/movie-ticket-booking/hermes/SOUL.md`
- Create: `examples/movie-ticket-booking/hermes/skills/movie-ticket-booking/SKILL.md`
- Create: `examples/movie-ticket-booking/test/skill.test.ts`

**Interfaces:**
- Consumes: `npm --prefix "$MOVIE_DEMO_ROOT" run moviectl -- ...`.
- Produces: a complete natural-language workflow with explicit command order,
  confirmation boundary, error recovery, and payment verification.

- [ ] **Step 1: Write a structural skill test**

Read `SKILL.md` and assert it contains:

- YAML frontmatter with `name` and `description`.
- District-only wording.
- `prepare-checkout`, `checkout`, and `booking-status`.
- An instruction to wait for explicit confirmation.
- A prohibition on treating “I've paid” as proof.
- No `bookmyshow` substring, case-insensitive.

- [ ] **Step 2: Run the test and verify failure**

```bash
npm --prefix examples/movie-ticket-booking test
```

Expected: FAIL because the skill does not exist.

- [ ] **Step 3: Write `SOUL.md`**

Keep it under 60 lines. It identifies the agent as a District movie-booking
assistant, requires the supplied skill, forbids credentials/payment data in
chat, and forbids confirmation without the provider result.

- [ ] **Step 4: Write `SKILL.md`**

The skill workflow is:

1. Run `profile get`.
2. Ask only for missing movie/city/date/count/preferences.
3. Run District search/showtimes and recommend concise options.
4. After screening choice, run seats with `--count` and `--together`.
5. Present two or three seat sets.
6. Run `prepare-checkout` for the chosen exact set.
7. Display the exact summary and wait for an explicit yes.
8. Run `checkout` once and return its payment link.
9. After “I've paid,” run `booking-status`.
10. Report confirmed only with District's booking reference.

Document typed recovery for auth required, stale seats, pending payment,
failed/expired payment, and service failure.

- [ ] **Step 5: Run tests**

```bash
npm --prefix examples/movie-ticket-booking test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add examples/movie-ticket-booking/hermes examples/movie-ticket-booking/test/skill.test.ts
git commit -m "feat(example): add Hermes movie booking skill"
```

---

### Task 6: Build the minimal authenticated web UI

**Files:**
- Create: `examples/movie-ticket-booking/public/index.html`
- Create: `examples/movie-ticket-booking/public/app.js`
- Create: `examples/movie-ticket-booking/public/style.css`
- Modify: `examples/movie-ticket-booking/src/server.ts`
- Modify: `examples/movie-ticket-booking/test/server.test.ts`

**Interfaces:**
- Consumes: Task 3 HTTP endpoints.
- Produces: login/register, last-chat resume, New chat, preferences, and visible
  booking-history screens.

- [ ] **Step 1: Extend server tests for static assets**

Assert `/`, `/app.js`, and `/style.css` return the correct content types and
that `../` traversal returns 404.

- [ ] **Step 2: Run tests and verify failure**

```bash
npm --prefix examples/movie-ticket-booking test
```

Expected: FAIL because public assets and static serving do not exist.

- [ ] **Step 3: Add static serving**

Map only three explicit paths to files below `public/`; do not implement a
general filesystem path resolver.

- [ ] **Step 4: Build the UI**

Use semantic HTML and native forms. The authenticated layout contains:

- Conversation sidebar with New chat.
- Chat transcript and message form.
- Preferences form.
- Booking-history list with status badges.

Disable the send button while that browser request is pending and show
server/Hermes errors inline. Do not add a seat-map component.

- [ ] **Step 5: Run tests and a local smoke check**

```bash
npm --prefix examples/movie-ticket-booking test
npm --prefix examples/movie-ticket-booking run typecheck
PORT=4317 MOVIE_DEMO_DB_PATH=/tmp/webcmd-movie-demo-smoke.db npm --prefix examples/movie-ticket-booking run dev
```

Open `http://localhost:4317`, verify the auth form renders, then stop the
process and remove only `/tmp/webcmd-movie-demo-smoke.db*`.

- [ ] **Step 6: Commit**

```bash
git add examples/movie-ticket-booking/public examples/movie-ticket-booking/src/server.ts examples/movie-ticket-booking/test/server.test.ts
git commit -m "feat(example): add movie booking web chat"
```

---

### Task 7: Add the local runbook and public guide

**Files:**
- Create: `examples/movie-ticket-booking/README.md`
- Create: `docs/guides/movie-ticket-booking.mdx`
- Modify: `docs/docs.json`

**Interfaces:**
- Consumes: exact commands and paths implemented by Tasks 1–6.
- Produces: one reproducible local setup and website guide.

- [ ] **Step 1: Write the example README**

Include exact prerequisites and commands:

```bash
webcmd setup
npm --prefix examples/movie-ticket-booking install
hermes profile create movie-booking --clone
cp examples/movie-ticket-booking/hermes/SOUL.md ~/.hermes/profiles/movie-booking/SOUL.md
mkdir -p ~/.hermes/profiles/movie-booking/skills
cp -R examples/movie-ticket-booking/hermes/skills/movie-ticket-booking ~/.hermes/profiles/movie-booking/skills/
```

Document environment variables without sample secrets:

```text
API_SERVER_KEY
HERMES_API_URL
MOVIE_DEMO_ROOT
MOVIE_DEMO_DB_PATH
PORT
```

Document separate commands for starting Hermes and the app.

- [ ] **Step 2: Write the Mintlify guide**

Cover: architecture, identity mapping, per-user FIFO queue, SQLite ownership,
Hermes skill contract, `moviectl`, hosted WebCMD setup, District booking flow,
payment handoff, provider confirmation, safe failure handling, and local-demo
limitations.

- [ ] **Step 3: Add Guides navigation**

Insert:

```json
{
  "group": "Guides",
  "pages": ["guides/movie-ticket-booking"]
}
```

before Reference and Support.

- [ ] **Step 4: Verify docs and copy**

```bash
node -e "JSON.parse(require('fs').readFileSync('docs/docs.json','utf8'))"
rg -ni "bookmyshow" examples/movie-ticket-booking docs/guides/movie-ticket-booking.mdx
npm run docs-sync-review
```

Expected: valid JSON, no BookMyShow matches, and docs review succeeds.

- [ ] **Step 5: Commit**

```bash
git add examples/movie-ticket-booking/README.md docs/guides/movie-ticket-booking.mdx docs/docs.json
git commit -m "docs: add Hermes movie booking guide"
```

---

### Task 8: Verify the complete branch and prepare the hosted release handoff

**Files:**
- Modify only if verification exposes a defect in files from Tasks 1–7.
- Do not modify `webcmd-cloud` in this task.

**Interfaces:**
- Produces: a clean, tested WebCMD feature branch and exact hosted-release
  prerequisite.

- [ ] **Step 1: Run focused checks**

```bash
npx vitest run --project adapter clis/district/booking-status.test.ts
npm --prefix examples/movie-ticket-booking test
npm --prefix examples/movie-ticket-booking run typecheck
npm run check:hosted-contract
```

- [ ] **Step 2: Run repository checks**

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: all commands succeed.

- [ ] **Step 3: Run safe live District checks**

```bash
webcmd district search movie --tab movies --limit 3 -f json
webcmd district showtimes "<current movie>" --city "<current city>" --limit 3 -f json
```

Do not automate payment. If a logged-in profile and active checkout are
available, manually verify `webcmd district booking-status -f json` returns a
typed row.

- [ ] **Step 4: Record the Cloud gate**

Confirm `/Users/ankitranjan/Work/webcmd-cloud/package.json` still pins a
released WebCMD version. The hosted rollout can begin only after this branch's
WebCMD package is published. The follow-up Cloud plan is:

```bash
npm run bump:webcmd -- <published-version>
npm test
npm run test:parity:packed
npm run build
```

Then deploy through the existing WebCMD Cloud release gate and prove the real
hosted District checkout/status path. Do not substitute a local package for a
production provenance pin.

- [ ] **Step 5: Commit verification fixes, if any**

If no files changed, do not create an empty commit. Otherwise stage only the
files fixed from Tasks 1–7 and commit:

```bash
git commit -m "fix: complete movie booking verification"
```
