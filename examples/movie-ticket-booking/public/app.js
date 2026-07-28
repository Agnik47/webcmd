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

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json' } : {},
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, body.error || 'Request failed');
  return body;
}

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

function renderBookings(bookings) {
  const list = byId('booking-list');
  list.replaceChildren();
  byId('no-bookings').hidden = bookings.length > 0;
  for (const booking of bookings) {
    const item = document.createElement('li');
    const title = document.createElement('h3');
    const details = document.createElement('p');
    const status = document.createElement('span');
    title.textContent = booking.movie || 'Movie booking';
    details.textContent = [booking.cinema, booking.showTime, booking.seats.join(', ')]
      .filter(Boolean).join(' · ');
    status.className = 'badge';
    status.textContent = booking.status.replaceAll('_', ' ');
    item.append(title, details, status);
    list.append(item);
  }
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
  content.textContent = message.content;
  item.append(role, content);
  transcript.append(item);
}

async function selectConversation(conversation) {
  activeConversationId = conversation.id;
  chatTitle.textContent = conversation.title;
  transcript.replaceChildren();
  byId('chat-error').textContent = '';
  messageInput.disabled = true;
  sendButton.disabled = true;
  renderConversations();
  try {
    const messages = await api(`/api/conversations/${encodeURIComponent(conversation.id)}/messages`);
    if (activeConversationId !== conversation.id) return;
    transcript.replaceChildren();
    messages.forEach(appendMessage);
    messageInput.disabled = false;
    sendButton.disabled = false;
    messageInput.focus();
  } catch (error) {
    if (activeConversationId === conversation.id) {
      showError(byId('chat-error'), error);
      messageInput.disabled = false;
      sendButton.disabled = false;
    }
  }
}

async function loadApp() {
  const data = await api('/api/bootstrap');
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
  const mode = event.submitter?.value || 'login';
  const buttons = authForm.querySelectorAll('button');
  buttons.forEach((button) => { button.disabled = true; });
  authError.textContent = '';
  try {
    await api(`/api/${mode}`, {
      method: 'POST',
      body: JSON.stringify({
        email: byId('email').value,
        password: byId('password').value,
      }),
    });
    await loadApp();
  } catch (error) {
    showError(authError, error);
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
});

byId('new-chat').addEventListener('click', async () => {
  appError.textContent = '';
  try {
    const conversation = await api('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    conversations.unshift(conversation);
    await selectConversation(conversation);
  } catch (error) {
    showError(appError, error);
  }
});

chatForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = messageInput.value.trim();
  if (!message || !activeConversationId) return;
  const conversationId = activeConversationId;
  sendButton.disabled = true;
  byId('chat-error').textContent = '';
  appendMessage({ role: 'user', content: message });
  messageInput.value = '';
  try {
    const response = await api(`/api/conversations/${encodeURIComponent(conversationId)}/chat`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
    if (activeConversationId === conversationId) appendMessage(response.message);
  } catch (error) {
    if (activeConversationId === conversationId) showError(byId('chat-error'), error);
  } finally {
    if (activeConversationId === conversationId) {
      sendButton.disabled = false;
      messageInput.focus();
    }
  }
});

byId('preferences-form').addEventListener('submit', async (event) => {
  event.preventDefault();
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
    });
    renderPreferences(preferences);
    status.textContent = 'Preferences saved.';
  } catch (error) {
    showError(status, error);
  } finally {
    button.disabled = false;
  }
});

byId('logout').addEventListener('click', async () => {
  appError.textContent = '';
  try {
    await api('/api/logout', { method: 'POST' });
    conversations = [];
    activeConversationId = '';
    transcript.replaceChildren();
    authForm.reset();
    showAuth();
  } catch (error) {
    showError(appError, error);
  }
});

loadApp().catch((error) => {
  showAuth(error.status === 401 ? '' : error.message);
});
