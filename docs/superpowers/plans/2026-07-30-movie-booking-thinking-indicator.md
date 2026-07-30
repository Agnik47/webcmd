# Movie Booking Thinking Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show an accessible inline `Hermes is thinking` assistant bubble with three animated dots while the active chat request is pending.

**Architecture:** Reuse the existing `chatPending` Solid signal and transcript message styles. Render one conditional transcript item, animate its three dots with CSS, and clear pending state when changing conversations so stale work cannot leave the new conversation looking busy.

**Tech Stack:** SolidJS, TypeScript, CSS, Node test runner, Vite.

## Global Constraints

- The bubble text is exactly `Hermes is thinking`.
- Insert the indicator after the optimistic user message and remove it when the request succeeds or fails.
- Keep the indicator visible only while the current chat request is pending.
- Expose the text as a polite status update for assistive technology.
- Stop the dot animation when the user prefers reduced motion.
- Reuse existing state and styles; add no backend route, polling, timer, dependency, streaming behavior, or unrelated UI change.

---

### Task 1: Add the pending assistant bubble

**Files:**
- Modify: `examples/movie-ticket-booking/test/client.test.ts`
- Modify: `examples/movie-ticket-booking/frontend/src/client.ts`
- Modify: `examples/movie-ticket-booking/frontend/src/App.tsx`
- Modify: `examples/movie-ticket-booking/frontend/src/styles.css`

**Interfaces:**
- Consumes: the existing `chatPending(): boolean` signal and `.message` / `.message-content` transcript styles.
- Produces: `thinkingStatus(pending: boolean): string`, returning `Hermes is thinking` only while pending.

- [ ] **Step 1: Write the failing client test**

Import the module namespace alongside the existing named imports:

```ts
import * as client from '../frontend/src/client.js';
```

Then add:

```ts
test('exposes a status only while Hermes is thinking', () => {
  assert.equal(client.thinkingStatus?.(true), 'Hermes is thinking');
  assert.equal(client.thinkingStatus?.(false), '');
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --import tsx --test --test-name-pattern="exposes a status only while Hermes is thinking" test/client.test.ts
```

Expected: FAIL because `client.thinkingStatus?.(true)` returns `undefined`.

- [ ] **Step 3: Add the minimum state and markup**

Add this helper to `frontend/src/client.ts`:

```ts
export function thinkingStatus(pending: boolean): string {
  return pending ? 'Hermes is thinking' : '';
}
```

Import it in `frontend/src/App.tsx`. At the start of `selectConversation`, clear `chatPending` so changing conversations cannot retain a stale busy state. After the existing message loop, render this item:

```tsx
<Show when={chatPending()}>
  <li class="message thinking-message" role="status" aria-live="polite">
    <span class="message-label">HERMES</span>
    <div class="message-content thinking-content">
      <span>{thinkingStatus(chatPending())}</span>
      <span class="thinking-dots" aria-hidden="true"><i /><i /><i /></span>
    </div>
  </li>
</Show>
```

- [ ] **Step 4: Add the native CSS animation**

Add styles beside the transcript message styles:

```css
.thinking-content {
  display: flex;
  align-items: center;
  gap: 8px;
}

.thinking-dots {
  display: inline-flex;
  gap: 3px;
}

.thinking-dots i {
  width: 4px;
  height: 4px;
  background: var(--text-weak);
  border-radius: 50%;
  animation: thinking-dot 1.2s ease-in-out infinite;
}

.thinking-dots i:nth-child(2) {
  animation-delay: 150ms;
}

.thinking-dots i:nth-child(3) {
  animation-delay: 300ms;
}

@keyframes thinking-dot {
  0%, 60%, 100% {
    opacity: 0.35;
    transform: translateY(0);
  }

  30% {
    opacity: 1;
    transform: translateY(-3px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .thinking-dots i {
    opacity: 0.65;
    animation: none;
  }
}
```

- [ ] **Step 5: Verify GREEN and the full demo**

Run:

```bash
node --import tsx --test --test-name-pattern="exposes a status only while Hermes is thinking" test/client.test.ts
npm test
npm run typecheck
npm run build
```

Expected: focused test passes, all demo tests pass, typecheck exits 0, and Vite build exits 0.

- [ ] **Step 6: Browser smoke test**

Run the demo against a delayed fake Hermes response. Confirm:

- `Hermes is thinking` appears after the optimistic user message.
- The three dots animate.
- The indicator disappears after the assistant response.
- The browser console has no errors.

- [ ] **Step 7: Commit**

```bash
git add examples/movie-ticket-booking/test/client.test.ts \
  examples/movie-ticket-booking/frontend/src/client.ts \
  examples/movie-ticket-booking/frontend/src/App.tsx \
  examples/movie-ticket-booking/frontend/src/styles.css
git commit -m "feat(movie-demo): show Hermes thinking indicator"
```
