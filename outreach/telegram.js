const https = require('https');

function post(method, params) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set in .env');

  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params);
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${token}/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function send(text) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) throw new Error('TELEGRAM_CHAT_ID not set in .env');
  return post('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown' });
}

/** Send a message with inline keyboard buttons.
 *  buttons: array of rows, each row is array of { text, callback_data }
 *  Example: [[{ text: '✅ שלח', callback_data: 'send' }], [{ text: '✏️ כתוב מחדש', callback_data: 'redraft' }]]
 */
async function sendWithButtons(text, buttons) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) throw new Error('TELEGRAM_CHAT_ID not set in .env');
  return post('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons },
  });
}

/**
 * Wait indefinitely for the next message or button press in the Telegram chat.
 * Returns { text, lastUpdateId } — for buttons, text is the callback_data.
 */
async function waitForReply(afterUpdateId) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  let offset = afterUpdateId + 1;

  while (true) {
    let result;
    try {
      result = await post('getUpdates', { offset, limit: 5, timeout: 60 });
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    for (const update of result?.result || []) {
      offset = update.update_id + 1;

      // Button press (callback query)
      if (update.callback_query) {
        const fromChat = String(update.callback_query?.message?.chat?.id) === String(chatId);
        if (fromChat) {
          // Dismiss the loading spinner on the button
          await post('answerCallbackQuery', { callback_query_id: update.callback_query.id });
          return { text: update.callback_query.data, lastUpdateId: update.update_id };
        }
      }

      // Regular text message
      const text = update.message?.text?.trim();
      const fromChat = String(update.message?.chat?.id) === String(chatId);
      if (fromChat && text) return { text, lastUpdateId: update.update_id };
    }
  }
}

/** Drain all pending Telegram updates (messages + callbacks) and return the latest update_id. */
async function drainUpdates() {
  let lastId = 0;
  try {
    const result = await post('getUpdates', { limit: 100, timeout: 0 });
    for (const u of result?.result || []) lastId = Math.max(lastId, u.update_id);
    if (lastId > 0) await post('getUpdates', { offset: lastId + 1, limit: 1, timeout: 0 });
  } catch {}
  return lastId;
}

module.exports = { send, sendWithButtons, waitForReply, drainUpdates };
