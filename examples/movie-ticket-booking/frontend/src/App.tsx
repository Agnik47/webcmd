import { Button } from '@opencode-ai/ui/button';
import { Card } from '@opencode-ai/ui/card';
import { Icon } from '@opencode-ai/ui/icon';
import { Tag } from '@opencode-ai/ui/tag';
import { For, Show, createSignal, onCleanup, onMount } from 'solid-js';
import { render } from 'solid-js/web';
import {
  applyFailedTurn,
  applyChatResponse,
  bookingDetails,
  bookingStatusLabel,
  createApi,
  createChatStream,
  createRequestEpoch,
  failedTurnForConversation,
  isComposerDisabled,
  isPendingConversation,
  preferencePayload,
  shouldIgnoreConversationReselection,
  shouldFollowOutput,
  shouldSubmitComposer,
  thinkingStatus,
  transcriptParts,
  type Booking,
  type ChatStreamEvent,
  type Conversation,
  type FailedTurn,
  type Message,
  type Preferences,
} from './client.js';
import './opencode.css';
import './styles.css';

interface Bootstrap {
  user: { email: string };
  conversations: Conversation[];
  preferences: Preferences;
  bookings: Booking[];
}

interface PreferenceFields {
  city: string;
  languages: string;
  formats: string;
  seatPosition: string;
  budget: string;
}

interface PendingTurn {
  conversationId: string;
  messages: Message[];
  draft: string;
  activity: boolean;
}

const EMPTY_PREFERENCES: PreferenceFields = {
  city: '',
  languages: '',
  formats: '',
  seatPosition: '',
  budget: '',
};

function fieldsFromPreferences(preferences: Preferences): PreferenceFields {
  return {
    city: preferences.city,
    languages: preferences.languages.join(', '),
    formats: preferences.formats.join(', '),
    seatPosition: preferences.seatPosition,
    budget: preferences.budgetPaise ? String(preferences.budgetPaise / 100) : '',
  };
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : 'Request failed';
}

