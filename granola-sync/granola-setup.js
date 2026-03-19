/**
 * granola-setup.js
 * Run ONCE after you've pushed your first note from Granola → Notion.
 * Finds the Granola database, adds a "טלפון" property if missing,
 * and writes GRANOLA_DB_ID to .env so granola-sync.js can use it.
 *
 * Usage: node granola-setup.js
 */

require('dotenv').config();
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const TOKEN    = process.env.NOTION_TOKEN;
const ENV_FILE = path.join(__dirname, '.env');

function notionRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.notion.com',
      path: urlPath,
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

// Heuristic: Granola databases usually have a title property + a date property
// and a text/notes property. We pick any DB that is NOT the leads DB.
const LEADS_DB = process.env.NOTION_LEADS_DB_ID;

async function findGranolaDB() {
  let cursor;
  const candidates = [];

  do {
    const body = cursor ? { start_cursor: cursor } : {};
    const res = await notionRequest('POST', '/v1/search', {
      ...body,
      filter: { value: 'database', property: 'object' },
    });

    for (const db of (res.results || [])) {
      if (db.id === LEADS_DB) continue;
      const title = (db.title || []).map(t => t.plain_text).join('').toLowerCase();
      const props = Object.values(db.properties || {});
      const hasDate  = props.some(p => p.type === 'date' || p.type === 'created_time');
      const hasTitle = props.some(p => p.type === 'title');
      if (hasDate && hasTitle) candidates.push({ id: db.id, title, props: db.properties });
    }

    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);

  return candidates;
}

async function main() {
  console.log('Searching Notion workspace for Granola database…');
  const candidates = await findGranolaDB();

  if (!candidates.length) {
    console.log('\n⚠️  No Granola database found yet.');
    console.log('Steps to finish setup:');
    console.log('  1. Open Granola on your Mac');
    console.log('  2. Open any meeting note');
    console.log('  3. Click Share → Notion  (this creates the database)');
    console.log('  4. Come back here and run:  node granola-setup.js');
    return;
  }

  let db;
  if (candidates.length === 1) {
    db = candidates[0];
    console.log(`✓ Found database: "${db.title}" (${db.id})`);
  } else {
    console.log('Multiple candidate databases found:');
    candidates.forEach((c, i) => console.log(`  [${i}] "${c.title}" — ${c.id}`));
    // Pick the first one that has "granola" in the name, else first
    db = candidates.find(c => c.title.includes('granola')) || candidates[0];
    console.log(`Picking: "${db.title}"`);
  }

  // Add "טלפון" phone_number property if missing
  const hasPhone = Object.values(db.props).some(p => p.type === 'phone_number');
  const hasSynced = Object.keys(db.props).some(k => /סונכרן|synced/i.test(k));

  const newProps = {};
  if (!hasPhone) newProps['טלפון'] = { phone_number: {} };
  if (!hasSynced) newProps['סונכרן ל-CRM'] = { checkbox: {} };

  if (Object.keys(newProps).length) {
    console.log('Adding missing properties:', Object.keys(newProps).join(', '));
    await notionRequest('PATCH', `/v1/databases/${db.id}`, { properties: newProps });
    console.log('✓ Properties added');
  } else {
    console.log('✓ Required properties already exist');
  }

  // Write GRANOLA_DB_ID to .env
  let env = fs.readFileSync(ENV_FILE, 'utf8');
  if (env.includes('GRANOLA_DB_ID=')) {
    env = env.replace(/GRANOLA_DB_ID=.*/g, `GRANOLA_DB_ID=${db.id}`);
  } else {
    env += `\nGRANOLA_DB_ID=${db.id}\n`;
  }
  fs.writeFileSync(ENV_FILE, env);
  console.log(`✓ GRANOLA_DB_ID=${db.id} saved to .env`);

  console.log('\n✅ Setup complete!');
  console.log('From now on, after each call in Granola:');
  console.log('  1. Open the meeting note in Granola');
  console.log('  2. Add the lead\'s phone number in the "טלפון" field');
  console.log('  3. Share → Notion  (or it auto-syncs)');
  console.log('  4. Run: node granola-sync.js');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
