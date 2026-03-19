require('dotenv').config();
const express = require('express');
const http = require('http');
const fs = require('fs');
const { Server } = require('socket.io');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const https = require('https');
const qrcode = require('qrcode');
const Roy = require('./roy');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

// ── Click tracking ────────────────────────────────────────────────────────────

const CLICKS_FILE   = './clicks.json';
const TRACKING_FILE = './tracking.json';

function saveClick(shortId, ip, ua) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(CLICKS_FILE, 'utf8')); } catch {}
  if (!data[shortId]) data[shortId] = [];
  data[shortId].push({ time: new Date().toISOString(), ip, ua });
  fs.writeFileSync(CLICKS_FILE, JSON.stringify(data, null, 2));
  return data[shortId].length; // return total click count
}

// Notion helpers — fire-and-forget, never blocks the redirect
function notionGet(pageId) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.notion.com',
      path: `/v1/pages/${pageId}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    });
    req.on('error', () => resolve({}));
    req.end();
  });
}

function notionPatch(pageId, properties) {
  const data = JSON.stringify({ properties });
  const req = https.request({
    hostname: 'api.notion.com',
    path: `/v1/pages/${pageId}`,
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    },
  }, () => {});
  req.on('error', (e) => console.error('[notion] click update error:', e.message));
  req.write(data);
  req.end();
}

function notionQuery(dbId, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body || {});
    const req = https.request({
      hostname: 'api.notion.com',
      path: `/v1/databases/${dbId}/query`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    });
    req.on('error', () => resolve({}));
    req.write(data);
    req.end();
  });
}

function notionAppend(pageId, children) {
  const data = JSON.stringify({ children });
  const req = https.request({
    hostname: 'api.notion.com',
    path: `/v1/blocks/${pageId}/children`,
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    },
  }, (res) => {
    if (res.statusCode >= 400) {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => console.error('[notion] append error:', res.statusCode, raw.slice(0, 200)));
    }
  });
  req.on('error', e => console.error('[notion] append error:', e.message));
  req.write(data);
  req.end();
}

async function recordClickInNotion(shortId, totalClicks) {
  if (!process.env.NOTION_TOKEN) return;

  // Find notionPageId from tracking.json
  let tracking = {};
  try { tracking = JSON.parse(fs.readFileSync(TRACKING_FILE, 'utf8')); } catch { return; }

  const entry = Object.entries(tracking).find(([id]) => id.replace(/-/g, '') === shortId);
  if (!entry) return;
  const [notionPageId] = entry;

  // Fetch current notes so we can append (not overwrite)
  const page = await notionGet(notionPageId);
  const existing = page.properties?.['הערות שיחה']?.rich_text?.[0]?.plain_text || '';
  const timestamp = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
  const note = `🔗 לחיצה על הלינק — ${timestamp} (סה"כ ${totalClicks})`;
  const updated = existing ? `${existing}\n${note}` : note;

  // Get current click count from Notion to increment it
  const currentClicks = page.properties?.['website clicks']?.number || 0;

  notionPatch(notionPageId, {
    'סטטוס':           { select: { name: 'ליד חם' } },
    'הערות שיחה':      { rich_text: [{ text: { content: updated } }] },
    'website clicks':  { number: currentClicks + 1 },
  });

  console.log(`[track] ${shortId} → click #${totalClicks}, Notion updated`);
}

// ── Lead cache & conversation logging ─────────────────────────────────────────

function normalizePhone(raw) {
  if (!raw && raw !== 0) return null;
  let s = String(raw).replace(/[\s\-\(\)\.]/g, '');
  s = s.replace(/^\+/, '');
  if (s.startsWith('00')) s = s.slice(2);
  if (s.startsWith('0'))  s = '972' + s.slice(1);
  if (!/^\d{10,15}$/.test(s)) return null;
  return s;
}

let leadCache = new Map(); // normalizedPhone → notionPageId

