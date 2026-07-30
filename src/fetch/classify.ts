const challengeMarkers = /cloudflare|cf-chl|datadome|perimeterx|px-captcha|akamai|captcha|just a moment|verify you are human/i;

export function isChallengeResponse(status: number, headers: Record<string, string>, body: string): boolean {
  const evidence = `${Object.entries(headers).map(([key, value]) => `${key}:${value}`).join('\n')}\n${body.slice(0, 20_000)}`;
  return challengeMarkers.test(evidence) && (status === 403 || status === 429 || status === 503 || status === 200);
}

export function isJavaScriptShell(body: string): boolean {
  return /<(?:div|main)[^>]+(?:id|data-[^=]+)=["'](?:root|app)["']/i.test(body)
    && (body.match(/<script\b/gi)?.length ?? 0) >= 1
    && body.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, '').trim().length < 500;
}
