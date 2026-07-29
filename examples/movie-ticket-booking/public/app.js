export function createRequestEpoch() {
  let current = 0;
  return {
    advance: () => ++current,
    capture: () => current,
    isCurrent: (captured) => captured === current,
  };
}

export function requiresAuthReset(path, status) {
  return status === 401 && path !== '/api/login' && path !== '/api/register';
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createApi(fetchRequest, isCurrent, onUnauthorized) {
  return async function api(
    path,
    options = {},
    captured,
    unauthorizedMessage = 'Your session expired. Please log in again.',
  ) {
    const response = await fetchRequest(path, {
      ...options,
      headers: options.body ? { 'content-type': 'application/json' } : {},
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new ApiError(response.status, body.error || 'Request failed');
      if (requiresAuthReset(path, response.status) && isCurrent(captured)) {
        onUnauthorized(unauthorizedMessage);
      }
      throw error;
    }
    return body;
  };
}

export function safeTranscriptUrl(value) {
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

export function appendTranscriptContent(element, value, documentRoot = document) {
  const text = String(value ?? '');
  const links = /https?:\/\/[^\s<>"']+/g;
  let offset = 0;
  for (const match of text.matchAll(links)) {
    const index = match.index ?? 0;
    if (index > offset) element.append(documentRoot.createTextNode(text.slice(offset, index)));
    const candidate = match[0];
    const safe = safeTranscriptUrl(candidate);
    if (safe) {
      const anchor = documentRoot.createElement('a');
      anchor.href = safe;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.textContent = candidate;
      element.append(anchor);
    } else {
      element.append(documentRoot.createTextNode(candidate));
    }
    offset = index + candidate.length;
  }
  if (offset < text.length) element.append(documentRoot.createTextNode(text.slice(offset)));
}

export function renderBookings(bookings, documentRoot = document) {
  const list = documentRoot.getElementById('booking-list');
  list.replaceChildren();
  documentRoot.getElementById('no-bookings').hidden = bookings.length > 0;
  for (const booking of bookings) {
    const item = documentRoot.createElement('li');
    const title = documentRoot.createElement('h3');
    const details = documentRoot.createElement('p');
    const status = documentRoot.createElement('span');
    title.textContent = booking.movie || 'Movie booking';
    details.textContent = [booking.cinema, booking.showTime, booking.seats.join(', ')]
      .filter(Boolean).join(' · ');
    status.className = 'badge';
    status.textContent = booking.status.replaceAll('_', ' ');
    item.append(title, details, status);
    list.append(item);
  }
}

export function applyChatResponse(
  response,
  isCurrent,
  appendMessage,
  renderBookingSnapshot,
  conversations,
  isCurrentSelection,
) {
  if (!isCurrent() || !isCurrentSelection()) return null;
  appendMessage(response.message);
  renderBookingSnapshot(response.bookings);
  return [
    response.conversation,
    ...conversations.filter((conversation) => conversation.id !== response.conversation.id),
  ];
}

if (typeof document !== 'undefined') startApp();

function startApp() {
const byId = (id) => document.getElementById(id);
const authView = byId('auth-view');
const appView = byId('app-view');
const authForm = byId('auth-form');
const authError = byId('auth-error');
const appError = byId('app-error');
const conversationList = byId('conversation-list');
const transcript = byId('transcript');
const chatTitle = byId('chat-title');
const chatForm = byId('chat-form');
const messageInput = byId('message');
const sendButton = byId('send');
let conversations = [];
let activeConversationId = '';
const requests = createRequestEpoch();
const selections = createRequestEpoch();
const api = createApi(fetch, requests.isCurrent, resetSession);

function showError(element, error) {
  element.textContent = error instanceof Error ? error.message : 'Request failed';
}

function showAuth(message = '') {
  appView.hidden = true;
  authView.hidden = false;
  authError.textContent = message;
  byId('email').focus();
}

function showApp() {
  authView.hidden = true;
  appView.hidden = false;
}

function setAuthPending(pending) {
  authForm.querySelectorAll('button').forEach((button) => { button.disabled = pending; });
}

function resetSession(message = '') {
  requests.advance();
  selections.advance();
  conversations = [];
  activeConversationId = '';
  byId('user-email').textContent = '';
  chatTitle.textContent = 'Choose a conversation';
  transcript.replaceChildren();
  renderConversations();
  renderBookings([]);
  renderPreferences({ city: '', languages: [], formats: [], seatPosition: '', budgetPaise: 0 });
  appError.textContent = '';
  byId('chat-error').textContent = '';
  byId('preferences-status').textContent = '';
  messageInput.value = '';
  messageInput.disabled = true;
  sendButton.disabled = true;
  byId('preferences-form').querySelector('button').disabled = false;
  setAuthPending(false);
  authForm.reset();
  showAuth(message);
  return requests.capture();
}

function splitList(value) {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function renderPreferences(preferences) {
  byId('city').value = preferences.city;
  byId('languages').value = preferences.languages.join(', ');
  byId('formats').value = preferences.formats.join(', ');
  byId('seat-position').value = preferences.seatPosition;
  byId('budget').value = preferences.budgetPaise ? String(preferences.budgetPaise / 100) : '';
}

function renderConversations() {
  conversationList.replaceChildren();
  byId('no-conversations').hidden = conversations.length > 0;
  for (const conversation of conversations) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'conversation-button';
    button.textContent = conversation.title;
    button.setAttribute('aria-current', conversation.id === activeConversationId ? 'page' : 'false');
    button.addEventListener('click', () => selectConversation(conversation));
    item.append(button);
    conversationList.append(item);
  }
}

function appendMessage(message) {
  const item = document.createElement('li');
  const role = document.createElement('strong');
  const content = document.createElement('p');
  item.className = message.role === 'user' ? 'message user-message' : 'message';
  role.textContent = message.role === 'user' ? 'You' : 'Assistant';
  appendTranscriptContent(content, message.content);
  item.append(role, content);
  transcript.append(item);
}

async function selectConversation(conversation) {
  const captured = requests.capture();
  const selected = selections.advance();
  activeConversationId = conversation.id;
  chatTitle.textContent = conversation.title;
  transcript.replaceChildren();
  byId('chat-error').textContent = '';
  messageInput.disabled = true;
  sendButton.disabled = true;
  renderConversations();
  try {
    const messages = await api(
      `/api/conversations/${encodeURIComponent(conversation.id)}/messages`,
      {},
      captured,
    );
    if (
      !requests.isCurrent(captured)
      || !selections.isCurrent(selected)
      || activeConversationId !== conversation.id
    ) return;
    transcript.replaceChildren();
    messages.forEach(appendMessage);
    messageInput.disabled = false;
    sendButton.disabled = false;
    messageInput.focus();
  } catch (error) {
    if (
      requests.isCurrent(captured)
      && selections.isCurrent(selected)
      && activeConversationId === conversation.id
    ) {
      showError(byId('chat-error'), error);
      messageInput.disabled = false;
      sendButton.disabled = false;
    }
  }
}

async function loadApp(
  captured = requests.capture(),
  unauthorizedMessage = 'Your session expired. Please log in again.',
) {
  const data = await api('/api/bootstrap', {}, captured, unauthorizedMessage);
  if (!requests.isCurrent(captured)) return;
  byId('user-email').textContent = data.user.email;
  conversations = data.conversations;
  renderPreferences(data.preferences);
  renderBookings(data.bookings);
  renderConversations();
  showApp();
  if (conversations[0]) await selectConversation(conversations[0]);
  else byId('new-chat').focus();
}

authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  requests.advance();
  const captured = requests.capture();
  const mode = event.submitter?.value || 'login';
  setAuthPending(true);
  authError.textContent = '';
  try {
    await api(`/api/${mode}`, {
      method: 'POST',
      body: JSON.stringify({
        email: byId('email').value,
        password: byId('password').value,
      }),
    }, captured);
    if (!requests.isCurrent(captured)) return;
    authForm.reset();
    await loadApp(captured);
  } catch (error) {
    if (requests.isCurrent(captured)) showError(authError, error);
  } finally {
    if (requests.isCurrent(captured)) setAuthPending(false);
  }
});

byId('new-chat').addEventListener('click', async () => {
  const captured = requests.capture();
  appError.textContent = '';
  try {
    const conversation = await api('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({}),
    }, captured);
    if (!requests.isCurrent(captured)) return;
    conversations.unshift(conversation);
    await selectConversation(conversation);
  } catch (error) {
    if (requests.isCurrent(captured)) showError(appError, error);
  }
});

chatForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = messageInput.value.trim();
  if (!message || !activeConversationId) return;
  const captured = requests.capture();
  const selected = selections.capture();
  const conversationId = activeConversationId;
  sendButton.disabled = true;
  byId('chat-error').textContent = '';
  appendMessage({ role: 'user', content: message });
  messageInput.value = '';
  try {
    const response = await api(`/api/conversations/${encodeURIComponent(conversationId)}/chat`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }, captured);
    const updatedConversations = applyChatResponse(
      response,
      () => requests.isCurrent(captured) && activeConversationId === conversationId,
      appendMessage,
      renderBookings,
      conversations,
      () => selections.isCurrent(selected),
    );
    if (updatedConversations) {
      conversations = updatedConversations;
      chatTitle.textContent = response.conversation.title;
      renderConversations();
    }
  } catch (error) {
    if (
      requests.isCurrent(captured)
      && selections.isCurrent(selected)
      && activeConversationId === conversationId
    ) {
      showError(byId('chat-error'), error);
    }
  } finally {
    if (
      requests.isCurrent(captured)
      && selections.isCurrent(selected)
      && activeConversationId === conversationId
    ) {
      sendButton.disabled = false;
      messageInput.focus();
    }
  }
});