async function buildLeadCache() {
  if (!process.env.NOTION_TOKEN || !process.env.NOTION_LEADS_DB_ID) return;
  const map = new Map();
  let cursor;
  try {
    do {
      const body = cursor ? { start_cursor: cursor } : {};
      const res = await notionQuery(process.env.NOTION_LEADS_DB_ID, body);
      for (const page of (res.results || [])) {
        const rawPhone = page.properties?.['טלפון']?.number;
        const phone = normalizePhone(rawPhone);
        if (phone) map.set(phone, page.id);
      }
      cursor = res.has_more ? res.next_cursor : null;
    } while (cursor);
    leadCache = map;
    console.log(`[leads] Cache built: ${map.size} leads with phone numbers`);
  } catch (e) {
    console.error('[leads] Failed to build cache:', e.message);
  }
}

function findNotionLead(chatId) {
  const phone = chatId.replace('@c.us', '');
  if (leadCache.has(phone)) return leadCache.get(phone);
  const norm = normalizePhone(phone);
  if (norm && leadCache.has(norm)) return leadCache.get(norm);
  return null;
}

function logConversationToNotion(notionPageId, direction, senderName, text) {
  if (!notionPageId || !text) return;
  const ts = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', hour12: false }).replace(',', '');
  const icon  = direction === 'in' ? '💬' : '📤';
  const label = direction === 'in' ? senderName : 'רוי';
  notionAppend(notionPageId, [{
    object: 'block',
    type: 'callout',
    callout: {
      rich_text: [{ type: 'text', text: { content: `${label} — ${ts}:\n${text}` } }],
      icon: { emoji: icon },
      color: direction === 'in' ? 'gray_background' : 'blue_background',
    },
  }]);
}

// ─────────────────────────────────────────────────────────────────────────────

