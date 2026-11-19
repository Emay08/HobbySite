/**
 * GoatBots trade history import (the CSV from your GoatBots account; it covers your
 * last 1,000 trades). One row per item per trade:
 *   timestamp, time_cet, bot, get_value, give_value, credits_before, credits_after,
 *   method (get = you received it, give = you handed it over), itemID (MTGO ID),
 *   name, cardset, rarity, foil (0/1), quantity, price (tix each)
 *
 * Every trade and every item gets a deterministic id built from the timestamp, bot,
 * method and MTGO ID, and is only inserted if that id isn't stored yet, so uploading
 * overlapping downloads any number of times never creates duplicates.
 */
const { parse } = require('csv-parse/sync');
const { CsvError } = require('./csv');

const REQUIRED = ['timestamp', 'bot', 'method', 'itemid', 'name', 'quantity', 'price'];
const TZ = process.env.DISPLAY_TIMEZONE || 'America/Vancouver';
const EVENT_TICKET_ID = '1';

const localDate = (d) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

function parseGoatbotsHistory(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
  const header = text.replace(/^\uFEFF/, '').split(/\r?\n|\r/, 1)[0].toLowerCase().split(',').map((h) => h.replace(/"/g, '').trim());
  const missingCols = REQUIRED.filter((k) => !header.includes(k));
  if (missingCols.length) {
    throw new CsvError(
      /card name/.test(header.join(','))
        ? 'This is a collection export, not a trade history — upload it on the Update page.'
        : `This doesn't look like a GoatBots trade history (missing: ${missingCols.join(', ')}).`
    );
  }
  let rows;
  try {
    rows = parse(text, { columns: (h) => h.map((c) => c.replace(/^﻿/, '').trim().toLowerCase()), skip_empty_lines: true, trim: true, bom: true, relax_column_count: true });
  } catch (err) {
    throw new CsvError(`Couldn't read the CSV (line ${err.lines || '?'}): ${err.message.split(':')[0]}`);
  }
  if (!rows.length) throw new CsvError('The file has no trades in it.');
  const missing = REQUIRED.filter((k) => !(k in rows[0]));
  if (missing.length) {
    throw new CsvError(`This doesn't look like a GoatBots trade history (missing: ${missing.join(', ')}).`);
  }

  const trades = new Map();
  const items = [];
  rows.forEach((r, i) => {
    const ts = parseInt(r.timestamp, 10);
    const qty = parseInt(r.quantity, 10);
    if (!Number.isFinite(ts) || !Number.isFinite(qty) || !r.itemid || !['get', 'give'].includes(r.method)) {
      throw new CsvError(`Row ${i + 2} isn't a valid trade line.`);
    }
    const tradeId = `gb|${ts}|${r.bot}`;
    const at = new Date(ts * 1000);
    if (!trades.has(tradeId)) {
      trades.set(tradeId, {
        _id: tradeId,
        source: 'goatbots',
        at,
        date: localDate(at),
        bot: r.bot,
        getValue: num(r.get_value),
        giveValue: num(r.give_value),
        creditsBefore: num(r.credits_before),
        creditsAfter: num(r.credits_after),
        items: [],
      });
    }
    const item = {
      method: r.method,
      mtgoId: String(r.itemid),
      name: r.name,
      set: (r.cardset || '').toUpperCase(),
      rarity: r.rarity || '',
      foil: r.foil === '1' || /^true$/i.test(r.foil || ''),
      qty,
      price: num(r.price),
    };
    trades.get(tradeId).items.push(item);
    items.push({ tradeId, at, bot: r.bot, ...item });
  });
  return { trades: [...trades.values()], items, rowCount: rows.length };
}

async function importGoatbotsHistory(db, parsed, { filename = '' } = {}) {
  const tradesColl = db.collection('gb_trades');
  const itemsColl = db.collection('trades'); // the per-card trade log shown on card pages

  const tradeOps = parsed.trades.map((t) => ({
    updateOne: { filter: { _id: t._id }, update: { $setOnInsert: { ...t, importedAt: new Date() } }, upsert: true },
  }));
  const tradeRes = tradeOps.length ? await tradesColl.bulkWrite(tradeOps, { ordered: false }) : { upsertedCount: 0 };

  // Card-level entries (Event Tickets are the payment side, not a card trade)
  const itemOps = parsed.items
    .filter((i) => i.mtgoId !== EVENT_TICKET_ID)
    .map((i) => {
      const doc = {
        name: i.name,
        nameLower: i.name.toLowerCase(),
        mtgoId: i.mtgoId,
        set: i.set,
        foil: i.foil,
        direction: i.method === 'get' ? 'buy' : 'sell',
        qty: i.qty,
        price: i.price,
        counterparty: i.bot,
        note: '',
        date: localDate(i.at),
        at: i.at,
        source: 'goatbots',
        tradeId: i.tradeId,
        createdAt: new Date(),
      };
      return { updateOne: { filter: { _id: `${i.tradeId}|${i.method}|${i.mtgoId}` }, update: { $setOnInsert: doc }, upsert: true } };
    });
  const itemRes = itemOps.length ? await itemsColl.bulkWrite(itemOps, { ordered: false }) : { upsertedCount: 0 };

  await Promise.all([
    tradesColl.createIndex({ at: -1 }),
    tradesColl.createIndex({ 'items.name': 1 }),
    itemsColl.createIndex({ nameLower: 1, date: -1 }),
  ]);

  const dates = parsed.trades.map((t) => t.at.getTime());
  const summary = {
    importedAt: new Date(),
    filename,
    rows: parsed.rowCount,
    tradesInFile: parsed.trades.length,
    newTrades: tradeRes.upsertedCount,
    duplicateTrades: parsed.trades.length - tradeRes.upsertedCount,
    newItems: itemRes.upsertedCount,
    from: dates.length ? new Date(Math.min(...dates)) : null,
    to: dates.length ? new Date(Math.max(...dates)) : null,
  };
  await db.collection('trade_imports').insertOne(summary);
  return summary;
}

module.exports = { parseGoatbotsHistory, importGoatbotsHistory };
