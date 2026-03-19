const socket = io();

// State
let currentChatId = null;
let allChats = [];
let currentSuggestionContext = null;

// DOM refs
const qrScreen = document.getElementById('qr-screen');
const appScreen = document.getElementById('app-screen');
const qrImage = document.getElementById('qr-image');
const qrImageWrap = document.getElementById('qr-image-wrap');
const qrStatusText = document.getElementById('qr-status-text');
const qrStatus = document.getElementById('qr-status');
const chatList = document.getElementById('chat-list');
const messagesArea = document.getElementById('messages');
const messageInput = document.getElementById('message-input');
const royBox = document.getElementById('roy-box');
const suggestionText = document.getElementById('suggestion-text');
const royLoading = document.getElementById('roy-loading');
const noChat = document.getElementById('no-chat');
const chatView = document.getElementById('chat-view');
const chatName = document.getElementById('chat-name');

// ── Socket Events ──────────────────────────────────────────

socket.on('connect', () => {
  console.log('Connected to server');
});

socket.on('qr', (dataUrl) => {
  qrStatus.style.display = 'none';
  qrImageWrap.style.display = 'block';
  qrImage.src = dataUrl;
});

socket.on('ready', () => {
  showApp();
});

socket.on('disconnected', ({ reason }) => {
  showScreen(qrScreen);
  hideScreen(appScreen);
  qrStatus.style.display = 'block';
  qrImageWrap.style.display = 'none';
  qrStatusText.textContent = 'Disconnected: ' + reason + '. Reconnecting...';
});

socket.on('chats', (chatsData) => {
  allChats = chatsData.sort((a, b) => {
    const ta = a.lastMessage?.timestamp || 0;
    const tb = b.lastMessage?.timestamp || 0;
    return tb - ta;
  });
  renderChatList(allChats);
});

socket.on('message', ({ chatId, message }) => {
  // Update chat in memory
  const chat = allChats.find(c => c.id === chatId);
  if (chat) {
    if (!chat.messages) chat.messages = [];
    chat.messages.push(message);
    chat.lastMessage = message;
    if (!message.fromMe) chat.unread = (chat.unread || 0) + 1;
  } else {
    allChats.push({ id: chatId, messages: [message], lastMessage: message, unread: 1 });
  }

  // If viewing this chat, add message
  if (chatId === currentChatId) {
    appendMessage(message);
    socket.emit('mark_read', { chatId });
    if (chat) chat.unread = 0;
  }

  sortAndRenderChats();
});

socket.on('chat_updated', (updatedChat) => {
  const idx = allChats.findIndex(c => c.id === updatedChat.id);
  if (idx >= 0) {
    allChats[idx] = { ...allChats[idx], ...updatedChat };
  } else {
    allChats.push(updatedChat);
  }
  sortAndRenderChats();
});

socket.on('suggestion', ({ chatId, suggestion, error }) => {
  if (chatId !== currentChatId) return;

  royLoading.style.display = 'none';
  if (suggestion) {
    suggestionText.textContent = suggestion;
    royBox.style.display = 'block';
    currentSuggestionContext = chatId;
  } else if (error) {
    suggestionText.textContent = '(Roy is unavailable right now)';
    royBox.style.display = 'block';
  }
});

socket.on('message_sent', ({ chatId, message }) => {
  if (chatId === currentChatId) {
    appendMessage(message);
  }
  hideRoyBox();
});

socket.on('send_error', ({ error }) => {
  alert('Could not send message: ' + error);
});

socket.on('error', ({ message }) => {
  qrStatusText.textContent = message;
});

// ── UI Functions ───────────────────────────────────────────

function showApp() {
  hideScreen(qrScreen);
  showScreen(appScreen);
  document.getElementById('connection-dot').classList.add('connected');
}

function showScreen(el) {
  el.classList.add('active');
  el.style.display = 'flex';
}

function hideScreen(el) {
  el.classList.remove('active');
  el.style.display = 'none';
}

function sortAndRenderChats() {
  allChats.sort((a, b) => {
    const ta = a.lastMessage?.timestamp || 0;
    const tb = b.lastMessage?.timestamp || 0;
    return tb - ta;
  });
  renderChatList(allChats);
}