app.get('/t/:shortId', (req, res) => {
  const dest = process.env.DESTINATION_URL || 'https://77kedem.com/offer.html';
  const ua   = req.headers['user-agent'] || '';

  // WhatsApp / Facebook crawlers: serve OG tags for link preview, no click logging
  const isCrawler = /facebookexternalhit|WhatsApp|Twitterbot|LinkedInBot|Slackbot|TelegramBot/i.test(ua);
  if (isCrawler) {
    return res.send(`<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <title>קדם 77 — בניין יוקרה בקו הראשון לים | תל אביב</title>
  <meta property="og:title" content="קדם 77 — בניין יוקרה בקו הראשון לים" />
  <meta property="og:description" content="הזדמנות נדירה: בניין שלם למכירה בתל אביב, קו ראשון לים. 381 מ״ר מגרש, אפשרות ל-35 חדרי מלון. הכנסה קיימת 750,000 ₪/שנה." />
  <meta property="og:image" content="https://www.dropbox.com/scl/fi/m4sh185e9gf1oktouh1vi/facade.png?rlkey=vsmky86wuok69it5ms03njdx5&raw=1" />
  <meta property="og:url" content="${dest}" />
  <meta property="og:type" content="website" />
</head>
<body></body>
</html>`);
  }

  // Real user: log click + redirect
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const totalClicks = saveClick(req.params.shortId, ip, ua);
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta property="og:title" content="קדם 77 — בניין יוקרה בקו הראשון לים" />
  <meta property="og:description" content="הזדמנות נדירה: בניין שלם למכירה בתל אביב, קו ראשון לים." />
  <meta property="og:image" content="https://www.dropbox.com/scl/fi/m4sh185e9gf1oktouh1vi/facade.png?rlkey=vsmky86wuok69it5ms03njdx5&raw=1" />
  <meta property="og:url" content="${dest}" />
  <meta http-equiv="refresh" content="0;url=${dest}" />
  <script>window.location.replace('${dest}');</script>
</head>
<body></body>
</html>`);
  recordClickInNotion(req.params.shortId, totalClicks).catch(() => {});
});

// ─────────────────────────────────────────────────────────────────────────────

// ── Webhook helpers ──────────────────────────────────────────────────────────

// Forward an incoming WhatsApp message to WEBHOOK_URL (fire-and-forget)
function forwardToWebhook(payload) {
  const webhookUrl = process.env.WEBHOOK_URL;
  if (!webhookUrl) return;
  try {
    const url = new URL(webhookUrl);
    const data = JSON.stringify(payload);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + (url.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...(process.env.WEBHOOK_SECRET && { 'x-webhook-secret': process.env.WEBHOOK_SECRET })
      }
    }, (res) => {
      console.log(`[webhook] Forwarded incoming message → ${res.statusCode}`);
    });
    req.on('error', (e) => console.error('[webhook] Forward error:', e.message));
    req.write(data);
    req.end();
  } catch (e) {
    console.error('[webhook] Invalid WEBHOOK_URL:', e.message);
  }
}

// Normalise a phone number to WhatsApp chatId format (e.g. "972501234567@c.us")
function toChatId(to) {
  if (to.includes('@')) return to;           // already a full chatId
  return to.replace(/[^0-9]/g, '') + '@c.us'; // strip non-digits, append suffix
}

// ─────────────────────────────────────────────────────────────────────────────

// In-memory storage
const chats = {};       // chatId -> { id, name, messages: [], unread: 0 }
const contacts = {};    // chatId -> display name

let clientReady = false;
let reinitializing = false;

async function reinitClient() {
  if (reinitializing) return;
  reinitializing = true;
  clientReady = false;
  console.log('[wwebjs] Reinitializing WhatsApp client...');
  try {
    await client.destroy();
  } catch (e) {}
  try {
    await client.initialize();
  } catch (e) {
    console.error('[wwebjs] Reinit error:', e.message);
  }
  reinitializing = false;
}

async function waitForReady(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = await client.getState();
      if (state === 'CONNECTED') return;
    } catch (e) {}
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('WhatsApp not ready after timeout');
}

// WhatsApp client setup
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  }
});

// QR Code event
client.on('qr', async (qr) => {
  console.log('QR code received, sending to browser...');
  try {
    const qrDataUrl = await qrcode.toDataURL(qr);
    io.emit('qr', qrDataUrl);
  } catch (err) {
    console.error('QR generation error:', err);
  }
});

// Ready event
client.on('ready', async () => {
  clientReady = true;
  console.log('WhatsApp client is ready!');
  io.emit('ready', { message: 'WhatsApp connected!' });

  // Build lead cache and refresh every 10 minutes
  buildLeadCache();
  setInterval(buildLeadCache, 10 * 60 * 1000);

  // Detect page reloads (WhatsApp Web auto-updates) — reinit when page navigates
  client.pupPage.once('load', () => {
    console.log('[wwebjs] Page reloaded — scheduling reinit...');
    clientReady = false;
    setTimeout(reinitClient, 3000);
  });

  // Load existing chats
  try {
    const allChats = await client.getChats();
    for (const chat of allChats.slice(0, 30)) { // Load top 30 chats
      const messages = await chat.fetchMessages({ limit: 20 });
      const formattedMessages = messages.map(formatMessage);

      chats[chat.id._serialized] = {
        id: chat.id._serialized,
        name: chat.name || chat.id.user,
        isGroup: chat.isGroup,
        messages: formattedMessages,
        unread: chat.unreadCount || 0,
        lastMessage: formattedMessages[formattedMessages.length - 1] || null
      };
    }
    io.emit('chats', Object.values(chats));
    console.log(`Loaded ${Object.keys(chats).length} chats`);
  } catch (err) {
    console.error('Error loading chats:', err);
  }
});

// Authentication failure
client.on('auth_failure', () => {
  console.log('Authentication failed');
  io.emit('error', { message: 'WhatsApp authentication failed. Please refresh and try again.' });
});

// Disconnected — auto-reconnect
client.on('disconnected', (reason) => {
  clientReady = false;
  console.log('Client disconnected:', reason, '— reinitializing...');
  io.emit('disconnected', { reason });
  setTimeout(reinitClient, 5000);
});

// Incoming message
client.on('message', async (msg) => {
  if (msg.isStatus) return;

  const chatId = msg.from;
  const chat = await msg.getChat();
  const contact = await msg.getContact();

  const formatted = formatMessage(msg, contact);

  // Update or create chat entry
  if (!chats[chatId]) {
    chats[chatId] = {
      id: chatId,
      name: chat.name || contact.pushname || contact.number,
      isGroup: chat.isGroup,
      messages: [],
      unread: 0,
      lastMessage: null
    };
  }

  chats[chatId].messages.push(formatted);
  chats[chatId].lastMessage = formatted;
  chats[chatId].unread = (chats[chatId].unread || 0) + 1;

  // Send message to frontend
  io.emit('message', { chatId, message: formatted });
  io.emit('chat_updated', chats[chatId]);

  // Log to Notion CRM if this is a known lead
  if (!msg.fromMe && !chat.isGroup) {
    const notionLeadId = findNotionLead(chatId);
    if (notionLeadId) {
      const senderName = contact?.pushname || contact?.number || chatId.replace('@c.us', '');
      logConversationToNotion(notionLeadId, 'in', senderName, msg.body || '');
    }
  }

  // Forward to external webhook if configured
  forwardToWebhook({
    event: 'message',
    from: chatId,
    name: chat.name || contact.pushname || contact.number || chatId,
    body: msg.body || '',
    hasMedia: msg.hasMedia || false,
    timestamp: formatted.timestamp,
    time: formatted.time
  });

  // Handle known lead replies
  if (!msg.fromMe && !chat.isGroup) {
    try {
      let tracking = {};
      try { tracking = JSON.parse(fs.readFileSync(TRACKING_FILE, 'utf8')); } catch {}
      const phone = chatId.replace('@c.us', '');
      const leadKey = Object.keys(tracking).find(k => {
        const l = tracking[k];
        return l.phone === phone || l.phone === '972' + phone.replace(/^0/, '');
      });

      if (leadKey) {
        const lead = tracking[leadKey];
        const name = lead.name || contact.pushname || phone;

        // Send tracking link on first reply only
        if (!lead.linkSent && lead.trackingLink) {
          await client.sendMessage(chatId, `אני מצרף לינק עם כל פרטי הנכס המלאים:\n${lead.trackingLink}`);
          tracking[leadKey].linkSent = true;
          fs.writeFileSync(TRACKING_FILE, JSON.stringify(tracking, null, 2));
          console.log(`[lead reply] Sent tracking link to ${name}`);
        }

        // Notify on Telegram
        const tgToken = process.env.TELEGRAM_BOT_TOKEN;
        const tgChat  = process.env.TELEGRAM_CHAT_ID;
        if (tgToken && tgChat) {
          const tgMsg  = `💬 *${name}* ענה:\n\n${msg.body || '(מדיה)'}`;
          const tgBody = JSON.stringify({ chat_id: tgChat, text: tgMsg, parse_mode: 'Markdown' });
          const tgReq  = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${tgToken}/sendMessage`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(tgBody) },
          }, () => {});
          tgReq.on('error', () => {});
          tgReq.write(tgBody); tgReq.end();
        }
      }
    } catch (e) { console.error('[lead reply handler]', e.message); }
  }

  // Ask Roy to draft a reply (only for private messages, not group unless mentioned)
  const shouldReply = !chat.isGroup || msg.mentionedIds?.length > 0;
  if (shouldReply && !msg.fromMe) {
    try {
      const chatHistory = chats[chatId].messages.slice(-10); // Last 10 messages for context
      const senderName = chat.name || contact.pushname || 'someone';
      const suggestion = await Roy.draftReply(msg.body, senderName, chatHistory);
      io.emit('suggestion', { chatId, suggestion });
    } catch (err) {
      console.error('Roy error:', err.message);
      io.emit('suggestion', { chatId, suggestion: null, error: 'Roy is unavailable right now.' });
    }
  }
});

