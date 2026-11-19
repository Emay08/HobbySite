/**
 * Parser for https://www.mtgo.com/news/mtgo-treasure-chest-info
 *
 * Works on any DOM Document (linkedom in Node, DOMParser in a browser) and has no
 * dependencies, so the exact same code can be checked against the live page.
 *
 * Page structure (Nov 2026):
 *   <p>Last Updated: 11/9/2026 1 p.m. PT<br>Effective Date: …</p>
 *   <p>Next Update: December 9, 10 a.m.</p>
 *   <h1 class="accordion">TREASURE CHEST CONTENTS - November 10</h1>  <table>…slot distribution…</table>
 *   <h1 class="accordion">VARIABLE PLAY POINTS</h1>                     <table>…</table>
 *   <h1 class="accordion">CURATED CARD LISTS - November 10</h1>
 *     <h2>CURATED SLOT</h2>  <p>Total RDR in this list – 28</p>  <table>Card Name|Set|Treatment|Slots</table>
 *     <h2>TC-ONLY SLOT</h2> …                                          (slot tables come and go)
 *   <h1 class="accordion">CHANGELIST - November 10</h1>                 <table>Card Name|Set|Treatment|Slots|Change</table>
 *
 * "Slots" is the card's relative drop rate (RDR) in that table. In the CHANGELIST,
 * "Slots" is the new total and "Change" the difference from before (removed cards show 0 / -N).
 */

const clean = (s) => String(s == null ? '' : s).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

function cellTexts(tr) {
  const out = [];
  for (const c of Array.from(tr.children || [])) {
    if (c.tagName === 'TD' || c.tagName === 'TH') out.push(clean(c.textContent));
  }
  return out;
}

function toInt(s) {
  const n = parseInt(String(s).replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function parseTreasureChest(document) {
  const root = document.querySelector('article.basic-article') || document.querySelector('article') || document.body;
  const result = {
    lastUpdatedText: null,
    effectiveText: null,
    nextUpdateText: null,
    sectionTitles: [],
    slots: [], // [{ name, rdrText, cards: [{ name, set, treatment, slots }] }]
    changelist: null, // { title, rows: [{ name, set, treatment, slots, change }] }
    otherTables: [], // [{ title, rows: [[cells]] }]
  };

  let h1 = null;
  let h2 = null;
  let rdrText = null;

  for (const el of Array.from(root.querySelectorAll('h1, h2, h3, p, table'))) {
    const tag = el.tagName;
    if (tag !== 'TABLE' && el.closest && el.closest('table')) continue;

    if (tag === 'H1') {
      const t = clean(el.textContent);
      if (/treasure chest information/i.test(t)) continue; // page title
      h1 = t;
      h2 = null;
      rdrText = null;
      result.sectionTitles.push(t);
      continue;
    }
    if (tag === 'H2' || tag === 'H3') {
      h2 = clean(el.textContent);
      rdrText = null;
      continue;
    }
    if (tag === 'P') {
      const t = clean(el.textContent);
      let m;
      if ((m = t.match(/Last Updated:\s*(.+?)(?=\s*Effective Date:|$)/i))) result.lastUpdatedText = clean(m[1]);
      if ((m = t.match(/Effective Date:\s*(.+)$/i))) result.effectiveText = clean(m[1]);
      if ((m = t.match(/Next Update:\s*(.+)$/i))) result.nextUpdateText = clean(m[1]);
      if (/Total RDR/i.test(t)) rdrText = t;
      continue;
    }

    // TABLE
    const rows = Array.from(el.querySelectorAll('tr')).map(cellTexts).filter((r) => r.length);
    if (!rows.length) continue;
    const header = rows[0].map((c) => c.toLowerCase());
    const isCardTable = header[0] === 'card name';
    if (!isCardTable) {
      result.otherTables.push({ title: h2 || h1 || '', rows });
      continue;
    }
    const col = (name) => header.findIndex((h) => h === name);
    const iName = 0;
    const iSet = col('set');
    const iTreat = col('treatment');
    const iSlots = col('slots');
    const iChange = header.findIndex((h) => h.startsWith('change'));
    const parsed = rows
      .slice(1)
      .filter((r) => clean(r[iName]))
      .map((r) => {
        const card = {
          name: clean(r[iName]),
          set: iSet >= 0 ? clean(r[iSet]) : '',
          treatment: iTreat >= 0 ? clean(r[iTreat]) : '',
          slots: iSlots >= 0 ? toInt(r[iSlots]) : null,
        };
        if (iChange >= 0) card.change = toInt(r[iChange]);
        return card;
      });

    if (iChange >= 0 || /changelist/i.test(h1 || '')) {
      result.changelist = { title: h1 || 'CHANGELIST', rows: parsed };
    } else {
      result.slots.push({ name: h2 || h1 || 'SLOT', rdrText, cards: parsed });
    }
  }
  return result;
}

/** Stable identity of one card version. Ignores case, accents and quote styles (Võx = Vox). */
function keyPart(s) {
  return clean(s)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[‘’`´]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase();
}
function cardKey(c) {
  return [c.name, c.set, c.treatment].map(keyPart).join('|');
}

/** Total RDR per card version across all slot tables. */
function slotTotals(parsed) {
  const totals = new Map();
  for (const slot of parsed.slots || []) {
    for (const c of slot.cards) {
      const k = cardKey(c);
      const prev = totals.get(k);
      if (prev) prev.total += c.slots || 0;
      else totals.set(k, { name: c.name, set: c.set, treatment: c.treatment, total: c.slots || 0 });
    }
  }
  return totals;
}

/** Changes in total RDR between two slot snapshots. */
function slotDelta(before, after) {
  const keys = new Set([...before.keys(), ...after.keys()]);
  const out = [];
  for (const k of keys) {
    const b = before.get(k);
    const a = after.get(k);
    const from = b ? b.total : 0;
    const to = a ? a.total : 0;
    if (from !== to) {
      const ref = a || b;
      out.push({ key: k, name: ref.name, set: ref.set, treatment: ref.treatment, from, to, change: to - from });
    }
  }
  return out.sort((x, y) => x.name.localeCompare(y.name));
}

/**
 * Checks the CHANGELIST against the slot tables.
 *   expected: slotDelta(baseline, current) – may be null when no baseline exists
 *             (then only the "Slots" column can be checked).
 * Returns lists of problems; all empty = consistent.
 */
function verifyChangelist(changelist, currentTotals, expected) {
  const rows = (changelist && changelist.rows) || [];
  const byKey = new Map(rows.map((r) => [cardKey(r), r]));
  const problems = { missing: [], wrongChange: [], unexpected: [], wrongSlots: [] };

  for (const r of rows) {
    const actual = currentTotals.get(cardKey(r));
    const now = actual ? actual.total : 0;
    if (r.slots !== null && r.slots !== now) problems.wrongSlots.push({ ...r, actual: now });
  }
  if (expected) {
    const expByKey = new Map(expected.map((d) => [d.key, d]));
    for (const d of expected) {
      const r = byKey.get(d.key);
      if (!r) problems.missing.push(d);
      else if (r.change !== null && r.change !== d.change) problems.wrongChange.push({ ...d, listed: r.change });
    }
    for (const r of rows) {
      if (!expByKey.has(cardKey(r))) problems.unexpected.push(r);
    }
  }
  problems.ok = !problems.missing.length && !problems.wrongChange.length && !problems.unexpected.length && !problems.wrongSlots.length;
  return problems;
}

if (typeof module !== 'undefined') {
  module.exports = { parseTreasureChest, cardKey, slotTotals, slotDelta, verifyChangelist, clean };
}