function renderChatList(chats) {
  if (chats.length === 0) {
    chatList.innerHTML = '<div class="empty-state"><p>No chats found</p></div>';
    return;
  }

  chatList.innerHTML = chats.map(chat => {
    const initial = getInitial(chat.name || chat.id);
    const preview = chat.lastMessage?.body || '';
    const time = chat.lastMessage ? formatTime(chat.lastMessage.timestamp) : '';
    const unread = chat.unread > 0 ? `<span class="unread-badge">${chat.unread}</span>` : '';
    const isActive = chat.id === currentChatId ? 'active' : '';

    return `
      <div class="chat-item ${isActive}" onclick="openChat('${escapeAttr(chat.id)}')">
        <div class="avatar" style="background:${colorFromString(chat.name || chat.id)}">${initial}</div>
        <div class="chat-info">
          <div class="chat-item-name">
            <span>${escapeHtml(chat.name || chat.id)}</span>
            <span class="time">${time}</span>
          </div>
          <div class="chat-preview">
            <span>${escapeHtml(preview.substring(0, 50))}${preview.length > 50 ? '…' : ''}</span>
            ${unread}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function openChat(chatId) {
  currentChatId = chatId;
  hideRoyBox();

  const chat = allChats.find(c => c.id === chatId);
  if (!chat) return;

  // Mark as read
  chat.unread = 0;
  socket.emit('mark_read', { chatId });

  // Update header
  chatName.textContent = chat.name || chatId;
  document.getElementById('chat-avatar').textContent = getInitial(chat.name || chatId);
  document.getElementById('chat-avatar').style.background = colorFromString(chat.name || chatId);
  document.getElementById('chat-status').textContent = chat.isGroup ? 'group' : '';

  // Show chat view
  noChat.style.display = 'none';
  chatView.style.display = 'flex';

  // Render messages
  messagesArea.innerHTML = '';
  (chat.messages || []).forEach(appendMessage);
  scrollToBottom();

  // Update active state in list
  document.querySelectorAll('.chat-item').forEach(el => el.classList.remove('active'));
  const items = chatList.querySelectorAll('.chat-item');
  const idx = allChats.findIndex(c => c.id === chatId);
  if (items[idx]) items[idx].classList.add('active');

  sortAndRenderChats();
}

function appendMessage(msg) {
  const div = document.createElement('div');
  div.className = `message-bubble ${msg.fromMe ? 'from-me' : 'from-them'}`;

  let senderHtml = '';
  if (!msg.fromMe && msg.sender && msg.sender !== 'Unknown') {
    senderHtml = `<div class="message-sender">${escapeHtml(msg.sender)}</div>`;
  }

  div.innerHTML = `
    ${senderHtml}
    <div>${escapeHtml(msg.body)}</div>
    <div class="message-time">${msg.time || ''}</div>
  `;
  messagesArea.appendChild(div);
  scrollToBottom();
}

function scrollToBottom() {
  messagesArea.scrollTop = messagesArea.scrollHeight;
}

function filterChats(query) {
  const filtered = query
    ? allChats.filter(c => (c.name || c.id).toLowerCase().includes(query.toLowerCase()))
    : allChats;
  renderChatList(filtered);
}

// ── Roy Functions ──────────────────────────────────────────

function sendSuggestion() {
  const text = suggestionText.textContent.trim();
  if (!text || !currentChatId) return;
  socket.emit('send_message', { chatId: currentChatId, text });
  hideRoyBox();
}

function dismissSuggestion() {
  hideRoyBox();
}

function refreshSuggestion() {
  if (!currentChatId) return;
  const chat = allChats.find(c => c.id === currentChatId);
  if (!chat) return;

  const lastIncoming = [...(chat.messages || [])]
    .reverse()
    .find(m => !m.fromMe);

  if (!lastIncoming) return;

  suggestionText.textContent = '';
  royLoading.style.display = 'block';
  royBox.style.display = 'block';

  socket.emit('ask_roy', {
    chatId: currentChatId,
    messageText: lastIncoming.body,
    senderName: chat.name || 'them'
  });
}

function hideRoyBox() {
  royBox.style.display = 'none';
  suggestionText.textContent = '';
  royLoading.style.display = 'none';
  currentSuggestionContext = null;
}

// ── Send Message ───────────────────────────────────────────

function sendMessage() {
  const text = messageInput.value.trim();
  if (!text || !currentChatId) return;
  socket.emit('send_message', { chatId: currentChatId, text });
  messageInput.value = '';
}

function handleKey(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
}

// ── Helpers ────────────────────────────────────────────────

function getInitial(name) {
  if (!name) return '?';
  const words = name.trim().split(' ');
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name[0].toUpperCase();
}

function formatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp * 1000);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  const days = Math.floor((now - date) / 86400000);
  if (days === 1) return 'Yesterday';
  if (days < 7) return date.toLocaleDateString([], { weekday: 'short' });
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function colorFromString(str) {
  const colors = ['#1abc9c','#2ecc71','#3498db','#9b59b6','#e74c3c','#e67e22','#16a085','#2980b9','#8e44ad','#c0392b'];
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  return String(str).replace(/'/g, "\\'");
}
