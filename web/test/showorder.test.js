const test = require('node:test');
const assert = require('node:assert');
const S = require('../public/showorder-solver.js');
const G = require('../public/showorder-sample.js');

// A tiny studio where every rule can be checked by hand.
function tiny() {
  return {
    dancers: [
      { name: 'Ann', age: 12, family: 'Lee' },
      { name: 'Bea', age: 5, family: 'Lee' },
      { name: 'Cal', age: 15, family: '' },
      { name: 'Dot', age: 9, family: '' },
    ],
    enrollments: [
      { class: 'Teen Jazz', dancer: 'Ann' },
      { class: 'Teen Jazz', dancer: 'Cal' },
      { class: 'Teen Ballet', dancer: 'Ann' },
      { class: 'Teen Ballet', dancer: 'Cal' },
      { class: 'Tiny Tap', dancer: 'Bea' },
      { class: 'Junior Hip Hop', dancer: 'Dot' },
      { class: 'Company', dancer: 'Cal' },
    ],
    dances: [
      { name: 'Jazz', classes: 'Teen Jazz', hair: 'down' },
      { name: 'Ballet', classes: 'Teen Ballet', hair: 'Bun' },
      { name: 'Tap', classes: 'Tiny Tap', hair: '' },
      { name: 'HipHop', classes: 'Junior Hip Hop', hair: 'down' },
      { name: 'Opener', classes: 'Company', hair: 'up', position: 'first' },
      { name: 'Extra', classes: 'Junior Hip Hop', hair: 'up', minutes: 4 },
    ],
  };
}
const idx = (P, name) => P.dances.findIndex((d) => d.name === name);
const sched = (P, nights) => ({ nights: nights.map(([names, split]) => ({ seq: names.map((n) => idx(P, n)), split })) });

test('build: reads hair, pins, rosters and same-night groups', () => {
  const { problem: P, issues } = S.build(tiny(), { nights: 1 });
  assert.deepStrictEqual(issues, []);
  assert.strictEqual(P.n, 6);
  assert.strictEqual(P.dances[idx(P, 'Ballet')].hair, 'up');
  assert.strictEqual(P.dances[idx(P, 'Tap')].hair, '');
  assert.deepStrictEqual(P.dances[idx(P, 'Opener')].pin, { position: 'first' });
  assert.strictEqual(P.dances[idx(P, 'Tap')].young, 1);
  assert.strictEqual(P.dances[idx(P, 'Extra')].minutes, 4);
  assert.strictEqual(P.conflict[idx(P, 'Jazz') * P.n + idx(P, 'Ballet')], 2);
  // Ann (2 dances), Dot (2 dances) — Cal has 3; the Lee family has 3 dances
  assert.deepStrictEqual(P.groups.map((g) => g.kind + ':' + g.who).sort(), ['dancer:Ann', 'dancer:Dot', 'family:Lee']);
});

test('build: reports unknown classes, duplicate dances and bad values', () => {
  const raw = tiny();
  raw.dances.push({ name: 'Ghost', classes: 'Nope', hair: 'sideways' }, { name: 'Jazz', classes: 'Teen Jazz' });
  raw.enrollments.push({ class: 'Teen Jazz', dancer: 'Zed' });
  const { issues } = S.build(raw, { nights: 1 });
  const text = issues.map((i) => i.level + ': ' + i.msg).join('\n');
  assert.match(text, /error: Dance "Ghost": class "Nope"/);
  assert.match(text, /hair "sideways"/);
  assert.match(text, /error: Two dances are called "Jazz"/);
  assert.match(text, /not in the dancer list.*Zed/);
});

test('evaluate: gap, hair, young and pin rules', () => {
  const { problem: P } = S.build(tiny(), { nights: 1, minGap: 2 });
  // Opener first; Jazz (down) then Ballet (up) with Ann+Cal in both, back to back; Tap after intermission.
  const bad = S.evaluate(P, sched(P, [[['Opener', 'Jazz', 'Ballet', 'HipHop', 'Extra', 'Tap'], 3]]), true);
  assert.strictEqual(bad.parts.hardGap, 2 + 1 + 1 + 1); // Jazz→Ballet ×2, Opener→Jazz (Cal), Opener→Ballet (Cal), HipHop→Extra (Dot)
  assert.strictEqual(bad.parts.hardHair, 2 + 1); // Ann, Cal after Jazz; Dot after HipHop
  assert.strictEqual(bad.parts.hardYoung, 1);
  assert.strictEqual(bad.parts.hardPin, 0);
  assert.ok(bad.items.some((x) => x.type === 'hair' && x.dances[0] === idx(P, 'Ballet')));

  // Cal is in Opener, Ballet and Jazz: Ballet goes exactly 2 dances after Opener, Jazz after the intermission
  const good = S.evaluate(P, sched(P, [[['Opener', 'Tap', 'Extra', 'Ballet', 'HipHop', 'Jazz'], 4]]), true);
  assert.strictEqual(good.hard, 0, JSON.stringify(good.items.filter((x) => x.hard)));
  assert.strictEqual(good.parts.tight, 1); // Opener → Ballet (Cal) has exactly the minimum 2 between
});

