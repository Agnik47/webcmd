import { describe, expect, it } from 'vitest';
import { BrowserRunObservationStore } from './observation.js';

describe('BrowserRunObservationStore', () => {
  it('returns a full first observation and a compact later diff', () => {
    const store = new BrowserRunObservationStore();

    expect(store.record({
      pageId: 'page-1',
      url: 'https://example.test/',
      content: 'button "Save"',
      requestedMode: 'diff',
      maxChars: 10_000,
    })).toEqual({
      observation: { mode: 'full', content: 'button "Save"' },
      truncated: false,
    });

    expect(store.record({
      pageId: 'page-1',
      url: 'https://example.test/',
      content: 'button "Save"\nstatus "Saved"',
      requestedMode: 'diff',
      maxChars: 10_000,
    })).toEqual({
      observation: { mode: 'diff', changed: '+ status "Saved"' },
      truncated: false,
    });
  });

  it('resets to a full observation after navigation and bounds content', () => {
    const store = new BrowserRunObservationStore();
    store.record({
      pageId: 'page-1',
      url: 'https://example.test/one',
      content: 'first',
      requestedMode: 'diff',
      maxChars: 10_000,
    });

    const result = store.record({
      pageId: 'page-1',
      url: 'https://example.test/two',
      content: 'x'.repeat(20),
      requestedMode: 'diff',
      maxChars: 10,
    });

    expect(result).toEqual({
      observation: { mode: 'full', content: 'xxxxxxxxxx' },
      truncated: true,
    });
  });
});
