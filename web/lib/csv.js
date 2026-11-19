const { parse } = require('csv-parse/sync');

/**
 * Parses an MTGO collection CSV export.
 *
 * The MTGO client's "Export > CSV" produces:
 *   Card Name, Quantity, ID #, Rarity, Set, Collector #, Premium
 * Header matching is case-insensitive and tolerant of a few common aliases so
 * exports from other tools (Goatbots, MTGGoldfish, etc.) also work.
 */
const ALIASES = {
  name: ['card name', 'name', 'card'],
  qty: ['quantity', 'qty', 'count', 'amount'],
  mtgoId: ['id #', 'id', 'mtgo id', 'mtgoid', 'catid', 'cat id'],
  rarity: ['rarity'],
  set: ['set', 'set code', 'edition', 'cardset'],
  collectorNumber: ['collector #', 'collector number', 'number', 'collector_number'],
  foil: ['premium', 'foil', 'is foil', 'printing'],
};

function normaliseHeader(h) {
  return String(h || '').replace(/^﻿/, '').trim().toLowerCase();
}

function mapHeaders(headers) {
  const map = {};
  const norm = headers.map(normaliseHeader);
  for (const [field, aliases] of Object.entries(ALIASES)) {
    const idx = norm.findIndex((h) => aliases.includes(h));
    if (idx !== -1) map[field] = headers[idx];
  }
  return map;
}

function parseFoil(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return ['yes', 'true', '1', 'foil', 'premium', 'y'].includes(s);
}

function parseCollectionCsv(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
  const records = parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    bom: true,
  });

  if (records.length === 0) {
    throw new Error('The CSV file has no rows.');
  }

  const map = mapHeaders(Object.keys(records[0]));
  if (!map.name || !map.qty) {
    throw new Error(
      `Could not find "Card Name" and "Quantity" columns. Found: ${Object.keys(records[0]).join(', ')}`
    );
  }

  const byKey = new Map();
  const warnings = [];

  records.forEach((r, i) => {
    const name = String(r[map.name] || '').trim();
    const qty = parseInt(String(r[map.qty] || '0').replace(/[^\d-]/g, ''), 10);
    if (!name) return;
    if (!Number.isFinite(qty) || qty <= 0) {
      warnings.push(`Row ${i + 2}: skipped "${name}" (quantity "${r[map.qty]}")`);
      return;
    }
    const mtgoId = map.mtgoId ? String(r[map.mtgoId] || '').trim() : '';
    const set = map.set ? String(r[map.set] || '').trim().toUpperCase() : '';
    const foil = map.foil ? parseFoil(r[map.foil]) : false;
    const key = mtgoId || `${name}|${set}|${foil ? 'F' : 'N'}`;

    const existing = byKey.get(key);
    if (existing) {
      existing.qty += qty;
    } else {
      byKey.set(key, {
        _id: key,
        mtgoId: mtgoId || null,
        name,
        qty,
        set,
        rarity: map.rarity ? String(r[map.rarity] || '').trim() : '',
        collectorNumber: map.collectorNumber ? String(r[map.collectorNumber] || '').trim() : '',
        foil,
      });
    }
  });

  return { cards: [...byKey.values()], warnings, rowCount: records.length };
}

module.exports = { parseCollectionCsv };
