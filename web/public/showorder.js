/*
 * Dance Recital Scheduler page: loads the lists, runs the solver in small slices (so the page stays
 * responsive), shows the schedules, and lets you drag, lock, export and save.
 */
(function () {
  'use strict';
  const S = window.ShowSolver;
  const G = window.ShowSample;
  const $ = (id) => document.getElementById(id);
  if (!S || !$('so-settings')) return;

  // ---------- small helpers ----------
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return node;
  }
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;
  const fmtNum = (x) => (Math.round(x * 10) / 10).toString();
  const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, '0')}m` : `${fmtNum(m)} min`);
  const nameList = (ms, max = 4) => {
    const names = ms.map((m) => P.dancers[m].name);
    return names.length > max ? names.slice(0, max).join(', ') + ` +${names.length - max}` : names.join(', ');
  };
  const key = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  // ---------- state ----------
  const EFFORT = { quick: 60000, normal: 200000, thorough: 600000 };
  function defaultSettings() {
    const d = S.DEFAULTS;
    return {
      nights: d.nights,
      minGap: d.minGap,
      gapResetAtIntermission: d.gapResetAtIntermission,
      youngAge: d.youngAge,
      hairResetAtIntermission: d.hairResetAtIntermission,
      dancerSameNightMax: d.dancerSameNightMax,
      familySameNightMax: d.familySameNightMax,
      weights: Object.assign({}, d.weights),
      iterations: EFFORT.normal,
      keep: d.keep,
    };
  }
  const state = {
    raw: { dancers: [], enrollments: [], dances: [] },
    source: '',
    files: {},
    settings: defaultSettings(),
    results: [], // [{ label, named, edited, locks: { norm(dance id) -> { night, act, slot } } }]
    active: 0,
  };
  // Locks belong to one schedule; schedules found from it inherit them.
  const activeLocks = () => {
    const r = state.results[state.active];
    if (!r) return {};
    if (!r.locks || typeof r.locks !== 'object') r.locks = {};
    return r.locks;
  };
  let P = null;
  let issues = [];
  let selected = null; // dance index
  let finding = null; // { label, dancers:Set }
  let running = null;
  let dirty = false;
  let savedAt = null;

  function markDirty() {
    dirty = true;
    renderSaved();
  }

  // ---------- problem ----------
  /** The problem with a schedule's locks added as fixed positions. */
  function problemWith(locks) {
    const r = S.build(state.raw, state.settings);
    for (const [id, lk] of Object.entries(locks || {})) {
      const di = r.problem.dances.findIndex((d) => S.norm(d.id) === id);
      if (di < 0 || lk.night >= r.problem.settings.nights) {
        delete locks[id];
        continue;
      }
      r.problem.dances[di].pin = { night: lk.night, act: lk.act, position: lk.slot };
    }
    return r;
  }
  function rebuild() {
    const r = problemWith(activeLocks());
    P = r.problem;
    issues = r.issues;
    if (selected != null && selected >= P.n) selected = null;
  }

  function currentSchedule() {
    const r = state.results[state.active];
    if (!r || !P || !P.n) return null;
    return S.fromNames(P, r.named);
  }

  function locate(sch) {
    const loc = new Array(P.n);
    sch.nights.forEach((nt, ni) => nt.seq.forEach((di, i) => (loc[di] = { night: ni, idx: i, act: i < nt.split ? 0 : 1 })));
    return loc;
  }
  const slotLabel = (l, withNight) => (withNight || P.settings.nights > 1 ? `N${l.night + 1} #${l.idx + 1}` : `#${l.idx + 1}`);

  // ---------- CSV ----------
  function parseCSV(text) {
    text = text.replace(/^﻿/, '');
    const first = text.split(/\r?\n/, 1)[0] || '';
    const counts = { ',': first.split(',').length, ';': first.split(';').length, '\t': first.split('\t').length };
    const delim = Object.keys(counts).reduce((a, b) => (counts[b] > counts[a] ? b : a), ',');
    const rows = [];
    let row = [];
    let field = '';
    let q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else q = false;
        } else field += c;
      } else if (c === '"' && field === '') q = true;
      else if (c === delim) {
        row.push(field);
        field = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else field += c;
    }
    if (field !== '' || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows.filter((r) => r.some((x) => x.trim() !== ''));
  }

  function toObjects(rows) {
    const head = rows[0].map(key);
    const col = (...names) => {
      for (const n of names) {
        const i = head.indexOf(n);
        if (i >= 0) return i;
      }
      return -1;
    };
    return { head, col, body: rows.slice(1) };
  }

  /** Works out which of the three lists a CSV is, and reads it. */
  function readFile(name, text) {
    const rows = parseCSV(text);
    if (rows.length < 2) return { error: `${name}: no rows found.` };
    const { head, col, body } = toObjects(rows);
    const get = (r, i) => (i >= 0 ? String(r[i] == null ? '' : r[i]).trim() : '');
    const has = (...n) => n.some((x) => head.includes(x));

    if (has('hair', 'hairstyle') || (has('dance', 'dancename', 'routine', 'title') && has('class', 'classes'))) {
      const c = {
        id: col('id', 'danceid'),
        name: col('dance', 'dancename', 'routine', 'title', 'name', 'number'),
        classes: col('class', 'classes', 'classname'),
        hair: col('hair', 'hairstyle'),
        minutes: col('minutes', 'mins', 'length', 'duration', 'time'),
        night: col('night', 'show'),
        act: col('act', 'half'),
        position: col('position', 'slot', 'order', 'fixed'),
      };
      if (c.name < 0 || c.classes < 0) return { error: `${name}: looks like the dances list, but needs a dance name column and a class column.` };
      return {
        kind: 'dances',
        rows: body.map((r) => ({ id: get(r, c.id), name: get(r, c.name), classes: get(r, c.classes), hair: get(r, c.hair), minutes: get(r, c.minutes), night: get(r, c.night), act: get(r, c.act), position: get(r, c.position) })).filter((r) => r.name),
      };
    }
    if (has('age')) {
      const c = { id: col('id', 'dancerid', 'studentid'), name: col('name', 'dancer', 'dancername', 'student', 'studentname', 'fullname'), first: col('firstname', 'first', 'givenname'), last: col('lastname', 'last', 'surname', 'familyname'), age: col('age'), family: col('family', 'familyid', 'household', 'parent', 'parents', 'guardian', 'account') };
      if (c.name < 0 && c.first < 0) return { error: `${name}: looks like the dancer list, but has no name column.` };
      return {
        kind: 'dancers',
        rows: body
          .map((r) => ({ id: get(r, c.id), name: c.name >= 0 ? get(r, c.name) : `${get(r, c.first)} ${get(r, c.last)}`.trim(), age: get(r, c.age), family: get(r, c.family) }))
          .filter((r) => r.name),
      };
    }
    if (has('class', 'classname', 'course')) {
      const cc = col('class', 'classname', 'course');
      const many = col('dancers', 'students', 'roster');
      const one = col('dancer', 'student', 'name', 'dancername', 'studentname');
      const first = col('firstname', 'first');
      const last = col('lastname', 'last', 'surname');
      const rowsOut = [];
      for (const r of body) {
        const cls = get(r, cc);
        if (!cls) continue;
        if (many >= 0) get(r, many).split(/[;\n]/).map((x) => x.trim()).filter(Boolean).forEach((d) => rowsOut.push({ class: cls, dancer: d }));
        else if (one >= 0) rowsOut.push({ class: cls, dancer: get(r, one) });
        else if (first >= 0) rowsOut.push({ class: cls, dancer: `${get(r, first)} ${get(r, last)}`.trim() });
      }
      if (!rowsOut.length) return { error: `${name}: looks like a class list, but has no dancer column.` };
      return { kind: 'enrollments', rows: rowsOut.filter((r) => r.dancer) };
    }
    return { error: `${name}: couldn't tell which list this is (columns: ${rows[0].join(', ')}).` };
  }

  function csvText(rows) {
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
  }
  function download(name, rows) {
    const blob = new Blob(['﻿' + csvText(rows)], { type: 'text/csv;charset=utf-8' });
    const a = el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }

  // ---------- data panel ----------
  const KIND_LABEL = { dancers: 'Dancers', enrollments: 'Class lists', dances: 'Dances' };
  async function takeFiles(fileList) {
    const notes = [];
    for (const f of fileList) {
      const text = await f.text();
      const r = readFile(f.name, text);
      if (r.error) {
        notes.push(r.error);
        continue;
      }
      state.raw[r.kind] = r.rows;
      state.files[r.kind] = `${f.name} · ${r.rows.length} rows`;
    }
    state.source = 'files';
    fileErrors = notes;
    afterDataChange();
  }
  let fileErrors = [];

  function afterDataChange() {
    selected = null;
    rebuild();
    markDirty();
    renderAll();
  }

  function renderData() {
    $('so-filechips').replaceChildren(
      ...['dancers', 'enrollments', 'dances'].map((k) =>
        el('span', { class: 'so-filechip ' + (state.raw[k].length ? 'ok' : '') }, el('strong', { text: KIND_LABEL[k] }), ' ', el('span', { class: 'muted', text: state.files[k] || (state.raw[k].length ? `${state.raw[k].length} rows` : 'not loaded') }))
      )
    );
    const sum = $('so-summary');
    if (!P || !state.raw.dances.length) {
      sum.replaceChildren(el('p', { class: 'muted small', text: 'No data yet. Drop the three CSV files, or generate a simulated studio to try things out.' }));
    } else {
      const classes = new Set(state.raw.enrollments.map((e) => S.norm(e.class))).size;
      const multi = P.byDancer.filter((l) => l.length > 1).length;
      const most = Math.max(0, ...P.byDancer.map((l) => l.length));
      const young = P.dancers.filter((d) => d.age != null && d.age < P.settings.youngAge).length;
      sum.replaceChildren(
        el('div', { class: 'so-counts' }, ...[
          [P.dancers.length, 'dancers'],
          [classes, 'classes'],
          [P.n, 'dances'],
          [P.families.length, 'families'],
        ].map(([n, l]) => el('div', null, el('strong', { text: n }), el('span', { class: 'muted small', text: l })))),
        el('p', { class: 'small muted' }, `${multi} dancers are in more than one dance (most: ${most}). ${young} are under ${P.settings.youngAge}. ${state.source && state.source !== 'files' ? 'Source: ' + state.source + '.' : ''}`)
      );
    }
    $('so-issues').replaceChildren(
      ...fileErrors.map((m) => el('li', { class: 'error-item', text: m })),
      ...issues.map((i) => el('li', { class: i.level === 'error' ? 'error-item' : 'warn-item', text: i.msg }))
    );
  }

  // ---------- settings panel ----------
  const form = $('so-settings');
  function fillSettings() {
    const s = state.settings;
    for (const inp of form.querySelectorAll('input, select')) {
      const n = inp.name;
      if (!n) continue;
      let v;
      if (n.startsWith('w.')) v = s.weights[n.slice(2)];
      else if (n === 'effort') {
        inp.value = String(Object.values(EFFORT).includes(s.iterations) ? s.iterations : EFFORT.normal);
        continue;
      } else v = s[n];
      if (inp.type === 'checkbox') inp.checked = !!v;
      else inp.value = v == null ? '' : v;
    }
  }
  function readSettings() {
    const d = defaultSettings();
    const s = { weights: {} };
    for (const inp of form.querySelectorAll('input, select')) {
      const n = inp.name;
      if (!n) continue;
      if (inp.type === 'checkbox') {
        s[n] = inp.checked;
        continue;
      }
      if (n === 'effort') {
        s.iterations = Number(inp.value) || d.iterations;
        continue;
      }
      const num = Number(String(inp.value).replace(',', '.'));
      if (n.startsWith('w.')) s.weights[n.slice(2)] = inp.value.trim() === '' || !Number.isFinite(num) ? d.weights[n.slice(2)] : num;
      else s[n] = inp.value.trim() === '' || !Number.isFinite(num) ? d[n] : num;
    }
    s.keep = Math.max(1, Math.min(10, Math.round(s.keep)));
    state.settings = s;
  }
  form.addEventListener('change', () => {
    readSettings();
    rebuild();
    markDirty();
    renderAll();
  });
  $('so-defaults').addEventListener('click', () => {
    state.settings = defaultSettings();
    fillSettings();
    rebuild();
    markDirty();
    renderAll();
  });

  // ---------- solving ----------
  function startRun(opts, onDone) {
    if (running) return;
    if (!P || !P.n) return alert('Load or generate the data first.');
    if (issues.some((i) => i.level === 'error')) return alert('Fix the problems listed under Data first.');
    const batch = S.createBatch(P, Object.assign({ keep: P.settings.keep, runs: Math.max(4, P.settings.keep + 2), iterations: P.settings.iterations }, opts));
    running = { batch, stop: false };
    const bar = $('so-progress');
    bar.classList.remove('hidden');
    const btn = $('so-solve');
    btn.textContent = 'Stop';
    $('so-resolve').disabled = true;
    const t0 = performance.now();
    const tick = () => {
      const t = performance.now();
      let done = false;
      while (!done && performance.now() - t < 45) done = batch.step(2500);
      const pct = Math.round(batch.progress * 100);
      bar.firstElementChild.style.width = pct + '%';
      bar.lastElementChild.textContent = `${pct}% · ${plural(batch.results.length, 'schedule')} so far · ${((performance.now() - t0) / 1000).toFixed(1)} s`;
      if (done || running.stop) {
        running = null;
        bar.classList.add('hidden');
        btn.textContent = 'Find schedules';
        $('so-resolve').disabled = false;
        onDone(batch.results);
      } else setTimeout(tick, 0);
    };
    setTimeout(tick, 0);
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (running) {
      running.stop = true;
      return;
    }
    readSettings();
    rebuild();
    startRun({}, (found) => {
      if (!found.length) return;
      const locks = JSON.stringify(activeLocks());
      state.results = found.map((f, i) => ({ label: `Option ${i + 1}`, named: S.toNames(P, f.schedule), edited: false, locks: JSON.parse(locks) }));
      state.active = 0;
      selected = null;
      markDirty();
      renderAll();
      $('so-results').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  $('so-resolve').addEventListener('click', () => {
    const cur = currentSchedule();
    if (!cur) return;
    const before = state.results[state.active];
    startRun({ start: cur, gentle: true }, (found) => {
      if (!found.length) return;
      const locks = JSON.stringify(activeLocks());
      const fresh = found.map((f, i) => ({ label: `Re-solved ${i + 1}`, named: S.toNames(P, f.schedule), edited: false, locks: JSON.parse(locks) }));
      const keepBefore = { label: `${before.label.replace(/ \(before re-solve\)$/, '')} (before re-solve)`, named: before.named, edited: before.edited, locks: before.locks };
      state.results = [...fresh, keepBefore].slice(0, 10);
      state.active = 0;
      markDirty();
      renderAll();
    });
  });

  // ---------- results ----------
  function renderResults() {
    const box = $('so-results');
    if (!P || !P.n || !state.results.length) {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    if (state.active >= state.results.length) state.active = 0;
    const evals = state.results.map((r, i) => {
      const PP = i === state.active || !r.locks || !Object.keys(r.locks).length ? (i === state.active ? P : problemWith({}).problem) : problemWith(r.locks).problem;
      const sch = S.fromNames(PP, r.named);
      return sch ? S.evaluate(PP, sch) : null;
    });
    $('so-tabs').replaceChildren(
      ...state.results.map((r, i) => {
        const ev = evals[i];
        return el(
          'button',
          {
            type: 'button',
            role: 'tab',
            'aria-selected': i === state.active ? 'true' : 'false',
            class: 'chip' + (i === state.active ? ' active' : ''),
            onclick: () => {
              state.active = i;
              selected = null;
              rebuild();
              markDirty();
              renderResults();
            },
          },
          `${r.label}${r.edited ? ' ✎' : ''} · `,
          ev ? (ev.hard ? el('span', { class: 'down', text: `✗ ${ev.hard}` }) : el('span', { class: 'up', text: '✓' })) : '?',
          ev ? ` ${Math.round(ev.soft)}` : ''
        );
      })
    );
    const sch = currentSchedule();
    if (!sch) return;
    const ev = S.evaluate(P, sch, true);
    renderScorecard(ev);
    renderNights(sch, ev);
    renderDetail(sch);
    renderNotes(sch, ev);
    renderPeople();
  }

  function renderScorecard(ev) {
    const p = ev.parts;
    const dancerGroups = P.groups.filter((g) => g.kind === 'dancer').length;
    const famGroups = P.groups.filter((g) => g.kind === 'family').length;
    const firm = ev.hard
      ? [p.hardGap && `${p.hardGap} too-quick change${p.hardGap > 1 ? 's' : ''}`, p.hardHair && `${p.hardHair} hair change${p.hardHair > 1 ? 's' : ''} too many or too quick`, p.hardYoung && `${p.hardYoung} young dancer${p.hardYoung > 1 ? 's' : ''} after intermission`, p.hardPin && `${p.hardPin} locked/fixed dance${p.hardPin > 1 ? 's' : ''} moved`].filter(Boolean).join(' · ')
      : 'all met';
    const tile = (label, value, sub, cls) => el('div', { class: 'stat ' + (cls || '') }, el('span', { class: 'stat-label', text: label }), el('span', { class: 'stat-value', text: value }), sub ? el('span', { class: 'stat-sub muted', text: sub }) : null);
    $('so-scorecard').replaceChildren(
      tile('Firm rules', ev.hard ? `✗ ${ev.hard}` : '✓', firm, ev.hard ? 'so-bad' : 'so-good'),
      tile('Dancers on both nights', P.settings.nights > 1 ? String(p.dancerSplit) : '–', `of ${dancerGroups} with ≤ ${P.settings.dancerSameNightMax} dances`),
      tile('Families on both nights', P.settings.nights > 1 ? String(p.familySplit) : '–', `of ${famGroups} with ≤ ${P.settings.familySameNightMax} dances`),
      tile('Tight changes', String(p.tight), `exactly ${P.settings.minGap} dance${P.settings.minGap === 1 ? '' : 's'} between`),
      tile('Length', ev.minutes.map((m) => fmtMin(m[0] + m[1])).join(' · '), ev.minutes.map((m) => `${fmtMin(m[0])} + ${fmtMin(m[1])}`).join(' · ')),
      tile('Score', String(Math.round(ev.score)), 'lower is better')
    );
  }

  const ITEM_TEXT = {
    gap: (x) => `${nameList(x.dancers)}: ${x.between === 0 ? 'back to back' : `only ${plural(x.between, 'dance')} between`}`,
    tight: (x) => `${nameList(x.dancers)}: ${plural(x.between, 'dance')} between`,
    hair: (x) => `${nameList(x.dancers)}: second hair change tonight (only one allowed)`,
    hairGap: (x) => `${nameList(x.dancers)}: hair change with ${x.between === 0 ? 'no dances' : `only ${plural(x.between, 'dance')}`} between (needs ${x.need})`,
    young: (x) => `${nameList(x.dancers)}: under ${P.settings.youngAge}, should be before intermission`,
    pin: (x) => `should be ${pinText(P.dances[x.dances[0]].pin)}`,
  };
  function pinText(pin) {
    const bits = [];
    if (pin.night != null) bits.push(`night ${pin.night + 1}`);
    if (pin.act != null) bits.push(`act ${pin.act + 1}`);
    if (pin.position === 'first') bits.push('first');
    else if (pin.position === 'last') bits.push('last');
    else if (pin.position != null) bits.push(`#${pin.position}`);
    return bits.join(', ');
  }

  function renderNights(sch, ev) {
    const loc = locate(sch);
    const flags = new Map(); // di -> [{cls, text}]
    const flag = (di, cls, text) => {
      if (!flags.has(di)) flags.set(di, []);
      flags.get(di).push({ cls, text });
    };
    for (const x of ev.items) {
      if (x.type === 'gap' || x.type === 'tight' || x.type === 'hairGap') {
        const [a, b] = x.dances;
        const cls = x.type === 'tight' ? 'so-flag-tight' : 'so-flag-bad';
        flag(a, cls, `→ ${slotLabel(loc[b])} ${ITEM_TEXT[x.type](x)}`);
        flag(b, cls, `← ${slotLabel(loc[a])} ${ITEM_TEXT[x.type](x)}`);
      } else if (x.type === 'hair' || x.type === 'young' || x.type === 'pin') flag(x.dances[0], 'so-flag-bad', ITEM_TEXT[x.type](x));
    }

    const shared = new Map();
    if (selected != null) for (let j = 0; j < P.n; j++) if (j !== selected && P.conflict[selected * P.n + j]) shared.set(j, P.conflict[selected * P.n + j]);
    const found = new Set();
    if (finding) P.dances.forEach((d, di) => d.roster.some((m) => finding.dancers.has(m)) && found.add(di));
    $('so-find-info').textContent = finding ? `${finding.label}: ${plural(found.size, 'dance')}${found.size ? ' — ' + [...found].map((di) => slotLabel(loc[di])).sort().join(', ') : ''}` : '';

    const nights = sch.nights.map((nt, ni) => {
      const mins = ev.minutes[ni];
      const list = el('ol', { class: 'so-list', 'data-night': ni });
      nt.seq.forEach((di, i) => {
        if (i === nt.split) list.append(el('li', { class: 'so-interval', 'data-night': ni, 'data-idx': i, 'data-interval': '1' }, el('span', { text: `Intermission` }), el('span', { class: 'muted small', text: `Act 2 · ${fmtMin(mins[1])}` })));
        const d = P.dances[di];
        const fl = flags.get(di) || [];
        const cls = ['so-row'];
        if (selected === di) cls.push('so-selected');
        if (shared.has(di)) cls.push('so-shared');
        if (found.has(di)) cls.push('so-found');
        if (fl.some((f) => f.cls === 'so-flag-bad')) cls.push('so-row-bad');
        const locked = !!activeLocks()[S.norm(d.id)];
        list.append(
          el(
            'li',
            { class: cls.join(' '), draggable: 'true', 'data-di': di, 'data-night': ni, 'data-idx': i, onclick: (e) => {
              if (e.target.closest('button')) return;
              selected = selected === di ? null : di;
              renderResults();
            } },
            el('span', { class: 'so-slot', text: i + 1 }),
            el('button', { type: 'button', class: 'so-lock' + (locked ? ' on' : ''), title: locked ? 'Locked here — click to unlock' : 'Lock in this slot', 'aria-pressed': locked ? 'true' : 'false', onclick: () => toggleLock(di, sch) }, locked ? '🔒' : '🔓'),
            el(
              'div',
              { class: 'so-main' },
              el('div', { class: 'so-name' }, d.name, shared.has(di) ? el('span', { class: 'so-sharedcount', title: 'dancers also in the selected dance', text: `${shared.get(di)} shared` }) : null),
              el('div', { class: 'so-sub muted small' }, `${d.classes.length === 1 && d.name.toLowerCase().startsWith(d.classes[0].toLowerCase()) ? '' : d.classes.join(' + ') + ' · '}${plural(d.roster.length, 'dancer')}${d.age != null ? ' · avg ' + fmtNum(d.age) : ''}${d.young ? ` · ${d.young} under ${P.settings.youngAge}` : ''}`),
              fl.length ? el('ul', { class: 'so-flags' }, ...fl.map((f) => el('li', { class: f.cls, text: f.text }))) : null
            ),
            el('span', { class: 'so-hair so-hair-' + (d.hair || 'any'), title: d.hair ? `hair ${d.hair}` : 'hair either way', text: d.hair === 'up' ? 'UP' : d.hair === 'down' ? 'DOWN' : '–' }),
            el('span', { class: 'so-mins muted small', text: fmtNum(d.minutes) + '′' })
          )
        );
      });
      list.append(el('li', { class: 'so-end', 'data-night': ni, 'data-idx': nt.seq.length, 'data-end': '1', text: 'drop here to add at the end' }));
      return el(
        'div',
        { class: 'so-night' },
        el('div', { class: 'so-night-head' }, el('h3', { text: P.settings.nights > 1 ? `Night ${ni + 1}` : 'Running order' }), el('span', { class: 'muted small', text: `${plural(nt.seq.length, 'dance')} · ${fmtMin(mins[0] + mins[1])} · Act 1 ${fmtMin(mins[0])}` })),
        list
      );
    });
    const box = $('so-nights');
    box.className = 'so-nights so-n' + sch.nights.length;
    box.replaceChildren(...nights);
  }

  function renderDetail(sch) {
    const box = $('so-detail');
    if (selected == null) {
      box.replaceChildren(
        el('h3', { text: 'Details' }),
        el('p', { class: 'muted small', text: 'Click a dance to see its dancers and where else each of them dances. Dances sharing dancers with it are highlighted.' }),
        el('ul', { class: 'so-legend small' },
          el('li', null, el('span', { class: 'so-hair so-hair-up', text: 'UP' }), ' hair in a bun'),
          el('li', null, el('span', { class: 'so-hair so-hair-down', text: 'DOWN' }), ' hair down'),
          el('li', null, el('span', { class: 'so-flag-bad', text: 'red' }), ' firm rule broken'),
          el('li', null, el('span', { class: 'so-flag-tight', text: 'amber' }), ' change with only the minimum gap'),
          el('li', null, el('span', { class: 'so-flag-age', text: 'grey' }), ' well out of age order'))
      );
      return;
    }
    const loc = locate(sch);
    const d = P.dances[selected];
    const slots = S.dancerSlots(P, sch);
    const roster = d.roster.slice().sort((a, b) => (P.dancers[a].age || 0) - (P.dancers[b].age || 0) || P.dancers[a].name.localeCompare(P.dancers[b].name));
    box.replaceChildren(
      el('div', { class: 'so-detail-head' }, el('h3', { text: d.name }), el('button', { type: 'button', class: 'link small', onclick: () => { selected = null; renderResults(); }, text: 'close' })),
      el('p', { class: 'small muted' }, `${slotLabel(loc[selected], true)} · act ${loc[selected].act + 1} · ${d.classes.join(' + ')} · hair ${d.hair || 'either'} · ${fmtNum(d.minutes)} min`, d.pin ? ` · fixed: ${pinText(d.pin)}` : ''),
      el('table', { class: 'table compact so-roster' },
        el('thead', null, el('tr', null, el('th', { text: 'Dancer' }), el('th', { class: 'num', text: 'Age' }), el('th', { text: 'Also in' }))),
        el('tbody', null, ...roster.map((m) => {
          const dm = P.dancers[m];
          const others = slots[m].filter((s) => s.dance !== selected);
          return el('tr', null,
            el('td', null, dm.name, dm.family ? el('span', { class: 'muted small block', text: dm.family }) : null),
            el('td', { class: 'num', text: dm.age == null ? '?' : dm.age }),
            el('td', { class: 'small' }, others.length ? others.map((s, k) => {
              const near = s.night === loc[selected].night && Math.abs(s.slot - 1 - loc[selected].idx) <= P.settings.minGap + 1;
              return el('span', { class: near ? 'so-near' : '', title: P.dances[s.dance].name }, (k ? ', ' : '') + slotLabel({ night: s.night, idx: s.slot - 1 }));
            }) : el('span', { class: 'muted', text: '—' })));
        }))
      )
    );
  }

  function renderNotes(sch, ev) {
    const loc = locate(sch);
    const sections = [];
    const hard = ev.items.filter((x) => x.hard);
    if (hard.length) {
      sections.push(el('h3', { class: 'down', text: `Firm rules broken (${hard.length})` }), el('ul', { class: 'small' }, ...hard.map((x) => el('li', null, x.dances.map((di) => `${slotLabel(loc[di])} ${P.dances[di].name}`).join(' → '), ': ', ITEM_TEXT[x.type](x)))));
    }
    const splitList = (type, title) => {
      const xs = ev.items.filter((x) => x.type === type);
      if (!xs.length) return;
      sections.push(
        el('details', null, el('summary', null, el('strong', { text: `${title} (${xs.length})` })),
          el('ul', { class: 'small' }, ...xs.map((x) => el('li', null, el('strong', { text: x.who }), ': ', x.dances.map((di) => `${slotLabel(loc[di], true)} ${P.dances[di].name}`).join(' · ')))))
      );
    };
    splitList('dancerSplit', 'Dancers with few dances, spread over two nights');
    splitList('familySplit', 'Families spread over two nights');
    const tight = ev.items.filter((x) => x.type === 'tight');
    if (tight.length)
      sections.push(
        el('details', null, el('summary', null, el('strong', { text: `Tight costume changes (${tight.length})` })),
          el('ul', { class: 'small' }, ...tight.map((x) => el('li', null, `${slotLabel(loc[x.dances[0]])} → ${slotLabel(loc[x.dances[1]])}: ${nameList(x.dancers, 8)}`))))
      );
    if (!sections.length) sections.push(el('p', { class: 'muted small', text: 'Nothing to report: no firm rule broken, nobody split across nights, no tight changes.' }));
    $('so-notes').replaceChildren(el('h2', { text: 'Notes' }), ...sections);
  }

  function renderPeople() {
    const dl = $('so-people');
    if (dl.dataset.for === String(P.dancers.length) + ':' + P.families.length) return;
    dl.dataset.for = String(P.dancers.length) + ':' + P.families.length;
    dl.replaceChildren(...P.dancers.map((d) => el('option', { value: d.name })), ...P.families.map((f) => el('option', { value: f.name })));
  }

  $('so-find').addEventListener('input', (e) => {
    const q = S.norm(e.target.value);
    finding = null;
    if (q && P) {
      const fam = P.families.find((f) => S.norm(f.name) === q);
      if (fam) finding = { label: fam.name, dancers: new Set(fam.members) };
      else {
        const ms = P.dancers.map((d, i) => (S.norm(d.name) === q ? i : -1)).filter((i) => i >= 0);
        const partial = ms.length ? ms : q.length >= 3 ? P.dancers.map((d, i) => (S.norm(d.name).includes(q) ? i : -1)).filter((i) => i >= 0) : [];
        if (partial.length && partial.length <= 12) finding = { label: partial.length === 1 ? P.dancers[partial[0]].name : `${partial.length} dancers`, dancers: new Set(partial) };
      }
    }
    renderResults();
  });

  // ---------- locks and manual edits ----------
  function lockAt(di, sch) {
    const loc = locate(sch)[di];
    activeLocks()[S.norm(P.dances[di].id)] = { night: loc.night, act: loc.act, slot: loc.idx + 1 };
  }
  function toggleLock(di, sch) {
    const k = S.norm(P.dances[di].id);
    if (activeLocks()[k]) delete activeLocks()[k];
    else lockAt(di, sch);
    rebuild();
    markDirty();
    renderResults();
  }
  $('so-unlock').addEventListener('click', () => {
    const r = state.results[state.active];
    if (r) r.locks = {};
    rebuild();
    markDirty();
    renderResults();
  });

  function applyEdit(sch) {
    // locks follow manual moves: re-pin every locked dance where it now is
    for (const k of Object.keys(activeLocks())) {
      const di = P.dances.findIndex((d) => S.norm(d.id) === k);
      if (di >= 0) lockAt(di, sch);
    }
    const r = state.results[state.active];
    r.named = S.toNames(P, sch);
    r.edited = true;
    rebuild();
    markDirty();
    renderResults();
  }

  let dragDi = null;
  const nightsBox = $('so-nights');
  nightsBox.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.so-row');
    if (!row) return;
    dragDi = Number(row.dataset.di);
    row.classList.add('so-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(dragDi));
  });
  nightsBox.addEventListener('dragend', () => {
    dragDi = null;
    nightsBox.querySelectorAll('.so-dragging, .so-drop-before, .so-drop-after').forEach((x) => x.classList.remove('so-dragging', 'so-drop-before', 'so-drop-after'));
  });
  const dropTarget = (e) => {
    const t = e.target.closest('.so-row, .so-interval, .so-end');
    if (!t) return null;
    const r = t.getBoundingClientRect();
    const after = !t.dataset.end && e.clientY > r.top + r.height / 2;
    return { t, after };
  };
  nightsBox.addEventListener('dragover', (e) => {
    if (dragDi == null) return;
    const d = dropTarget(e);
    if (!d) return;
    e.preventDefault();
    nightsBox.querySelectorAll('.so-drop-before, .so-drop-after').forEach((x) => x.classList.remove('so-drop-before', 'so-drop-after'));
    d.t.classList.add(d.after ? 'so-drop-after' : 'so-drop-before');
  });
  nightsBox.addEventListener('drop', (e) => {
    if (dragDi == null) return;
    const d = dropTarget(e);
    if (!d) return;
    e.preventDefault();
    const sch = currentSchedule();
    const toNight = Number(d.t.dataset.night);
    const rowIdx = Number(d.t.dataset.idx);
    let toIdx, toAct1;
    if (d.t.dataset.interval) {
      // on the intermission: top half = end of act 1, bottom half = start of act 2
      toIdx = rowIdx;
      toAct1 = !d.after;
    } else {
      // before or after a dance: same act as that dance
      toIdx = rowIdx + (d.after ? 1 : 0);
      toAct1 = rowIdx < sch.nights[toNight].split;
    }
    const from = locate(sch)[dragDi];
    const A = sch.nights[from.night];
    A.seq.splice(from.idx, 1);
    if (from.idx < A.split) A.split--;
    if (from.night === toNight && from.idx < toIdx) toIdx--;
    const B = sch.nights[toNight];
    B.seq.splice(toIdx, 0, dragDi);
    if (toIdx < B.split || (toIdx === B.split && toAct1)) B.split++;
    for (const nt of sch.nights) nt.split = Math.max(1, Math.min(nt.seq.length - 1, nt.split));
    if (!S.valid(P, sch)) return alert('Each act needs at least one dance.');
    applyEdit(sch);
  });

  // ---------- exports ----------
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-export], [data-download]');
    if (!b || !P) return;
    if (b.dataset.download === 'dancers') return download('dancers.csv', [['name', 'age', 'family'], ...state.raw.dancers.map((d) => [d.name, d.age, d.family])]);
    if (b.dataset.download === 'classes') return download('classes.csv', [['class', 'dancer'], ...state.raw.enrollments.map((x) => [x.class, x.dancer])]);
    if (b.dataset.download === 'dances') return download('dances.csv', [['dance', 'class', 'hair', 'minutes', 'night', 'act', 'position'], ...state.raw.dances.map((d) => [d.name, Array.isArray(d.classes) ? d.classes.join('; ') : d.classes, d.hair, d.minutes, d.night, d.act, d.position])]);
    const sch = currentSchedule();
    if (!sch) return;
    const ev = S.evaluate(P, sch, true);
    const label = (state.results[state.active].label || 'schedule').replace(/[^\w-]+/g, '-').toLowerCase();
    if (b.dataset.export === 'order') {
      const notes = new Map();
      for (const x of ev.items) if (x.hard) for (const di of x.dances) notes.set(di, [...(notes.get(di) || []), ITEM_TEXT[x.type](x)]);
      const rows = [['night', 'act', 'slot', 'dance', 'classes', 'hair', 'minutes', 'dancers', 'average age', 'locked', 'problems']];
      sch.nights.forEach((nt, ni) => nt.seq.forEach((di, i) => {
        const d = P.dances[di];
        rows.push([ni + 1, i < nt.split ? 1 : 2, i + 1, d.name, d.classes.join('; '), d.hair || 'either', d.minutes, d.roster.length, d.age == null ? '' : fmtNum(d.age), activeLocks()[S.norm(d.id)] ? 'yes' : '', (notes.get(di) || []).join(' | ')]);
      }));
      download(`running-order-${label}.csv`, rows);
    } else if (b.dataset.export === 'dancers') {
      const slots = S.dancerSlots(P, sch);
      const rows = [['dancer', 'age', 'family', 'nights', 'dances', 'closest change (dances between)']];
      P.dancers.forEach((d, m) => {
        const s = slots[m].slice().sort((a, b) => a.night - b.night || a.slot - b.slot);
        let closest = '';
        for (let k = 1; k < s.length; k++) if (s[k].night === s[k - 1].night && s[k].act === s[k - 1].act) closest = Math.min(closest === '' ? Infinity : closest, s[k].slot - s[k - 1].slot - 1);
        rows.push([d.name, d.age == null ? '' : d.age, d.family, [...new Set(s.map((x) => x.night + 1))].join(' & '), s.map((x) => `N${x.night + 1} #${x.slot} ${P.dances[x.dance].name}`).join('; '), closest]);
      });
      download(`dancers-${label}.csv`, rows);
    }
  });
  $('so-print').addEventListener('click', () => window.print());

  // ---------- data loading ----------
  const drop = $('so-drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.remove('over');
  }));
  drop.addEventListener('drop', (e) => e.dataTransfer.files.length && takeFiles(e.dataTransfer.files));
  $('so-files').addEventListener('change', (e) => {
    if (e.target.files.length) takeFiles(e.target.files);
    e.target.value = '';
  });
  window.addEventListener('dragover', (e) => e.target.closest && !e.target.closest('#so-nights') && e.preventDefault());
  window.addEventListener('drop', (e) => e.target.closest && !e.target.closest('#so-nights, #so-drop') && e.preventDefault());

  $('so-generate').addEventListener('click', () => {
    if (state.raw.dances.length && state.source === 'files' && !confirm('Replace the loaded lists with a simulated studio?')) return;
    const seed = parseInt($('so-seed').value, 10) || 1;
    const n = parseInt($('so-ndancers').value, 10) || 200;
    state.raw = G.generate({ seed, dancers: n });
    state.source = `simulated studio, seed ${seed}`;
    state.files = {};
    state.results = [];
    fileErrors = [];
    afterDataChange();
  });

  // ---------- save / load ----------
  function renderSaved() {
    const t = $('so-saved');
    if (dirty) t.textContent = 'Unsaved changes';
    else if (savedAt) t.textContent = `Saved ${new Date(savedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
    else t.textContent = '';
    $('so-save').classList.toggle('primary', dirty);
  }
  $('so-save').addEventListener('click', async () => {
    const btn = $('so-save');
    btn.disabled = true;
    try {
      const res = await fetch('/showorder/api/project', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ raw: state.raw, source: state.source, settings: state.settings, results: state.results, active: state.active }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      dirty = false;
      savedAt = j.updatedAt;
      renderSaved();
    } catch (err) {
      alert('Could not save: ' + err.message);
    } finally {
      btn.disabled = false;
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  function renderAll() {
    renderData();
    renderResults();
    renderSaved();
  }

  async function load() {
    try {
      const res = await fetch('/showorder/api/project', { headers: { accept: 'application/json' } });
      const j = await res.json();
      if (j.project) {
        const p = j.project;
        state.raw = Object.assign({ dancers: [], enrollments: [], dances: [] }, p.raw);
        state.source = p.source || '';
        state.settings = Object.assign(defaultSettings(), p.settings || {});
        state.settings.weights = Object.assign(defaultSettings().weights, (p.settings || {}).weights || {});
        state.results = p.results || [];
        state.active = p.active || 0;
        savedAt = p.updatedAt;
        if (/seed (\d+)/.test(state.source)) $('so-seed').value = RegExp.$1;
      }
    } catch (err) {
      console.error(err);
    }
    fillSettings();
    rebuild();
    renderAll();
  }
  load();
})();
