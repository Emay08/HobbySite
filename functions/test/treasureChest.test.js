const test = require('node:test');
const assert = require('node:assert');
const { tcHtml } = require('./fixtures/tcPage');
const { parseHtml, schedule, analyse } = require('../src/lib/treasureChest');
const { parseNextUpdate, parseNumericDate } = require('../src/lib/time');

const A = tcHtml({
  slots: {
    'CURATED SLOT': [['Mox Diamond', 'TPR', '', 1], ['Wasteland', 'TPR', '', 2]],
    'SET DEBUT SLOT': [['Borg Cube', 'TRK', 'Extended Art', 1], ['Borg Cube', 'TRK', 'Schematic', 1]],
  },
  changelist: [['Mox Diamond', 'TPR', '', 1, 1], ['Wasteland', 'TPR', '', 2, 2]],
});

test('parses the page structure (and ignores the JSON-LD copy)', () => {
  const p = parseHtml(A);
  assert.strictEqual(p.lastUpdatedText, '11/9/2026 1 p.m. PT');
  assert.strictEqual(p.nextUpdateText, 'December 9, 10 a.m.');
  assert.match(p.effectiveText, /^11\/10\/2026 10 a\.m\. PT/);
  assert.deepStrictEqual(p.slots.map((s) => [s.name, s.cards.length]), [['CURATED SLOT', 2], ['SET DEBUT SLOT', 2]]);
  assert.strictEqual(p.slots[0].cards[0].treatment, '');
  assert.strictEqual(p.slots[1].cards[1].treatment, 'Schematic');
  assert.strictEqual(p.changelist.title, 'CHANGELIST - November 10');
  assert.deepStrictEqual(p.changelist.rows[1], { name: 'Wasteland', set: 'TPR', treatment: '', slots: 2, change: 2 });
  assert.strictEqual(p.otherTables.length, 2);
});

test('rejects a page without slot tables or CHANGELIST', () => {
  assert.throws(() => parseHtml('<html><body><article class="basic-article"><p>Maintenance</p></article></body></html>'), /No slot tables/);
});

test('reads "Next Update" without a year as the next such date, Pacific time', () => {
  const ref = parseNumericDate('11/9/2026 1 p.m. PT');
  assert.strictEqual(ref.toISOString(), '2026-11-09T21:00:00.000Z');
  assert.strictEqual(parseNextUpdate('December 9, 10 a.m.', ref).toISOString(), '2026-12-09T18:00:00.000Z');
  // Across New Year, and summer time (PDT)
  assert.strictEqual(parseNextUpdate('January 13, 10 a.m.', new Date('2026-12-20T00:00:00Z')).toISOString(), '2027-01-13T18:00:00.000Z');
  assert.strictEqual(parseNextUpdate('June 2, 9:30 a.m.', new Date('2026-05-10T00:00:00Z')).toISOString(), '2026-06-02T16:30:00.000Z');
  assert.strictEqual(parseNextUpdate('TBD', ref), null);
});

test('schedule: every tick within 7 days of the update, otherwise daily', () => {
  const nextUpdate = new Date('2026-12-09T18:00:00Z');
  const lastSuccess = new Date('2026-11-25T12:00:00Z');
  assert.deepStrictEqual(
    [schedule({ nextUpdate, lastSuccess }, new Date('2026-11-25T18:00:00Z')).due, schedule({ nextUpdate, lastSuccess }, new Date('2026-11-25T18:00:00Z')).mode],
    [false, 'daily']
  );
  assert.strictEqual(schedule({ nextUpdate, lastSuccess }, new Date('2026-11-26T12:30:00Z')).due, true); // 24 h later
  const inWindow = schedule({ nextUpdate, lastSuccess: new Date('2026-12-03T00:00:00Z') }, new Date('2026-12-03T00:00:30Z'));
  assert.deepStrictEqual([inWindow.due, inWindow.mode], [true, 'watching']);
  // Update is late: keep watching for 7 days after
  assert.strictEqual(schedule({ nextUpdate, lastSuccess: new Date() }, new Date('2026-12-15T00:00:00Z')).mode, 'watching');
  assert.strictEqual(schedule({ nextUpdate, lastSuccess: new Date('2026-12-17T00:00:00Z') }, new Date('2026-12-17T01:00:00Z')).mode, 'daily');
  // Never checked → due now
  assert.strictEqual(schedule(null, new Date()).due, true);
});

test('analyse: stale CHANGELIST, then caught up, then mismatched', () => {
  const pA = parseHtml(A);
  const B = parseHtml(
    tcHtml({
      date: 'December 9',
      slots: { 'CURATED SLOT': [['Mox Diamond', 'TPR', '', 1], ['Force of Will', 'SOA', 'Japanese Mystical Archive', 1]], 'SET DEBUT SLOT': [['Borg Cube', 'TRK', 'Extended Art', 1], ['Borg Cube', 'TRK', 'Schematic', 1]] },
      changelist: [['Mox Diamond', 'TPR', '', 1, 1], ['Wasteland', 'TPR', '', 2, 2]], // not updated!
    })
  );
  const r1 = analyse(pA, pA, B);
  assert.strictEqual(r1.status, 'stale');
  assert.deepStrictEqual(r1.step.map((d) => [d.name, d.change]), [['Force of Will', 1], ['Wasteland', -2]]);
  assert.strictEqual(r1.sectionDate, 'December 9');

  const C = parseHtml(
    tcHtml({
      date: 'December 9',
      slots: { 'CURATED SLOT': [['Mox Diamond', 'TPR', '', 1], ['Force of Will', 'SOA', 'Japanese Mystical Archive', 1]], 'SET DEBUT SLOT': [['Borg Cube', 'TRK', 'Extended Art', 1], ['Borg Cube', 'TRK', 'Schematic', 1]] },
      changelist: [['Force of Will', 'SOA', 'Japanese Mystical Archive', 1, 1], ['Wasteland', 'TPR', '', 0, -2]],
    })
  );
  const r2 = analyse(B, pA, C); // baseline stays at A while the CHANGELIST is stale
  assert.strictEqual(r2.status, 'ok');
  assert.strictEqual(r2.step.length, 0);

  const D = parseHtml(
    tcHtml({
      date: 'December 9',
      slots: { 'CURATED SLOT': [['Force of Will', 'SOA', 'Japanese Mystical Archive', 1]], 'SET DEBUT SLOT': [['Borg Cube', 'TRK', 'Extended Art', 1], ['Borg Cube', 'TRK', 'Schematic', 1]] },
      changelist: [['Mox Diamond', 'TPR', '', 0, -2], ['Borg Cube', 'TRK', 'Schematic', 0, -1]],
      rdrOverride: { 'CURATED SLOT': 5 },
    })
  );
  const r3 = analyse(C, C, D);
  assert.strictEqual(r3.status, 'mismatch');
  assert.deepStrictEqual(r3.problems.wrongChange.map((d) => [d.name, d.listed, d.change]), [['Mox Diamond', -2, -1]]);
  assert.deepStrictEqual(r3.problems.unexpected.map((d) => d.name + '|' + d.treatment), ['Borg Cube|Schematic']);
  assert.deepStrictEqual(r3.problems.wrongSlots.map((d) => [d.name, d.slots, d.actual]), [['Borg Cube', 0, 1]]);
  assert.deepStrictEqual(r3.rdrProblems, [{ slot: 'CURATED SLOT', stated: 5, sum: 1 }]);
});
