// Forkie Chat App — same agent, two brains:
//  1. Your own forkie backend (the handoff): POST /api/chat on the server that
//     runs the same agent as the Slack bot — same model, same keys, same prompt.
//     Configured via the gear button (stored in localStorage).
//  2. Public fallback: Pollinations, keyless, so the site works out of the box.
const API_URL = 'https://text.pollinations.ai/';
const SYSTEM_PROMPT = `You are Forkie — a calm, intelligent, and genuinely helpful AI assistant. You're one of the best AI agents around. You carry that with quiet, good-natured confidence. You prioritize correctness, clarity, and usefulness, but bring warmth and character. You adapt your tone to the situation: concise for simple questions, more detailed for complex ones. You're friendly and approachable, with a natural conversational style. You can be witty when it fits, but never let personality get in the way of being helpful. You avoid filler and needless verbosity, but you're not afraid to show enthusiasm when something is genuinely interesting. Never use em dashes; use a period or comma instead. Write naturally, like a person chatting.`;

let messages = [];
let isStreaming = false;
let chatSessions = [];
let currentSessionId = null;

const messagesEl = document.getElementById('messages');
const welcomeEl = document.getElementById('welcome');
const inputEl = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const newChatBtn = document.getElementById('new-chat-btn');
const chatHistory = document.getElementById('chat-history');
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebar = document.getElementById('sidebar');
const connDot = document.getElementById('conn-dot');
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const backendUrlInput = document.getElementById('backend-url');
const backendSecretInput = document.getElementById('backend-secret');
const backendStatus = document.getElementById('backend-status');

// ---- backend config (the handoff) ----
function getBackend() {
  try {
    return JSON.parse(localStorage.getItem('forkie-backend') || 'null');
  } catch (e) {
    return null;
  }
}

function saveBackend(cfg) {
  if (cfg && cfg.url) {
    localStorage.setItem('forkie-backend', JSON.stringify(cfg));
  } else {
    localStorage.removeItem('forkie-backend');
  }
}

function updateConnDot() {
  const backend = getBackend();
  if (backend && backend.url) {
    connDot.classList.add('connected');
    connDot.classList.remove('public');
    connDot.title = 'connected to your forkie backend (' + backend.url + ')';
  } else {
    connDot.classList.add('public');
    connDot.classList.remove('connected');
    connDot.title = 'public mode — using a free model until you connect your backend';
  }
}

async function checkBackendHealth(backend) {
  try {
    const res = await fetch(backend.url.replace(/\/$/, '') + '/health', { method: 'GET' });
    if (res.ok) {
      connDot.classList.add('connected');
      connDot.classList.remove('public');
      return true;
    }
  } catch (e) {}
  return false;
}

// ---- session management ----
function init() {
  loadSessions();
  if (chatSessions.length === 0) {
    createNewSession();
  } else {
    loadSession(chatSessions[0].id);
  }
  renderHistory();
  setupListeners();
  updateConnDot();
  const backend = getBackend();
  if (backend && backend.url) {
    checkBackendHealth(backend);
  }
}

function createNewSession() {
  const session = {
    id: Date.now().toString(),
    title: 'new chat',
    messages: [],
    createdAt: Date.now()
  };
  chatSessions.unshift(session);
  currentSessionId = session.id;
  saveSessions();
  return session;
}

function loadSession(id) {
  currentSessionId = id;
  const session = chatSessions.find(s => s.id === id);
  if (session) {
    messages = session.messages;
    renderMessages();
    renderHistory();
  }
}

function saveSessions() {
  try {
    localStorage.setItem('forkie-sessions', JSON.stringify(chatSessions));
  } catch (e) {}
}

function loadSessions() {
  try {
    const saved = localStorage.getItem('forkie-sessions');
    if (saved) chatSessions = JSON.parse(saved);
  } catch (e) {}
}

function renderHistory() {
  chatHistory.innerHTML = chatSessions.map(s => `
    <div class="chat-history-item ${s.id === currentSessionId ? 'active' : ''}" data-id="${s.id}">
      ${escapeHtml(s.title)}
    </div>
  `).join('');

  chatHistory.querySelectorAll('.chat-history-item').forEach(el => {
    el.addEventListener('click', () => loadSession(el.dataset.id));
  });
}

