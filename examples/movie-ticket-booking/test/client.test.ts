import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-ignore -- exercise the browser JavaScript module directly.
import { appendTranscriptContent, applyChatResponse, createApi, createRequestEpoch, renderBookings, requiresAuthReset, safeTranscriptUrl } from '../public/app.js';

class FakeNode {
  children: FakeNode[] = [];
  className = '';
  hidden = false;
  href = '';
  rel = '';
  target = '';
  #text = '';

  constructor(readonly tagName: string) {}

  set textContent(value: string) {
    this.#text = value;
    this.children = [];
  }

  get textContent(): string {
    return this.#text + this.children.map(child => child.textContent).join('');
  }

  append(...children: FakeNode[]): void {
    this.children.push(...children);
  }

  replaceChildren(...children: FakeNode[]): void {
    this.#text = '';
    this.children = children;
  }
}

function fakeDocument() {
  const nodes = new Map([
    ['booking-list', new FakeNode('UL')],
    ['no-bookings', new FakeNode('P')],
  ]);
  return {
    nodes,
    createElement: (tag: string) => new FakeNode(tag.toUpperCase()),
    createTextNode: (text: string) => {
      const node = new FakeNode('#text');
      node.textContent = text;
      return node;
    },
    getElementById: (id: string) => nodes.get(id),
  };
}

function descendants(node: FakeNode): FakeNode[] {
  return node.children.flatMap(child => [child, ...descendants(child)]);
}

test('invalidates an async result captured before the session changes', async () => {
  const requests = createRequestEpoch();
  const captured = requests.capture();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const result = blocked.then(() => requests.isCurrent(captured) ? 'applied' : 'discarded');

  requests.advance();
  release();

  assert.equal(await result, 'discarded');
});

test('resets authenticated requests on 401 but preserves login errors', () => {
  assert.equal(requiresAuthReset('/api/preferences', 401), true);
  assert.equal(requiresAuthReset('/api/login', 401), false);
  assert.equal(requiresAuthReset('/api/register', 401), false);
  assert.equal(requiresAuthReset('/api/preferences', 500), false);
});

test('discards an old unauthorized response before it can reset a new session', async () => {
  const requests = createRequestEpoch();
  let respond!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => { respond = resolve; });
  const resets: string[] = [];
  const api = createApi(() => response, requests.isCurrent, (message: string) => resets.push(message));
  const pending = api('/api/preferences', {}, requests.capture());

  requests.advance();
  respond(Response.json({ error: 'authentication required' }, { status: 401 }));

  await assert.rejects(pending, /authentication required/);
  assert.deepEqual(resets, []);
});

test('resets a current unauthorized request and keeps initial bootstrap neutral', async () => {
  const requests = createRequestEpoch();
  const resets: string[] = [];
  const api = createApi(
    async () => Response.json({ error: 'authentication required' }, { status: 401 }),
    requests.isCurrent,
    (message: string) => resets.push(message),
  );

  await assert.rejects(api('/api/preferences', {}, requests.capture()), /authentication required/);
  requests.advance();
  await assert.rejects(api('/api/bootstrap', {}, requests.capture(), ''), /authentication required/);

  assert.deepEqual(resets, ['Your session expired. Please log in again.', '']);
});

test('renders only validated HTTPS transcript URLs as safe anchors', () => {
  const valid = 'https://api.webcmd.test/account/live/checkout-token';
  assert.equal(safeTranscriptUrl(valid), valid);
  for (const unsafe of [
    'http://api.webcmd.test/account/live/token',
    'javascript:alert(1)',
    'data:text/html,unsafe',
    'https://user:pass@api.webcmd.test/account/live/token',
  ]) {
    assert.equal(safeTranscriptUrl(unsafe), null, unsafe);
  }

  const documentRoot = fakeDocument();
  const content = new FakeNode('P');
  appendTranscriptContent(
    content,
    `Pay here: ${valid} not http://unsafe.example or javascript:alert(1)`,
    documentRoot,
  );
  const anchors = descendants(content).filter(node => node.tagName === 'A');
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0]?.href, valid);
  assert.equal(anchors[0]?.target, '_blank');
  assert.equal(anchors[0]?.rel, 'noopener noreferrer');
  assert.match(content.textContent, /http:\/\/unsafe\.example/);
  assert.match(content.textContent, /javascript:alert/);
});

test('applies confirmed bookings immediately and ignores a stale session response', () => {
  const requests = createRequestEpoch();
  const documentRoot = fakeDocument();
  const apply = (status: string, captured: number) => applyChatResponse(
    {
      message: { role: 'assistant', content: status },
      bookings: [{
        movie: 'Dune',
        cinema: 'PVR Phoenix',
        showTime: '2026-07-28T19:00:00+05:30',
        seats: ['A1', 'A2'],
        status,
      }],
    },
    () => requests.isCurrent(captured),
    () => {},
    (bookings: unknown[]) => renderBookings(bookings, documentRoot),
  );

  assert.equal(apply('confirmed', requests.capture()), true);
  assert.match(documentRoot.nodes.get('booking-list')?.textContent ?? '', /confirmed/);

  const stale = requests.capture();
  requests.advance();
  assert.equal(apply('failed', stale), false);
  assert.doesNotMatch(documentRoot.nodes.get('booking-list')?.textContent ?? '', /failed/);
  assert.match(documentRoot.nodes.get('booking-list')?.textContent ?? '', /confirmed/);
});