byId('preferences-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const captured = requests.capture();
  const form = event.currentTarget;
  const button = form.querySelector('button');
  const status = byId('preferences-status');
  button.disabled = true;
  status.textContent = '';
  try {
    const preferences = await api('/api/preferences', {
      method: 'PUT',
      body: JSON.stringify({
        city: byId('city').value.trim(),
        languages: splitList(byId('languages').value),
        formats: splitList(byId('formats').value),
        seatPosition: byId('seat-position').value,
        budgetPaise: Math.round(Number(byId('budget').value || 0) * 100),
      }),
    }, captured);
    if (!requests.isCurrent(captured)) return;
    renderPreferences(preferences);
    status.textContent = 'Preferences saved.';
  } catch (error) {
    if (requests.isCurrent(captured)) showError(status, error);
  } finally {
    if (requests.isCurrent(captured)) button.disabled = false;
  }
});

byId('logout').addEventListener('click', async () => {
  const captured = resetSession();
  setAuthPending(true);
  try {
    await api('/api/logout', { method: 'POST' }, captured);
  } catch (error) {
    if (requests.isCurrent(captured)) showError(authError, error);
  } finally {
    if (requests.isCurrent(captured)) setAuthPending(false);
  }
});

const startup = requests.capture();
loadApp(startup, '').catch((error) => {
  if (requests.isCurrent(startup)) resetSession(error.message);
});
}
