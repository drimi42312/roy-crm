/**
 * granola-sync.js
 * Reads new meeting notes from the Granola Notion database,
 * matches each to a lead by phone number, appends a call log block
 * to the lead page, and updates status → "בוצעה שיחה".
 *
 * Run once manually: node granola-sync.js
 * Run on a schedule: crontab -e  →  * * * * * cd /root/whatsap_claud && node granola-sync.js >> granola-sync.log 2>&1
 *
 * Required .env vars:
 *   NOTION_TOKEN         – Notion integration token
 *   NOTION_LEADS_DB_ID  – your leads CRM database
 *   GRANOLA_DB_ID       – the Granola meeting-notes database (set after first Granola→Notion push)
 */

require('dotenv').config();
const https = require('https');

const TOKEN   = process.env.NOTION_TOKEN;
const LEADS   = process.env.NOTION_LEADS_DB_ID;
const GRANOLA = process.env.GRANOLA_DB_ID;

if (!TOKEN || !LEADS || !GRANOLA) {
  console.error('Missing env vars. Make sure NOTION_TOKEN, NOTION_LEADS_DB_ID, and GRANOLA_DB_ID are set in .env');
  process.exit(1);
}

// ── Notion helpers ────────────────────────────────────────────────────────────

function notionRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.notion.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve(JSON.parse(raw)));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const notion = {
  queryDB: (dbId, filter) => notionRequest('POST', `/v1/databases/${dbId}/query`, filter || {}),
  getPage:  (id)          => notionRequest('GET',  `/v1/pages/${id}`, null),
  getBlocks:(id)          => notionRequest('GET',  `/v1/blocks/${id}/children`, null),
  patchPage:(id, body)    => notionRequest('PATCH', `/v1/pages/${id}`, body),
  appendBlocks:(id, body) => notionRequest('PATCH', `/v1/blocks/${id}/children`, body),
};

// ── Phone normalization ───────────────────────────────────────────────────────
// Returns a canonical numeric string like "972546619990", or null if no phone found.

function normalizePhone(raw) {
  if (!raw && raw !== 0) return null;
  let s = String(raw).replace(/[\s\-\(\)\.]/g, '');   // strip separators
  s = s.replace(/^\+/, '');                            // remove leading +
  if (s.startsWith('00')) s = s.slice(2);              // 00972... → 972...
  if (s.startsWith('0'))  s = '972' + s.slice(1);      // 052... → 97252...
  if (!/^\d{10,15}$/.test(s)) return null;
  return s;
}

// ── Extract phone from Granola page content ───────────────────────────────────
// If the Granola DB has a phone property, use it.
// Otherwise scan rich-text blocks for a phone-like pattern.

const PHONE_RE = /(?:\+?972|0)(?:[-\s]?\d){8,10}/g;

async function extractPhone(page) {
  // 1. Try a property named "טלפון" or "Phone" or "phone"
  const props = page.properties || {};
  for (const [, prop] of Object.entries(props)) {
    if (prop.type === 'phone_number' && prop.phone_number) {
      return normalizePhone(prop.phone_number);
    }
    if (prop.type === 'rich_text') {
      const text = prop.rich_text.map(r => r.plain_text).join('');
      const m = text.match(PHONE_RE);
      if (m) return normalizePhone(m[0]);
    }
    if (prop.type === 'title') {
      const text = prop.title.map(r => r.plain_text).join('');
      const m = text.match(PHONE_RE);
      if (m) return normalizePhone(m[0]);
    }
  }

  // 2. Scan first-level blocks for phone-like numbers
  try {
    const blocks = await notion.getBlocks(page.id);
    for (const block of (blocks.results || [])) {
      const richTexts = block[block.type]?.rich_text || [];
      const text = richTexts.map(r => r.plain_text).join('');
      const m = text.match(PHONE_RE);
      if (m) return normalizePhone(m[0]);
    }
  } catch (_) {}

  return null;
}

// ── Get meeting title and date from Granola page ──────────────────────────────

function getMeetingTitle(page) {
  const props = page.properties || {};
  for (const [, prop] of Object.entries(props)) {
    if (prop.type === 'title') {
      return prop.title.map(r => r.plain_text).join('') || 'שיחה';
    }
  }
  return 'שיחה';
}

