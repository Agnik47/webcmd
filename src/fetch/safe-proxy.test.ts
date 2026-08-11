import { describe, expect, it } from 'vitest';
import * as net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSafeProxy, isSafeAddress } from './safe-proxy.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

describe('isSafeAddress', () => {
  it.each(['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', '::', 'fe80::1', '::ffff:127.0.0.1'])('rejects private address %s', address => {
    expect(isSafeAddress(address)).toBe(false);
  });
  it('allows public IPv4 addresses', () => expect(isSafeAddress('93.184.216.34')).toBe(true));
});

describe('createSafeProxy CONNECT tunnel', () => {
  async function startFakeUpstream(): Promise<{ port: number; socket: Promise<net.Socket>; close(): Promise<void> }> {
    let resolveSocket: (socket: net.Socket) => void;
    const socket = new Promise<net.Socket>((resolve) => { resolveSocket = resolve; });
    const server = net.createServer((s) => { s.resume(); resolveSocket(s); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    return { port, socket, close: () => new Promise((resolve) => server.close(() => resolve())) };
  }

  function runNodeScript(scriptPath: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout: Buffer[] = []; const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
      child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
      child.once('error', reject);
      child.once('close', (status) => resolve({ status, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
    });
  }

  async function openTunnel(proxyUrl: string, targetPort: number): Promise<net.Socket> {
    const url = new URL(proxyUrl);
    const client = net.connect({ host: url.hostname, port: Number(url.port) });
    await new Promise<void>((resolve, reject) => {
      client.once('connect', () => client.write(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\n`));
      client.once('data', (chunk) => {
        expect(chunk.toString()).toContain('200 Connection Established');
        resolve();
      });
      client.once('error', reject);
    });
    return client;
  }

  // A crashed process kills the whole vitest worker, not just this test, so the
  // repro has to run isolated in a real child process to observe pass/fail cleanly.
  it('does not crash the process when the client leg resets the connection', async () => {
    const safeProxyUrl = pathToFileURL(path.join(moduleDir, 'safe-proxy.ts')).href;
    const dir = await mkdtemp(path.join(tmpdir(), 'webcmd-safe-proxy-crash-'));
    const scriptPath = path.join(dir, 'repro.mjs');
    await writeFile(scriptPath, [
      "import * as net from 'node:net';",
      `import { createSafeProxy } from ${JSON.stringify(safeProxyUrl)};`,
      '',
      "const fakeUpstream = net.createServer((s) => s.resume());",
      "await new Promise((resolve) => fakeUpstream.listen(0, '127.0.0.1', resolve));",
      'const upstreamPort = fakeUpstream.address().port;',
      '',
      'const proxy = await createSafeProxy({ allowPrivate: true });',
      'const proxyUrl = new URL(proxy.url);',
      'const client = net.connect({ host: proxyUrl.hostname, port: Number(proxyUrl.port) });',
      'await new Promise((resolve, reject) => {',
      "  client.once('connect', () => client.write(`CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\\r\\nHost: 127.0.0.1:${upstreamPort}\\r\\n\\r\\n`));",
      "  client.once('data', () => resolve());",
      "  client.once('error', reject);",
      '});',
      '',
      '// A hard RST (not a graceful end()) is what an aborted/timed-out real client',
      "// produces, and reliably surfaces as an 'error' event on the proxy's peer socket",
      '// -- the exact unhandled error reported in issue #283.',
      'client.resetAndDestroy();',
      'await new Promise((resolve) => setTimeout(resolve, 200));',
      '',
      'await proxy.close();',
      "await new Promise((resolve) => fakeUpstream.close(() => resolve()));",
      'process.exit(0);',
      '',
    ].join('\n'));

    const result = await runNodeScript(scriptPath);
    await rm(dir, { recursive: true, force: true });

    expect(result.stderr).not.toContain('ECONNRESET');
    expect(result.status).toBe(0);
  }, 15_000);

  it('close() destroys dangling tunnel sockets instead of hanging or leaking them', async () => {
    const fakeUpstream = await startFakeUpstream();
    const proxy = await createSafeProxy({ allowPrivate: true });

    try {
      const client = await openTunnel(proxy.url, fakeUpstream.port);
      await fakeUpstream.socket; // tunnel is fully live on both legs

      const clientClosed = new Promise<void>((resolve) => client.once('close', () => resolve()));
      // server.close() alone waits for every existing connection to end on its own --
      // an established CONNECT tunnel never does that by itself, so pre-fix this hangs.
      await proxy.close();
      await clientClosed;
    } finally {
      await fakeUpstream.close();
    }
  });
});
