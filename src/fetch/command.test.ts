import { describe, expect, it, vi } from 'vitest';
import { formatWebFetchMarkdown, runClientOwnedWebFetch } from './command.js';
import { CliError } from '../errors.js';

describe('web fetch command', () => {
  it('renders fetch metadata before content', () => {
    expect(formatWebFetchMarkdown({ status: 200, requestedUrl: 'https://a', finalUrl: 'https://b', contentType: 'text/plain', tier: 'plain', title: 'T', extractionSource: 'raw', truncated: false, content: 'body' })).toContain('Source: https://a');
  });
  it('runs the client-owned command without Cloud routing', async () => {
    const webFetch = vi.fn().mockResolvedValue({ status: 200, requestedUrl: 'https://a', finalUrl: 'https://a', contentType: 'text/plain', tier: 'plain', title: '', extractionSource: 'raw', truncated: false, content: 'ok' });
    await runClientOwnedWebFetch(['web', 'fetch', '--url', 'https://a'], { webFetch, stdout: { write: vi.fn() } as never });
    expect(webFetch).toHaveBeenCalledOnce();
  });
  it('formats a thrown CliError instead of letting it escape as a raw stack trace', async () => {
    const webFetch = vi.fn().mockRejectedValue(new CliError('FETCH_BLOCKED', 'The site blocked non-browser fetches.', 'Use webcmd web fetch-browser for this URL.', 1));
    const write = vi.fn();
    const priorExitCode = process.exitCode;
    await runClientOwnedWebFetch(['web', 'fetch', '--url', 'https://a'], { webFetch, stderr: { write } as never });
    const output = write.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('FETCH_BLOCKED');
    expect(output).toContain('Use webcmd web fetch-browser for this URL.');
    expect(process.exitCode).toBe(1);
    process.exitCode = priorExitCode;
  });
  it('formats an ArgumentError from bad flags instead of letting it escape as a raw stack trace', async () => {
    const write = vi.fn();
    const priorExitCode = process.exitCode;
    await runClientOwnedWebFetch(['web', 'fetch', '--url', 'not-a-url'], { stderr: { write } as never });
    const output = write.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('ARGUMENT');
    expect(output).toContain('--url must be an http or https URL');
    expect(process.exitCode).toBe(2);
    process.exitCode = priorExitCode;
  });
});
