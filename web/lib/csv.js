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

/** A problem with the uploaded file that the user should see (shown as-is, HTTP 400). */
class CsvError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
    this.expose = true;
  }
}

/**
 * The MTGO client's own CSV export is not valid CSV:
 *  - after a name with an accented letter ("Márton Stromgald", "Nazgûl") the line
 *    break is dropped, so the next card continues on the same line;
 *  - quotes inside names aren't escaped: "Henzie "Toolbox" Torre".
 * So MTGO exports are read record by record with a pattern instead of a CSV parser:
 * a quoted name followed by the remaining comma-separated fields (none of which can
 * contain commas or quotes).
 */
function parseMtgoExport(text) {
  const firstBreak = text.search(/\r\n|\r|\n/);
  const headerLine = firstBreak === -1 ? text : text.slice(0, firstBreak);
  const headers = headerLine.split(',').map((h) => h.trim());
  const body = firstBreak === -1 ? '' : text.slice(firstBreak);
  const rest = headers.length - 2; // fields after name and quantity
  // name: "quoted (may contain unescaped quotes)" or unquoted; then quantity and the other fields
  const re = new RegExp(
    '(?:"(.*?)"|([^",\\r\\n][^,\\r\\n]*)),(\\d+)' + (rest > 0 ? ',' + Array(rest).fill('([^,\\r\\n"]*)').join(',') : '') + '[ \\t]*(?=[\\r\\n"]|$)',
    'ys'
  );
  const records = [];
  let pos = 0;
  while (pos < body.length) {
    const ws = /[\s]*/y;
    ws.lastIndex = pos;
    ws.exec(body);
    pos = ws.lastIndex;
    if (pos >= body.length) break;
    re.lastIndex = pos;
    const m = re.exec(body);
    if (!m) {
      const line = (body.slice(0, pos).match(/\r\n|\r|\n/g) || []).length + 1;
      throw new CsvError(`Couldn't read the MTGO export at line ${line}: ${body.slice(pos, pos + 60).replace(/[\r\n]+/g, ' ')}…`);
    }
    const rec = {};
    headers.forEach((h, i) => {
      if (i === 0) rec[h] = m[1] !== undefined ? m[1] : m[2].trim();
      else if (i === 1) rec[h] = m[3];
      else rec[h] = (m[i + 2] || '').trim();
    });
    records.push(rec);
    pos = re.lastIndex;
  }
  return records;
}

function isMtgoExport(text) {
  return /^\s*Card Name,Quantity,ID #,Rarity,Set,Collector #,Premium/i.test(text);
}

function parseCollectionCsv(buffer) {
  const text = (Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer)).replace(/^\uFEFF/, '');
  let records;
  if (isMtgoExport(text)) {
    records = parseMtgoExport(text);
  } else {
    try {
      records = parse(text, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
        relax_quotes: true,
        bom: true,
      });
    } catch (err) {
      throw new CsvError(`Couldn't read the CSV (line ${err.lines || '?'}): ${err.message.split(':')[0]}`);
    }
  }

  if (records.length === 0) {
    throw new CsvError('The CSV file has no rows.');
  }

  const map = mapHeaders(Object.keys(records[0]));
  if (!map.name || !map.qty) {
    throw new CsvError(
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

module.exports = { parseCollectionCsv, parseMtgoExport, CsvError };