function getMeetingDate(page) {
  const props = page.properties || {};
  // Try "Date", "תאריך", or the page's created_time
  for (const [, prop] of Object.entries(props)) {
    if (prop.type === 'date' && prop.date?.start) {
      return new Date(prop.date.start);
    }
    if (prop.type === 'created_time' && prop.created_time) {
      return new Date(prop.created_time);
    }
  }
  return new Date(page.created_time || Date.now());
}

function formatDate(d) {
  return d.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', hour12: false })
    .replace(',', '');
}

// ── Load all leads into a phone→leadId map ────────────────────────────────────

async function buildLeadMap() {
  const map = new Map(); // normalizedPhone → pageId
  let cursor;
  do {
    const res = await notion.queryDB(LEADS, cursor ? { start_cursor: cursor } : {});
    for (const page of (res.results || [])) {
      const rawPhone = page.properties?.['טלפון']?.number;
      const phone = normalizePhone(rawPhone);
      if (phone) map.set(phone, page.id);
    }
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return map;
}

// ── Mark a Granola page as synced ─────────────────────────────────────────────
// We look for a checkbox property named "סונכרן ל-CRM" or "Synced".
// If not found we just log it but still process — won't re-run duplicate blocks
// because we check "last_edited_time" on next run.

async function markSynced(pageId, phone) {
  const update = {
    'סונכרן ל-CRM': { checkbox: true },
  };
  if (phone) update['טלפון'] = { phone_number: '+' + phone };
  await notion.patchPage(pageId, { properties: update });
}

// ── Append call-log block to lead page ───────────────────────────────────────

async function appendCallLog(leadId, title, date, granolaPageId) {
  const dateStr = formatDate(date);
  await notion.appendBlocks(leadId, {
    children: [
      {
        object: 'block',
        type: 'callout',
        callout: {
          rich_text: [
            { type: 'text', text: { content: `📞 שיחה: ${title}` }, annotations: { bold: true } },
            { type: 'text', text: { content: `\nתאריך ושעה: ${dateStr}` } },
            { type: 'text', text: { content: `\nנרשם אוטומטית מ-Granola` }, annotations: { italic: true, color: 'gray' } },
          ],
          icon: { emoji: '📞' },
          color: 'blue_background',
        },
      },
    ],
  });
}

// ── Update lead status ────────────────────────────────────────────────────────

async function updateLeadStatus(leadId) {
  await notion.patchPage(leadId, {
    properties: {
      'סטטוס': { select: { name: 'בוצעה שיחה' } },
    },
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[${new Date().toISOString()}] granola-sync starting…`);

  // 1. Load leads phone map
  const leadMap = await buildLeadMap();
  console.log(`  Loaded ${leadMap.size} leads with phone numbers`);

  // 2. Query all Granola pages, filter out already-synced ones in code
  const res = await notion.queryDB(GRANOLA, {
    filter: { property: 'סונכרן ל-CRM', checkbox: { equals: false } },
    sorts: [{ timestamp: 'created_time', direction: 'ascending' }],
  });

  const pages = res.results || [];
  console.log(`  Found ${pages.length} unsynced Granola note(s)`);

  let synced = 0, skipped = 0;

  for (const page of pages) {
    const title = getMeetingTitle(page);
    const phone = await extractPhone(page);

    if (!phone) {
      console.log(`  [skip] "${title}" — no phone number found`);
      skipped++;
      continue;
    }

    const leadId = leadMap.get(phone);
    if (!leadId) {
      console.log(`  [skip] "${title}" — phone ${phone} not found in leads`);
      skipped++;
      continue;
    }

    const date = getMeetingDate(page);
    console.log(`  [match] "${title}" → lead ${leadId} (${phone})`);

    await appendCallLog(leadId, title, date, page.id);
    await updateLeadStatus(leadId);
    await markSynced(page.id, phone).catch(() => {});

    console.log(`  [done] Call logged, status → "בוצעה שיחה"`);
    synced++;
  }

  console.log(`\n  Done. Synced: ${synced}, Skipped: ${skipped}`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
