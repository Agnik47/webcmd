import { randomUUID } from 'node:crypto';

export interface HermesMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface HermesChatResponse {
  object: string;
  session_id: string;
  message: HermesMessage;
}

export type HermesStreamEvent =
  | { type: 'assistant.delta'; delta: string }
  | { type: 'activity'; active: boolean };

function toHermesMessage(value: unknown): HermesMessage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { role, content } = value as Record<string, unknown>;
  if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string' || !content.trim()) {
    return undefined;
  }
  return { role, content };
}

export class HermesHttpError extends Error {
  constructor(
    readonly status: number,
    readonly upstreamStatus?: number,
  ) {
    super(upstreamStatus
      ? `Hermes request failed with status ${upstreamStatus}`
      : 'Hermes request failed');
    this.name = 'HermesHttpError';
  }
}

export class HermesClient {
  readonly #baseUrl: URL;
  readonly #authorization: string;

  constructor(
    apiUrl = process.env.HERMES_API_URL ?? '',
    apiKey = process.env.API_SERVER_KEY ?? '',
  ) {
    if (!apiUrl) throw new Error('HERMES_API_URL is required');
    this.#baseUrl = new URL(apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`);
    const username = decodeURIComponent(this.#baseUrl.username);
    const password = decodeURIComponent(this.#baseUrl.password);
    this.#baseUrl.username = '';
    this.#baseUrl.password = '';
    this.#authorization = apiKey
      ? `Bearer ${apiKey}`
      : username
        ? `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
        : '';
    if (!this.#authorization) throw new Error('API_SERVER_KEY or URL credentials are required');
  }

  async createSession(): Promise<string> {
    const id = `movie_${randomUUID()}`;
    await this.#request('/api/sessions', { method: 'POST', body: JSON.stringify({ id }) });
    return id;
  }

  async getMessages(sessionId: string): Promise<HermesMessage[]> {
    const response = await this.#request(`/api/sessions/${encodeURIComponent(sessionId)}/messages`);
    if (!Array.isArray(response.data)) {
      throw new HermesHttpError(502);
    }
    return response.data.flatMap((message) => {
      const safeMessage = toHermesMessage(message);
      return safeMessage ? [safeMessage] : [];
    });
  }

  async chat(sessionId: string, sessionKey: string, message: string): Promise<HermesChatResponse> {
    const response = await this.#request(`/api/sessions/${encodeURIComponent(sessionId)}/chat`, {
      method: 'POST',
      headers: { 'X-Hermes-Session-Key': sessionKey },
      body: JSON.stringify({ input: message }),
    });
    const reply = toHermesMessage(response.message);
    if (
      typeof response.object !== 'string'
      || typeof response.session_id !== 'string'
      || reply?.role !== 'assistant'
    ) {
      throw new HermesHttpError(502);
    }
    return { object: response.object, session_id: response.session_id, message: reply };
  }

  async chatStream(
    sessionId: string,
    sessionKey: string,
    message: string,
    onEvent: (event: HermesStreamEvent) => void,
  ): Promise<HermesChatResponse> {
    let response: Response;
    try {
      response = await fetch(new URL(`api/sessions/${encodeURIComponent(sessionId)}/chat/stream`, this.#baseUrl), {
        method: 'POST',
        headers: {
          Authorization: this.#authorization,
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
          'X-Hermes-Session-Key': sessionKey,
        },
        body: JSON.stringify({ input: message }),
      });
    } catch {
      throw new HermesHttpError(502);
    }
    if (!response.ok) throw new HermesHttpError(502, response.status);
    if (!/^text\/event-stream(?:;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) {
      throw new HermesHttpError(502);
    }

    let buffer = '';
    let reply: HermesMessage | undefined;
    let replySessionId: string | undefined;
    let runCompleted = false;

    const processEvent = (block: string): void => {
      let event = '';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
        if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart());
      }
      if (!['assistant.delta', 'tool.started', 'tool.completed', 'tool.failed', 'assistant.completed', 'run.completed', 'error', 'done'].includes(event)) {
        return;
      }
      let payload: Record<string, unknown>;
      try {
        const value = JSON.parse(data.join('\n')) as unknown;
        if (!value || typeof value !== 'object') throw new Error();
        payload = value as Record<string, unknown>;
      } catch {
        throw new HermesHttpError(502);
      }
      if (event === 'error') throw new HermesHttpError(502);
      if (event === 'assistant.delta') {
        if (typeof payload.delta === 'string') onEvent({ type: 'assistant.delta', delta: payload.delta });
        return;
      }
      if (event === 'tool.started') {
        onEvent({ type: 'activity', active: true });
        return;
      }
      if (event === 'tool.completed' || event === 'tool.failed') {
        onEvent({ type: 'activity', active: false });
        return;
      }
      if (event === 'assistant.completed') {
        const completedReply = toHermesMessage({ role: 'assistant', content: payload.content });
        if (!completedReply || typeof payload.session_id !== 'string' || !payload.session_id) {
          throw new HermesHttpError(502);
        }
        reply = completedReply;
        replySessionId = payload.session_id;
        return;
      }
      if (event === 'run.completed') {
        runCompleted = true;
        return;
      }
      if (!reply || !runCompleted) throw new HermesHttpError(502);
    };

    const processBuffer = (atEnd = false): void => {
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        processEvent(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
      }
      if (atEnd && buffer) {
        processEvent(buffer);
        buffer = '';
      }
    };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        processBuffer();
      }
      buffer += decoder.decode();
      processBuffer(true);
    } catch (error) {
      if (error instanceof HermesHttpError) throw error;
      throw new HermesHttpError(502);
    }
    if (!reply || !replySessionId || !runCompleted) throw new HermesHttpError(502);
    return {
      object: 'hermes.session.chat.completion',
      session_id: replySessionId,
      message: reply,
    };
  }

  async #request(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(new URL(path.replace(/^\//, ''), this.#baseUrl), {
        ...init,
        headers: {
          Authorization: this.#authorization,
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
      });
    } catch {
      throw new HermesHttpError(502);
    }
    if (!response.ok) throw new HermesHttpError(502, response.status);
    try {
      return await response.json() as Record<string, unknown>;
    } catch {
      throw new HermesHttpError(502, response.status);
    }
  }
}
