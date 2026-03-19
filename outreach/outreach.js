/**
 * Roy Outreach — drafts a WhatsApp message template, gets your approval via
 * Telegram, then sends it to all new Notion leads with each lead's name.
 *
 * Prerequisites:
 *   1. WhatsApp server (server.js) must be running on localhost:3000
 *   2. NOTION_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID set in .env
 *
 * Usage:
 *   node outreach.js           ← full flow
 *   node outreach.js --dry-run ← show draft only, no Telegram, no send
 *
 * Telegram approval flow:
 *   "send"        → sends to all leads with their names
 *   any other text → Roy re-drafts using your text as feedback, asks again
 *   (no timeout — Roy waits until you reply)
 */

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const fs    = require('fs');
const http  = require('http');
const https = require('https');
const tg    = require('./telegram');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const LEADS_DB_ID      = process.env.NOTION_LEADS_DB_ID  || '30282bbf-9cec-80cc-8a8a-d252a60c17c7';
const WA_SERVER_URL    = process.env.WA_SERVER_URL        || 'http://localhost:3000';
const MODEL            = process.env.CLAUDE_MODEL         || 'claude-haiku-4-5-20251001';
const TRACKING_DOMAIN  = process.env.TRACKING_DOMAIN      || 'http://track.77kedem.com';
const TRACKING_FILE    = './tracking.json';
const DRY_RUN          = process.argv.includes('--dry-run');
const SEND_DELAY_MS    = 5000; // 5s between sends
const limitArg         = process.argv.find(a => a.startsWith('--limit='));
const LIMIT            = limitArg ? parseInt(limitArg.split('=')[1]) : null;
const templateFileArg  = process.argv.find(a => a.startsWith('--template-file='));
const TEMPLATE_FILE    = templateFileArg ? templateFileArg.split('=')[1] : null;

// ── Notion ────────────────────────────────────────────────────────────────────

function notionRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: 'api.notion.com',
        path,
        method,
        headers: {
          'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            if (res.statusCode >= 400) reject(new Error(parsed.message || raw));
            else resolve(parsed);
          } catch { reject(new Error(raw)); }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function fetchNewLeads() {
  const res = await notionRequest(
    'POST',
    `/v1/databases/${LEADS_DB_ID}/query`,
    { filter: { property: 'סטטוס', select: { equals: 'חדש' } }, page_size: 100 }
  );

  return res.results.map((page) => {
    const p = page.properties;
    return {
      id:       page.id,
      name:     p['שם מלא']?.title?.[0]?.plain_text || '',
      phone:    p['טלפון']?.number?.toString() || '',
      interest: p['סוג עניין']?.select?.name || '',
      budget:   p['תקציב']?.select?.name || '',
      platform: p['פלטפורמה']?.select?.name || '',
      city:     p['עיר']?.rich_text?.[0]?.plain_text || '',
      seaView:  p['נוף לים']?.select?.name || '',
      notes:    p['הערות']?.rich_text?.[0]?.plain_text || '',
    };
  }).filter((l) => l.name && l.phone);
}

async function updateLead(pageId, sentMessage) {
  await notionRequest('PATCH', `/v1/pages/${pageId}`, {
    properties: {
      'סטטוס': { select: { name: 'בתהליך' } },
      'הערות שיחה': {
        rich_text: [{ text: { content: `[רוי — פנייה ראשונית]\n${sentMessage}` } }],
      },
    },
  });
}

// ── Tracking ──────────────────────────────────────────────────────────────────

function loadTracking() {
  try { return JSON.parse(fs.readFileSync(TRACKING_FILE, 'utf8')); }
  catch { return {}; }
}

function saveTracking(data) {
  fs.writeFileSync(TRACKING_FILE, JSON.stringify(data, null, 2));
}

/** Returns a per-lead tracking URL using the full UUID (no hyphens) as ID. */
function createTrackingLink(lead) {
  const shortId = lead.id.replace(/-/g, '');
  return `${TRACKING_DOMAIN}/t/${shortId}`;
}

// ── Claude ────────────────────────────────────────────────────────────────────

