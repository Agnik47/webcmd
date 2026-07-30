export interface Conversation {
  id: string;
  title: string;
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export interface Preferences {
  city: string;
  languages: string[];
  formats: string[];
  seatPosition: string;
  budgetPaise: number;
}

export interface Booking {
  id?: string;
  movie?: string;
  cinema: string;
  showTime: string;
  seats: string[];
  status: string;
}

export interface ChatResponse {
  message: Message;
  conversation: Conversation;
  bookings: Booking[];
}

export type ChatStreamEvent =
  | { type: 'assistant.delta'; delta: string }
  | { type: 'activity'; active: boolean }
  | { type: 'chat.completed'; response: ChatResponse };

export function thinkingStatus(pending: boolean): string {
  return pending ? 'Hermes is thinking' : '';
}

export function shouldIgnoreConversationReselection(
  pending: boolean,
  activeConversationId: string,
  selectedConversationId: string,
): boolean {
  return pending && activeConversationId === selectedConversationId;
}

export function createRequestEpoch() {
  let current = 0;
  return {
    advance: () => ++current,
    capture: () => current,
    isCurrent: (captured: number) => captured === current,
  };
}

export function requiresAuthReset(path: string, status: number): boolean {
  return status === 401 && path !== '/api/login' && path !== '/api/register';
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function errorMessage(body: unknown): string {
  return body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
    ? body.error
    : 'Request failed';
}

export function createApi(
  fetchRequest: typeof fetch,
  isCurrent: (captured: number) => boolean,
  onUnauthorized: (message: string) => void,
) {
  return async function api<T>(
    path: string,
    options: RequestInit = {},
    captured: number,
    unauthorizedMessage = 'Your session expired. Please log in again.',
  ): Promise<T> {
    const response = await fetchRequest(path, {
      ...options,
      headers: options.body ? { 'content-type': 'application/json' } : {},
    });
    const body: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (requiresAuthReset(path, response.status) && isCurrent(captured)) {
        onUnauthorized(unauthorizedMessage);
      }
      throw new ApiError(response.status, errorMessage(body));
    }
    return body as T;
  };
}

function chatResponse(value: unknown): ChatResponse | null {
  if (!value || typeof value !== 'object') return null;
  const { message, conversation, bookings } = value as Record<string, unknown>;
  if (
    !message || typeof message !== 'object'
    || !conversation || typeof conversation !== 'object'
    || !Array.isArray(bookings)
  ) return null;
  const reply = message as Record<string, unknown>;
  const updatedConversation = conversation as Record<string, unknown>;
  if (
    (reply.role !== 'user' && reply.role !== 'assistant')
    || typeof reply.content !== 'string'
    || typeof updatedConversation.id !== 'string'
    || typeof updatedConversation.title !== 'string'
    || !bookings.every((booking) => {
      if (!booking || typeof booking !== 'object') return false;
      const item = booking as Record<string, unknown>;
      return typeof item.cinema === 'string'
        && typeof item.showTime === 'string'
        && Array.isArray(item.seats)
        && item.seats.every((seat) => typeof seat === 'string')
        && typeof item.status === 'string'
        && (item.id === undefined || typeof item.id === 'string')
        && (item.movie === undefined || typeof item.movie === 'string');
    })
  ) return null;
  return value as ChatResponse;
}

export function createChatStream(
  fetchRequest: typeof fetch,
  isCurrent: (captured: number) => boolean,
  onUnauthorized: (message: string) => void,
): (
  path: string,
  message: string,
  captured: number,
  onEvent: (event: ChatStreamEvent) => void,
) => Promise<void> {
  return async (path, message, captured, onEvent) => {
    const response = await fetchRequest(path, {
      method: 'POST',
      headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => ({}));
      if (requiresAuthReset(path, response.status) && isCurrent(captured)) {
        onUnauthorized('Your session expired. Please log in again.');
      }
      throw new ApiError(response.status, errorMessage(body));
    }
    if (!/^text\/event-stream(?:;|$)/iu.test(response.headers.get('content-type') ?? '') || !response.body) {
      throw new Error('Invalid chat stream');
    }

    let buffer = '';
    let completed = false;
    const processEvent = (block: string): void => {
      let event = '';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
        if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart());
      }
      if (!['assistant.delta', 'activity', 'chat.completed', 'error'].includes(event)) return;
      let payload: Record<string, unknown>;
      try {
        const value = JSON.parse(data.join('\n')) as unknown;
        if (!value || typeof value !== 'object') throw new Error();
        payload = value as Record<string, unknown>;
      } catch {
        throw new Error('Invalid chat stream');
      }
      if (event === 'error') throw new Error(typeof payload.error === 'string' ? payload.error : 'Request failed');
      if (event === 'assistant.delta') {
        if (typeof payload.delta !== 'string') throw new Error('Invalid chat stream');
        onEvent({ type: event, delta: payload.delta });
        return;
      }
      if (event === 'activity') {
        if (typeof payload.active !== 'boolean') throw new Error('Invalid chat stream');
        onEvent({ type: event, active: payload.active });
        return;
      }
      if (completed) throw new Error('Duplicate chat completion');
      const completedResponse = chatResponse(payload);
      if (!completedResponse) throw new Error('Invalid chat stream');
      completed = true;
      onEvent({ type: 'chat.completed', response: completedResponse });
    };
    const processBuffer = (atEnd = false): void => {
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        processEvent(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
      }
      if (atEnd && buffer) processEvent(buffer);
    };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      processBuffer();
    }
    buffer += decoder.decode();
    processBuffer(true);
    if (!completed) throw new Error('Chat stream ended without chat completion');
  };
}

