const AdmZip = require('adm-zip');

const { downloadFirst } = require('./goatbotsDownload');

const DEFAULT_URLS = ['https://www.goatbots.com/download/prices/card-definitions.zip', 'https://www.goatbots.com/download/card-definitions.zip'];

/**
 * GoatBots' card definitions: MTGO catalog ID → { name, cardset, rarity, foil }.
 * Stored in the `cards` collection so the website can search every printing on
 * MTGO (not just the ones you own) when adding watch-list items, targets and swaps.
 */
async function downloadCardDefinitions(urls = [process.env.GOATBOTS_CARDS_URL, ...DEFAULT_URLS]) {
  return parseCardZip(await downloadFirst([].concat(urls), 'Card definitions'));
}

function parseCardZip(buf) {
  const zip = new AdmZip(buf);
  const entry = zip.getEntries().find((e) => !e.isDirectory && /\.(txt|json)$/i.test(e.entryName));
  if (!entry) throw new Error('Card definitions zip contained no .txt/.json file');
  return normaliseCards(JSON.parse(entry.getData().toString('utf8')));
}

function normaliseCards(json) {
  const out = [];
  for (const [id, v] of Object.entries(json)) {
    if (!v || typeof v !== 'object' || !v.name) continue;
    out.push({
      _id: String(id),
      name: String(v.name),
      set: String(v.cardset ?? v.set ?? '').toUpperCase(),
      rarity: String(v.rarity ?? ''),
      foil: v.foil === true || v.foil === 1 || v.foil === '1' || v.foil === 'true',
    });
  }
  if (!out.length) throw new Error('Card definitions parsed but no cards found');
  return out;
}

async function storeCards(db, cards) {
  const coll = db.collection('cards');
  await coll.createIndex({ name: 1 });
  await coll.createIndex({ nameLower: 1 });
  const now = new Date();
  for (let i = 0; i < cards.length; i += 5000) {
    // firstSeen: when GoatBots first listed this printing (only set when it's inserted), so
    // brand-new printings can be told apart. Cards stored before this field existed have none.
    const ops = cards.slice(i, i + 5000).map((c) => {
      const { _id, ...fields } = c;
      return {
        updateOne: {
          filter: { _id },
          update: { $set: { ...fields, nameLower: c.name.toLowerCase() }, $setOnInsert: { firstSeen: now } },
          upsert: true,
        },
      };
    });
    await coll.bulkWrite(ops, { ordered: false });
  }
  // firstSyncAt: the earliest sync that stored cards; printings first seen then were already
  // on MTGO before tracking started, not new.
  await db.collection('meta').updateOne(
    { _id: 'cardSync' },
    { $set: { updatedAt: now, count: cards.length }, $min: { firstSyncAt: now } },
    { upsert: true }
  );
  return cards.length;
}

module.exports = { downloadCardDefinitions, parseCardZip, normaliseCards, storeCards };
