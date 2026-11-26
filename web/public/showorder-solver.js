/*
 * Dance Recital Scheduler solver — orders the dances of a multi-night recital.
 *
 * Runs in the browser (window.ShowSolver) and in Node (require) so it can be tested.
 *
 * A schedule is { nights: [ { seq: [danceIndex…], split } ] }: each night is one running
 * order, and `split` is where the intermission falls (act 1 = seq[0 … split-1]).
 *
 * Search: simulated annealing over swaps, moves, segment reversals and intermission shifts.
 * Every schedule gets one number (lower = better): firm rules cost HARD each time they
 * are broken, preferences cost their weight. Several independent runs give several
 * different schedules, ranked by that number.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ShowSolver = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const HARD = 1000;

  const DEFAULTS = {
    nights: 2,
    minGap: 2, // at least this many other dances between two of a dancer's dances (firm)
    gapResetAtIntermission: true, // the intermission counts as enough time to change
    youngAge: 7, // dancers younger than this only dance before intermission (firm)
    hairResetAtIntermission: false, // true: a hair change during intermission doesn't count as the night's one change
    dancerSameNightMax: 2, // dancers in this many dances or fewer: keep them on one night
    familySameNightMax: 4, // families whose children dance this many dances or fewer: one night
    weights: {
      dancerSplit: 10, // per dancer whose few dances are spread over two nights
      familySplit: 15, // per family spread over two nights
      tight: 1, // per dancer with exactly the minimum gap between two dances
      nightBalance: 3, // per minute of difference between the longest and shortest night
      actBalance: 1.5, // per minute of difference between act 1 and act 2 of a night
    },
    runs: 6,
    keep: 5,
    iterations: 200000,
  };

  function mergeSettings(s) {
    s = s || {};
    const out = Object.assign({}, DEFAULTS, s);
    // only known weights (older saved projects may carry ones that no longer exist)
    out.weights = {};
    for (const k of Object.keys(DEFAULTS.weights)) out.weights[k] = s.weights && s.weights[k] != null ? s.weights[k] : DEFAULTS.weights[k];
    for (const k of ['nights', 'minGap', 'youngAge', 'dancerSameNightMax', 'familySameNightMax', 'runs', 'keep', 'iterations']) {
      out[k] = Number(out[k]);
      if (!Number.isFinite(out[k])) out[k] = DEFAULTS[k];
    }
    out.nights = Math.max(1, Math.min(6, Math.round(out.nights)));
    out.minGap = Math.max(0, Math.min(10, Math.round(out.minGap)));
    for (const k of Object.keys(out.weights)) {
      out.weights[k] = Number(out.weights[k]);
      if (!Number.isFinite(out.weights[k]) || out.weights[k] < 0) out.weights[k] = DEFAULTS.weights[k];
    }
    return out;
  }

  const norm = (x) => String(x == null ? '' : x).trim().replace(/\s+/g, ' ').toLowerCase();

  function parseHair(h) {
    const x = norm(h);
    if (!x || x === 'any' || x === 'either' || x === '-' || x === 'n/a') return '';
    if (/^(up|bun|u|hair up)$/.test(x)) return 'up';
    if (/^(down|d|loose|hair down)$/.test(x)) return 'down';
    return null;
  }

  function parsePosition(p) {
    const x = norm(p);
    if (!x) return null;
    if (x === 'first' || x === 'open' || x === 'opener' || x === 'opening') return 'first';
    if (x === 'last' || x === 'close' || x === 'closer' || x === 'closing' || x === 'finale') return 'last';
    const n = parseInt(x, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }

  /**
   * Turns the three lists from the CSVs into the indexed problem the solver works on.
   *   raw.dancers     [{ id?, name, age, family? }]
   *   raw.enrollments [{ class, dancer }]
   *   raw.dances      [{ id?, name, classes: 'A; B' | [..], hair, minutes?, night?, act?, position? }]
   * Returns { problem, issues } — issues: [{ level: 'error'|'warning', msg }]
   */
  function build(raw, settings) {
    const S = mergeSettings(settings);
    const issues = [];
    const err = (msg) => issues.push({ level: 'error', msg });
    const warn = (msg) => issues.push({ level: 'warning', msg });

    const dancers = [];
    const dancerByKey = new Map();
    const addDancer = (d) => {
      const idx = dancers.length;
      dancers.push(d);
      return idx;
    };
    for (const d of raw.dancers || []) {
      const name = String(d.name || d.id || '').trim();
      if (!name) continue;
      const key = norm(d.id || d.name);
      if (dancerByKey.has(key)) {
        warn(`Dancer "${name}" is listed twice; the first row is used.`);
        continue;
      }
      let age = d.age === '' || d.age == null ? null : Number(d.age);
      if (age != null && !Number.isFinite(age)) {
        warn(`Dancer "${name}" has an age that isn't a number ("${d.age}").`);
        age = null;
      }
      const idx = addDancer({ key, name, age, family: String(d.family || '').trim() });
      dancerByKey.set(key, idx);
      if (d.id && norm(d.name) && !dancerByKey.has(norm(d.name))) dancerByKey.set(norm(d.name), idx);
    }

    const classRoster = new Map(); // norm(class) -> { name, members:Set }
    let unknownDancers = new Set();
    for (const e of raw.enrollments || []) {
      const cls = String(e.class || '').trim();
      const dk = norm(e.dancer);
      if (!cls || !dk) continue;
      let di = dancerByKey.get(dk);
      if (di == null) {
        unknownDancers.add(String(e.dancer).trim());
        di = addDancer({ key: dk, name: String(e.dancer).trim(), age: null, family: '' });
        dancerByKey.set(dk, di);
      }
      const ck = norm(cls);
      if (!classRoster.has(ck)) classRoster.set(ck, { name: cls, members: new Set() });
      classRoster.get(ck).members.add(di);
    }
    if (unknownDancers.size) {
      const list = [...unknownDancers];
      warn(`${list.length} dancer${list.length > 1 ? 's are' : ' is'} in a class but not in the dancer list (no age, so the under-${S.youngAge} rule can't be checked): ${list.slice(0, 8).join(', ')}${list.length > 8 ? '…' : ''}`);
    }
    const noAge = dancers.filter((d) => d.age == null).length - unknownDancers.size;
    if (noAge > 0) warn(`${noAge} dancer${noAge > 1 ? 's have' : ' has'} no age.`);

    const dances = [];
    const classesWithDance = new Set();
    for (const r of raw.dances || []) {
      const name = String(r.name || r.id || '').trim();
      if (!name) continue;
      const clsList = (Array.isArray(r.classes) ? r.classes : String(r.classes || '').split(/[;|]/)).map((c) => String(c).trim()).filter(Boolean);
      const roster = new Set();
      const clsNames = [];
      for (const c of clsList) {
        const cr = classRoster.get(norm(c));
        if (!cr) {
          err(`Dance "${name}": class "${c}" has no dancers in the class list.`);
          continue;
        }
        classesWithDance.add(norm(c));
        clsNames.push(cr.name);
        for (const m of cr.members) roster.add(m);
      }
      if (!clsList.length) err(`Dance "${name}" has no class.`);
      let hair = parseHair(r.hair);
      if (hair === null) {
        warn(`Dance "${name}": hair "${r.hair}" isn't up or down; treated as either.`);
        hair = '';
      }
      let minutes = r.minutes === '' || r.minutes == null ? 3 : Number(r.minutes);
      if (!Number.isFinite(minutes) || minutes <= 0) minutes = 3;
      const pin = {};
      if (r.night !== '' && r.night != null) {
        const n = parseInt(r.night, 10);
        if (n >= 1 && n <= S.nights) pin.night = n - 1;
        else warn(`Dance "${name}": night "${r.night}" ignored (the show has ${S.nights} night${S.nights > 1 ? 's' : ''}).`);
      }
      if (r.act !== '' && r.act != null) {
        const a = parseInt(r.act, 10);
        if (a === 1 || a === 2) pin.act = a - 1;
        else warn(`Dance "${name}": act "${r.act}" ignored (use 1 or 2).`);
      }
      const pos = parsePosition(r.position);
      if (pos === undefined) warn(`Dance "${name}": position "${r.position}" ignored (use first, last or a number).`);
      else if (pos != null) pin.position = pos;
      const members = [...roster];
      const ages = members.map((m) => dancers[m].age).filter((a) => a != null);
      dances.push({
        id: String(r.id || name),
        name,
        classes: clsNames,
        hair,
        minutes,
        pin: Object.keys(pin).length ? pin : null,
        roster: members,
        age: ages.length ? ages.reduce((a, b) => a + b, 0) / ages.length : null,
        young: members.filter((m) => dancers[m].age != null && dancers[m].age < S.youngAge).length,
      });
      if (!members.length) warn(`Dance "${name}" has no dancers.`);
    }
    for (const [ck, cr] of classRoster) if (!classesWithDance.has(ck)) warn(`Class "${cr.name}" has no dance.`);

    const seen = new Map();
    for (const d of dances) {
      const k = norm(d.id);
      if (seen.has(k)) err(`Two dances are called "${d.name}". Give them different names (or an id column).`);
      seen.set(k, true);
    }

    const n = dances.length;
    // shared dancers between every pair of dances
    const conflict = new Int16Array(n * n);
    const byDancer = dancers.map(() => []);
    dances.forEach((d, i) => d.roster.forEach((m) => byDancer[m].push(i)));
    for (const list of byDancer)
      for (let a = 0; a < list.length; a++)
        for (let b = a + 1; b < list.length; b++) {
          conflict[list[a] * n + list[b]]++;
          conflict[list[b] * n + list[a]]++;
        }

    // "same night" groups: dancers with few dances, families with few dances
    const groups = [];
    byDancer.forEach((list, m) => {
      if (list.length >= 2 && list.length <= S.dancerSameNightMax) groups.push({ kind: 'dancer', who: dancers[m].name, members: [m], dances: list.slice(), w: S.weights.dancerSplit });
    });
    const fams = new Map();
    dancers.forEach((d, m) => {
      if (!d.family) return;
      const fk = norm(d.family);
      if (!fams.has(fk)) fams.set(fk, { name: d.family, members: [] });
      fams.get(fk).members.push(m);
    });
    for (const f of fams.values()) {
      if (f.members.length < 2) continue;
      const ds = new Set();
      for (const m of f.members) for (const di of byDancer[m]) ds.add(di);
      if (ds.size >= 2 && ds.size <= S.familySameNightMax) groups.push({ kind: 'family', who: f.name, members: f.members, dances: [...ds], w: S.weights.familySplit });
    }

    // quick sanity checks that make a perfect schedule impossible
    const pinsFirst = dances.filter((d) => d.pin && d.pin.position === 'first').length;
    if (pinsFirst > S.nights) warn(`${pinsFirst} dances are set to open a night but there ${S.nights === 1 ? 'is' : 'are'} only ${S.nights} night${S.nights > 1 ? 's' : ''}.`);
    const pinsLast = dances.filter((d) => d.pin && d.pin.position === 'last').length;
    if (pinsLast > S.nights) warn(`${pinsLast} dances are set to close a night but there ${S.nights === 1 ? 'is' : 'are'} only ${S.nights} night${S.nights > 1 ? 's' : ''}.`);
    if (n && n < S.nights * 2) err(`Only ${n} dances: each night needs at least one dance in each act.`);

    const problem = {
      settings: S,
      dancers,
      dances,
      n,
      conflict,
      byDancer,
      groups,
      families: [...fams.values()].filter((f) => f.members.length >= 2),
      _nightOf: new Int8Array(n),
      _actOf: new Int8Array(n),
      _posOf: new Int16Array(n),
      _hairStamp: new Int32Array(dancers.length), // which night/act the hair state below belongs to
      _hairState: new Int8Array(dancers.length), // 1 = up, 2 = down
      _hairChanges: new Int8Array(dancers.length),
      _hairPos: new Int16Array(dancers.length), // position of the dancer's last hair-up/down dance
      _stamp: 0,
    };
    return { problem, issues };
  }

  /**
   * Scores a schedule. With detail = true also lists every broken rule and tight change,
   * tagged with the dances involved, for the page to show.
   */
  function evaluate(P, sch, detail) {
    const S = P.settings;
    const W = S.weights;
    const gap = S.minGap;
    const n = P.n;
    const D = P.dances;
    const conflict = P.conflict;
    const nightOf = P._nightOf;
    const actOf = P._actOf;
    const posOf = P._posOf;
    const hairStamp = P._hairStamp, hairState = P._hairState, hairChanges = P._hairChanges, hairPos = P._hairPos;
    const out = detail ? [] : null;
    let hardGap = 0, hardHair = 0, hardYoung = 0, hardPin = 0, hardMissing = 0;
    let tight = 0, actDiff = 0;
    let nightMin = Infinity, nightMax = -Infinity;
    const minutes = [];
    let placed = 0;

    for (let ni = 0; ni < sch.nights.length; ni++) {
      const night = sch.nights[ni];
      const seq = night.seq;
      const L = seq.length;
      const split = night.split;
      let m1 = 0, m2 = 0;
      placed += L;
      let stamp = ++P._stamp;
      for (let i = 0; i < L; i++) {
        const di = seq[i];
        const d = D[di];
        const act = i < split ? 0 : 1;
        nightOf[di] = ni;
        actOf[di] = act;
        posOf[di] = i;
        if (act === 0) m1 += d.minutes;
        else m2 += d.minutes;

        // costume-change gap (and the "tight" count one past the minimum)
        for (let k = 1; k <= gap + 1; k++) {
          const j = i + k;
          if (j >= L) break;
          if (S.gapResetAtIntermission && i < split && j >= split) break;
          const dj = seq[j];
          const c = conflict[di * n + dj];
          if (!c) continue;
          if (k <= gap) {
            hardGap += c;
            if (out) out.push({ type: 'gap', hard: true, dances: [di, dj], dancers: shared(P, di, dj), between: k - 1 });
          } else {
            tight += c;
            if (out) out.push({ type: 'tight', hard: false, dances: [di, dj], dancers: shared(P, di, dj), between: k - 1 });
          }
        }

        // hair: at most one change (up → down or down → up) per dancer per night, and a change
        // needs one more dance in between than a costume change
        if (S.hairResetAtIntermission && i === split) stamp = ++P._stamp;
        if (d.hair === 'up' || d.hair === 'down') {
          const h = d.hair === 'up' ? 1 : 2;
          let second = null, quick = null;
          for (const m of d.roster) {
            if (hairStamp[m] !== stamp) {
              hairStamp[m] = stamp;
              hairState[m] = h;
              hairChanges[m] = 0;
              hairPos[m] = i;
              continue;
            }
            if (hairState[m] !== h) {
              hairChanges[m]++;
              if (hairChanges[m] > 1) {
                hardHair++;
                if (out) (second || (second = [])).push(m);
              } else {
                const p = hairPos[m];
                const acrossBreak = S.gapResetAtIntermission && p < split && i >= split;
                if (!acrossBreak && i - p - 1 < gap + 1) {
                  hardHair++;
                  if (out) (quick || (quick = [])).push({ m, from: seq[p], between: i - p - 1 });
                }
              }
              hairState[m] = h;
            }
            hairPos[m] = i;
          }
          if (second) out.push({ type: 'hair', hard: true, dances: [di], dancers: second });
          if (quick) for (const q of quick) out.push({ type: 'hairGap', hard: true, dances: [q.from, di], dancers: [q.m], between: q.between, need: gap + 1 });
        }

        // young dancers before intermission
        if (act === 1 && d.young) {
          hardYoung += d.young;
          if (out) out.push({ type: 'young', hard: true, dances: [di], dancers: d.roster.filter((m) => P.dancers[m].age != null && P.dancers[m].age < S.youngAge) });
        }
      }
      actDiff += Math.abs(m1 - m2);
      minutes.push([m1, m2]);
      const tot = m1 + m2;
      if (tot < nightMin) nightMin = tot;
      if (tot > nightMax) nightMax = tot;
    }
    if (placed !== n) hardMissing = Math.abs(n - placed);

    // pinned dances
    for (let di = 0; di < n; di++) {
      const pin = D[di].pin;
      if (!pin) continue;
      let bad = false;
      if (pin.night != null && nightOf[di] !== pin.night) bad = true;
      if (pin.act != null && actOf[di] !== pin.act) bad = true;
      if (pin.position != null) {
        const L = sch.nights[nightOf[di]].seq.length;
        if (pin.position === 'first' && posOf[di] !== 0) bad = true;
        else if (pin.position === 'last' && posOf[di] !== L - 1) bad = true;
        else if (typeof pin.position === 'number' && posOf[di] !== pin.position - 1) bad = true;
      }
      if (bad) {
        hardPin++;
        if (out) out.push({ type: 'pin', hard: true, dances: [di] });
      }
    }

    // same-night preferences
    let dancerSplit = 0, familySplit = 0, groupPenalty = 0;
    for (const g of P.groups) {
      const nt = nightOf[g.dances[0]];
      let split = false;
      for (let k = 1; k < g.dances.length; k++) if (nightOf[g.dances[k]] !== nt) { split = true; break; }
      if (!split) continue;
      groupPenalty += g.w;
      if (g.kind === 'dancer') dancerSplit++;
      else familySplit++;
      if (out) out.push({ type: g.kind === 'dancer' ? 'dancerSplit' : 'familySplit', hard: false, dances: g.dances.slice(), dancers: g.members, who: g.who });
    }

    const hard = hardGap + hardHair + hardYoung + hardPin + hardMissing;
    const nightDiff = sch.nights.length > 1 ? nightMax - nightMin : 0;
    const soft =
      groupPenalty + W.tight * tight + W.nightBalance * nightDiff + W.actBalance * actDiff;
    const res = {
      score: hard * HARD + soft,
      hard,
      soft,
      parts: { hardGap, hardHair, hardYoung, hardPin, dancerSplit, familySplit, tight, nightDiff, actDiff },
      minutes,
    };
    if (out) res.items = out;
    return res;
  }

  function shared(P, a, b) {
    const set = new Set(P.dances[a].roster);
    return P.dances[b].roster.filter((m) => set.has(m));
  }

  // ---------- random numbers (seeded, so runs can be repeated) ----------
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

  function clone(sch) {
    return { nights: sch.nights.map((x) => ({ seq: x.seq.slice(), split: x.split })) };
  }

  /** Starting point: roughly youngest to oldest, dealt across the nights. */
  function initial(P, rnd) {
    const S = P.settings;
    const order = P.dances.map((d, i) => ({ i, k: (d.age == null ? 12 : d.age) + rnd() * 4 }));
    order.sort((a, b) => a.k - b.k);
    const nights = Array.from({ length: S.nights }, () => ({ seq: [], split: 0 }));
    order.forEach((o, k) => nights[k % S.nights].seq.push(o.i));
    for (const nt of nights) nt.split = Math.max(1, Math.min(nt.seq.length - 1, Math.round(nt.seq.length / 2)));
    return { nights };
  }

  /** Is this a valid schedule for this problem (every dance exactly once)? */
  function valid(P, sch) {
    if (!sch || !Array.isArray(sch.nights) || sch.nights.length !== P.settings.nights) return false;
    const seen = new Uint8Array(P.n);
    let c = 0;
    for (const nt of sch.nights) {
      if (!Array.isArray(nt.seq) || nt.seq.length < 2) return false;
      if (!(nt.split >= 1 && nt.split <= nt.seq.length - 1)) return false;
      for (const di of nt.seq) {
        if (!(di >= 0 && di < P.n) || seen[di]) return false;
        seen[di] = 1;
        c++;
      }
    }
    return c === P.n;
  }

  /** One simulated-annealing run. Call step() repeatedly until it returns true. */
  function createRun(P, opts) {
    opts = opts || {};
    const rnd = rng32(opts.seed || 1);
    const iters = Math.max(1000, opts.iterations || P.settings.iterations);
    const T0 = opts.T0 != null ? opts.T0 : 15;
    const T1 = opts.T1 != null ? opts.T1 : 0.05;
    let cur = opts.start && valid(P, opts.start) ? clone(opts.start) : initial(P, rnd);
    let curE = evaluate(P, cur).score;
    let best = clone(cur);
    let bestE = curE;
    let it = 0;
    const NN = cur.nights.length;

    function pickPos() {
      let total = 0;
      for (const nt of cur.nights) total += nt.seq.length;
      let g = Math.floor(rnd() * total);
      for (let ni = 0; ni < NN; ni++) {
        const L = cur.nights[ni].seq.length;
        if (g < L) return [ni, g];
        g -= L;
      }
      return [NN - 1, 0];
    }

    function propose() {
      const r = rnd();
      const cand = { nights: cur.nights.slice() };
      const own = (ni) => {
        if (cand.nights[ni] === cur.nights[ni]) cand.nights[ni] = { seq: cur.nights[ni].seq.slice(), split: cur.nights[ni].split };
        return cand.nights[ni];
      };
      if (r < 0.35) {
        // swap two dances anywhere
        const [na, ia] = pickPos();
        const [nb, ib] = pickPos();
        if (na === nb && ia === ib) return null;
        const A = own(na), B = own(nb);
        const t = A.seq[ia];
        A.seq[ia] = B.seq[ib];
        B.seq[ib] = t;
      } else if (r < 0.7) {
        // move one dance somewhere else (maybe another night or act)
        const [na, ia] = pickPos();
        const nb = Math.floor(rnd() * NN);
        const A = own(na);
        if (A.seq.length <= 2) return null;
        const [di] = A.seq.splice(ia, 1);
        if (ia < A.split) A.split--;
        const B = own(nb);
        const p = Math.floor(rnd() * (B.seq.length + 1));
        B.seq.splice(p, 0, di);
        if (p < B.split || (p === B.split && rnd() < 0.5)) B.split++;
        if (A.split < 1 || A.split > A.seq.length - 1 || B.split < 1 || B.split > B.seq.length - 1) return null;
      } else if (r < 0.88) {
        // reverse a short stretch
        const ni = Math.floor(rnd() * NN);
        const A = own(ni);
        const len = 2 + Math.floor(rnd() * 5);
        if (A.seq.length < len) return null;
        const s = Math.floor(rnd() * (A.seq.length - len + 1));
        const part = A.seq.slice(s, s + len).reverse();
        for (let k = 0; k < len; k++) A.seq[s + k] = part[k];
      } else {
        // move the intermission
        const ni = Math.floor(rnd() * NN);
        const A = own(ni);
        A.split += rnd() < 0.5 ? -1 : 1;
        if (A.split < 1 || A.split > A.seq.length - 1) return null;
      }
      return cand;
    }

    return {
      get best() {
        return best;
      },
      get bestScore() {
        return bestE;
      },
      get progress() {
        return it / iters;
      },
      /** Runs up to k iterations; true once finished. */
      step(k) {
        const end = Math.min(iters, it + k);
        const ratio = T1 / T0;
        for (; it < end; it++) {
          const cand = propose();
          if (!cand) continue;
          const e = evaluate(P, cand).score;
          const d = e - curE;
          if (d <= 0 || rnd() < Math.exp(-d / (T0 * Math.pow(ratio, it / iters)))) {
            cur = cand;
            curE = e;
            if (e < bestE) {
              bestE = e;
              best = clone(cand);
            }
          }
        }
        return it >= iters;
      },
    };
  }

  /**
   * Several runs one after another; keeps the best few different schedules.
   * opts: { runs, keep, iterations, seed, start (schedule to begin from), gentle (start cool) }
   */
  function createBatch(P, opts) {
    opts = opts || {};
    const S = P.settings;
    const runs = Math.max(1, opts.runs || S.runs);
    const keep = Math.max(1, opts.keep || S.keep);
    const iterations = opts.iterations || S.iterations;
    const seed0 = opts.seed || (Date.now() & 0x7fffffff);
    const found = [];
    let r = 0;
    let run = null;
    const startRun = () =>
      createRun(P, {
        seed: seed0 + r * 7919,
        iterations,
        start: opts.start,
        T0: opts.start && opts.gentle ? 4 : undefined,
      });
    return {
      get progress() {
        return (r + (run ? run.progress : 0)) / runs;
      },
      get results() {
        return found;
      },
      step(k) {
        if (r >= runs) return true;
        if (!run) run = startRun();
        if (run.step(k)) {
          const sch = run.best;
          const key = sch.nights.map((x) => x.seq.join(',') + '|' + x.split).join('/');
          if (!found.some((f) => f.key === key)) found.push({ key, schedule: sch, score: run.bestScore });
          found.sort((a, b) => a.score - b.score);
          if (found.length > keep) found.length = keep;
          r++;
          run = null;
        }
        return r >= runs;
      },
    };
  }

  /** Runs a whole batch synchronously (tests, scripts). */
  function solve(P, opts) {
    const b = createBatch(P, opts);
    while (!b.step(20000));
    return b.results.map((f) => ({ schedule: f.schedule, eval: evaluate(P, f.schedule, true) }));
  }

  /** Where each dancer appears: [{ night, act, slot (1-based, whole night), dance }] */
  function dancerSlots(P, sch) {
    const out = P.dancers.map(() => []);
    sch.nights.forEach((nt, ni) =>
      nt.seq.forEach((di, i) => {
        for (const m of P.dances[di].roster) out[m].push({ night: ni, act: i < nt.split ? 0 : 1, slot: i + 1, dance: di });
      })
    );
    return out;
  }

  /** Turns a schedule into names (to save) and back (after the data changes). */
  function toNames(P, sch) {
    return { nights: sch.nights.map((nt) => ({ seq: nt.seq.map((di) => P.dances[di].id), split: nt.split })) };
  }
  function fromNames(P, named) {
    if (!named || !Array.isArray(named.nights)) return null;
    const idx = new Map(P.dances.map((d, i) => [norm(d.id), i]));
    const used = new Set();
    const nights = named.nights.slice(0, P.settings.nights).map((nt) => {
      const seq = [];
      (nt.seq || []).forEach((id) => {
        const i = idx.get(norm(id));
        if (i != null && !used.has(i)) {
          used.add(i);
          seq.push(i);
        }
      });
      return { seq, split: Math.round(nt.split) || 1 };
    });
    while (nights.length < P.settings.nights) nights.push({ seq: [], split: 1 });
    // dances that are new since the schedule was saved go at the end of the shortest night
    for (let i = 0; i < P.n; i++)
      if (!used.has(i)) nights.reduce((a, b) => (b.seq.length < a.seq.length ? b : a)).seq.push(i);
    for (const nt of nights) nt.split = Math.max(1, Math.min(nt.seq.length - 1, nt.split));
    const sch = { nights };
    return valid(P, sch) ? sch : null;
  }

  return { HARD, DEFAULTS, mergeSettings, build, evaluate, createRun, createBatch, solve, initial, valid, clone, dancerSlots, toNames, fromNames, rng32, norm };
});