export function safeTranscriptUrl(value: unknown): string | null {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  try {
    const url = new URL(value);
    return url.href === value
      && url.protocol === 'https:'
      && !url.username
      && !url.password
      ? value
      : null;
  } catch {
    return null;
  }
}

export function transcriptParts(value: unknown): Array<{ text: string; href?: string }> {
  const text = String(value ?? '');
  const parts: Array<{ text: string; href?: string }> = [];
  const links = /https?:\/\/[^\s<>"']+/g;
  let offset = 0;
  for (const match of text.matchAll(links)) {
    const index = match.index ?? 0;
    if (index > offset) parts.push({ text: text.slice(offset, index) });
    const candidate = match[0];
    const href = safeTranscriptUrl(candidate);
    parts.push(href ? { text: candidate, href } : { text: candidate });
    offset = index + candidate.length;
  }
  if (offset < text.length) parts.push({ text: text.slice(offset) });
  return parts;
}

function splitList(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

export function preferencePayload(fields: {
  city: string;
  languages: string;
  formats: string;
  seatPosition: string;
  budget: string;
}): Preferences {
  const budget = Number(fields.budget || 0);
  return {
    city: fields.city.trim(),
    languages: splitList(fields.languages),
    formats: splitList(fields.formats),
    seatPosition: fields.seatPosition.trim(),
    budgetPaise: Number.isFinite(budget) ? Math.max(0, Math.round(budget * 100)) : 0,
  };
}

export function bookingStatusLabel(status: string): string {
  const label = status.replaceAll('_', ' ');
  return label ? label[0]!.toUpperCase() + label.slice(1) : 'Unknown';
}

export function bookingDetails(booking: Pick<Booking, 'cinema' | 'showTime' | 'seats'>): string {
  return [booking.cinema, booking.showTime, booking.seats.join(', ')].filter(Boolean).join(' · ');
}

export function applyChatResponse(
  response: ChatResponse,
  isCurrent: () => boolean,
  appendMessage: (message: Message) => void,
  renderBookingSnapshot: (bookings: Booking[]) => void,
  conversations: Conversation[],
  isCurrentSelection: () => boolean,
): Conversation[] | null {
  if (!isCurrent()) return null;
  renderBookingSnapshot(response.bookings);
  const updated = [
    response.conversation,
    ...conversations.filter((conversation) => conversation.id !== response.conversation.id),
  ];
  if (isCurrentSelection()) appendMessage(response.message);
  return updated;
}

export function shouldSubmitComposer(input: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
}): boolean {
  return input.key === 'Enter' && !input.shiftKey && !input.isComposing;
}
