# Movie Booking Hermes Streaming UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a polished Hermes-style chat interface with token streaming while preserving the demo's existing authentication, persistence, booking, and deployment boundaries.

**Architecture:** The Node server relays Hermes' persisted-session SSE endpoint through a small same-origin SSE contract. The SolidJS client keeps one conversation-aware pending turn, renders a provisional assistant reply as deltas arrive, and reconciles it with the authoritative final message and booking snapshot.

**Tech Stack:** Node.js 22 native HTTP/fetch/Web Streams, TypeScript, SolidJS, Vite, existing `@opencode-ai/ui`, Node built-in test runner.

## Global Constraints

- Do not add a package or copy Hermes WebUI runtime code, assets, fonts, logos, theme machinery, or Markdown renderer.
- Keep the synchronous `/api/conversations/:id/chat` route available.
- Stream through Hermes `POST /api/sessions/:id/chat/stream` with `X-Hermes-Session-Key: movie-demo:user:<uuid>`.
- Keep cookie authentication, conversation ownership, `PerUserQueue`, SQLite title/recency updates, booking snapshots, `moviectl`, WebCMD workspace isolation, and payment behavior unchanged.
- Forward visible assistant deltas and generic activity only; never expose tool arguments/results, credentials, upstream bodies, provider URLs, or WebCMD identity.
- After an accepted downstream disconnect, continue consuming Hermes and finalize successful DB state; never replay or fall back because tools may have side effects.
- Keep transcript output as text plus validated HTTPS links. Never insert streamed content as HTML.
- Preserve request/session epochs and prevent background streams from writing into a different active conversation.
- Respect keyboard accessibility, one polite status region, 44px mobile targets, and `prefers-reduced-motion`.

---

### Task 1: Hermes persisted-session SSE client

**Files:**
- Modify: `examples/movie-ticket-booking/src/hermes.ts`
- Modify: `examples/movie-ticket-booking/test/hermes.test.ts`

**Interfaces:**
- Consumes: Hermes `POST /api/sessions/:id/chat/stream`, bearer authentication, `X-Hermes-Session-Key`, and body `{ "input": string }`.
- Produces:

```ts
export type HermesStreamEvent =
  | { type: 'assistant.delta'; delta: string }
  | { type: 'activity'; active: boolean };

async chatStream(
  sessionId: string,
  sessionKey: string,
  message: string,
  onEvent: (event: HermesStreamEvent) => void,
): Promise<HermesChatResponse>
```

- [ ] **Step 1: Add failing streaming contract tests**

Add focused tests that make the fixture write raw SSE chunks and assert:

```ts
const events: HermesStreamEvent[] = [];
const response = await client.chatStream(
  'hermes-1',
  'movie-demo:user:user-1',
  'Find Dune',
  (event) => events.push(event),
);

assert.equal(seen.path, '/api/sessions/hermes-1/chat/stream');
assert.equal(seen.sessionKey, 'movie-demo:user:user-1');
assert.equal(seen.accept, 'text/event-stream');
assert.deepEqual(events, [
  { type: 'assistant.delta', delta: 'Du' },
  { type: 'assistant.delta', delta: 'ne 😀' },
  { type: 'activity', active: true },
  { type: 'activity', active: false },
]);
assert.deepEqual(response.message, {
  role: 'assistant',
  content: 'Dune 😀 is playing.',
});
```

The fixture must split one UTF-8 emoji across byte chunks, use both CRLF and LF
event separators, include a `: keepalive` comment, and omit the trailing blank
line after `done`.

Add rejection cases for:

```ts
// non-SSE 200 response
// error event containing a secret upstream message
// done before assistant.completed/run.completed
// malformed JSON event data
```

Each rejection must be `HermesHttpError` with status `502` and no secret text.

- [ ] **Step 2: Run the Hermes tests and verify RED**

Run:

```bash
cd examples/movie-ticket-booking
node --import tsx --test test/hermes.test.ts
```

Expected: FAIL because `HermesClient.chatStream` and `HermesStreamEvent` do not exist.

- [ ] **Step 3: Implement the minimal native SSE reader**

In `hermes.ts`, keep `chat()` unchanged and add `chatStream()` using native
`fetch`, `ReadableStream.getReader()`, and one streaming `TextDecoder`.

The parser must:

```ts
// normalize CRLF to LF;
// preserve incomplete event text between reads;
// ignore comment and unknown event blocks;
// emit assistant.delta only for a string `delta`;
// map tool.started to activity true;
// map tool.completed/tool.failed to activity false;
// retain assistant.completed content;
// require run.completed before done/EOF;
// return the existing safe HermesChatResponse shape.
```

