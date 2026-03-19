# Roy CRM

An AI-powered CRM system for real estate lead management, built around WhatsApp, Notion, and Granola.

---

## Features

### 1. WhatsApp AI Assistant (`whatsapp-bot/`)
Connects to WhatsApp Web and automatically drafts replies to incoming messages using Claude AI (Haiku). Loads the top 30 active chats with message history, detects incoming leads, and presents a suggested reply in a browser UI. The agent replies in the voice and style of Roy — a real estate professional.

- Auto-drafts replies via Claude AI
- Browser UI to approve, edit, dismiss or regenerate replies
- Tracks link clicks per lead (UTM/tracking URLs)
- Exposes a `/webhook/send` endpoint for external triggers

### 2. Lead Outreach (`outreach/`)
Sends personalized WhatsApp messages to new leads fetched from the Notion CRM. Uses Claude AI to draft a message template, then sends a preview to Telegram for approval before sending. Supports feedback loops — if the template is rejected, Claude re-drafts based on the feedback.

- Fetches leads with status "חדש" from Notion
- Claude drafts a personalized template with `{שם}` placeholder
- Telegram approval flow before any message is sent
- On approval: sends to all leads and updates Notion status → "בתהליך"
- Supports `--limit` flag and custom template files

### 3. Granola Call Sync (`granola-sync/`)
Automatically syncs phone call recordings from the Granola AI note-taking app into the Notion CRM. Matches each call to a lead by phone number (handles all Israeli number formats), appends a timestamped call log to the lead's Notion card, and updates the lead status to "בוצעה שיחה".

- Extracts phone numbers from Granola meeting titles automatically
- Normalizes phone formats: `0XX`, `+972XX`, `00972XX`
- Appends a 📞 call log block with date and time to the matching lead card
- Updates lead status → "בוצעה שיחה"
- Fills the phone field in the Granola record
- Runs automatically every 5 minutes via cron

---

## Tech Stack

- **Node.js** — runtime
- **whatsapp-web.js** — WhatsApp Web automation
- **@anthropic-ai/sdk** — Claude AI (Haiku model)
- **Notion API** — leads CRM database
- **Telegram Bot API** — outreach approval flow
- **Granola** — AI call recording and notes

## Setup

Copy `.env.example` to `.env` and fill in:

```
ANTHROPIC_API_KEY=
NOTION_TOKEN=
NOTION_LEADS_DB_ID=
GRANOLA_DB_ID=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

Run the WhatsApp bot:
```bash
cd whatsapp-bot && npm install && node server.js
```

Run outreach:
```bash
cd outreach && node outreach.js --limit=10
```

Run Granola sync manually:
```bash
cd granola-sync && node granola-sync.js
```
