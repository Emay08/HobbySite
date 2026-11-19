#!/usr/bin/env node
require('./env');
const telegram = require('../src/lib/telegram');

(async () => {
  if (!telegram.isConfigured()) {
    console.error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in local.settings.json first.');
    process.exit(1);
  }
  await telegram.sendMessage('✅ <b>MTGO monitor</b> can reach you. This is a test message.');
  console.log('Sent. Check your phone.');
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