const DRAFT_SYSTEM = `אתה רוי, נציג של Levant Living — חברת נדל"ן יוקרתית בתל אביב.
אתה כותב הודעות WhatsApp ראשוניות ללידים שהתעניינו ברכישת נכס.

כללים:
- השתמש תמיד ב-{שם} כמקום-שמירה לשם הלקוח — זה יוחלף אוטומטית
- הודעה קצרה (3-4 שורות), חמה ומקצועית בעברית
- הצג את עצמך כרוי מ-Levant Living
- הזמן לשיחה קצרה
- אל תבטיח מחירים ואל תשתמש בסוגריים מרובעים חוץ מ-{שם}
- כתוב רק את תוכן ההודעה, ללא הסברים`;

async function draftTemplate(messages) {
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 300,
    system: DRAFT_SYSTEM,
    messages,
  });
  return res.content[0].text.trim();
}

/** Replace {שם} and {לינק} in template. If no {לינק} placeholder, appends link at end. */
function personalize(template, name, trackingLink) {
  let msg = template.replace(/\{שם\}/g, name);
  const link = trackingLink || 'http://track.77kedem.com/t/...';
  if (msg.includes('{לינק}')) {
    msg = msg.replace(/\{לינק\}/g, link);
  } else if (trackingLink) {
    msg += `\n${trackingLink}`;
  }
  return msg;
}

// ── WhatsApp ──────────────────────────────────────────────────────────────────

