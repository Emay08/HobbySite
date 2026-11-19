/**
 * Minimal Telegram Bot API client.
 * Create a bot with @BotFather, send it any message from your phone, then run
 * `npm run telegram:chat-id` to discover your chat id.
 */
const API = 'https://api.telegram.org';

function isConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendMessage(html, { disablePreview = false } = {}) {
  if (!isConfigured()) {
    return { skipped: true, reason: 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set' };
  }
  // Telegram caps messages at 4096 chars
  const text = html.length > 4000 ? html.slice(0, 3990) + '…' : html;
  const res = await fetch(`${API}/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: disablePreview },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(`Telegram error ${res.status}: ${data.description || 'unknown'}`);
  }
  return data.result;
}

/**
 * Sends a message that may be longer than Telegram's limit by splitting it on line
 * breaks into several messages (never inside an HTML tag, since tags stay on one line).
 */
async function sendLong(html, opts = {}) {
  const lines = String(html).split('\n');
  const chunks = [];
  let cur = '';
  for (const line of lines) {
    const piece = line.length > 3800 ? line.slice(0, 3790) + '…' : line;
    if (cur && cur.length + piece.length + 1 > 3800) {
      chunks.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n${piece}` : piece;
  }
  if (cur) chunks.push(cur);
  const results = [];
  for (let i = 0; i < chunks.length; i++) {
    const suffix = chunks.length > 1 ? `\n<i>(${i + 1}/${chunks.length})</i>` : '';
    results.push(await sendMessage(chunks[i] + suffix, { disablePreview: true, ...opts }));
  }
  return results;
}

async function getUpdates() {
  const res = await fetch(`${API}/bot${process.env.TELEGRAM_BOT_TOKEN}/getUpdates`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || 'getUpdates failed');
  return data.result;
}

module.exports = { sendMessage, sendLong, getUpdates, escapeHtml, isConfigured };
