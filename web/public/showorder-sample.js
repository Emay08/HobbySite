/*
 * Simulated studio data for trying the Show Order tool before the real lists exist.
 * Same shape as the three CSVs: dancers, enrollments (class rosters) and dances.
 * Seeded, so the same seed always gives the same studio.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ShowSample = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function rng32(seed) {
    let a = seed >>> 0 || 1;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const FIRST = ('Ava Mia Emma Olivia Chloe Lily Zoe Nora Ella Leah Maya Ruby Isla Hazel Aria Clara Ivy Sadie Jade Piper Quinn Rosie Tessa Wren Alice Bella Cora Daisy Eden Fiona Gemma Hannah Iris June Kate Lola Mila Nina Opal Paige Rhea Sofia Talia Uma Vera Willa Yara Zara Abby Brooke Callie Dana Elise Faith Grace Holly Ingrid Jenna Kira Luna Molly Nadia Phoebe Reese Sienna Tara Violet Lucas Noah Eli Owen Leo Max Theo Sam Finn Jack Ben Kai').split(' ');
  const LAST = ('Anders Baker Chen Dubois Ellis Fraser Gill Hughes Ibarra Jensen Kaur Lam Moreau Nakamura Olsen Patel Quinn Reyes Singh Tremblay Usman Vance Wong Young Zhou Barnes Clarke Dhillon Evans Fong Grant Hart Ito Joshi Klein Lopez Mehta Novak Ortiz Park Ross Sato Tan Varga Walsh').split(' ');
  const TITLES = ('Paper Boats|Lanterns|Small Hours|Glasswing|Saltwater|Northern Lights|Undertow|Brightside|Clockwork|Wildflowers|Static|Gold Rush|Daydreamer|Riverstones|Neon Rain|Featherweight|Open Road|Satellites|Ember|Tidepools|Moonlit|Copper Skies|Velvet|Echoes|Kite Season|Firefly|Hummingbird|Cityscape|Afterglow|Snowglobe|Rocket Ship|Puddle Jump|Honeybee|Parade|Lemonade|Marbles|Pinwheel|Raincoats|Teacups|Bubblegum|Crossroads|Midnight Train|Starling|Prism|Driftwood|Haywire|Overture|Fault Lines|Wavelength|Silhouette|Heartbeat|Arcade|Bloom|Thunder|Tightrope|Sundial|Afterparty|Mosaic').split('|');

  // style -> chance the costume is hair-up, chance it's "either"
  const HAIR = { Ballet: [0.9, 0.05], Pointe: [1, 0], Lyrical: [0.75, 0.05], Contemporary: [0.6, 0.1], Jazz: [0.45, 0.1], Tap: [0.4, 0.15], 'Hip Hop': [0.1, 0.1], 'Musical Theatre': [0.45, 0.15], Acro: [0.75, 0.05], 'Creative Movement': [0.3, 0.4], 'Small Group': [0.5, 0.1] };

  // [level, minAge, maxAge, styles]
  const LEVELS = [
    ['Tiny', 3, 5, ['Creative Movement', 'Ballet', 'Tap', 'Hip Hop']],
    ['Mini', 6, 8, ['Ballet', 'Jazz', 'Tap', 'Hip Hop', 'Acro', 'Lyrical']],
    ['Junior', 9, 11, ['Ballet', 'Jazz', 'Tap', 'Hip Hop', 'Lyrical', 'Acro', 'Musical Theatre']],
    ['Inter', 12, 14, ['Ballet', 'Jazz', 'Tap', 'Hip Hop', 'Lyrical', 'Contemporary', 'Acro', 'Musical Theatre']],
    ['Senior', 15, 18, ['Ballet', 'Jazz', 'Tap', 'Hip Hop', 'Lyrical', 'Contemporary', 'Musical Theatre']],
  ];

  /**
   * opts: { seed, dancers (≈200), classes (≈40) }
   * Returns { dancers: [{name, age, family}], enrollments: [{class, dancer}], dances: [{name, classes, hair, minutes, position}] }
   */
  function generate(opts) {
    opts = opts || {};
    const rnd = rng32(opts.seed || 1);
    const nDancers = Math.max(30, Math.min(600, opts.dancers || 200));
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    const between = (a, b) => a + Math.floor(rnd() * (b - a + 1));
    const shuffle = (arr) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    };

    // ---- dancers: ages spread 3–18, fewer at the extremes; about a quarter have siblings
    const ageWeights = { 3: 4, 4: 8, 5: 10, 6: 11, 7: 11, 8: 11, 9: 11, 10: 10, 11: 10, 12: 9, 13: 9, 14: 8, 15: 7, 16: 6, 17: 5, 18: 3 };
    const ageBag = [];
    for (const [a, w] of Object.entries(ageWeights)) for (let k = 0; k < w; k++) ageBag.push(Number(a));
    const dancers = [];
    const usedNames = new Set();
    const makeName = (last) => {
      for (let tries = 0; tries < 50; tries++) {
        const nm = `${pick(FIRST)} ${last || pick(LAST)}`;
        if (!usedNames.has(nm)) {
          usedNames.add(nm);
          return nm;
        }
      }
      const nm = `${pick(FIRST)} ${last || pick(LAST)} ${dancers.length}`;
      usedNames.add(nm);
      return nm;
    };
    let famNo = 0;
    const usedFams = new Set();
    while (dancers.length < nDancers) {
      const left = nDancers - dancers.length;
      if (left >= 2 && rnd() < 0.14) {
        // a family of 2 (sometimes 3) siblings, a few years apart
        const last = pick(LAST);
        famNo++;
        const fam = usedFams.has(last) ? `${last} family (${famNo})` : `${last} family`;
        usedFams.add(last);
        const size = left >= 3 && rnd() < 0.2 ? 3 : 2;
        let age = between(3, 13);
        for (let k = 0; k < size; k++) {
          dancers.push({ name: makeName(last), age: Math.min(18, age), family: fam });
          age += between(2, 4);
        }
      } else {
        dancers.push({ name: makeName(), age: pick(ageBag), family: '' });
      }
    }

    // ---- classes: one per level × style, plus specials
    const classes = []; // { name, style, lo, hi, cap, kind }
    for (const [lvl, lo, hi, styles] of LEVELS) for (const st of styles) classes.push({ name: `${lvl} ${st}`, style: st, lo, hi, cap: 18, kind: 'regular' });
    classes.push({ name: 'Pointe', style: 'Pointe', lo: 12, hi: 18, cap: 12, kind: 'special' });
    classes.push({ name: 'Boys Hip Hop', style: 'Hip Hop', lo: 7, hi: 14, cap: 10, kind: 'special' });
    classes.push({ name: 'Junior Company', style: 'Jazz', lo: 10, hi: 13, cap: 14, kind: 'company' });
    classes.push({ name: 'Company', style: 'Contemporary', lo: 14, hi: 18, cap: 16, kind: 'company' });
    classes.push({ name: 'Junior Trio', style: 'Small Group', lo: 9, hi: 12, cap: 3, kind: 'small' });
    classes.push({ name: 'Teen Quartet', style: 'Small Group', lo: 13, hi: 16, cap: 4, kind: 'small' });
    classes.push({ name: 'Senior Duet', style: 'Small Group', lo: 16, hi: 18, cap: 3, kind: 'small' });
    classes.push({ name: 'Senior Small Group', style: 'Small Group', lo: 15, hi: 18, cap: 6, kind: 'small' });
    const want = opts.classes || 40;
    while (classes.length > want) classes.splice(classes.findIndex((c) => c.kind === 'regular' && c.style === 'Acro'), 1);

    const rosters = classes.map(() => []);
    const boys = new Set(['Lucas', 'Noah', 'Eli', 'Owen', 'Leo', 'Max', 'Theo', 'Sam', 'Finn', 'Jack', 'Ben', 'Kai']);
    const isBoy = (d) => boys.has(d.name.split(' ')[0]);

    // how many classes each dancer takes: little ones 1–2, teens up to 6
    const order = shuffle(dancers.map((d, i) => i));
    for (const i of order) {
      const d = dancers[i];
      const max = d.age <= 5 ? 2 : d.age <= 8 ? 3 : d.age <= 11 ? 4 : 5;
      let want = 1;
      while (want < max && rnd() < (d.age <= 5 ? 0.35 : 0.55)) want++;
      const options = shuffle(
        classes
          .map((c, ci) => ({ c, ci }))
          .filter(({ c }) => d.age >= c.lo && d.age <= c.hi && c.kind === 'regular' && (c.name.indexOf('Boys') < 0 || isBoy(d)))
      );
      let got = 0;
      for (const { ci } of options) {
        if (got >= want) break;
        if (rosters[ci].length >= classes[ci].cap) continue;
        rosters[ci].push(i);
        got++;
      }
    }
    // specials, company and small groups draw from dancers already busy at that age
    classes.forEach((c, ci) => {
      if (c.kind === 'regular') return;
      const pool = shuffle(
        dancers
          .map((d, i) => i)
          .filter((i) => dancers[i].age >= c.lo && dancers[i].age <= c.hi && (c.name !== 'Boys Hip Hop' || isBoy(dancers[i])))
      );
      const target = c.kind === 'small' ? c.cap : between(Math.min(6, c.cap), c.cap);
      for (const i of pool) {
        if (rosters[ci].length >= target) break;
        rosters[ci].push(i);
      }
    });
    // classes need at least 3 dancers
    classes.forEach((c, ci) => {
      if (rosters[ci].length >= 3) return;
      const pool = shuffle(dancers.map((d, i) => i).filter((i) => dancers[i].age >= c.lo && dancers[i].age <= c.hi && !rosters[ci].includes(i)));
      while (rosters[ci].length < 3 && pool.length) rosters[ci].push(pool.pop());
    });
    // anyone left without a class joins one at their age
    const enrolled = new Set(rosters.flat());
    dancers.forEach((d, i) => {
      if (enrolled.has(i)) return;
      const ci = classes.findIndex((c, k) => c.kind === 'regular' && d.age >= c.lo && d.age <= c.hi && rosters[k].length < 20 && (c.name.indexOf('Boys') < 0 || isBoy(d)));
      if (ci >= 0) rosters[ci].push(i);
    });

    const keep = classes.map((c, ci) => rosters[ci].length >= 3);
    const enrollments = [];
    classes.forEach((c, ci) => {
      if (!keep[ci]) return;
      for (const i of rosters[ci]) enrollments.push({ class: c.name, dancer: dancers[i].name });
    });

    // ---- dances: one per class, a second for some bigger older classes; Company opens each night
    const titles = shuffle(TITLES.slice());
    let t = 0;
    const title = () => titles[t++ % titles.length] + (t > titles.length ? ` ${Math.ceil(t / titles.length)}` : '');
    const hairFor = (style) => {
      const [up, either] = HAIR[style] || [0.5, 0.1];
      const r = rnd();
      return r < either ? '' : r < either + up ? 'up' : 'down';
    };
    const minutes = () => [2.5, 3, 3, 3, 3.5, 3.5, 4][Math.floor(rnd() * 7)];
    const dances = [];
    classes.forEach((c, ci) => {
      if (!keep[ci]) return;
      const count = c.name === 'Company' ? 2 : c.kind === 'company' ? 2 : c.lo >= 12 && rnd() < 0.18 ? 2 : 1;
      for (let k = 0; k < count; k++) {
        dances.push({
          name: `${c.name} – ${title()}`,
          classes: c.name,
          hair: c.lo <= 5 ? (rnd() < 0.5 ? 'down' : '') : hairFor(c.style),
          minutes: c.lo <= 5 ? 2.5 : minutes(),
          position: c.name === 'Company' ? 'first' : '',
        });
      }
    });
    // the opening number is quick to get into: hair up so nobody's stuck afterwards
    for (const d of dances) if (d.position === 'first') d.hair = 'up';

    return {
      dancers: dancers.map((d) => ({ name: d.name, age: d.age, family: d.family })),
      enrollments,
      dances: dances.map((d) => ({ name: d.name, classes: d.classes, hair: d.hair, minutes: d.minutes, night: '', act: '', position: d.position })),
    };
  }

  return { generate };
});