function sendViaWebhook(phone, message) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ to: phone, message });
    const url  = new URL(`${WA_SERVER_URL}/webhook/send`);
    const lib  = url.protocol === 'https:' ? https : http;

    const req = lib.request(
      {
        hostname: url.hostname,
        port:     url.port || (url.protocol === 'https:' ? 443 : 80),
        path:     url.pathname,
        method:   'POST',
        headers:  {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...(process.env.WEBHOOK_SECRET
            ? { 'x-webhook-secret': process.env.WEBHOOK_SECRET }
            : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          else try { resolve(JSON.parse(data)); } catch { resolve({ ok: true }); }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  console.log(`\n📲 Roy Outreach${DRY_RUN ? ' [DRY RUN]' : ''} — starting\n`);

  // 1. Fetch leads
  let leads;
  try {
    leads = await fetchNewLeads();
  } catch (err) {
    console.error('❌ Failed to fetch leads from Notion:', err.message);
    process.exit(1);
  }

  if (leads.length === 0) {
    console.log('✅ No new leads with status "חדש" found.');
    return;
  }

  if (LIMIT) leads = leads.slice(0, LIMIT);
  console.log(`📋 Found ${leads.length} new lead(s)${LIMIT ? ` (limited to ${LIMIT})` : ''}`);

  // 2. Draft initial template (or load from file)
  const sampleName = leads[0].name.split(' ')[0]; // first name for preview
  let template, convHistory;

  if (TEMPLATE_FILE) {
    let raw = fs.readFileSync(TEMPLATE_FILE, 'utf8').trim();
    // Replace destination URL with {לינק} if present
    const destUrl = process.env.DESTINATION_URL || 'https://77kedem.com/offer.html';
    if (raw.includes(destUrl)) raw = raw.replace(destUrl, '{לינק}');
    template = raw;
    convHistory = [];
    console.log(`\n📄 Loaded template from file:\n${template}\n`);
  } else {
    const initialPrompt =
      `כתוב הודעת פנייה ראשונית ללידים שהתעניינו ברכישת נכס נדל"ן יוקרתי בתל אביב. ` +
      `השתמש ב-{שם} לשם הלקוח.`;
    convHistory = [{ role: 'user', content: initialPrompt }];
    template = await draftTemplate(convHistory);
    convHistory.push({ role: 'assistant', content: template });
    console.log(`\n💬 Initial draft:\n${template}\n`);
  }

  if (DRY_RUN) {
    console.log(`Preview for "${sampleName}":\n${personalize(template, sampleName)}`);
    console.log('\n[DRY RUN] Done.');
    return;
  }

  // 3. Drain old Telegram messages so we only react to new replies
  let lastUpdateId = await tg.drainUpdates();

  // 4. Approval loop — wait until user approves
  while (true) {
    const preview = personalize(template, sampleName);

    await tg.sendWithButtons(
      `📋 *${leads.length} ליד/ים מוכנים*\n\n` +
      `תצוגה מקדימה (עם "${sampleName}"):\n\n` +
      `${preview}`,
      [
        [{ text: `✅ שלח לכולם (${leads.length})`, callback_data: 'send' }],
        [{ text: '✏️ כתוב מחדש', callback_data: 'redraft' }],
      ]
    );

    console.log('⏳ Waiting for Telegram approval…');
    const reply = await tg.waitForReply(lastUpdateId);
    lastUpdateId = reply.lastUpdateId;
    const replyText = reply.text.trim();

    if (replyText === 'send') {
      break; // Approved
    }

    if (replyText === 'redraft') {
      // Ask for feedback via text
      await tg.send('✏️ מה לשנות? כתוב את ההערות שלך (או שלח הודעה חדשה שלמה):');
      const feedback = await tg.waitForReply(lastUpdateId);
      lastUpdateId = feedback.lastUpdateId;
      const feedbackText = feedback.text.trim();

      if (feedbackText.length > 80) {
        // Full replacement message
        let tpl = feedbackText;
        const destUrl = process.env.DESTINATION_URL || 'https://77kedem.com/offer.html';
        if (tpl.includes(destUrl)) tpl = tpl.replace(destUrl, '{לינק}');
        if (!tpl.includes('{שם}')) {
          tpl = await draftTemplate([{ role: 'user', content: `הוסף את המקום-שמירה {שם} בהודעה הבאה במקום המתאים ביותר. החזר רק את ההודעה המעודכנת, ללא הסברים:\n\n${tpl}` }]);
        }
        template = tpl;
        await tg.send('📝 משתמש בהודעה שלך כתבנית.');
      } else {
        // Short feedback — re-draft with Claude
        if (!convHistory) convHistory = [];
        convHistory.push({ role: 'user', content: feedbackText });
        template = await draftTemplate(convHistory);
        convHistory.push({ role: 'assistant', content: template });
        console.log(`  💬 New draft:\n${template}`);
      }
      continue;
    }

    // User typed a long message directly (bypassing buttons)
    if (replyText.length > 80) {
      let tpl = replyText;
      const destUrl = process.env.DESTINATION_URL || 'https://77kedem.com/offer.html';
      if (tpl.includes(destUrl)) tpl = tpl.replace(destUrl, '{לינק}');
      if (!tpl.includes('{שם}')) {
        tpl = await draftTemplate([{ role: 'user', content: `הוסף את המקום-שמירה {שם} בהודעה הבאה במקום המתאים ביותר. החזר רק את ההודעה המעודכנת, ללא הסברים:\n\n${tpl}` }]);
      }
      template = tpl;
      await tg.send('📝 משתמש בהודעה שלך כתבנית.');
    }
  }

  // 5. Reinit WhatsApp client before sending (ensures fresh session)
  console.log('\n🔄 Reinitializing WhatsApp client before sending...');
  await new Promise((resolve, reject) => {
    const body = JSON.stringify({});
    const url = new URL(`${WA_SERVER_URL}/webhook/reinit`);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 150000,
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error(`Reinit failed: ${d}`));
        else resolve();
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
  console.log('✅ WhatsApp client ready — starting send\n');

  // 6. Send to all leads
  await tg.send(`✅ Approved! Sending to *${leads.length}* leads…`);
  console.log(`\n🚀 Sending to ${leads.length} lead(s)…\n`);

  let sent = 0, failed = 0;
  const tracking = loadTracking();

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    const trackingLink = createTrackingLink(lead);
    let message = personalize(template, lead.name.split(' ')[0], trackingLink);

    console.log(`[${i + 1}/${leads.length}] ${lead.name} (${lead.phone})`);
    tracking[lead.id] = {
      name: lead.name,
      phone: lead.phone,
      trackingLink,
      sentAt: new Date().toISOString(),
    };
    saveTracking(tracking);
    console.log(`  🔗 ${trackingLink}`);

    try {
      await sendViaWebhook(lead.phone, message);
      await updateLead(lead.id, message);
      console.log(`  ✅ Sent`);
      sent++;
    } catch (err) {
      console.error(`  ❌ Failed: ${err.message}`);
      failed++;
    }

    if (i < leads.length - 1) await sleep(SEND_DELAY_MS);
  }

  const summary =
    `\n✅ *Outreach complete*\n` +
    `Sent: *${sent}* | Failed: ${failed}`;

  console.log(summary.replace(/\*/g, ''));
  await tg.send(summary);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
