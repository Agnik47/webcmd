# Movie Booking OpenCode UI Design

**Status:** Approved
**Date:** 2026-07-30

## Outcome

Replace the movie-booking demo's hand-written static interface with a polished,
responsive frontend built from OpenCode's MIT-licensed `@opencode-ai/ui`
primitives. Keep the existing Node.js server, authentication, SQLite data,
Hermes sessions, WebCMD isolation, API routes, and GCP process topology
unchanged.

## Scope

The frontend keeps the existing product surfaces:

- register, login, and logout;
- conversation list, new chat, transcript, and composer;
- preferences editing;
- pending and historical booking attempts.

The frontend does not adopt OpenCode's coding-agent application, SDK, session
schema, file tools, terminal, model selector, permissions, or persistence.
It also does not add streaming, attachments, voice, markdown extensions, or a
new backend API.

## Architecture

Add a small SolidJS/Vite frontend inside the example. It imports individual
components and styles from `@opencode-ai/ui` and talks directly to the current
same-origin REST endpoints.

```text
SolidJS + @opencode-ai/ui
          |
          | existing /api/* JSON contract
          v
current Node server -> SQLite / Hermes / moviectl / WebCMD
```

Vite produces fixed-name static assets so the existing Node server can serve a
small explicit allowlist. The setup helper builds those assets after installing
the example package. No frontend development server runs in deployment.

## Interface

Desktop layout:

- a narrow left rail for the product name, new-chat action, and conversations;
- the chat timeline and composer as the primary central surface;
- preferences and booking history in a collapsible right panel.

Mobile layout:

- chat remains primary;
- conversations and details open as drawers;
- all controls remain keyboard accessible and labelled.

Use OpenCode's typography, colour tokens, buttons, fields, cards, scroll
surfaces, icons, and dark/light theme behavior. Product copy and booking states
remain movie-specific.

## Data Flow

The existing bootstrap endpoint remains the source of truth after login.
Selecting a conversation loads its messages. Sending a message uses the
existing per-user serialized chat endpoint and refreshes the returned
conversation and booking state. Preferences continue to use the current update
endpoint. Unauthorized responses reset the client to the login view.

Preserve the existing request-epoch behavior so responses from an earlier login
or conversation cannot overwrite the current screen.

## Errors and Safety

- Keep authentication cookies same-origin and HTTP-only.
- Render transcript links through the existing safe URL policy.
- Render all other message content as text.
- Keep submit actions disabled while their request is pending.
- Show concise inline errors without exposing upstream response bodies.
- Do not move Hermes keys, WebCMD identity, payment data, or booking transitions
  into browser code.

## Verification

- Existing server, authentication, ownership, Hermes, queue, and `moviectl`
  tests remain unchanged and pass.
- Client tests cover unauthorized reset, stale-response rejection, safe
  transcript links, conversation switching, preference updates, and chat state.
- The production frontend build succeeds from a clean install.
- The server serves the built root and asset files and rejects unknown paths.
- Desktop and mobile layouts are inspected in a real browser.
- Registration, login, new chat, transcript loading, sending, preferences,
  logout, and health checks are smoke-tested without starting a purchase.
