import { describe, expect, it } from 'vitest';
import { isChallengeResponse, isJavaScriptShell } from './classify.js';

describe('fetch classification', () => {
  it('recognizes explicit challenges but not bare forbidden responses', () => {
    expect(isChallengeResponse(403, { server: 'cloudflare' }, 'Just a moment...')).toBe(true);
    expect(isChallengeResponse(403, {}, 'forbidden')).toBe(false);
  });
  it('recognizes script-heavy app shells', () => expect(isJavaScriptShell('<div id="root"></div><script src="/app.js"></script><script>boot()</script>')).toBe(true));
});
