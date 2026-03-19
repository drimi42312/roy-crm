/**
 * notion-logger.js
 * Logs incoming and outgoing WhatsApp messages to Notion lead pages.
 *
 * On startup: call buildLeadCache() then setInterval(buildLeadCache, 10 * 60 * 1000)
 * On incoming message: logConversation(chatId, 'in', senderName, text)
 * On outgoing message: logConversation(chatId, 'out', 'רוי', text)
 */

'use strict';

const https = require('https');

// ── Notion helpers ────────────────────────────────────────────────────────────

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
      res.on('end', () => console.error('[notion-logger] append error:', res.statusCode, raw.slice(0, 200)));
    }
  });
  req.on('error', e => console.error('[notion-logger] append error:', e.message));
  req.write(data);
  req.end();
}

// ── Phone normalization ───────────────────────────────────────────────────────

function normalizePhone(raw) {
  if (!raw && raw !== 0) return null;
  let s = String(raw).replace(/[\s\-\(\)\.]/g, '');
  s = s.replace(/^\+/, '');
  if (s.startsWith('00')) s = s.slice(2);
  if (s.startsWith('0'))  s = '972' + s.slice(1);
  if (!/^\d{10,15}$/.test(s)) return null;
  return s;
}

// ── Lead cache ────────────────────────────────────────────────────────────────

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
    console.log(`[notion-logger] Lead cache built: ${map.size} leads`);
  } catch (e) {
    console.error('[notion-logger] Failed to build cache:', e.message);
  }
}

function findNotionLead(chatId) {
  const phone = chatId.replace('@c.us', '');
  if (leadCache.has(phone)) return leadCache.get(phone);
  const norm = normalizePhone(phone);
  if (norm && leadCache.has(norm)) return leadCache.get(norm);
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Append a conversation block to the matching lead's Notion page.
 * direction: 'in'  → incoming message from lead (gray 💬)
 * direction: 'out' → outgoing message from Roy  (blue 📤)
 */
function logConversation(chatId, direction, senderName, text) {
  if (!text) return;
  const notionPageId = findNotionLead(chatId);
  if (!notionPageId) return;

  const ts    = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', hour12: false }).replace(',', '');
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

module.exports = { buildLeadCache, logConversation };
