// Forkie Chat App
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

// Init
function init() {
  loadSessions();
  if (chatSessions.length === 0) {
    createNewSession();
  } else {
    loadSession(chatSessions[0].id);
  }
  renderHistory();
  setupListeners();
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
  
  try {
    // Build messages array for API
    const apiMessages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...messages.map(m => ({ role: m.role, content: m.content }))
    ];
    
    // Call Pollinations API (streaming)
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: apiMessages,
        model: 'openai',
        stream: true
      })
    });
    
    if (!response.ok) throw new Error('API error');
    
    removeTypingIndicator();
    
    // Stream response
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let assistantText = '';
    
    // Add empty assistant message
    messagesEl.insertAdjacentHTML('beforeend', createMessageHtml('assistant', ''));
    const assistantMsgEl = messagesEl.lastElementChild;
    const textEl = assistantMsgEl.querySelector('.message-text');
    
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
              textEl.innerHTML = formatMessage(assistantText);
              scrollToBottom();
            }
          } catch (e) {}
        }
      }
    }
    
    // Save assistant message
    if (assistantText) {
      messages.push({ role: 'assistant', content: assistantText });
      session.messages = messages;
      saveSessions();
    }
    
  } catch (error) {
    removeTypingIndicator();
    console.error('Error:', error);
    messagesEl.insertAdjacentHTML('beforeend', createMessageHtml('assistant', 'sorry, something went wrong. please try again.'));
  }
  
  isStreaming = false;
  sendBtn.disabled = false;
  inputEl.focus();
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
}

init();