function renderMessages() {
  if (messages.length === 0) {
    welcomeEl.style.display = 'flex';
    messagesEl.innerHTML = '';
  } else {
    welcomeEl.style.display = 'none';
    messagesEl.innerHTML = messages.map(m => createMessageHtml(m.role, m.content)).join('');
  }
  scrollToBottom();
}

function createMessageHtml(role, content) {
  if (role === 'user') {
    return `
      <div class="message">
        <div class="message-avatar user">Y</div>
        <div class="message-content">
          <div class="message-role">You</div>
          <div class="message-text">${formatMessage(content)}</div>
        </div>
      </div>
    `;
  } else {
    return `
      <div class="message">
        <img src="./avatar.jpg" alt="forkie" class="message-avatar">
        <div class="message-content">
          <div class="message-role">Forkie</div>
          <div class="message-text">${formatMessage(content)}</div>
        </div>
      </div>
    `;
  }
}

function formatMessage(text) {
  // Basic markdown-like formatting
  let html = escapeHtml(text);
  // Code blocks
  html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Line breaks to paragraphs
  html = html.split('\n\n').map(p => '<p>' + p.replace(/\n/g, '<br>') + '</p>').join('');
  return html;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function scrollToBottom() {
  const container = document.getElementById('chat-container');
  container.scrollTop = container.scrollHeight;
}

function showTypingIndicator() {
  const html = `
    <div class="message" id="typing-message">
      <img src="./avatar.jpg" alt="forkie" class="message-avatar">
      <div class="message-content">
        <div class="message-role">Forkie</div>
        <div class="message-text">
          <div class="typing-indicator"><span></span><span></span><span></span></div>
        </div>
      </div>
    </div>
  `;
  messagesEl.insertAdjacentHTML('beforeend', html);
  scrollToBottom();
}

function removeTypingIndicator() {
  const el = document.getElementById('typing-message');
  if (el) el.remove();
}

// ---- streaming: your backend (SSE) ----
async function streamFromBackend(backend, apiMessages, textEl, onText) {
  const base = backend.url.replace(/\/$/, '');
  const res = await fetch(base + '/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(backend.secret ? { 'x-web-chat-secret': backend.secret } : {})
    },
    body: JSON.stringify({ messages: apiMessages })
  });
  if (!res.ok) {
    const errText = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error('backend error ' + res.status + (errText ? ': ' + errText : ''));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE events are separated by blank lines
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const lines = raw.split('\n');
      let event = 'message';
      let data = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (!data) continue;
      let payload;
      try { payload = JSON.parse(data); } catch (e) { continue; }

      if (event === 'delta' && payload.delta) {
        onText(payload.delta);
      } else if (event === 'error') {
        throw new Error(payload.error || 'backend stream error');
      } else if (event === 'done') {
        return payload.text || '';
      }
    }
  }
  return '';
}

// ---- streaming: pollinations fallback ----
async function streamFromPollinations(apiMessages, textEl, onText) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: apiMessages,
      model: 'openai',
      stream: true
    })
  });
  if (!res.ok) throw new Error('API error');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let assistantText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value);
    const lines = chunk.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content || '';
          if (content) {
            assistantText += content;
            onText(content);
          }
        } catch (e) {}
      }
    }
  }
  return assistantText;
}

