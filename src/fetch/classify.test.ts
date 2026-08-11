import { describe, expect, it } from 'vitest';
import { isChallengeResponse, isJavaScriptShell } from './classify.js';

describe('fetch classification', () => {
  it('recognizes explicit challenges but not bare forbidden responses', () => {
    expect(isChallengeResponse(403, { server: 'cloudflare' }, 'Just a moment...')).toBe(true);
    expect(isChallengeResponse(403, {}, 'forbidden')).toBe(false);
  });
  it('does not flag an ordinary 200 just because it is served through a CDN (issue #283)', () => {
    expect(isChallengeResponse(200, { server: 'cloudflare', 'cf-cache-status': 'HIT', 'content-type': 'text/html' }, '<html><body>Example Domain</body></html>')).toBe(false);
    expect(isChallengeResponse(200, { server: 'akamaighost' }, '<html>ordinary page</html>')).toBe(false);
  });
  it('still flags a CDN vendor name as a challenge signal once the status itself looks blocked', () => {
    expect(isChallengeResponse(503, { server: 'cloudflare' }, '')).toBe(true);
    expect(isChallengeResponse(429, { server: 'akamaighost' }, '')).toBe(true);
  });
  it('flags a 200 challenge interstitial via a body marker, without needing a CDN header', () => {
    expect(isChallengeResponse(200, {}, 'Just a moment...')).toBe(true);
  });
  it('flags a 200 challenge via a specific challenge header even without body markers', () => {
    expect(isChallengeResponse(200, { server: 'cloudflare', 'cf-mitigated': 'challenge' }, '<html>interstitial</html>')).toBe(true);
  });
  it('recognizes script-heavy app shells', () => expect(isJavaScriptShell('<div id="root"></div><script src="/app.js"></script><script>boot()</script>')).toBe(true));
});