Use the existing authorization construction and safe `HermesHttpError`.
Do not add a general-purpose SSE abstraction or dependency.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```bash
cd examples/movie-ticket-booking
node --import tsx --test test/hermes.test.ts
npm run typecheck
```

Expected: all Hermes tests pass and TypeScript exits 0.

- [ ] **Step 5: Commit Task 1**

```bash
git add examples/movie-ticket-booking/src/hermes.ts examples/movie-ticket-booking/test/hermes.test.ts
git commit -m "feat(movie-demo): stream Hermes session replies"
```

---

### Task 2: Authenticated same-origin streaming relay

**Files:**
- Modify: `examples/movie-ticket-booking/src/server.ts`
- Modify: `examples/movie-ticket-booking/test/server.test.ts`

**Interfaces:**
- Consumes: Task 1 `HermesClient.chatStream(...)` and `HermesStreamEvent`.
- Produces:

```http
POST /api/conversations/:conversationId/chat/stream
Content-Type: application/json

{"message":"Find Dune"}
```

```text
: connected

event: assistant.delta
data: {"delta":"Dune"}

event: activity
data: {"active":true}

event: chat.completed
data: {"message":{...},"conversation":{...},"bookings":[...]}

```

Exactly one terminal `chat.completed` or `error` event is emitted when the
downstream connection is writable.

- [ ] **Step 1: Add failing server relay tests**

Extend the test Hermes dependency to include `chatStream`. Add tests for:

```ts
// unauthenticated and wrong-owner requests fail before SSE headers;
// the route sends text/event-stream, no-cache, and X-Accel-Buffering: no;
// the stable key is exactly movie-demo:user:<authenticated user id>;
// deltas and generic activity are forwarded without tool details;
// chat.completed contains the authoritative message, updated title, and bookings;
// a failed stream emits a safe error event and does not title/touch the chat;
// /chat still returns the unchanged synchronous JSON response;
// two same-user operations remain serialized through terminal completion;
// a disconnected browser does not cancel Hermes finalization.
```

The successful fake should call:

```ts
onEvent({ type: 'assistant.delta', delta: 'Du' });
onEvent({ type: 'activity', active: true });
onEvent({ type: 'activity', active: false });
return {
  object: 'hermes.session.chat.completion',
  session_id: sessionId,
  message: { role: 'assistant', content: 'Dune is playing.' },
};
```

The disconnect test must destroy the client response after the first delta,
allow the fake Hermes promise to resolve, then assert a later bootstrap sees
the updated conversation title/recency and booking snapshot.

- [ ] **Step 2: Run server tests and verify RED**

Run:

```bash
cd examples/movie-ticket-booking
node --import tsx --test test/server.test.ts
```

Expected: FAIL because the injected dependency lacks `chatStream` and the route is 404.

- [ ] **Step 3: Add the minimal relay and shared finalization**

Update the injected Hermes type to include `chatStream`. Extend the conversation
route matcher to recognize `chat/stream`.

Inside the authenticated/owned route:

```ts
response.writeHead(200, {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
});
response.write(': connected\n\n');
```

Use one local `writeSse(event, data)` helper that returns without writing when
`response.destroyed || response.writableEnded`.

Hold `userQueue.run(user.id, ...)` across:

```ts
await hermes.chatStream(
  conversation.hermesSessionId,
  `movie-demo:user:${user.id}`,
  message,
  forwardSafeEvent,
);
// existing default-title update
// existing touchConversation
// existing listBookingAttempts
// chat.completed write
```

Extract only the duplicated successful-turn finalization shared by `/chat` and
`/chat/stream`. Do not create a transport framework.

Catch streaming failures inside the route, emit:

```text
event: error
data: {"error":"Hermes request failed"}
```

when writable, and always `response.end()` after the queued turn settles. Do
not abort `chatStream` on downstream `close`.

- [ ] **Step 4: Run focused and adjacent tests**

Run:

```bash
cd examples/movie-ticket-booking
node --import tsx --test test/server.test.ts test/hermes.test.ts test/user-queue.test.ts
npm run typecheck
```

Expected: all selected tests pass and TypeScript exits 0.

- [ ] **Step 5: Commit Task 2**

```bash
git add examples/movie-ticket-booking/src/server.ts examples/movie-ticket-booking/test/server.test.ts
git commit -m "feat(movie-demo): relay streamed chat turns"
```

---

### Task 3: Browser stream parser and conversation-safe state helpers

**Files:**
- Modify: `examples/movie-ticket-booking/frontend/src/client.ts`
- Modify: `examples/movie-ticket-booking/test/client.test.ts`

**Interfaces:**
- Consumes: Task 2 `assistant.delta`, `activity`, `chat.completed`, and `error` SSE events.
- Produces:

