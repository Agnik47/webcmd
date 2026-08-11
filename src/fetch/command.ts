import { cli, Strategy } from '../registry.js';
import { ArgumentError, CliError, EXIT_CODES, toEnvelope } from '../errors.js';
import { webFetch, type WebFetchOptions, type WebFetchResult } from './client.js';

export const webFetchCommand = cli({
  site: 'web', name: 'fetch', access: 'read', strategy: Strategy.PUBLIC, browser: false,
  description: 'Fetch a URL locally without launching a browser', defaultFormat: 'md',
  args: [
    { name: 'url', type: 'string', required: true },
    { name: 'timeout', type: 'int', default: 30 },
    { name: 'max-chars', type: 'int', default: 50000 },
    { name: 'allow-private', type: 'boolean', default: false },
  ],
  func: async kwargs => webFetch({ url: String(kwargs.url), timeoutSeconds: Number(kwargs.timeout ?? 30), maxChars: Number(kwargs['max-chars'] ?? 50000), allowPrivate: kwargs['allow-private'] === true }),
});

export function formatWebFetchMarkdown(result: WebFetchResult): string {
  return [`# ${result.title || 'Fetched content'}`, '', `Source: ${result.requestedUrl}`, `Final URL: ${result.finalUrl}`, `Content type: ${result.contentType || 'unknown'}`, `Extraction: ${result.extractionSource}`, '', result.content].join('\n');
}

function clientOptions(argv: readonly string[]): WebFetchOptions {
  const values: Record<string, string | boolean> = {};
  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!arg.startsWith('--')) continue;
    const name = arg.slice(2); const value = argv[index + 1];
    if (value && !value.startsWith('--')) { values[name] = value; index++; } else values[name] = true;
  }
  if (typeof values.url !== 'string' || !/^https?:\/\//i.test(values.url)) throw new ArgumentError('--url must be an http or https URL');
  const int = (name: string, fallback: number) => { const value = values[name]; const number = value === undefined ? fallback : Number(value); if (!Number.isInteger(number) || number < 0) throw new ArgumentError(`--${name} must be a non-negative integer`); return number; };
  return { url: values.url, timeoutSeconds: int('timeout', 30), maxChars: int('max-chars', 50000), allowPrivate: values['allow-private'] === true || values['allow-private'] === 'true' };
}

export async function runClientOwnedWebFetch(argv: readonly string[], dependencies: { webFetch?: typeof webFetch; stdout?: NodeJS.WritableStream; stderr?: NodeJS.WritableStream } = {}): Promise<void> {
  try {
    const result = await (dependencies.webFetch ?? webFetch)(clientOptions(argv));
    (dependencies.stdout ?? process.stdout).write(`${formatWebFetchMarkdown(result)}\n`);
  } catch (err) {
    const { formatErrorEnvelope } = await import('../output.js');
    (dependencies.stderr ?? process.stderr).write(formatErrorEnvelope(toEnvelope(err), { cmdName: 'web/fetch' }));
    process.exitCode = err instanceof CliError ? err.exitCode : EXIT_CODES.GENERIC_ERROR;
  }
}