async function sendMessage(text) {
  if (isStreaming || !text.trim()) return;

  isStreaming = true;
  sendBtn.disabled = true;

  // Hide welcome, show messages
  welcomeEl.style.display = 'none';

  // Add user message
  messages.push({ role: 'user', content: text });
  messagesEl.insertAdjacentHTML('beforeend', createMessageHtml('user', text));

  // Update session title from first message
  const session = chatSessions.find(s => s.id === currentSessionId);
  if (session && session.messages.length === 0) {
    session.title = text.slice(0, 40) + (text.length > 40 ? '...' : '');
    renderHistory();
  }

  scrollToBottom();
  showTypingIndicator();

  // Add empty assistant message element for streaming
  messagesEl.insertAdjacentHTML('beforeend', createMessageHtml('assistant', ''));
  const assistantMsgEl = messagesEl.lastElementChild;
  const textEl = assistantMsgEl.querySelector('.message-text');
  removeTypingIndicator();

  let assistantText = '';
  const onText = (delta) => {
    assistantText += delta;
    textEl.innerHTML = formatMessage(assistantText);
    scrollToBottom();
  };

  try {
    // Build messages array for API
    const apiMessages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...messages.map(m => ({ role: m.role, content: m.content }))
    ];

    const backend = getBackend();
    if (backend && backend.url) {
      assistantText = await streamFromBackend(backend, apiMessages, textEl, onText);
      // model may not echo accumulated deltas; onText already collected them
    } else {
      assistantText = await streamFromPollinations(apiMessages, textEl, onText);
    }

    // Save assistant message
    if (assistantText && assistantText.trim()) {
      messages.push({ role: 'assistant', content: assistantText });
      session.messages = messages;
      saveSessions();
    } else {
      textEl.innerHTML = formatMessage('sorry, i got an empty response. please try again.');
    }

  } catch (error) {
    console.error('Error:', error);
    textEl.innerHTML = formatMessage('sorry, something went wrong. please try again. (' + (error.message || 'unknown error') + ')');
  }

  isStreaming = false;
  sendBtn.disabled = false;
  inputEl.focus();
}

// ---- settings modal ----
function openSettings() {
  const backend = getBackend();
  backendUrlInput.value = backend ? backend.url : '';
  backendSecretInput.value = backend ? (backend.secret || '') : '';
  backendStatus.textContent = '';
  settingsModal.classList.remove('hidden');
  backendUrlInput.focus();
}

function closeSettings() {
  settingsModal.classList.add('hidden');
}

function setupListeners() {
  // Send button
  sendBtn.addEventListener('click', () => {
    const text = inputEl.value.trim();
    if (text) {
      inputEl.value = '';
      inputEl.style.height = 'auto';
      sendMessage(text);
    }
  });

  // Enter to send
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendBtn.click();
    }
  });

  // Auto-resize textarea
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
    sendBtn.disabled = !inputEl.value.trim();
  });

  // New chat
  newChatBtn.addEventListener('click', () => {
    createNewSession();
    messages = [];
    renderMessages();
    renderHistory();
    inputEl.focus();
  });

  // Sidebar toggle (mobile)
  sidebarToggle.addEventListener('click', () => {
    sidebar.classList.toggle('open');
  });

  // Suggestion buttons
  document.querySelectorAll('.suggestion').forEach(btn => {
    btn.addEventListener('click', () => {
      const prompt = btn.dataset.prompt;
      inputEl.value = prompt;
      sendMessage(prompt);
    });
  });

  // Settings
  settingsBtn.addEventListener('click', openSettings);
  document.getElementById('backend-cancel').addEventListener('click', closeSettings);
  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) closeSettings();
  });

  document.getElementById('backend-save').addEventListener('click', async () => {
    const url = backendUrlInput.value.trim().replace(/\/+$/, '');
    if (!url) {
      backendStatus.textContent = 'enter a backend url first.';
      return;
    }
    const secret = backendSecretInput.value.trim();
    const cfg = { url, secret: secret || undefined };
    saveBackend(cfg);
    updateConnDot();
    backendStatus.textContent = 'saved. testing connection...';
    const ok = await checkBackendHealth(cfg);
    backendStatus.textContent = ok
      ? 'connected — forkie is now running on your own backend. 🎉'
      : 'saved, but could not reach ' + url + '/health. is the server running? chat will fall back to public mode.';
    connDot.classList.toggle('connected', ok);
    if (ok) closeSettings();
  });

  document.getElementById('backend-clear').addEventListener('click', () => {
    saveBackend(null);
    updateConnDot();
    backendStatus.textContent = 'disconnected — back to public mode.';
    backendUrlInput.value = '';
    backendSecretInput.value = '';
  });
}

init();