// ── POST /webhook/send ───────────────────────────────────────────────────────
//
// Send a WhatsApp message (with optional file) from an external system.
//
// Request body (JSON):
//   {
//     "to": "972501234567",          ← phone number or full chatId
//     "message": "Hello!",           ← text (optional if sending a file)
//     "file": {                      ← optional
//       "url":      "https://...",   ← fetch file from URL  (option A)
//       "base64":   "...",           ← raw base64 data      (option B)
//       "mimetype": "application/pdf",
//       "filename": "document.pdf"
//     }
//   }
//
// Optional security: set WEBHOOK_SECRET in .env, then include the header:
//   x-webhook-secret: <your-secret>
//
// ── POST /webhook/reinit ─────────────────────────────────────────────────────
// Destroys and reinitializes the WhatsApp client. Waits until ready.
app.post('/webhook/reinit', async (req, res) => {
  console.log('[reinit] Starting WhatsApp client reinit...');
  try {
    await reinitClient();
    await waitForReady(120000);
    console.log('[reinit] Done — client is ready');
    res.json({ ok: true });
  } catch (err) {
    console.error('[reinit] Failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /webhook/send ───────────────────────────────────────────────────────
app.post('/webhook/send', async (req, res) => {
  // Verify secret if configured
  const secret = process.env.WEBHOOK_SECRET;
  if (secret && req.headers['x-webhook-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { to, message, file } = req.body;

  if (!to) {
    return res.status(400).json({ error: 'Missing required field: to' });
  }

  if (!message && !file) {
    return res.status(400).json({ error: 'Provide at least one of: message, file' });
  }

  const chatId = toChatId(to);

  const doSend = async () => {
    if (file) {
      let media;
      if (file.url) {
        media = await MessageMedia.fromUrl(file.url, { unsafeMime: true });
      } else if (file.base64 && file.mimetype) {
        media = new MessageMedia(file.mimetype, file.base64, file.filename || 'file');
      } else {
        throw new Error('file must have either url, or base64 + mimetype');
      }
      await client.sendMessage(chatId, media, { caption: message || '' });
    }
    if (message && !file) {
      await client.sendMessage(chatId, message);
    }
  };

  try {
    await waitForReady(60000);
    try {
      await doSend();
    } catch (sendErr) {
      if (sendErr.message.includes('detached Frame')) {
        // WhatsApp page navigated — reinitialize and retry once
        console.log('[webhook/send] Detached frame — reinitializing and retrying…');
        await reinitClient();
        await waitForReady(90000);
        await doSend();
      } else {
        throw sendErr;
      }
    }

    console.log(`[webhook/send] Sent to ${chatId}`);
    res.json({ ok: true, to: chatId });
  } catch (err) {
    console.error('[webhook/send] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

// Socket.io connection
io.on('connection', (socket) => {
  console.log('Browser connected');

  // Send current state if already connected
  if (Object.keys(chats).length > 0) {
    socket.emit('ready', { message: 'WhatsApp connected!' });
    socket.emit('chats', Object.values(chats));
  }

  // Handle send message from frontend
  socket.on('send_message', async ({ chatId, text }) => {
    try {
      await client.sendMessage(chatId, text);

      const msg = {
        id: Date.now().toString(),
        body: text,
        fromMe: true,
        timestamp: Math.floor(Date.now() / 1000),
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        sender: 'You'
      };

      if (chats[chatId]) {
        chats[chatId].messages.push(msg);
        chats[chatId].lastMessage = msg;
      }

      socket.emit('message_sent', { chatId, message: msg });
      io.emit('chat_updated', chats[chatId]);

      // Log to Notion CRM if this is a known lead
      const notionLeadId = findNotionLead(chatId);
      if (notionLeadId) logConversationToNotion(notionLeadId, 'out', 'רוי', text);
    } catch (err) {
      console.error('Send error:', err);
      socket.emit('send_error', { error: 'Failed to send message.' });
    }
  });

  // Handle request for Roy suggestion on demand
  socket.on('ask_roy', async ({ chatId, messageText, senderName }) => {
    try {
      const chatHistory = chats[chatId]?.messages.slice(-10) || [];
      const suggestion = await Roy.draftReply(messageText, senderName, chatHistory);
      socket.emit('suggestion', { chatId, suggestion });
    } catch (err) {
      socket.emit('suggestion', { chatId, suggestion: null, error: 'Roy is unavailable.' });
    }
  });

  // Mark chat as read
  socket.on('mark_read', async ({ chatId }) => {
    if (chats[chatId]) {
      chats[chatId].unread = 0;
    }
    try {
      const chat = await client.getChatById(chatId);
      await chat.sendSeen();
    } catch (e) {
      // non-critical
    }
  });

  socket.on('disconnect', () => {
    console.log('Browser disconnected');
  });
});

// Helper to format a WhatsApp message
function formatMessage(msg, contact) {
  const timestamp = msg.timestamp || Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000);
  return {
    id: msg.id?.id || Date.now().toString(),
    body: msg.body || '',
    fromMe: msg.fromMe || false,
    timestamp,
    time: date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    sender: msg.fromMe ? 'You' : (contact?.pushname || contact?.number || 'Unknown')
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🤖 Roy is starting up...`);
  console.log(`📱 Open http://localhost:${PORT} in your browser`);
  console.log(`⏳ Initializing WhatsApp...\n`);
  client.initialize();
});
