import { randomUUID } from 'node:crypto';

export interface HermesMessage {
  role: string;
  content: string;
  [key: string]: unknown;
}

export interface HermesChatResponse {
  object: string;
  session_id: string;
  message: HermesMessage;
  [key: string]: unknown;
}

function isHermesMessage(value: unknown): value is HermesMessage {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof (value as Record<string, unknown>).role === 'string'
    && typeof (value as Record<string, unknown>).content === 'string',
  );
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
    if (!Array.isArray(response.data) || !response.data.every(isHermesMessage)) {
      throw new HermesHttpError(502);
    }
    return response.data;
  }

  async chat(sessionId: string, sessionKey: string, message: string): Promise<HermesChatResponse> {
    const response = await this.#request(`/api/sessions/${encodeURIComponent(sessionId)}/chat`, {
      method: 'POST',
      headers: { 'X-Hermes-Session-Key': sessionKey },
      body: JSON.stringify({ input: message }),
    });
    if (
      typeof response.object !== 'string'
      || typeof response.session_id !== 'string'
      || !isHermesMessage(response.message)
    ) {
      throw new HermesHttpError(502);
    }
    return response as unknown as HermesChatResponse;
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
