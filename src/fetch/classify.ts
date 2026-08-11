// Strings that don't legitimately appear except on an actual challenge/block page —
// decisive on their own, at any status including a plain 200 (e.g. a Cloudflare
// managed challenge can render its interstitial with a 200).
const strongChallengeMarkers = /cf-chl|cf-mitigated|datadome|perimeterx|px-captcha|captcha|just a moment|verify you are human/i;
// Bare CDN/vendor names are not evidence of blocking by themselves — `server: cloudflare`
// (or akamai) shows up on every response those networks front, challenged or not, so
// treating it as decisive on a 200 flags most of the ordinary CDN-fronted web. Only
// corroborate an already-suspicious non-200 status with it.
const cdnVendorMarkers = /cloudflare|akamai/i;

export function isChallengeResponse(status: number, headers: Record<string, string>, body: string): boolean {
  const evidence = `${Object.entries(headers).map(([key, value]) => `${key}:${value}`).join('\n')}\n${body.slice(0, 20_000)}`;
  const blockedStatus = status === 403 || status === 429 || status === 503;
  if (strongChallengeMarkers.test(evidence)) return blockedStatus || status === 200;
  if (cdnVendorMarkers.test(evidence)) return blockedStatus;
  return false;
}

export function isJavaScriptShell(body: string): boolean {
  return /<(?:div|main)[^>]+(?:id|data-[^=]+)=["'](?:root|app)["']/i.test(body)
    && (body.match(/<script\b/gi)?.length ?? 0) >= 1
    && body.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, '').trim().length < 500;
}