test('evaluate: intermission resets the gap unless told otherwise', () => {
  const { problem: P } = S.build(tiny(), { nights: 1, minGap: 2 });
  const s = sched(P, [[['Opener', 'Tap', 'Ballet', 'Jazz', 'Extra', 'HipHop'], 3]]);
  // Opener→Ballet (Cal, 1 between) and Extra→HipHop (Dot, adjacent) break the gap either way;
  // Ballet | Jazz (Ann, Cal) straddle the intermission, so they only count without the reset.
  assert.strictEqual(S.evaluate(P, s).parts.hardGap, 1 + 1);
  const { problem: P2 } = S.build(tiny(), { nights: 1, minGap: 2, gapResetAtIntermission: false });
  assert.strictEqual(S.evaluate(P2, s).parts.hardGap, 1 + 1 + 2);
});

test('evaluate: same-night preferences across two nights', () => {
  const { problem: P } = S.build(tiny(), { nights: 2 });
  const together = S.evaluate(P, sched(P, [[['Opener', 'Tap', 'Ballet', 'Jazz'], 2], [['Extra', 'HipHop'], 1]]));
  assert.strictEqual(together.parts.dancerSplit, 0);
  assert.strictEqual(together.parts.familySplit, 0);
  const apart = S.evaluate(P, sched(P, [[['Opener', 'Ballet', 'Extra'], 2], [['Tap', 'HipHop', 'Jazz'], 2]]));
  assert.strictEqual(apart.parts.dancerSplit, 2); // Ann (Ballet / Jazz), Dot (Extra / HipHop)
  assert.strictEqual(apart.parts.familySplit, 1);
});

test('solver: simulated studio comes out with no firm rule broken', () => {
  const raw = G.generate({ seed: 1 });
  const { problem: P, issues } = S.build(raw, {});
  assert.deepStrictEqual(issues.filter((i) => i.level === 'error'), []);
  const res = S.solve(P, { runs: 2, iterations: 120000, seed: 7 });
  assert.ok(res.length >= 1);
  for (const r of res) {
    assert.ok(S.valid(P, r.schedule));
    assert.strictEqual(r.eval.hard, 0, JSON.stringify(r.eval.parts));
  }
  // each Company dance opens a night
  for (const nt of res[0].schedule.nights) assert.match(P.dances[nt.seq[0]].name, /^Company/);
});

test('solver: locked dances stay put when re-solving', () => {
  const { problem: P } = S.build(G.generate({ seed: 2 }), {});
  const [first] = S.solve(P, { runs: 1, iterations: 60000, seed: 3 });
  // lock three dances where they are, then re-solve from that schedule
  const locks = [first.schedule.nights[0].seq[3], first.schedule.nights[1].seq[5], first.schedule.nights[1].seq[9]];
  const where = locks.map((di) => {
    const ni = first.schedule.nights.findIndex((nt) => nt.seq.includes(di));
    const pos = first.schedule.nights[ni].seq.indexOf(di);
    return { di, ni, pos };
  });
  for (const w of where) P.dances[w.di].pin = { night: w.ni, position: w.pos + 1 };
  const [again] = S.solve(P, { runs: 1, iterations: 60000, seed: 9, start: first.schedule, gentle: true });
  assert.strictEqual(again.eval.parts.hardPin, 0);
  for (const w of where) assert.strictEqual(again.schedule.nights[w.ni].seq[w.pos], w.di);
});

test('names round trip, and new dances are slotted in', () => {
  const raw = tiny();
  const { problem: P } = S.build(raw, { nights: 2 });
  const s = sched(P, [[['Opener', 'Tap', 'Ballet'], 2], [['Jazz', 'Extra', 'HipHop'], 1]]);
  const named = S.toNames(P, s);
  assert.deepStrictEqual(S.fromNames(P, named), s);
  raw.dances.push({ name: 'Encore', classes: 'Company', hair: 'up' });
  const { problem: P2 } = S.build(raw, { nights: 2 });
  const s2 = S.fromNames(P2, named);
  assert.ok(S.valid(P2, s2));
  assert.strictEqual(s2.nights[0].seq.length + s2.nights[1].seq.length, 7);
});

test('sample data: ≈200 dancers, ≈40 classes of 3–20, same seed same studio', () => {
  const a = G.generate({ seed: 11 });
  assert.deepStrictEqual(a, G.generate({ seed: 11 }));
  assert.strictEqual(a.dancers.length, 200);
  const sizes = new Map();
  for (const e of a.enrollments) sizes.set(e.class, (sizes.get(e.class) || 0) + 1);
  assert.ok(sizes.size >= 36 && sizes.size <= 40, `classes: ${sizes.size}`);
  for (const [c, n] of sizes) assert.ok(n >= 3 && n <= 20, `${c}: ${n}`);
  assert.ok(a.dancers.some((d) => d.family));
  assert.ok(a.dances.every((d) => sizes.has(d.classes)));
});