```ts
export type ChatStreamEvent =
  | { type: 'assistant.delta'; delta: string }
  | { type: 'activity'; active: boolean }
  | { type: 'chat.completed'; response: ChatResponse };

export function createChatStream(
  fetchRequest: typeof fetch,
  isCurrent: (captured: number) => boolean,
  onUnauthorized: (message: string) => void,
): (
  path: string,
  message: string,
  captured: number,
  onEvent: (event: ChatStreamEvent) => void,
) => Promise<void>;

export function shouldSubmitComposer(input: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
}): boolean;
```

`ChatResponse` moves from `App.tsx` to `client.ts` and remains:

```ts
export interface ChatResponse {
  message: Message;
  conversation: Conversation;
  bookings: Booking[];
}
```

- [ ] **Step 1: Add failing browser contract tests**

Add tests asserting:

```ts
// fragmented UTF-8 and event blocks emit ordered typed events;
// keepalive comments and unknown events are ignored;
// chat.completed is required exactly once;
// error event rejects with only its safe public message;
// a non-2xx JSON error uses the existing safe message extraction;
// a 401 invokes onUnauthorized only when the captured request is current;
// Enter submits, Shift+Enter does not, and IME composition does not.
```

Update `applyChatResponse` expectations so a current request always refreshes
conversation ordering and bookings, but calls its message callback only when
the original conversation is still selected.

- [ ] **Step 2: Run client tests and verify RED**

Run:

```bash
cd examples/movie-ticket-booking
node --import tsx --test test/client.test.ts
```

Expected: FAIL because the streaming types/functions and new background completion behavior do not exist.

- [ ] **Step 3: Implement the smallest browser reader**

Use native `fetch`, `response.body.getReader()`, and one streaming
`TextDecoder`. Reuse the same event-block rules from the server contract but
keep the implementation local and short; do not add a shared cross-runtime
abstraction.

`createChatStream` must POST JSON, require `text/event-stream`, call
`onUnauthorized` under the same epoch rule as `createApi`, emit only typed
events, and reject missing/duplicate terminal events.

Change `applyChatResponse` in this order:

```ts
if (!isCurrent()) return null;
renderBookingSnapshot(response.bookings);
const updated = [
  response.conversation,
  ...conversations.filter((item) => item.id !== response.conversation.id),
];
if (isCurrentSelection()) applyMessage(response.message);
return updated;
```

Implement `shouldSubmitComposer` as one boolean expression.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```bash
cd examples/movie-ticket-booking
node --import tsx --test test/client.test.ts
npm run typecheck
```

Expected: all client tests pass and TypeScript exits 0.

- [ ] **Step 5: Commit Task 3**

```bash
git add examples/movie-ticket-booking/frontend/src/client.ts examples/movie-ticket-booking/test/client.test.ts
git commit -m "feat(movie-demo): consume streamed chat events"
```

---

### Task 4: Hermes-style streamed conversation experience

**Files:**
- Modify: `examples/movie-ticket-booking/frontend/src/App.tsx`
- Modify: `examples/movie-ticket-booking/frontend/src/styles.css`
- Modify: `examples/movie-ticket-booking/test/client.test.ts`

**Interfaces:**
- Consumes: Task 3 `createChatStream`, `ChatStreamEvent`,
  `shouldSubmitComposer`, and the revised `applyChatResponse`.
- Produces:

```ts
interface PendingTurn {
  conversationId: string;
  messages: Message[];
  draft: string;
  activity: boolean;
}

export function isPendingConversation(
  pendingConversationId: string | undefined,
  selectedConversationId: string,
): boolean;

export function shouldFollowOutput(input: {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}): boolean;
```

- [ ] **Step 1: Add failing state-policy tests**

Add pure helper coverage for the behavior App needs:

```ts
assert.equal(isPendingConversation('chat-1', 'chat-1'), true);
assert.equal(isPendingConversation('chat-1', 'chat-2'), false);
assert.equal(isPendingConversation(undefined, 'chat-1'), false);

assert.equal(shouldFollowOutput({
  scrollTop: 700,
  clientHeight: 300,
  scrollHeight: 1040,
}), true);
assert.equal(shouldFollowOutput({
  scrollTop: 200,
  clientHeight: 300,
  scrollHeight: 1040,
}), false);

// completion for a background conversation updates global metadata/bookings
// but does not append its assistant message to the active transcript;
// the existing same-conversation reselection guarantee remains covered.
```

Implement both helpers as direct boolean expressions. Test background
completion through the existing `applyChatResponse` callback boundary.

- [ ] **Step 2: Run client tests and verify RED**

Run:

```bash
cd examples/movie-ticket-booking
node --import tsx --test test/client.test.ts
```

Expected: FAIL on the newly specified pending/background behavior.

