import { describe, expect, it } from 'vitest';
import { diffSnapshots } from './snapshot.js';

const snapshot = (body: string) => `url: https://example.test/\ntitle: Demo\n---\n${body}\n---\ninteractive: 0 | iframes: 0`;

describe('diffSnapshots', () => {
  it('preserves ordered duplicate siblings and their unchanged ancestors', () => {
    expect(diffSnapshots(
      snapshot('<main>\n  [1]<button>Save</button>\n  [2]<button>Save</button>'),
      snapshot('<main>\n  [3]<button>Save</button>\n  [4]<button>Saved</button>'),
    )).toBe([
      '<main>',
      '~   [4]<button>Saved</button>',
      '</main>',
    ].join('\n'));
  });

  it('suppresses ref-only and href query or fragment changes', () => {
    expect(diffSnapshots(
      snapshot('<main>\n  [1]<a href=https://example.test/docs?old=1#intro>Docs</a>'),
      snapshot('<main>\n  [99]<a href=https://example.test/docs?new=2#api>Docs</a>'),
    )).toBe('');
  });

  it('elides changed children after four and caps labels at 140 characters', () => {
    const label = 'x'.repeat(200);
    const before = snapshot('<main>');
    const after = snapshot([
      '<main>',
      ...Array.from({ length: 5 }, (_, index) => `  [${index + 1}]<button>${label}</button>`),
    ].join('\n'));

    const result = diffSnapshots(before, after);

    expect(result.match(/^\+ /gm)).toHaveLength(4);
    expect(result).toContain('[Truncated 1 more element]');
    expect(result).toContain(`${'x'.repeat(139)}…`);
  });

  it('bounds output deterministically', () => {
    const before = snapshot('<main>');
    const after = snapshot('<main>\n  [1]<button>Saved</button>');

    expect(diffSnapshots(before, after, 20)).toBe('<main>\n+   [1]<butto');
  });
});
