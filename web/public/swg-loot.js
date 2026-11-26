/* SWG Loot page. Math: swg-loot-calc.js (window.SwgLoot). */
(function () {
  'use strict';
  const L = window.SwgLoot;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return n;
  };
  const local = {
    get(k) { try { return JSON.parse(localStorage.getItem('swg.' + k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem('swg.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
  };
  const session = {
    get(k) { try { return JSON.parse(sessionStorage.getItem('swg.' + k)); } catch { return null; } },
    set(k, v) { try { if (v == null) sessionStorage.removeItem('swg.' + k); else sessionStorage.setItem('swg.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  // ---------- state ----------
  let data = null; // { items, groups, tables, npcs }
  let drops = null; // SwgLoot.makeDropIndex(data)
  let npcs = []; // [{ id, chance, rolls, table, faction }]
  const state = {
    type: null,
    tier: 1,
    sel: new Set(), // item ids the user picked (empty = all)
    values: {}, // stat → value the user entered (display units)
    npc: null, // picked NPC id
    compName: null, // name the current component was loaded / saved as
  };
  let project = session.get('reProject') || { name: '', type: null, tier: null, components: [] };
  let target = session.get('lootTarget'); // { slot, label } from the ship builder
  let view = null; // last compute() result
  const MAX_NPCS_SHOWN = 300;

  // ---------- formatting ----------
  const fmtNum = (v, d) => (v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: d }));
  const prettyNpc = (id) => String(id).replace(/_/g, ' ').replace(/\btier(\d)/g, 'tier $1').replace(/\b\w/g, (c) => c.toUpperCase());
  /** red (0) → yellow (0.5) → green (1) */
  const pctColor = (p) => 'hsl(' + Math.round(120 * p) + ', 75%, 58%)';
  const typeLabel = (t) => (L.TYPES[t] ? L.TYPES[t].label : t);
  function statDecimals(key, items) {
    for (const it of items) if (it.stats[key]) return L.decimals(key, it.stats[key][2]);
    return 1;
  }
  const slotLabel = (slot) => {
    const kind = String(slot).replace(/_\d+$/, '');
    const i = Number((String(slot).match(/_(\d+)$/) || [])[1] || 0);
    if (kind === 'weapon') return 'Weapon ' + (i + 1);
    if (kind === 'armor') return 'Armor ' + (i === 0 ? '(front)' : i === 1 ? '(back)' : i + 1);
    if (kind === 'shield') return i ? 'Shield ' + (i + 1) : 'Shield';
    if (kind === 'droid_interface') return 'Droid interface';
    return kind.charAt(0).toUpperCase() + kind.slice(1);
  };

  // ---------- the model ----------
  function compute() {
    const all = [];
    data.items.forEach((it, idx) => { if (it.type === state.type && it.tier === state.tier) all.push([idx, it]); });
    const base = state.sel.size ? all.filter(([, it]) => state.sel.has(it.id)) : all;
    const keys = L.statKeysForType(state.type, all.map(([, it]) => it));
    const constraints = Object.entries(state.values);
    const passes = (it, except) => constraints.every(([k, v]) => k === except || L.canRoll(L.itemStat(it, k), v));
    const eligible = new Set(all.filter(([, it]) => passes(it)).map(([, it]) => it.id));
    const effective = base.filter(([, it]) => eligible.has(it.id));

    // NPCs that can drop any of the effective components, best odds first
    const effIdx = effective.map(([idx]) => idx);
    const npcRows = [];
    if (effIdx.length) {
      for (const n of npcs) {
        const p = L.killChance(n, drops.tableProbs(n.table), effIdx);
        if (p > 0) npcRows.push({ npc: n, p });
      }
      npcRows.sort((a, b) => b.p - a.p || a.npc.id.localeCompare(b.npc.id));
    }
    if (state.npc && !npcRows.some((r) => r.npc.id === state.npc)) state.npc = null;
    const oddsNpc = state.npc ? npcRows.find((r) => r.npc.id === state.npc).npc : npcRows.length ? npcRows[0].npc : null;
    const weights = oddsNpc ? drops.tableProbs(oddsNpc.table) : null;

    // pre-filled values: one component picked, stat fixed (min = max)
    const fixed = {}, auto = {};
    if (base.length === 1) {
      for (const k of keys) {
        const st = L.itemStat(base[0][1], k);
        if (st && st.hi - st.lo < 1e-9) {
          fixed[k] = st.lo;
          if (state.values[k] == null) auto[k] = st.lo;
        }
      }
    }

    const stats = keys.map((k) => {
      let set = base.filter(([, it]) => passes(it, k));
      if (!set.length) set = base;
      const range = L.statRange(set.map(([, it]) => it), k);
      const v = state.values[k] != null ? state.values[k] : auto[k];
      const odds = v != null && oddsNpc ? L.statKillChance(oddsNpc, weights, set, k, v) : null;
      return { key: k, set, range, value: v, auto: state.values[k] == null && auto[k] != null, odds, decimals: statDecimals(k, all.map(([, it]) => it)) };
    });

    const entered = { ...auto, ...state.values };
    const joint = Object.keys(state.values).length > 1 && oddsNpc ? L.jointKillChance(oddsNpc, weights, effective, entered) : null;
    return { all, base, eligible, effective, npcRows, oddsNpc, weights, stats, auto, fixed, joint, keys };
  }

  // ---------- rendering ----------
  function renderTiers() {
    for (const b of document.querySelectorAll('.lt-tier')) {
      const on = Number(b.dataset.tier) === state.tier;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }

  function renderItems() {
    const ul = $('#lt-items');
    ul.replaceChildren();
    if (!view.all.length) ul.append(el('li', { class: 'muted small lt-empty' }, 'No looted ' + typeLabel(state.type).toLowerCase() + 's at RE level ' + state.tier + '.'));
    for (const [, it] of view.all) {
      const ok = view.eligible.has(it.id);
      const on = ok && state.sel.has(it.id);
      ul.append(el('li', {
        class: 'lt-row' + (on ? ' on' : '') + (ok ? '' : ' off'), role: 'option', 'aria-selected': String(on), 'aria-disabled': String(!ok), tabindex: ok ? '0' : '-1',
        title: ok ? it.id : 'Can’t roll the value(s) entered below',
        onclick: () => ok && toggleItem(it.id),
        onkeydown: (e) => { if (ok && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); toggleItem(it.id); } },
      }, el('span', { class: 'lt-check', 'aria-hidden': 'true' }), el('span', { class: 'lt-row-name' }, L.prettyId(it.id)), el('code', { class: 'muted small' }, it.id)));
    }
    const n = view.all.length, picked = [...state.sel].filter((id) => view.eligible.has(id)).length;
    $('#lt-items-note').replaceChildren(
      n ? (picked ? picked + ' of ' + n + ' picked' : view.effective.length < n ? view.effective.length + ' of ' + n + ' possible' : 'all ' + n) : '',
      state.sel.size ? ' · ' : '',
      state.sel.size ? el('button', { type: 'button', class: 'link small', onclick: () => { state.sel.clear(); state.compName = null; update(); } }, 'clear') : '',
    );
  }

  function renderNpcs() {
    const ul = $('#lt-npcs');
    ul.replaceChildren();
    if (!view.npcRows.length) ul.append(el('li', { class: 'muted small lt-empty' }, view.effective.length ? 'No NPC ship drops these.' : 'Pick a component that can roll the values entered.'));
    for (const { npc, p } of view.npcRows.slice(0, MAX_NPCS_SHOWN)) {
      const on = npc.id === state.npc;
      ul.append(el('li', {
        class: 'lt-row lt-npc' + (on ? ' on' : '') + (npc === view.oddsNpc && !on ? ' top' : ''), role: 'option', 'aria-selected': String(on), tabindex: '0',
        title: npc.id + ' · loot table ' + npc.table + ' · loot chance ' + Math.round(npc.chance * 1000) / 10 + '%',
        onclick: () => pickNpc(npc.id),
        onkeydown: (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); pickNpc(npc.id); } },
      }, el('span', { class: 'lt-row-name' }, prettyNpc(npc.id)), el('span', { class: 'muted small lt-faction' }, npc.faction), el('span', { class: 'lt-odds' }, L.oneIn(p))));
    }
    const n = view.npcRows.length;
    $('#lt-npcs-note').textContent = n ? n.toLocaleString() + ' ship' + (n === 1 ? '' : 's') + (n > MAX_NPCS_SHOWN ? ', top ' + MAX_NPCS_SHOWN + ' shown' : '') : '';
    $('#lt-odds-npc').textContent = view.oddsNpc ? prettyNpc(view.oddsNpc.id) + (state.npc ? '' : ' (best odds)') : '—';
  }

  // stat rows are built once per type / tier and updated in place, so typing isn't interrupted
  let rowsKey = null;
  const rows = new Map(); // stat → { tr, min, max, input, slider, canvas, odds, clear, best, worst }
  function buildStatRows() {
    const tb = $('#lt-stats');
    tb.replaceChildren();
    rows.clear();
    for (const s of view.stats) {
      const k = s.key;
      const input = el('input', { type: 'text', inputmode: 'decimal', class: 'lt-val', 'aria-label': L.STATS[k].label + ' value', autocomplete: 'off' });
      const slider = el('input', { type: 'range', min: '0', max: '1000', step: '1', class: 'lt-range', 'aria-label': L.STATS[k].label + ' percentile' });
      const canvas = el('canvas', { class: 'lt-curve', width: '300', height: '34', 'aria-hidden': 'true' });
      const clear = el('button', { type: 'button', class: 'link small lt-clear', title: 'Clear', 'aria-label': 'Clear ' + L.STATS[k].label }, '✕');
      const r = {
        min: el('td', { class: 'num' }), max: el('td', { class: 'num' }), odds: el('td', { class: 'num lt-odds-cell' }),
        pct: el('span', { class: 'lt-pct small' }), worst: el('span', { class: 'small muted' }), best: el('span', { class: 'small muted' }),
        input, slider, canvas, clear,
      };
      input.addEventListener('change', () => commitTyped(k));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitTyped(k); } });
      slider.addEventListener('input', () => slid(k));
      clear.addEventListener('click', () => { delete state.values[k]; state.compName = null; update(); });
      r.tr = el('tr', null,
        el('th', { scope: 'row' }, L.STATS[k].label, L.STATS[k].lower ? el('span', { class: 'muted small', title: 'Lower is better' }, ' ↓') : null),
        r.min, r.max,
        el('td', { class: 'lt-val-cell' }, input, clear),
        el('td', { class: 'lt-slider-col' }, el('div', { class: 'lt-slider' }, canvas, slider), el('div', { class: 'lt-slider-ends' }, r.worst, r.pct, r.best)),
        r.odds);
      rows.set(k, r);
      tb.append(r.tr);
    }
  }

  function renderStats() {
    const key = state.type + ':' + state.tier + ':' + view.stats.map((s) => s.key).join(',');
    if (key !== rowsKey) { buildStatRows(); rowsKey = key; }
    for (const s of view.stats) {
      const r = rows.get(s.key);
      const d = s.decimals;
      r.min.textContent = s.range ? fmtNum(s.range.lo, d) : '—';
      r.max.textContent = s.range ? fmtNum(s.range.hi, d) : '—';
      if (document.activeElement !== r.input) r.input.value = s.value == null ? '' : String(L.round(s.value, d));
      r.input.classList.toggle('auto', s.auto);
      r.input.placeholder = s.range ? (s.range.lower ? '≤ ' : '≥ ') + '…' : '';
      r.clear.style.visibility = state.values[s.key] == null ? 'hidden' : 'visible'; // keeps its space: no column shifts
      const fixed = !s.range || Math.abs(s.range.best - s.range.worst) < 1e-12;
      r.slider.disabled = fixed;
      const pct = s.value == null || fixed ? (fixed && s.value != null ? 1 : null) : (s.value - s.range.worst) / (s.range.best - s.range.worst);
      if (document.activeElement !== r.slider) r.slider.value = String(Math.round((pct == null ? 0 : Math.max(0, Math.min(1, pct))) * 1000));
      r.slider.classList.toggle('unset', pct == null);
      r.pct.textContent = pct == null ? '' : Math.round(Math.max(0, Math.min(1, pct)) * 1000) / 10 + '%';
      r.worst.textContent = s.range ? fmtNum(s.range.worst, d) : '';
      r.best.textContent = s.range ? fmtNum(s.range.best, d) : '';
      r.odds.textContent = s.odds == null ? '' : L.oneIn(s.odds);
      r.odds.title = s.odds == null ? '' : 'Chance per kill: ' + (s.odds * 100).toPrecision(3) + '%';
      drawCurve(r.canvas, s, pct);
    }
    $('#lt-joint').textContent = view.joint == null ? '—' : L.oneIn(view.joint);
    $('#lt-joint-label').textContent = Object.keys(state.values).length > 1 ? 'All entered values together' : 'All entered values together (enter two or more)';
  }

  /** Bell curve (fill) and its S-shaped cumulative (line) across the slider, worst → best. */
  function drawCurve(canvas, s, pct) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!s.range || Math.abs(s.range.best - s.range.worst) < 1e-12) return;
    const comps = s.set.map(([idx, it]) => [view.weights ? view.weights.get(idx) || 0 : 1, L.itemStat(it, s.key)]).filter(([w, st]) => w > 0 && st);
    if (!comps.length) return;
    const N = 120, dens = [], cum = [];
    const wsum = comps.reduce((a, [w]) => a + w, 0);
    for (let i = 0; i <= N; i++) {
      const v = s.range.worst + (i / N) * (s.range.best - s.range.worst);
      let dsum = 0, tsum = 0;
      for (const [w, st] of comps) { dsum += w * L.densityAt(st, v); tsum += w * L.tailProb(st, v); }
      dens.push(dsum);
      cum.push(1 - tsum / wsum); // share of drops worse than v
    }
    const dmax = Math.max(...dens) || 1;
    const css = getComputedStyle(document.documentElement);
    const accent = (css.getPropertyValue('--accent') || '#e8b04b').trim();
    ctx.beginPath();
    ctx.moveTo(0, H);
    dens.forEach((d, i) => ctx.lineTo((i / N) * W, H - (d / dmax) * (H - 3)));
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    cum.forEach((c, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, (i / N) * W, H - c * (H - 3) - 1));
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function renderTarget() {
    const p = $('#lt-target');
    if (!target || !target.slot) { p.hidden = true; return; }
    const fits = L.typeForSlot(target.slot) === state.type;
    p.hidden = false;
    p.replaceChildren(
      'For the Ship Builder’s ', el('strong', null, slotLabel(target.slot)), ' slot',
      fits ? '' : ' (this component type doesn’t fit it, so a matching slot will be picked)',
      '. ',
      el('a', { href: '/swg/ships' }, 'Back to the ship'),
      ' · ',
      el('button', { type: 'button', class: 'link small', onclick: () => { target = null; session.set('lootTarget', null); renderTarget(); } }, 'forget slot'),
    );
  }

  function renderButtons() {
    const hasUserValue = view.stats.some((st) => st.value != null); // typed, slid or pre-filled
    $('#re-add').disabled = !hasUserValue;
    const hasProject = project.components.length > 0;
    for (const id of ['#re-clear', '#re-saveload', '#re-use']) $(id).disabled = !hasProject;
    $('#lt-comp-name').textContent = state.compName ? state.compName : '';
  }

  // ---------- RE project ----------
  function renderProject() {
    const comps = project.components;
    const type = project.type || state.type;
    const level = project.tier;
    if (document.activeElement !== $('#re-name')) $('#re-name').value = project.name || '';
    $('#re-level').textContent = level || '—';
    $('#re-bonus').textContent = level ? '+' + Math.round(L.reBonus(level) * 100) + '% bonus' : '';
    const sum = L.projectSummary(type, level || 0, comps);
    const summary = sum.values;
    const keys = L.statKeysForType(type, data.items.filter((it) => it.type === type));
    const tb = $('#re-summary');
    tb.replaceChildren();
    const cells = keys.map((k) => {
      const d = statDecimals(k, data.items.filter((it) => it.type === type && it.stats[k]));
      const est = sum.estimated.includes(k);
      // colour: where the value sits in the level's looted range with the RE bonus applied
      const pct = comps.length && !est && summary[k] != null ? levelPercentile(k, summary[k], true) : null;
      const td = el('td', {
        class: 'swg-v' + (est ? ' lt-est' : ''),
        title: est ? 'No value entered for any component: typical roll (middle of the range), plus the bonus'
          : pct != null ? Math.round(pct * 100) + 'th percentile of the RE ' + level + ' looted range with the +' + Math.round(L.reBonus(level) * 100) + '% bonus applied' : '',
      }, comps.length ? fmtNum(summary[k], d) + (est ? ' ~' : '') : '—');
      if (pct != null) td.style.color = pctColor(pct);
      return [el('th', { title: L.STATS[k].lower ? 'Lowest of the components, minus the bonus' : 'Highest of the components, plus the bonus' }, L.STATS[k].label), td];
    });
    for (let i = 0; i < cells.length; i += 2) tb.append(el('tr', null, cells[i], cells[i + 1] || [el('th'), el('td')]));

    const box = $('#re-tiles');
    box.replaceChildren();
    comps.forEach((c, i) => {
      const hide = type === 'armor' ? [] : ['hitpoints', 'armor'];
      const dl = el('dl', { class: 'swg-attrs small' });
      for (const k of keys) {
        if (hide.includes(k)) continue;
        const d = statDecimals(k, data.items.filter((it) => it.type === type && it.stats[k]));
        const v = c.values[k];
        const pct = v == null ? null : levelPercentile(k, v);
        const dd = el('dd', {
          class: v == null ? 'muted' : isBest(k, v) ? 'lt-best' : '',
          title: v == null ? (c.typical && c.typical[k] != null ? 'Not entered · typical roll ' + fmtNum(c.typical[k], d) : '') : Math.round(pct * 100) + 'th percentile among all RE ' + level + ' ' + typeLabel(type).toLowerCase() + 's' + (isBest(k, v) ? ' · best in the project' : ''),
        }, v == null ? '—' : fmtNum(v, d));
        if (pct != null) dd.style.color = pctColor(pct);
        dl.append(el('dt', null, L.STATS[k].label), dd);
      }
      box.append(el('article', { class: 'swg-slot swg-k-' + (L.TYPES[type] ? L.TYPES[type].slot : type) },
        el('header', { class: 'swg-slot-head' }, el('span', { class: 'swg-slot-name' }, 'Component ' + (i + 1)),
          el('button', { type: 'button', class: 'link small', title: 'Remove from the project', 'aria-label': 'Remove ' + c.name, onclick: () => removeFromProject(i) }, '✕')),
        el('div', { class: 'swg-part' }, el('strong', null, c.name), el('code', { class: 'small muted' }, c.itemIds.length === 1 ? c.itemIds[0] : c.itemIds.length + ' possible components')),
        dl));
    });
    const fillers = level ? level - comps.length : 0;
    $('#re-cap').textContent = level
      ? comps.length + ' of ' + level + ' components (an RE level ' + level + ' project requires ' + level + 'x level ' + level + ' ' + typeLabel(type).toLowerCase() + 's' +
        (fillers > 0 ? ', currently assuming ' + fillers + 'x filler component' + (fillers === 1 ? '' : 's') : '') + ').'
      : 'Add looted components with at least one stat value entered.';

    /** Where v sits between the worst and best roll of every component of this type and RE level (0–1). */
    function levelPercentile(k, v, withBonus) {
      const r = L.statRange(data.items.filter((it) => it.type === type && it.tier === level), k);
      if (!r || Math.abs(r.best - r.worst) < 1e-12) return 1;
      const f = withBonus ? (r.lower ? 1 - L.reBonus(level) : 1 + L.reBonus(level)) : 1;
      const worst = r.worst * f, best = r.best * f;
      return Math.max(0, Math.min(1, (v - worst) / (best - worst)));
    }
    function isBest(k, v) {
      const lower = L.STATS[k].lower;
      return comps.every((o) => o.values[k] == null || (lower ? v <= o.values[k] : v >= o.values[k]));
    }
  }

  function saveProject() { session.set('reProject', project); }
  /** Default RE project name: "R8 Weapon"; RE level 10 is "R0". */
  const reName = (type, tier) => 'R' + (tier % 10) + ' ' + typeLabel(type);

  function addToProject() {
    const msg = $('#re-msg');
    const cur = currentComponent();
    if (project.components.length) {
      if (project.type !== state.type) return (msg.textContent = 'This project is for ' + typeLabel(project.type).toLowerCase() + 's.');
      if (project.tier !== state.tier) return (msg.textContent = 'This project only takes RE level ' + project.tier + ' components.');
      if (project.components.length >= project.tier) return (msg.textContent = 'An RE level ' + project.tier + ' project holds at most ' + project.tier + ' components.');
    } else {
      project.type = state.type;
      project.tier = state.tier;
      if (!project.name) project.name = reName(state.type, state.tier);
    }
    project.components.push({ name: cur.name, itemIds: cur.itemIds, values: cur.values, typical: cur.typical });
    msg.textContent = 'Added ' + cur.name + '.';
    saveProject();
    renderProject();
    renderButtons();
  }
  function removeFromProject(i) {
    project.components.splice(i, 1);
    if (!project.components.length) { project.type = null; project.tier = null; }
    saveProject();
    renderProject();
    renderButtons();
  }
  function clearProject() {
    if (!confirm('Remove every component from the RE project?')) return;
    project = { name: '', type: null, tier: null, components: [] };
    saveProject();
    $('#re-msg').textContent = '';
    renderProject();
    renderButtons();
  }

  // ---------- the component on screen ----------
  /** { name, itemIds, values (entered + pre-filled), typical (missing stats at the middle of their range) } */
  function currentComponent() {
    const eff = view.effective.map(([, it]) => it);
    const values = {};
    for (const s of view.stats) if (s.value != null) values[s.key] = L.round(s.value, s.decimals);
    const typical = { ...values };
    for (const s of view.stats) {
      if (typical[s.key] != null) continue;
      const r = L.statRange(eff.length ? eff : view.base.map(([, it]) => it), s.key);
      if (r) typical[s.key] = L.round((r.lo + r.hi) / 2, s.decimals);
    }
    const name = eff.length === 1 ? L.prettyId(eff[0].id) : typeLabel(state.type) + ' (RE ' + state.tier + ')';
    return { name, itemIds: eff.map((it) => it.id), values, typical };
  }

  // ---------- events ----------
  function toggleItem(id) {
    if (state.sel.has(id)) state.sel.delete(id);
    else state.sel.add(id);
    state.compName = null;
    update();
  }
  function pickNpc(id) {
    state.npc = state.npc === id ? null : id;
    update();
  }
  function commitTyped(k) {
    const s = view.stats.find((x) => x.key === k);
    const r = rows.get(k);
    const raw = r.input.value.replace(/,/g, '').trim();
    if (raw === '') delete state.values[k];
    else {
      let v = Number(raw);
      if (!Number.isFinite(v)) { r.input.value = state.values[k] != null ? String(state.values[k]) : ''; return; }
      if (s.range) v = Math.min(s.range.hi, Math.max(s.range.lo, v)); // only values the components can roll
      state.values[k] = L.round(v, s.decimals);
    }
    state.compName = null;
    update();
    r.input.value = state.values[k] != null ? String(state.values[k]) : '';
  }
  function slid(k) {
    const s = view.stats.find((x) => x.key === k);
    if (!s.range) return;
    const pct = Number(rows.get(k).slider.value) / 1000;
    state.values[k] = L.round(s.range.worst + pct * (s.range.best - s.range.worst), s.decimals);
    state.compName = null;
    update();
  }
  /** Clear Component: no values, no component or ship picked (keeps type, level and the RE project). */
  function clearComponent() {
    state.sel.clear();
    state.values = {};
    state.npc = null;
    state.compName = null;
    $('#lt-all-pct').textContent = '—';
    $('#lt-all-note').textContent = '';
    $('#lt-all').value = '500';
    update();
  }
  /** Every stat at the same percentile of its range (0 = worst, 1 = best). */
  function setAllPercentile(p) {
    // Each stat's range is taken over the components that can roll the *other* entered values,
    // so setting one value can narrow another stat's range. Repeat until the values sit at p of
    // the ranges they produce (usually 2–4 rounds).
    state.values = {};
    for (let round = 0; round < 25; round++) {
      const v = compute();
      const next = {};
      for (const s of v.stats) {
        if (!s.range || Math.abs(s.range.best - s.range.worst) < 1e-12) continue;
        next[s.key] = L.round(s.range.worst + p * (s.range.best - s.range.worst), s.decimals);
      }
      const same = Object.keys(next).length === Object.keys(state.values).length && Object.entries(next).every(([k, x]) => state.values[k] === x);
      state.values = next;
      if (same) break;
    }
    state.compName = null;
    $('#lt-all-pct').textContent = Math.round(p * 1000) / 10 + '%';
    update();
    $('#lt-all-note').textContent = view.effective.length
      ? ''
      : 'No single component can roll every stat at ' + Math.round(p * 1000) / 10 + '% of these ranges. Press Clear Component, tick one component, then set the percentile again to use that component’s own ranges.';
  }
  function setType(t, keepValues) {
    if (t === state.type) return;
    state.type = t;
    state.sel.clear();
    if (!keepValues) state.values = {};
    state.npc = null;
    state.compName = null;
    local.set('loot.type', t);
    $('#lt-type').value = t;
    update();
  }
  function setTier(n) {
    if (n === state.tier) return;
    state.tier = n;
    state.sel.clear();
    state.values = {};
    state.npc = null;
    state.compName = null;
    local.set('loot.tier', n);
    update();
  }

  function update() {
    view = compute();
    renderTiers();
    renderTarget();
    renderItems();
    renderNpcs();
    renderStats();
    renderButtons();
    if (!project.components.length) renderProject();
  }

  // ---------- saving / using ----------
  async function api(path, opts) {
    const res = await fetch('/swg/api' + path, { ...opts, headers: { accept: 'application/json', 'content-type': 'application/json' } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Request failed (' + res.status + ')');
    return body;
  }

  function componentDoc() {
    const c = currentComponent();
    return { kind: 'loot', type: state.type, tier: state.tier, itemIds: c.itemIds, values: c.values, ship: { ...L.toShipFields(state.type, c.typical), reLevel: state.tier } };
  }
  function projectDoc() {
    const summary = L.projectSummary(project.type, project.tier, project.components).values;
    const values = {};
    for (const [k, v] of Object.entries(summary)) if (v != null) values[k] = L.round(v, 3);
    return { kind: 're', type: project.type, tier: project.tier, values, ship: { ...L.toShipFields(project.type, values), reLevel: project.tier }, components: project.components };
  }

  async function save(kind, name) {
    const doc = kind === 're' ? projectDoc() : componentDoc();
    const r = await api('/components/' + encodeURIComponent(name), { method: 'PUT', body: JSON.stringify(doc) });
    if (kind === 're') { project.name = r.name; saveProject(); } else state.compName = r.name;
    return r.name;
  }

  async function useInShip(kind) {
    const msg = $('#re-msg');
    try {
      let name;
      if (kind === 're') {
        name = await save('re', project.name || reName(project.type, project.tier));
      } else {
        const c = currentComponent();
        name = state.compName || (await save('loot', c.name + ' · ' + new Date().toLocaleString('en-CA', { dateStyle: 'short', timeStyle: 'short' })));
        if (state.compName) await save('loot', state.compName);
      }
      const type = kind === 're' ? project.type : state.type;
      const slot = target && target.slot && L.typeForSlot(target.slot) === type ? target.slot : '';
      session.set('lootTarget', null);
      location.href = '/swg/ships?use=' + encodeURIComponent(name) + (slot ? '&slot=' + encodeURIComponent(slot) : '');
    } catch (err) {
      msg.textContent = err.message;
      $('#lt-comp-name').textContent = err.message;
    }
  }

  // floating save / load panel, for components or RE projects
  const panel = $('#lt-panel');
  let panelKind = 'loot';
  const pmsg = (t, bad) => { const m = $('#lt-panel-msg'); m.textContent = t || ''; m.classList.toggle('bad', !!bad); };
  function openPanel(kind, anchor) {
    panelKind = kind;
    $('#lt-panel-title').textContent = kind === 're' ? 'RE projects' : 'Looted components';
    $('#lt-save-name').value = kind === 're' ? project.name || '' : state.compName || currentComponent().name;
    $('#lt-save-form').hidden = kind === 're' && !project.components.length;
    const r = anchor.getBoundingClientRect();
    panel.style.top = Math.min(window.innerHeight - 200, r.bottom + 8) + 'px';
    panel.style.left = Math.max(16, Math.min(window.innerWidth - panel.offsetWidth - 16, r.left)) + 'px';
    panel.hidden = false;
    const w = panel.offsetWidth;
    panel.style.left = Math.max(16, Math.min(window.innerWidth - w - 16, r.right - w)) + 'px';
    pmsg('');
    $('#lt-save-name').focus();
    refreshSaved();
  }
  const closePanel = () => { panel.hidden = true; };
  async function refreshSaved() {
    const ul = $('#lt-saved-list');
    ul.replaceChildren(el('li', { class: 'muted small' }, 'Loading…'));
    try {
      const { components } = await api('/components?kind=' + panelKind);
      ul.replaceChildren();
      if (!components.length) ul.append(el('li', { class: 'muted small' }, 'Nothing saved yet.'));
      for (const c of components) {
        ul.append(el('li', { class: 'swg-build' },
          el('button', { type: 'button', class: 'swg-build-load', onclick: () => load(c.name) },
            el('span', { class: 'strong' }, c.name),
            el('span', { class: 'muted small' }, typeLabel(c.type) + ' · RE ' + c.tier + ' · ' + new Date(c.updatedAt).toLocaleDateString())),
          el('button', { type: 'button', class: 'link small', 'aria-label': 'Delete ' + c.name, onclick: () => remove(c.name) }, 'Delete')));
      }
    } catch (err) {
      ul.replaceChildren();
      pmsg(err.message, true);
    }
  }
  async function load(name) {
    try {
      const { component: c } = await api('/components/' + encodeURIComponent(name));
      if (c.kind === 're') {
        project = { name: c.name, type: c.type, tier: c.tier, components: (c.components || []).map((x) => ({ name: x.name, itemIds: x.itemIds || [], values: x.values || {}, typical: x.typical || {} })) };
        saveProject();
        renderProject();
        renderButtons();
      } else {
        state.type = c.type;
        state.tier = c.tier;
        $('#lt-type').value = c.type;
        const ids = new Set(data.items.filter((it) => it.type === c.type && it.tier === c.tier).map((it) => it.id));
        const picked = (c.itemIds || []).filter((id) => ids.has(id));
        state.sel = new Set(picked.length < ids.size ? picked : []);
        state.values = { ...(c.values || {}) };
        state.npc = null;
        state.compName = c.name;
        update();
        // values that were pre-filled (fixed stats) don't count as entered
        for (const [k, v] of Object.entries(view.fixed)) if (Math.abs((state.values[k] ?? NaN) - v) < 1e-6) delete state.values[k];
        update();
      }
      closePanel();
    } catch (err) { pmsg(err.message, true); }
  }
  async function remove(name) {
    if (!confirm('Delete “' + name + '”?')) return;
    try {
      await api('/components/' + encodeURIComponent(name), { method: 'DELETE' });
      if (panelKind === 'loot' && state.compName === name) state.compName = null;
      pmsg('Deleted “' + name + '”.');
      renderButtons();
      refreshSaved();
    } catch (err) { pmsg(err.message, true); }
  }

  // ---------- start ----------
  async function init() {
    const sel = $('#lt-type');
    for (const t of L.TYPE_KEYS) sel.append(el('option', { value: t }, L.TYPES[t].label));
    sel.addEventListener('change', () => setType(sel.value));
    for (const b of document.querySelectorAll('.lt-tier')) b.addEventListener('click', () => setTier(Number(b.dataset.tier)));
    $('#re-add').addEventListener('click', addToProject);
    $('#lt-comp-clear').addEventListener('click', clearComponent);
    $('#lt-comp-clear2').addEventListener('click', clearComponent);
    $('#lt-all').addEventListener('input', (e) => setAllPercentile(Number(e.target.value) / 1000));
    $('#re-clear').addEventListener('click', clearProject);
    $('#re-use').addEventListener('click', () => useInShip('re'));
    $('#lt-comp-use').addEventListener('click', () => useInShip('loot'));
    $('#lt-comp-saveload').addEventListener('click', (e) => (panel.hidden || panelKind !== 'loot' ? openPanel('loot', e.currentTarget) : closePanel()));
    $('#re-saveload').addEventListener('click', (e) => (panel.hidden || panelKind !== 're' ? openPanel('re', e.currentTarget) : closePanel()));
    $('[data-close]', panel).addEventListener('click', closePanel);
    $('#lt-save-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = $('#lt-save-name').value.trim();
      if (!name) return pmsg('Give it a name.', true);
      try {
        const saved = await save(panelKind, name);
        pmsg('Saved “' + saved + '”.');
        renderButtons();
        renderProject();
        refreshSaved();
      } catch (err) { pmsg(err.message, true); }
    });
    $('#re-name').addEventListener('input', (e) => { project.name = e.target.value; saveProject(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) closePanel(); });
    document.addEventListener('mousedown', (e) => {
      if (!panel.hidden && !panel.contains(e.target) && !e.target.closest('#lt-comp-saveload, #re-saveload')) closePanel();
    });

    // arriving from a ship builder slot: /swg/loot?slot=weapon_1
    const qs = new URLSearchParams(location.search);
    if (qs.get('slot')) {
      target = { slot: qs.get('slot') };
      session.set('lootTarget', target);
      // a new looted component for a ship slot starts with a fresh RE project
      project = { name: '', type: null, tier: null, components: [] };
      saveProject();
      history.replaceState(null, '', location.pathname);
    }
    const fromSlot = target && target.slot ? L.typeForSlot(target.slot) : null;
    state.type = fromSlot || (L.TYPES[local.get('loot.type')] ? local.get('loot.type') : 'reactor');
    const t = Number(local.get('loot.tier'));
    state.tier = t >= 1 && t <= 10 ? t : 1;
    sel.value = state.type;

    try {
      data = await api('/loot');
    } catch (err) {
      $('#lt-items').replaceChildren(el('li', { class: 'bad' }, 'Could not load the loot data: ' + err.message));
      return;
    }
    npcs = data.npcs.map(([id, chance, rolls, table, faction]) => ({ id, chance, rolls, table, faction }));
    drops = L.makeDropIndex(data);
    update();
    renderProject();
    renderButtons();
  }
  init();
})();