function App() {
  const [authenticated, setAuthenticated] = createSignal(false);
  const [userEmail, setUserEmail] = createSignal('');
  const [conversations, setConversations] = createSignal<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = createSignal('');
  const [messages, setMessages] = createSignal<Message[]>([]);
  const [bookings, setBookings] = createSignal<Booking[]>([]);
  const [preferenceFields, setPreferenceFields] = createSignal(EMPTY_PREFERENCES);
  const [authPending, setAuthPending] = createSignal(false);
  const [newChatPending, setNewChatPending] = createSignal(false);
  const [pendingTurn, setPendingTurn] = createSignal<PendingTurn | null>(null);
  const [failedTurns, setFailedTurns] = createSignal<Record<string, FailedTurn>>({});
  const [transcriptPending, setTranscriptPending] = createSignal(false);
  const [preferencesPending, setPreferencesPending] = createSignal(false);
  const [authError, setAuthError] = createSignal('');
  const [appError, setAppError] = createSignal('');
  const [chatError, setChatError] = createSignal('');
  const [chatStatus, setChatStatus] = createSignal('');
  const [preferencesStatus, setPreferencesStatus] = createSignal('');
  const [mobilePanel, setMobilePanel] = createSignal<'conversations' | 'details' | null>(null);
  const requests = createRequestEpoch();
  const selections = createRequestEpoch();
  let authForm!: HTMLFormElement;
  let transcript!: HTMLOListElement;
  let messageInput!: HTMLTextAreaElement;
  let emailInput!: HTMLInputElement;
  let passwordInput!: HTMLInputElement;
  let mobilePanelOpener: HTMLElement | undefined;
  const api = createApi(fetch, requests.isCurrent, resetSession);
  const chatStream = createChatStream(fetch, requests.isCurrent, resetSession);

  const activeConversation = () =>
    conversations().find((conversation) => conversation.id === activeConversationId());
  const selectedPendingTurn = () => {
    const turn = pendingTurn();
    return isPendingConversation(turn?.conversationId, activeConversationId()) ? turn : null;
  };
  const composerDisabled = () => isComposerDisabled({
    conversationId: activeConversationId(),
    pending: Boolean(pendingTurn()),
    transcriptPending: transcriptPending(),
  });

  function scrollTranscript(follow = true): void {
    if (!follow) return;
    requestAnimationFrame(() => {
      transcript.scrollTop = transcript.scrollHeight;
    });
  }

  function closeMobilePanel(): void {
    setMobilePanel(null);
    requestAnimationFrame(() => mobilePanelOpener?.focus());
  }

  function openMobilePanel(
    panel: 'conversations' | 'details',
    opener: HTMLElement,
  ): void {
    mobilePanelOpener = opener;
    setMobilePanel(panel);
  }

  function resetSession(message = ''): number {
    requests.advance();
    selections.advance();
    setAuthenticated(false);
    setUserEmail('');
    setConversations([]);
    setActiveConversationId('');
    setMessages([]);
    setBookings([]);
    setPreferenceFields(EMPTY_PREFERENCES);
    setAuthPending(false);
    setNewChatPending(false);
    setPendingTurn(null);
    setFailedTurns({});
    setTranscriptPending(false);
    setPreferencesPending(false);
    setAuthError(message);
    setAppError('');
    setChatError('');
    setChatStatus('');
    setPreferencesStatus('');
    setMobilePanel(null);
    requestAnimationFrame(() => {
      authForm?.reset();
      if (emailInput) emailInput.value = '';
      if (passwordInput) passwordInput.value = '';
      emailInput?.focus();
    });
    return requests.capture();
  }

  async function selectConversation(conversation: Conversation): Promise<void> {
    const turn = pendingTurn();
    if (shouldIgnoreConversationReselection(Boolean(turn), activeConversationId(), conversation.id)) {
      setMobilePanel(null);
      requestAnimationFrame(() => messageInput?.focus());
      return;
    }
    if (isPendingConversation(turn?.conversationId, conversation.id)) {
      selections.advance();
      setActiveConversationId(conversation.id);
      setMessages(turn!.messages);
      setTranscriptPending(false);
      setChatError('');
      setMobilePanel(null);
      scrollTranscript();
      requestAnimationFrame(() => messageInput?.focus());
      return;
    }
    const failedTurn = failedTurnForConversation(failedTurns(), conversation.id);
    if (failedTurn) {
      selections.advance();
      setActiveConversationId(conversation.id);
      setMessages(failedTurn.messages);
      setTranscriptPending(false);
      setChatError(failedTurn.error);
      setChatStatus(`Message failed: ${failedTurn.error}`);
      setMobilePanel(null);
      scrollTranscript();
      requestAnimationFrame(() => messageInput?.focus());
      return;
    }
    const captured = requests.capture();
    const selected = selections.advance();
    setActiveConversationId(conversation.id);
    setMessages([]);
    setTranscriptPending(true);
    setChatError('');
    setMobilePanel(null);
    try {
      const result = await api<Message[]>(
        `/api/conversations/${encodeURIComponent(conversation.id)}/messages`,
        {},
        captured,
      );
      if (
        !requests.isCurrent(captured)
        || !selections.isCurrent(selected)
        || activeConversationId() !== conversation.id
      ) return;
      setMessages(result);
      scrollTranscript();
      requestAnimationFrame(() => messageInput?.focus());
    } catch (error) {
      if (
        requests.isCurrent(captured)
        && selections.isCurrent(selected)
        && activeConversationId() === conversation.id
      ) setChatError(messageFor(error));
    } finally {
      if (
        requests.isCurrent(captured)
        && selections.isCurrent(selected)
        && activeConversationId() === conversation.id
      ) setTranscriptPending(false);
    }
  }

  async function loadApp(
    captured = requests.capture(),
    unauthorizedMessage = 'Your session expired. Please log in again.',
  ): Promise<void> {
    const data = await api<Bootstrap>('/api/bootstrap', {}, captured, unauthorizedMessage);
    if (!requests.isCurrent(captured)) return;
    setUserEmail(data.user.email);
    setConversations(data.conversations);
    setPreferenceFields(fieldsFromPreferences(data.preferences));
    setBookings(data.bookings);
    setAuthenticated(true);
    if (data.conversations[0]) await selectConversation(data.conversations[0]);
  }

  async function submitAuth(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    requests.advance();
    const captured = requests.capture();
    const form = event.currentTarget as HTMLFormElement;
    const mode = (event.submitter as HTMLButtonElement | null)?.value || 'login';
    setAuthPending(true);
    setAuthError('');
    const data = new FormData(form);
    try {
      await api(`/api/${mode}`, {
        method: 'POST',
        body: JSON.stringify({
          email: data.get('email'),
          password: data.get('password'),
        }),
      }, captured);
      if (!requests.isCurrent(captured)) return;
      form.reset();
      await loadApp(captured);
    } catch (error) {
      if (requests.isCurrent(captured)) setAuthError(messageFor(error));
    } finally {
      if (requests.isCurrent(captured)) setAuthPending(false);
    }
  }

  async function newConversation(): Promise<void> {
    const captured = requests.capture();
    setNewChatPending(true);
    setAppError('');
    try {
      const conversation = await api<Conversation>('/api/conversations', {
        method: 'POST',
        body: JSON.stringify({}),
      }, captured);
      if (!requests.isCurrent(captured)) return;
      setConversations((current) => [conversation, ...current]);
      await selectConversation(conversation);
    } catch (error) {
      if (requests.isCurrent(captured)) setAppError(messageFor(error));
    } finally {
      if (requests.isCurrent(captured)) setNewChatPending(false);
    }
  }

  async function sendMessage(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const message = String(data.get('message') ?? '').trim();
    const conversationId = activeConversationId();
    if (!message || composerDisabled()) return;
    const captured = requests.capture();
    const optimistic = [...messages(), { role: 'user', content: message } satisfies Message];
    setFailedTurns((current) => {
      const updated = { ...current };
      delete updated[conversationId];
      return updated;
    });
    setMessages(optimistic);
    setPendingTurn({ conversationId, messages: optimistic, draft: '', activity: false });
    setChatError('');
    setChatStatus(thinkingStatus(true));
    form.reset();
    scrollTranscript();

    const handleStreamEvent = (streamEvent: ChatStreamEvent): void => {
      const turn = pendingTurn();
      if (!requests.isCurrent(captured) || turn?.conversationId !== conversationId) return;
      const follow = activeConversationId() === conversationId && shouldFollowOutput(transcript);
      if (streamEvent.type === 'assistant.delta') {
        setPendingTurn({ ...turn, draft: turn.draft + streamEvent.delta });
        if (!turn.draft) setChatStatus('Hermes is responding');
        scrollTranscript(follow);
        return;
      }
      if (streamEvent.type === 'activity') {
        setPendingTurn({ ...turn, activity: streamEvent.active });
        setChatStatus(streamEvent.active ? 'Hermes is working' : 'Hermes is responding');
        scrollTranscript(follow);
        return;
      }
      const updated = applyChatResponse(
        streamEvent.response,
        () => requests.isCurrent(captured),
        (reply) => setMessages([...turn.messages, reply]),
        setBookings,
        conversations(),
        () => activeConversationId() === conversationId,
      );
      if (updated) setConversations(updated);
      setPendingTurn(null);
      setChatStatus('Response complete');
      scrollTranscript(follow);
    };

    try {
      await chatStream(
        `/api/conversations/${encodeURIComponent(conversationId)}/chat/stream`,
        message,
        captured,
        handleStreamEvent,
      );
    } catch (error) {
      const turn = pendingTurn();
      if (!requests.isCurrent(captured) || turn?.conversationId !== conversationId) return;
      const message = messageFor(error);
      const selectedConversationId = activeConversationId();
      const failedState = applyFailedTurn({
        failedTurns: failedTurns(),
        failedConversationId: conversationId,
        failedMessages: turn.messages,
        draft: turn.draft,
        error: message,
        activeConversationId: selectedConversationId,
        visibleMessages: messages(),
        visibleError: chatError(),
      });
      setFailedTurns(failedState.failedTurns);
      setMessages(failedState.visibleMessages);
      setChatError(failedState.visibleError);
      setPendingTurn(null);
      if (selectedConversationId === conversationId) {
        setChatStatus(`Message failed: ${message}`);
      }
    } finally {
      if (requests.isCurrent(captured) && activeConversationId() === conversationId) {
        messageInput.focus();
      }
    }
  }

  async function savePreferences(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const captured = requests.capture();
    setPreferencesPending(true);
    setPreferencesStatus('');
    try {
      const preferences = await api<Preferences>('/api/preferences', {
        method: 'PUT',
        body: JSON.stringify(preferencePayload(preferenceFields())),
      }, captured);
      if (!requests.isCurrent(captured)) return;
      setPreferenceFields(fieldsFromPreferences(preferences));
      setPreferencesStatus('Preferences saved.');
    } catch (error) {
      if (requests.isCurrent(captured)) setPreferencesStatus(messageFor(error));
    } finally {
      if (requests.isCurrent(captured)) setPreferencesPending(false);
    }
  }

  async function logout(): Promise<void> {
    const captured = resetSession();
    setAuthPending(true);
    try {
      await api('/api/logout', { method: 'POST' }, captured);
    } catch (error) {
      if (requests.isCurrent(captured)) setAuthError(messageFor(error));
    } finally {
      if (requests.isCurrent(captured)) setAuthPending(false);
    }
  }

  onMount(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !mobilePanel()) return;
      event.preventDefault();
      closeMobilePanel();
    };
    window.addEventListener('keydown', closeOnEscape);
    onCleanup(() => window.removeEventListener('keydown', closeOnEscape));
    const captured = requests.capture();
    loadApp(captured, '').catch((error) => {
      if (requests.isCurrent(captured)) resetSession(messageFor(error));
    });
  });

  return (
    <Show when={authenticated()} fallback={
      <main class="auth-shell">
        <section class="auth-intro">
          <div class="brand-mark" aria-hidden="true"><Icon name="speech-bubble" size="large" /></div>
          <p class="eyebrow">HERMES MOVIE DESK</p>
          <h1>Find the right show.<br />Keep the booking in one place.</h1>
          <p>Tell your assistant what you want to watch. It searches District, remembers your preferences, and stops before payment.</p>
        </section>
        <Card class="auth-card">
          <div class="auth-card-inner">
            <p class="eyebrow">WELCOME BACK</p>
            <h2>Continue to your assistant</h2>
            <p class="muted">Use your demo account or create one below.</p>
            <form ref={authForm} onSubmit={submitAuth}>
              <label for="email">Email</label>
              <input ref={emailInput} id="email" name="email" type="email" autocomplete="email" maxlength="320" required />
              <label for="password">Password</label>
              <input ref={passwordInput} id="password" name="password" type="password" autocomplete="current-password" minlength="8" required />
              <p class="error" role="alert">{authError()}</p>
              <div class="auth-actions">
                <Button type="submit" name="mode" value="login" variant="primary" disabled={authPending()}>
                  {authPending() ? 'Working…' : 'Log in'}
                </Button>
                <Button type="submit" name="mode" value="register" disabled={authPending()}>Create account</Button>
              </div>
            </form>
          </div>
        </Card>
      </main>
    }>
      <main class="app-shell">
        <Show when={mobilePanel()}>
          <button class="mobile-backdrop" aria-label="Close panel" onClick={closeMobilePanel} />
        </Show>

        <aside class="conversation-rail" data-mobile-open={mobilePanel() === 'conversations'}>
          <header class="rail-header">
            <div class="product">
              <span class="brand-mark small" aria-hidden="true"><Icon name="speech-bubble" /></span>
              <div><strong>Movie desk</strong><span>powered by Hermes</span></div>
            </div>
            <Button class="mobile-only" variant="ghost" icon="close" aria-label="Close conversations" onClick={closeMobilePanel}>Close</Button>
          </header>
          <Button class="new-chat" variant="primary" icon="plus-small" disabled={newChatPending()} onClick={newConversation}>
            {newChatPending() ? 'Starting…' : 'New conversation'}
          </Button>
          <p class="section-label">CONVERSATIONS</p>
          <nav aria-label="Movie booking conversations">
            <Show when={conversations().length} fallback={<p class="empty-copy">Start a conversation to find your next movie.</p>}>
              <ul class="conversation-list">
                <For each={conversations()}>{(conversation) =>
                  <li>
                    <button
                      type="button"
                      aria-current={conversation.id === activeConversationId() ? 'page' : undefined}
                      onClick={() => selectConversation(conversation)}
                    >
                      <Icon name="speech-bubble" size="small" />
                      <span>{conversation.title}</span>
                    </button>
                  </li>
                }</For>
              </ul>
            </Show>
          </nav>
          <footer class="rail-footer">
            <div class="user-chip"><span>{userEmail().slice(0, 1).toUpperCase()}</span><div><strong>{userEmail()}</strong><small>Demo account</small></div></div>
            <Button variant="ghost" icon="arrow-left" onClick={logout}>Log out</Button>
          </footer>
        </aside>

        <section class="chat-pane">
          <header class="chat-header">
            <Button
              class="mobile-only compact"
              variant="ghost"
              icon="sidebar"
              aria-label="Open conversations"
              onClick={(event: MouseEvent & { currentTarget: HTMLButtonElement }) =>
                openMobilePanel('conversations', event.currentTarget)}
            >Chats</Button>
            <div>
              <span class="status-dot" aria-hidden="true" />
              <div><h1>{activeConversation()?.title ?? 'Your movie assistant'}</h1><p>Ready to search shows and plan seats</p></div>
            </div>
            <Button
              class="mobile-only compact"
              variant="ghost"
              icon="sliders"
              aria-label="Open preferences and bookings"
              onClick={(event: MouseEvent & { currentTarget: HTMLButtonElement }) =>
                openMobilePanel('details', event.currentTarget)}
            >Details</Button>
          </header>
          <Show when={appError()}><p class="banner error" role="alert">{appError()}</p></Show>
          <p class="sr-only" role="status">{chatStatus()}</p>
          <ol ref={transcript} class="transcript" aria-label="Conversation transcript">
            <Show when={!transcriptPending()} fallback={<li class="transcript-loading">Loading conversation…</li>}>
              <Show when={messages().length} fallback={
                <li class="chat-empty">
                  <span class="brand-mark" aria-hidden="true"><Icon name="prompt" size="large" /></span>
                  <h2>What would you like to watch?</h2>
                  <p>Try “Find an evening IMAX show in Bengaluru” or start with a movie name.</p>
                </li>
              }>
                <For each={messages()}>{(message) =>
                  <li class="message" data-role={message.role}>
                    <span class="message-label">{message.role === 'user' ? 'YOU' : 'HERMES'}</span>
                    <div class="message-content">
                      <For each={transcriptParts(message.content)}>{(part) =>
                        part.href
                          ? <a href={part.href} target="_blank" rel="noopener noreferrer">{part.text}</a>
                          : part.text
                      }</For>
                    </div>
                  </li>
                }</For>
                <Show when={selectedPendingTurn()}>{(turn) =>
                  <li class="message streaming-message" data-role="assistant">
                    <span class="message-label">HERMES</span>
                    <Show when={turn().draft} fallback={
                      <div class="thinking-content">
                        <span>{turn().activity ? 'Hermes is working' : thinkingStatus(true)}</span>
                        <span class="thinking-dots" aria-hidden="true"><i /><i /><i /></span>
                      </div>
                    }>
                      <div class="message-content">
                        <For each={transcriptParts(turn().draft)}>{(part) =>
                          part.href
                            ? <a href={part.href} target="_blank" rel="noopener noreferrer">{part.text}</a>
                            : part.text
                        }</For>
                      </div>
                      <Show when={turn().activity}>
                        <div class="stream-activity">
                          <span class="thinking-dots" aria-hidden="true"><i /><i /><i /></span>
                          <span>Working…</span>
                        </div>
                      </Show>
                    </Show>
                  </li>
                }</Show>
              </Show>
            </Show>
          </ol>
          <div class="composer-wrap">
            <form class="composer" onSubmit={sendMessage}>
              <label class="sr-only" for="message">Message</label>
              <textarea
                ref={messageInput}
                id="message"
                name="message"
                rows="1"
                placeholder={activeConversationId() ? 'Ask about movies, shows, or seats…' : 'Start a conversation first'}
                disabled={composerDisabled()}
                onKeyDown={(event) => {
                  if (shouldSubmitComposer({
                    key: event.key,
                    shiftKey: event.shiftKey,
                    isComposing: event.isComposing,
                  })) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                required
              />
              <Button
                class="send-action"
                type="submit"
                variant="primary"
                icon="arrow-up"
                aria-label={pendingTurn() ? 'Waiting for Hermes' : 'Send message'}
                disabled={composerDisabled()}
              >
                {pendingTurn() ? 'Sending…' : 'Send'}
              </Button>
            </form>
            <p class="composer-note">Hermes can prepare a booking but will always stop before payment.</p>
            <p class="error">{chatError()}</p>
          </div>
        </section>

        <aside class="details-panel" data-mobile-open={mobilePanel() === 'details'}>
          <header class="details-header">
            <div><p class="eyebrow">YOUR CONTEXT</p><h2>Trip details</h2></div>
            <Button class="mobile-only" variant="ghost" icon="close" aria-label="Close details" onClick={closeMobilePanel}>Close</Button>
          </header>
          <section class="detail-section">
            <div class="section-title"><h3>Preferences</h3><Icon name="sliders" size="small" /></div>
            <form class="preferences-form" onSubmit={savePreferences}>
              <label for="city">City</label>
              <input id="city" autocomplete="address-level2" value={preferenceFields().city} onInput={(event) => setPreferenceFields({ ...preferenceFields(), city: event.currentTarget.value })} placeholder="Bengaluru" />
              <label for="languages">Languages</label>
              <input id="languages" value={preferenceFields().languages} onInput={(event) => setPreferenceFields({ ...preferenceFields(), languages: event.currentTarget.value })} placeholder="Hindi, English" />
              <label for="formats">Formats</label>
              <input id="formats" value={preferenceFields().formats} onInput={(event) => setPreferenceFields({ ...preferenceFields(), formats: event.currentTarget.value })} placeholder="2D, IMAX" />
              <label for="seat-position">Seat position</label>
              <input id="seat-position" value={preferenceFields().seatPosition} onInput={(event) => setPreferenceFields({ ...preferenceFields(), seatPosition: event.currentTarget.value })} placeholder="Back centre" />
              <label for="budget">Budget per booking (₹)</label>
              <input id="budget" type="number" min="0" step="0.01" value={preferenceFields().budget} onInput={(event) => setPreferenceFields({ ...preferenceFields(), budget: event.currentTarget.value })} placeholder="750" />
              <Button type="submit" disabled={preferencesPending()}>{preferencesPending() ? 'Saving…' : 'Save preferences'}</Button>
              <p class="status" role="status">{preferencesStatus()}</p>
            </form>
          </section>
          <section class="detail-section bookings-section">
            <div class="section-title"><h3>Booking history</h3><span>{bookings().length}</span></div>
            <Show when={bookings().length} fallback={<p class="empty-copy">No booking attempts yet.</p>}>
              <ul class="booking-list">
                <For each={bookings()}>{(booking) =>
                  <li>
                    <Card>
                      <div class="booking-heading"><strong>{booking.movie || 'Movie booking'}</strong><Tag>{bookingStatusLabel(booking.status)}</Tag></div>
                      <p>{bookingDetails(booking)}</p>
                    </Card>
                  </li>
                }</For>
              </ul>
            </Show>
          </section>
        </aside>
      </main>
    </Show>
  );
}

render(() => <App />, document.getElementById('root')!);
