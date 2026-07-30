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

export function thinkingStatus(pending: boolean): string {
  return pending ? 'Hermes is thinking' : '';
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
      const message = body && typeof body === 'object' && 'error' in body
        && typeof body.error === 'string' ? body.error : 'Request failed';
      if (requiresAuthReset(path, response.status) && isCurrent(captured)) {
        onUnauthorized(unauthorizedMessage);
      }
      throw new ApiError(response.status, message);
    }
    return body as T;
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

export function applyChatResponse<B>(
  response: { message: Message; conversation: Conversation; bookings: B[] },
  isCurrent: () => boolean,
  appendMessage: (message: Message) => void,
  renderBookingSnapshot: (bookings: B[]) => void,
  conversations: Conversation[],
  isCurrentSelection: () => boolean,
): Conversation[] | null {
  if (!isCurrent() || !isCurrentSelection()) return null;
  appendMessage(response.message);
  renderBookingSnapshot(response.bookings);
  return [
    response.conversation,
    ...conversations.filter((conversation) => conversation.id !== response.conversation.id),
  ];
}