- [ ] **Step 3: Wire one streaming turn into `App.tsx`**

Replace `chatPending: boolean` with `pendingTurn: PendingTurn | null` and create
the stream client beside the existing JSON API client.

On send:

```ts
const optimistic = [...messages(), { role: 'user', content: message } satisfies Message];
setMessages(optimistic);
setPendingTurn({ conversationId, messages: optimistic, draft: '', activity: false });
await chatStream(path, message, captured, handleStreamEvent);
```

Event behavior:

```ts
assistant.delta -> append to pendingTurn.draft
activity -> update pendingTurn.activity
chat.completed -> applyChatResponse using the original conversation selection
error/throw -> remove only the empty provisional assistant, preserve user text,
               clear pending state, and show one inline error
```

When selecting the pending conversation, restore `pendingTurn.messages` and its
draft without requesting `/messages`. Selecting another conversation must not
clear or abort the pending turn. Disable sending another message while any turn
is active.

Use `shouldFollowOutput()` before a stream update and scroll after rendering
only when it returns true.

Add composer keyboard handling:

```ts
if (shouldSubmitComposer({
  key: event.key,
  shiftKey: event.shiftKey,
  isComposing: event.isComposing,
})) {
  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
}
```

Use a single screen-reader status node for thinking, activity, completion, and
failure. Do not make token deltas an `aria-live` region.

- [ ] **Step 4: Apply the focused Hermes visual treatment**

Keep the existing app structure and OpenCode imports. Change only local markup
classes and CSS:

```text
assistant: unboxed prose, max-width about 780px
user: compact right-aligned bubble, max-width 70% desktop / 90% mobile
composer: one-row start, field-sizing: content, max-height 180px, circular send
sidebar: quiet hover, active fill plus narrow accent, 44px touch rows
loading: no empty-state flash while a transcript request is pending
scroll: follow output only when already near the bottom
mobile: Escape closes drawers and focus returns to the opener
motion: retain one thinking/activity cue and reduced-motion fallback
```

Keep the current safe `transcriptParts()` rendering. Do not import an upstream
stylesheet or create a component library.

- [ ] **Step 5: Run UI-adjacent verification**

Run:

```bash
cd examples/movie-ticket-booking
node --import tsx --test test/client.test.ts test/server.test.ts test/hermes.test.ts
npm run typecheck
npm run build
```

Expected: selected tests pass, TypeScript exits 0, and Vite produces the fixed
`dist/index.html`, `dist/app.js`, and `dist/style.css` files.

- [ ] **Step 6: Commit Task 4**

```bash
git add examples/movie-ticket-booking/frontend/src/App.tsx examples/movie-ticket-booking/frontend/src/styles.css examples/movie-ticket-booking/test/client.test.ts
git commit -m "feat(movie-demo): add Hermes streaming chat experience"
```

---

### Task 5: Documentation and complete verification

**Files:**
- Modify: `examples/movie-ticket-booking/README.md`
- Modify: `docs/guides/movie-ticket-booking.mdx`

**Interfaces:**
- Consumes: the completed streaming route and UI behavior from Tasks 1–4.
- Produces: operator/user documentation that describes the streaming boundary
  and retains the existing local and GCP lifecycle commands.

- [ ] **Step 1: Update only the relevant documentation**

Document:

```text
- the browser uses the same-origin /chat/stream endpoint;
- the Node server forwards the stable per-user Hermes session key;
- the synchronous /chat endpoint remains;
- disconnects continue accepted turns and never replay tool work;
- no Hermes WebUI runtime is bundled;
- local start/build commands are unchanged.
```

Do not add speculative live-view, Markdown, attachment, or deployment changes.

- [ ] **Step 2: Run the complete repository checks for this example**

Run:

```bash
cd examples/movie-ticket-booking
npm test
npm run typecheck
npm run build
cd ../..
git diff --check
```

Expected: the full demo test suite has zero failures; typecheck, build, and
whitespace validation exit 0.

- [ ] **Step 3: Run real-browser smoke tests**

Start the existing local Hermes gateway and app using the documented scripts.
Verify at desktop and mobile widths:

```text
registration/login
new conversation
thinking indicator before first delta
visible token streaming
generic tool activity with no internal arguments
switch away from and back to a pending conversation
Enter send, Shift+Enter newline, IME-safe key handling
near-bottom auto-scroll without pulling a reader from older messages
preferences, bookings, logout, and /healthz
```

Use a safe search/showtimes request and do not start checkout or payment.

- [ ] **Step 4: Commit Task 5**

```bash
git add examples/movie-ticket-booking/README.md docs/guides/movie-ticket-booking.mdx
git commit -m "docs(movie-demo): document streamed chat"
```
