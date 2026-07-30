# Movie Booking Hermes Streaming UI Design

**Status:** Approved
**Date:** 2026-07-30

## Outcome

Give the movie-booking demo a polished Hermes-style chat experience with
token-by-token responses, without importing Hermes WebUI's application runtime
or changing the demo's ownership boundaries.

The current Node server, cookie authentication, SQLite data, per-user queue,
Hermes session IDs, `movie-demo:user:<uuid>` memory key, `moviectl`, WebCMD
workspace isolation, booking state, and GCP service topology remain authoritative.

## Scope

The implementation includes:

- a visually restrained Hermes-style transcript, sidebar, and composer;
- token streaming from the existing Hermes session API;
- generic tool activity feedback while Hermes works;
- conversation-aware pending state when the user changes chats;
- composer auto-grow and Enter-to-send with Shift+Enter for a newline;
- polished loading, focus, mobile drawer, and reduced-motion behavior.

It excludes:

- the Hermes WebUI runtime, Python server, session controller, workspace,
  terminal, model selector, settings, skills, memory, cron, voice, attachments,
  PWA, and theme system;
- rich Markdown or copied third-party assets;
- the WebCMD Cloud live-view panel discussed separately;
- changes to booking rules, payment handoff, authentication, or persistence.

## Architecture

Use Hermes' existing session streaming endpoint rather than switching to a new
chat protocol or resending transcript history.

```text
SolidJS chat UI
    |
    | POST /api/conversations/:id/chat/stream
    v
current Node server + per-user queue
    |
    | POST /api/sessions/:id/chat/stream
    | X-Hermes-Session-Key: movie-demo:user:<uuid>
    v
Hermes SSE: assistant.delta, tool.*, assistant.completed, run.completed
    |
    v
Node emits a small same-origin SSE contract
```

The existing synchronous `/chat` route remains available for compatibility,
but the browser uses `/chat/stream`.

No new package is required. The frontend keeps SolidJS and the installed
OpenCode primitives/tokens. Hermes WebUI is used only as a visual and
interaction reference.

## Streaming Contract

The Node endpoint authenticates and authorizes the conversation before writing
SSE headers. It validates the message, enters the existing per-user queue, and
forwards the turn to the matching Hermes session with the stable user key.

The browser-facing stream contains only these events:

- `assistant.delta` with `{ "delta": "..." }` for visible assistant text;
- `activity` with `{ "active": true }` when Hermes starts a tool and
  `{ "active": false }` when it finishes, without exposing internal arguments;
- `chat.completed` with the authoritative assistant message, updated conversation,
  and current booking snapshot;
- `error` with a safe user-facing message.

Hermes' `assistant.completed` value is the authoritative final reply.
`run.completed` marks the point at which the server updates a default
conversation title, touches its recency, reads the booking snapshot, emits
`chat.completed`, and releases the queue.

SSE parsing must handle arbitrary network chunk boundaries, CRLF or LF line
endings, comments/keepalives, split UTF-8 characters, and a final event without
a trailing blank line. Malformed upstream events fail with a safe error and do
not expose Hermes response bodies or credentials.

## Conversation State

Sending appends the user message immediately and creates one provisional
assistant message for that conversation. Before the first token it shows the
existing “Hermes is thinking” dots. Deltas update that same message instead of
adding new bubbles. The final event replaces the provisional content with the
authoritative reply.

Only one chat turn may be active per user, matching the current queue. The
frontend records the pending conversation ID:

- reselecting that same conversation preserves its draft and pending state;
- selecting another conversation loads that transcript while the original
  stream continues;
- background completion updates conversation ordering and bookings but never
  writes messages into the currently selected different conversation;
- selecting the completed conversation later loads its persisted transcript.

Logout or authentication expiry invalidates all pending UI updates through the
existing request epoch. A network or upstream failure removes the empty
provisional assistant message, preserves the user's message, clears pending
state, and shows one inline retryable error. Refreshing reconciles with Hermes'
persisted transcript.

## Interface

Keep the useful three-column product structure:

- narrow conversation rail;
- centered chat transcript;
- booking and preference context panel.

Apply the relevant Hermes WebUI patterns without copying its runtime:

- assistant replies are unboxed readable prose in a roughly 780px column;
- user messages are compact right-aligned bubbles;
- the active conversation uses a quiet fill and narrow accent;
- the composer starts at one row, grows to a capped height, and uses a circular
  send action;
- mobile keeps the current drawer model with 44px touch targets, Escape close,
  focus return, and safe-area padding;
- motion remains subtle and respects `prefers-reduced-motion`.

The transcript retains the current safe plain-text and validated HTTPS-link
policy. Streaming text is never inserted as HTML.

Auto-scroll follows new output only while the reader is already near the
bottom. Reading older messages is not interrupted. A single polite status
region announces thinking, tool activity, completion, and failure; token
deltas themselves are not announced one by one.

## Upstream Boundary

The visual reference is
[`nesquena/hermes-webui`](https://github.com/nesquena/hermes-webui) at commit
`0a401597594575d5650a755d1228b7de5a87544e`, especially its transcript,
composer, sidebar, responsive spacing, and reduced-motion patterns.

No upstream source file, logo, favicon, font, vendored Markdown renderer, or
other asset is copied. Therefore this change does not add an upstream runtime,
fork, or attribution file. If meaningful upstream code or assets are copied
later, its MIT notice and any third-party notices must accompany them.

## Errors and Safety

- Authenticate before starting the stream and keep cookies same-origin and
  HTTP-only.
- Preserve `X-Hermes-Session-Key: movie-demo:user:<uuid>` server-side.
- Do not expose Hermes authorization, tool arguments, WebCMD identity,
  provider URLs, or upstream error bodies.
- Keep transcript reads and chat turns inside the per-user queue.
- If the browser disconnects after the turn is accepted, stop downstream
  writes but continue consuming Hermes through terminal success or failure,
  finalize successful DB state, and then release the queue. Never replay or
  fall back to synchronous chat because tools may already have produced side
  effects.
- Keep purchase confirmation and payment handoff behavior unchanged.

## Verification

- Hermes client tests cover fragmented SSE, UTF-8 boundaries, keepalives,
  deltas, tool lifecycle, completion, malformed events, and safe errors.
- Server tests cover authentication, ownership, the stable user key, event
  forwarding, title/booking finalization, per-user serialization, and client
  disconnect cleanup.
- Client tests cover the stream parser, one provisional assistant message,
  background conversation completion, stale epochs, Enter/Shift+Enter/IME,
  loading states, and safe links.
- The full demo suite, typecheck, production build, and `git diff --check`
  pass.
- Real-browser smoke tests cover desktop and mobile auth, new chat, visible
  thinking state, token streaming, tool activity, conversation switching,
  preferences, bookings, keyboard behavior, scrolling, and logout.
- Deployment verification checks the exact deployed commit, both systemd
  services, `/healthz`, and one safe non-purchase streamed turn.
