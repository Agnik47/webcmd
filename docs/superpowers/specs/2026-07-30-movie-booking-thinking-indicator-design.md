# Movie Booking Thinking Indicator Design

**Status:** Approved
**Date:** 2026-07-30

## Outcome

Show an inline assistant bubble while a chat request is waiting for Hermes.
The bubble reads `Hermes is thinking` and includes three animated dots.

## Behavior

- Insert the indicator after the optimistic user message.
- Keep it visible only while the current chat request is pending.
- Remove it when the request succeeds or fails.
- Scroll it into view through the existing transcript scroll behavior.
- Expose the text as a polite status update for assistive technology.
- Stop the dot animation when the user prefers reduced motion.

## Scope

Reuse the existing `chatPending` state and transcript styles. Add no backend
route, polling, timer, dependency, streaming behavior, or unrelated UI change.

## Verification

- A client test covers the pending status label.
- The demo test suite, typecheck, and production build pass.
- A browser smoke test confirms the indicator appears during a delayed response
  and disappears after the response arrives.
