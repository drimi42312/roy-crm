/**
 * Show click stats for all tracked leads.
 * Usage: node clicks.js
 */

const fs = require('fs');

const TRACKING_FILE = './tracking.json';
const CLICKS_FILE   = './clicks.json';

function main() {
  let tracking = {}, clicks = {};
  try { tracking = JSON.parse(fs.readFileSync(TRACKING_FILE, 'utf8')); } catch {}
  try { clicks   = JSON.parse(fs.readFileSync(CLICKS_FILE,   'utf8')); } catch {}

  const entries = Object.entries(tracking);
  if (entries.length === 0) { console.log('No tracked leads yet.'); return; }

  console.log(`\n📊 Click tracking — ${entries.length} lead(s)\n`);

  const results = entries.map(([notionId, entry]) => {
    const shortId = notionId.replace(/-/g, '');
    const clickEvents = clicks[shortId] || [];
    return { ...entry, clicks: clickEvents.length };
  }).sort((a, b) => b.clicks - a.clicks);

  for (const r of results) {
    const date = r.sentAt ? new Date(r.sentAt).toLocaleDateString('he-IL') : '';
    console.log(`${r.clicks.toString().padStart(3)} clicks  ${r.name} (${r.phone})  ${r.trackingLink}  ${date}`);
  }

  const total = results.reduce((s, r) => s + r.clicks, 0);
  console.log(`\nTotal clicks: ${total}`);
}

main();
