const test = require('node:test');
const assert = require('node:assert');
const { variantLabel, mapResults, versionInfo } = require('../lib/scryfall');

const lichA = { mtgo_id: 150001, mtgo_foil_id: 150002, collector_number: '120', border_color: 'black', frame: '2015', image_uris: { small: 's1', normal: 'n1', large: 'l1' } };
const lichB = { mtgo_id: 150003, mtgo_foil_id: 150004, collector_number: '365', border_color: 'borderless', frame: '2015', frame_effects: ['showcase'], image_uris: { small: 's2', normal: 'n2', large: 'l2' } };

test('version labels tell look-alike versions apart', () => {
  assert.equal(variantLabel(lichA), 'Regular');
  assert.equal(variantLabel(lichB), 'Borderless · Showcase');
  assert.equal(variantLabel({ frame: '1997', frame_effects: ['extendedart'] }), 'Extended art · Retro frame');
  assert.equal(variantLabel({ card_faces: [{}], promo_types: ['textured', 'boosterfun'] }), 'Textured');
});

test('results map back to regular and foil MTGO IDs', () => {
  const m = mapResults(['150002', '150003', '999'], { data: [lichA, lichB] });
  assert.equal(m.get('150002').label, 'Regular');
  assert.equal(m.get('150002').collector, '120');
  assert.equal(m.get('150003').img.small, 's2');
  assert.equal(m.has('999'), false);
});

test('lookups are cached and fail soft', async () => {
  const docs = new Map();
  const db = {
    collection: () => ({
      find: (q) => ({ toArray: async () => q._id.$in.filter((id) => docs.has(id)).map((id) => docs.get(id)) }),
      bulkWrite: async (ops) => ops.forEach((o) => docs.set(o.replaceOne.filter._id, o.replaceOne.replacement)),
    }),
  };
  let calls = 0;
  const fetchImpl = async (url, opts) => {
    calls++;
    assert.deepEqual(JSON.parse(opts.body).identifiers, [{ mtgo_id: 150002 }, { mtgo_id: 777 }]);
    return { ok: true, json: async () => ({ data: [lichA] }) };
  };
  let r = await versionInfo(db, ['150002', '777'], { fetchImpl });
  assert.equal(r.get('150002').label, 'Regular');
  r = await versionInfo(db, ['150002', '777'], { fetchImpl });
  assert.equal(calls, 1); // second time from cache, including the miss
  const down = await versionInfo(db, ['555'], { fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(down.size, 0);
});
