import { describe, expect, it, vi } from 'vitest';
import { formatWebFetchMarkdown, runClientOwnedWebFetch } from './command.js';

describe('web fetch command', () => {
  it('renders fetch metadata before content', () => {
    expect(formatWebFetchMarkdown({ status: 200, requestedUrl: 'https://a', finalUrl: 'https://b', contentType: 'text/plain', tier: 'plain', title: 'T', extractionSource: 'raw', truncated: false, content: 'body' })).toContain('Source: https://a');
  });
  it('runs the client-owned command without Cloud routing', async () => {
    const webFetch = vi.fn().mockResolvedValue({ status: 200, requestedUrl: 'https://a', finalUrl: 'https://a', contentType: 'text/plain', tier: 'plain', title: '', extractionSource: 'raw', truncated: false, content: 'ok' });
    await runClientOwnedWebFetch(['web', 'fetch', '--url', 'https://a'], { webFetch, stdout: { write: vi.fn() } as never });
    expect(webFetch).toHaveBeenCalledOnce();
  });
});
