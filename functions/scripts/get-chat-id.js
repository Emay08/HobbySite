#!/usr/bin/env node
// After creating your bot with @BotFather, open it in Telegram and send it any message.
// Then run this to print the chat id to put in TELEGRAM_CHAT_ID.
require('./env');
const { getUpdates } = require('../src/lib/telegram');

(async () => {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.error('Set TELEGRAM_BOT_TOKEN in local.settings.json first.');
    process.exit(1);
  }
  const updates = await getUpdates();
  const chats = new Map();
  for (const u of updates) {
    const chat = (u.message || u.channel_post || {}).chat;
    if (chat) chats.set(chat.id, chat.username || chat.title || chat.first_name);
  }
  if (!chats.size) {
    console.log('No messages found. Send your bot a message in Telegram, then run this again.');
    return;
  }
  for (const [id, name] of chats) console.log(`TELEGRAM_CHAT_ID=${id}   (${name})`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
