/* SWG Crafting page — the UI. The math is in swg-craft-calc.js (window.SwgCraft). */
(function () {
  'use strict';
  const C = window.SwgCraft;
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const MEDICAL = ['doctor', 'combatmedic'];
  const SLOT_KIND = { 1: 'identical', 2: 'mixed', 3: 'optional, identical', 4: 'optional' };
  const LS = 'swg.craft';

  let data = null;
  let bySchem = {};
  let byTarget = {};
  let saved = []; // [{ name, schematic, target, updatedAt }]
  const savedCache = {}; // name → full doc
  let result = null;

  const prefs = (() => {
    try {
      return JSON.parse(localStorage.getItem(LS)) || {};
    } catch {
      return {};
    }
  })();
  const state = { prof: prefs.prof || 'weaponsmith', id: prefs.id || null, showAll: !!prefs.showAll, showFixed: !!prefs.showFixed, search: '', itemName: '' };
  const inputs = {}; // schematic id → inputs
  const remember = () => {
    try {
      localStorage.setItem(LS, JSON.stringify({ prof: state.prof, id: state.id, showAll: state.showAll, showFixed: state.showFixed }));
    } catch {
      /* ignore */
    }
  };

  const defaultInputs = () => ({ mode: 'uniform', uniform: 900, manual: {}, comps: {}, assembly: 1, expMode: 'max', exp: {} });
  const cur = () => (state.id ? (inputs[state.id] = inputs[state.id] || defaultInputs()) : null);

  // ---------- API ----------
  async function api(path, opts) {
    const res = await fetch('/swg/api' + path, { ...opts, headers: { accept: 'application/json', 'content-type': 'application/json' } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Request failed (' + res.status + ')');
    return body;
  }
  async function loadSavedList() {
    try {
      saved = (await api('/crafted')).items || [];
    } catch (e) {
      saved = [];
      $('#cr-panel-msg').textContent = e.message;
    }
  }
  async function getSaved(name) {
    const k = name.toLowerCase();
    if (!savedCache[k]) savedCache[k] = (await api('/crafted/' + encodeURIComponent(name))).item;
    return savedCache[k];
  }

  // ---------- professions & list ----------
  function inTab(s, tab) {
    if (s.p.includes(tab)) return true;
    if (MEDICAL.includes(tab)) return s.p.includes('medic');
    return s.p.includes('artisan');
  }
  const nfsOn = () => !window.SwgNfs || window.SwgNfs.on();
  const category = (s) => {
    const parts = s.t.replace(/^tangible\//, '').split('/');
    parts.pop();
    return parts.map((p) => C.attrLabel(p)).join(' › ') || 'Other';
  };

  function renderProfs() {
    const el = $('#cr-profs');
    el.innerHTML = data.professions
      .map((p) => `<button type="button" role="tab" class="cr-prof" data-prof="${p.id}" aria-selected="${p.id === state.prof}">${esc(p.label)}</button>`)
      .join('');
  }

  function renderList() {
    const q = state.search.trim().toLowerCase();
    const shown = data.schematics.filter((s) => inTab(s, state.prof) && (state.showAll || s.st) && (nfsOn() || !s.nfs) && (!q || s.n.toLowerCase().includes(q)));
    const groups = new Map();
    for (const s of shown) {
      const c = category(s);
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c).push(s);
    }
    const keys = [...groups.keys()].sort((a, b) => a.localeCompare(b));
    const tag = (s) =>
      s.p.includes(state.prof) ? '' : s.p.includes('artisan') ? '<span class="cr-tag">Artisan</span>' : s.p.includes('medic') ? '<span class="cr-tag">Medic</span>' : '';
    $('#cr-list').innerHTML = keys
      .map(
        (k) =>
          `<div class="cr-group"><div class="cr-group-head">${esc(k)}</div>` +
          groups
            .get(k)
            .map(
              (s) =>
                `<button type="button" role="option" class="cr-item${s.st ? '' : ' cr-statless'}" data-id="${esc(s.id)}" aria-selected="${s.id === state.id}">${esc(s.n)}${tag(s)}${data.targets[s.t].nfs ? '<span class="cr-tag cr-nfs" title="NFS changed this item’s stat ranges">NFS</span>' : ''}</button>`,
            )
            .join('') +
          '</div>',
      )
      .join('');
    $('#cr-count').textContent = shown.length + ' schematic' + (shown.length === 1 ? '' : 's');
  }

  // ---------- the schematic ----------
  const schem = () => bySchem[state.id];
  const target = (s = schem()) => data.targets[s.t];

  function selectSchematic(id, keepName) {
    if (!bySchem[id]) return;
    state.id = id;
    if (!keepName) state.itemName = '';
    remember();
    document.querySelectorAll('.cr-item').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.id === id)));
    renderSchematic();
  }

  function renderSchematic() {
    const s = schem();
    $('#cr-empty').hidden = !!s;
    $('#cr-schematic').hidden = !s;
    if (!s) return;
    const t = target(s);
    const inp = cur();
    $('#cr-name').textContent = s.n;
    const profs = s.p.map((p) => (data.professions.find((x) => x.id === p) || { label: p === 'artisan' ? 'Artisan' : p === 'medic' ? 'Medic' : p }).label);
    $('#cr-meta').textContent = `${profs.join(', ')} · complexity ${s.cx} · ${s.xp} XP · ${category(s)}`;
    const notes = [];
    if (t.nfs) notes.push('NFS has changed this item’s stat ranges from public SWGEmu.');
    if (/^tangible\/wearables\//.test(s.t) && !t.armor) notes.push('Clothing doesn’t take stats from its components (only skill mods from bio-engineered cloth, which this page doesn’t model).');
    if (!s.st) notes.push('Materials don’t change any of this item’s stats.');
    $('#cr-notes').hidden = !notes.length;
    $('#cr-notes').textContent = notes.join(' ');
    $('#cr-item-name').textContent = state.itemName ? 'Editing “' + state.itemName + '”' : '';

    // resources
    document.querySelectorAll('input[name=cr-mode]').forEach((r) => (r.checked = r.value === inp.mode));
    $('#cr-uniform').hidden = inp.mode !== 'uniform';
    $('#cr-manual').hidden = inp.mode !== 'manual';
    $('#cr-uniform-range').value = inp.uniform;
    $('#cr-uniform-num').value = inp.uniform;
    renderResourceTable();

    // components
    const compSlots = s.s.map((x, i) => [x, i]).filter(([x]) => x[1]);
    $('#cr-comp-card').hidden = !compSlots.length;
    renderComponents();

    // assembly / experimentation
    $('#cr-assembly').innerHTML = C.ASSEMBLY.map((a, i) => `<option value="${i}"${i === inp.assembly ? ' selected' : ''}>${esc(a.label)} (×${a.mod})</option>`).join('');
    document.querySelectorAll('input[name=cr-exp]').forEach((r) => (r.checked = r.value === inp.expMode));
    recompute();
  }

  function renderResourceTable() {
    const s = schem();
    const inp = cur();
    const stats = C.relevantStats(target(s));
    const res = s.s.map((x, i) => [x, i]).filter(([x]) => !x[1]);
    if (!res.length) {
      $('#cr-res-table').innerHTML = '<tr><td class="muted">No resource slots.</td></tr>';
      return;
    }
    const head = `<thead><tr><th>Slot</th><th>Resource</th><th class="num">Qty</th>${stats.map((st) => `<th class="num" title="${esc(C.STATS[st] || st)}">${st}</th>`).join('')}</tr></thead>`;
    const rows = res
      .map(([x, i]) => {
        const v = inp.manual[i] || {};
        return `<tr><td>${esc(C.slotLabel(x[0]))}</td><td class="muted">${esc(C.resourceLabel(x[2]))}</td><td class="num">${x[3]}</td>${stats
          .map((st) => `<td class="num"><input class="cr-num cr-stat" type="number" min="0" max="1000" step="1" data-slot="${i}" data-stat="${st}" value="${v[st] == null ? '' : v[st]}" aria-label="${esc(C.slotLabel(x[0]) + ' ' + (C.STATS[st] || st))}"></td>`)
          .join('')}</tr>`;
      })
      .join('');
    const fill = `<tfoot><tr><td colspan="3" class="muted small">Fill every slot with</td>${stats.map((st) => `<td class="num"><input class="cr-num cr-fill" type="number" min="0" max="1000" step="1" data-stat="${st}" aria-label="Fill ${esc(C.STATS[st] || st)}"></td>`).join('')}</tr></tfoot>`;
    $('#cr-res-table').innerHTML = head + '<tbody>' + rows + '</tbody>' + (res.length > 1 ? fill : '');
  }

  // ---------- components ----------
  function fitSchematics(slot) {
    const out = [];
    for (const t of slot[5] || []) for (const s of byTarget[t] || []) out.push(s);
    return out;
  }
  function fittingSaved(slot) {
    return saved.filter((it) => C.fits(slot, it.target));
  }

  function renderComponents() {
    const s = schem();
    const inp = cur();
    const html = s.s
      .map((slot, i) => {
        if (!slot[1]) return '';
        const sel = inp.comps[i] || null;
        const fitsS = fitSchematics(slot);
        const fitsSaved = fittingSaved(slot);
        const other = saved.filter((it) => !fitsSaved.includes(it));
        const val = sel ? (sel.kind === 'saved' ? 'saved:' + sel.name : sel.kind === 'sim' ? 'sim:' + sel.id : 'manual') : '';
        const opt = (v, label) => `<option value="${esc(v)}"${v === val ? ' selected' : ''}>${esc(label)}</option>`;
        const options =
          opt('', slot[1] >= 3 ? '— empty —' : '— not filled —') +
          (fitsSaved.length ? `<optgroup label="Saved">${fitsSaved.map((it) => opt('saved:' + it.name, it.name)).join('')}</optgroup>` : '') +
          (fitsS.length ? `<optgroup label="Simulate">${fitsS.map((f) => opt('sim:' + f.id, f.n)).join('')}</optgroup>` : '') +
          (other.length ? `<optgroup label="Other saved items">${other.map((it) => opt('saved:' + it.name, it.name)).join('')}</optgroup>` : '') +
          opt('manual', 'Enter stats by hand…');
        let extra = '';
        if (sel && sel.kind === 'sim') {
          extra = `<div class="cr-comp-sim small"><label>Resource value <input class="cr-num cr-sim-value" type="number" min="1" max="1000" step="1" data-slot="${i}" value="${sel.value}"></label>
            <label><input type="checkbox" class="cr-sim-exp" data-slot="${i}"${sel.exp === 'max' ? ' checked' : ''}> fully experimented</label>
            <button type="button" class="link small cr-to-manual" data-slot="${i}">edit these stats</button></div>`;
        }
        if (sel && (sel.kind === 'manual' || sel.kind === 'saved') && sel.props) {
          const visible = sel.props.filter((p) => !/^(xp|complexity)$/.test(p[0]));
          const editable = sel.kind === 'manual';
          extra += `<div class="cr-comp-props small">${visible
            .map(
              (p, k) =>
                `<label class="cr-prop${p[4] ? ' cr-prop-hidden' : ''}" title="${esc(p[0])}">${esc(C.attrLabel(p[0]))}${editable ? ` <input class="cr-num cr-prop-in" type="number" step="any" data-slot="${i}" data-prop="${esc(p[0])}" value="${esc(+Number(p[1]).toFixed(3))}">` : ` <strong>${esc(C.fmt(Number(p[1]), p[2]))}</strong>`}</label>`,
            )
            .join('')}${editable ? `<button type="button" class="link small cr-prop-add" data-slot="${i}">+ stat</button>` : ''}</div>`;
        }
        if (sel && sel.missing) extra += `<p class="small bad">Saved item “${esc(sel.name)}” no longer exists; using the copy kept with this item.</p>`;
        return `<div class="cr-comp">
          <div class="cr-comp-head"><strong>${esc(C.slotLabel(slot[0]))}</strong> <span class="muted small">${slot[3]}× ${esc(C.attrLabel(slot[2].split('/').pop()))} · ${SLOT_KIND[slot[1]] || ''}${slot[4] !== 100 ? ' · ' + slot[4] + '% contribution' : ''}</span></div>
          <select class="cr-comp-sel" data-slot="${i}" aria-label="${esc(C.slotLabel(slot[0]))}">${options}</select>${extra}</div>`;
      })
      .join('');
    $('#cr-comps').innerHTML = html;
  }

  /** Craft a component here: uniform resources, great assembly, required sub-components simulated too. */
  function simulate(s, value, exp, depth = 0) {
    const comps = {};
    if (depth < 3)
      s.s.forEach((slot, i) => {
        if (slot[1] !== 1 && slot[1] !== 2) return;
        const f = fitSchematics(slot)[0];
        if (f) comps[i] = simulate(f, value, exp, depth + 1);
      });
    const r = C.craft(s, data.targets[s.t], { uniform: value, assembly: 1, experiment: exp, components: comps });
    return { target: s.t, props: r.props };
  }

  function componentsFor(inp) {
    const out = {};
    for (const [i, sel] of Object.entries(inp.comps)) {
      if (!sel) continue;
      if (sel.kind === 'sim') {
        const f = bySchem[sel.id];
        if (f) out[i] = simulate(f, sel.value, sel.exp);
      } else if (sel.props) out[i] = { target: sel.target, props: sel.props };
    }
    return out;
  }

  // ---------- compute & render results ----------
  function recompute() {
    const s = schem();
    if (!s) return;
    const inp = cur();
    const opts = { assembly: inp.assembly, components: componentsFor(inp) };
    if (inp.mode === 'uniform') opts.uniform = inp.uniform;
    else opts.resources = inp.manual;
    opts.experiment = inp.expMode === 'max' ? 'max' : inp.expMode === 'custom' ? inp.exp : null;
    result = C.craft(s, target(s), opts);
    renderAverages();
    renderExpRows();
    renderResult();
    renderArmor();
  }

  function renderAverages() {
    const s = schem();
    const stats = C.relevantStats(target(s));
    const inp = cur();
    if (!stats.length) {
      $('#cr-averages').textContent = 'No stat of this item reads resource stats.';
      return;
    }
    if (inp.mode === 'uniform') {
      $('#cr-averages').innerHTML = `<span class="muted">Relevant stats:</span> ${stats.map((st) => `<span title="${esc(C.STATS[st] || st)}">${st}</span>`).join(' · ')}`;
      return;
    }
    $('#cr-averages').innerHTML =
      '<span class="muted">Averages:</span> ' + stats.map((st) => `<span title="${esc(C.STATS[st] || st)}">${st} <strong>${result.averages[st] == null ? '—' : Math.round(result.averages[st] * 10) / 10}</strong></span>`).join(' · ');
  }

  function renderExpRows() {
    const inp = cur();
    const el = $('#cr-exp-rows');
    el.hidden = inp.expMode !== 'custom';
    const groups = result.groups;
    if (!groups.length) {
      el.hidden = true;
      $('#cr-exp-note').textContent = 'Nothing on this item can be experimented on.';
      return;
    }
    const total = groups.reduce((n, g) => n + (Number((inp.exp[g.group] || [])[0]) || 0), 0);
    const capTotal = groups.reduce((n, g) => n + g.pointsToCap, 0);
    $('#cr-exp-note').textContent =
      inp.expMode === 'custom'
        ? `${total} point${total === 1 ? '' : 's'} spent. Every point adds to the % of every stat in its row; Amazing reaches every cap with ${capTotal} point${capTotal === 1 ? '' : 's'}.`
        : `Reaching every cap takes ${capTotal} experimentation point${capTotal === 1 ? '' : 's'} of Amazing success (more with weaker results).`;
    if (el.hidden) return;
    if (el.dataset.for === state.id + '|' + groups.map((g) => g.group).join(',')) {
      for (const g of groups) {
        const hint = el.querySelector(`[data-hint="${CSS.escape(g.group)}"]`);
        if (hint) hint.textContent = g.pointsToCap + ' to cap';
      }
      return;
    }
    el.dataset.for = state.id + '|' + groups.map((g) => g.group).join(',');
    el.innerHTML = groups
      .map((g) => {
        const [pts, out] = inp.exp[g.group] || [0, 0];
        return `<div class="cr-exp-row"><div><strong>${esc(g.label)}</strong><div class="muted small">${g.attrs.map((n) => esc(C.attrLabel(n))).join(', ')}</div></div>
          <label class="small">Points <input class="cr-num cr-exp-pts" type="number" min="0" max="50" step="1" data-group="${esc(g.group)}" value="${pts}"></label>
          <label class="small">Result <select class="cr-exp-out" data-group="${esc(g.group)}">${C.EXPERIMENT.map((e, i) => `<option value="${i}"${i === out ? ' selected' : ''}>${esc(e.label)} (${e.per > 0 ? '+' : ''}${+(e.per * 100).toFixed(1)}%)</option>`).join('')}</select></label>
          <span class="muted small" data-hint="${esc(g.group)}">${g.pointsToCap} to cap</span></div>`;
      })
      .join('');
  }

  function renderResult() {
    const rows = result.attrs.filter((a) => !/^(xp|complexity)$/.test(a.name) && (state.showFixed || a.experimentable || a.source === 'component' || (a.min !== a.max && !a.filler)));
    const pctBar = (a) => {
      if (!a.experimentable) return '';
      const cap = Math.max(0, Math.min(1, a.maxPct));
      const p = Math.max(0, Math.min(1, a.pct));
      return `<div class="cr-bar" title="${(p * 100).toFixed(1)}% of ${(cap * 100).toFixed(1)}% cap"><div class="cr-bar-cap" data-w="${cap}"></div><div class="cr-bar-fill" data-w="${p}"></div></div>`;
    };
    const range = (a) => (a.min === a.max ? C.fmt(a.min, a.precision) : `${C.fmt(a.min, a.precision)} – ${C.fmt(a.max, a.precision)}`);
    const body = rows
      .map((a) => {
        const at = a.value === a.maxValue && a.experimentable;
        const src = a.source === 'component' ? '<span class="cr-tag">component</span>' : a.fromComponents ? `<span class="muted small" title="added by components"> (+${C.fmt(a.fromComponents, a.precision)})</span>` : '';
        return `<tr class="${a.experimentable ? '' : 'cr-fixed'}"><th title="${esc(a.name)}">${esc(a.label)}${src}</th><td class="muted small">${esc(a.groupLabel)}</td><td class="num muted">${range(a)}</td><td class="num">${C.fmt(a.assemblyValue, a.precision)}</td><td class="num cr-val${at ? ' cr-at-cap' : ''}">${C.fmt(a.value, a.precision)}</td><td class="num muted">${a.experimentable ? C.fmt(a.maxValue, a.precision) : ''}</td><td class="cr-bar-cell">${pctBar(a)}</td></tr>`;
      })
      .join('');
    $('#cr-result').innerHTML = `<thead><tr><th>Stat</th><th>Row</th><th class="num">Range</th><th class="num">Assembly</th><th class="num">Result</th><th class="num">Cap</th><th></th></tr></thead><tbody>${body || '<tr><td colspan="7" class="muted">No stats.</td></tr>'}</tbody>`;
    // widths are set here, not in the markup: the CSP doesn't allow inline style attributes
    document.querySelectorAll('#cr-result [data-w]').forEach((el) => (el.style.width = Number(el.dataset.w) * 100 + '%'));
  }

  function renderArmor() {
    const a = result.armor;
    $('#cr-armor').hidden = !a;
    if (!a) return;
    $('#cr-armor-table').innerHTML =
      '<thead><tr>' + a.rows.map((r) => `<th class="num">${esc(r.label)}</th>`).join('') + '</tr></thead><tbody><tr>' +
      a.rows.map((r) => `<td class="num cr-armor-${r.kind}" title="${r.kind}${r.added ? ' · +' + C.fmt(r.added, 1) + ' from layers' : ''}">${r.value}%</td>`).join('') +
      '</tr></tbody>';
  }

  // ---------- events ----------
  function onInput(e) {
    const t = e.target;
    const inp = cur();
    if (!inp) return;
    if (t.id === 'cr-uniform-range' || t.id === 'cr-uniform-num') {
      const v = Math.max(1, Math.min(1000, Number(t.value) || 1));
      inp.uniform = v;
      if (t.id === 'cr-uniform-range') $('#cr-uniform-num').value = v;
      else $('#cr-uniform-range').value = v;
      recompute();
    } else if (t.classList.contains('cr-stat')) {
      const slot = t.dataset.slot;
      inp.manual[slot] = inp.manual[slot] || {};
      if (t.value === '') delete inp.manual[slot][t.dataset.stat];
      else inp.manual[slot][t.dataset.stat] = Math.max(0, Math.min(1000, Number(t.value)));
      recompute();
    } else if (t.classList.contains('cr-fill')) {
      document.querySelectorAll(`.cr-stat[data-stat="${t.dataset.stat}"]`).forEach((x) => {
        x.value = t.value;
        x.dispatchEvent(new Event('input', { bubbles: true }));
      });
    } else if (t.classList.contains('cr-exp-pts')) {
      const g = t.dataset.group;
      inp.exp[g] = [Math.max(0, Number(t.value) || 0), (inp.exp[g] || [0, 0])[1]];
      recompute();
    } else if (t.classList.contains('cr-sim-value')) {
      inp.comps[t.dataset.slot].value = Math.max(1, Math.min(1000, Number(t.value) || 1));
      recompute();
    } else if (t.classList.contains('cr-prop-in')) {
      const sel = inp.comps[t.dataset.slot];
      const p = sel.props.find((x) => x[0] === t.dataset.prop);
      if (p) p[1] = Number(t.value) || 0;
      recompute();
    }
  }

  async function onChange(e) {
    const t = e.target;
    const inp = cur();
    if (t.name === 'cr-mode') {
      inp.mode = t.value;
      $('#cr-uniform').hidden = inp.mode !== 'uniform';
      $('#cr-manual').hidden = inp.mode !== 'manual';
      recompute();
    } else if (t.name === 'cr-exp') {
      inp.expMode = t.value;
      recompute();
    } else if (t.id === 'cr-assembly') {
      inp.assembly = Number(t.value);
      recompute();
    } else if (t.classList.contains('cr-exp-out')) {
      const g = t.dataset.group;
      inp.exp[g] = [(inp.exp[g] || [0, 0])[0], Number(t.value)];
      recompute();
    } else if (t.classList.contains('cr-sim-exp')) {
      inp.comps[t.dataset.slot].exp = t.checked ? 'max' : null;
      recompute();
    } else if (t.classList.contains('cr-comp-sel')) {
      await chooseComponent(Number(t.dataset.slot), t.value);
    } else if (t.id === 'cr-show-all') {
      state.showAll = t.checked;
      remember();
      renderList();
    } else if (t.id === 'cr-show-fixed') {
      state.showFixed = t.checked;
      remember();
      renderResult();
    } else if (t.id === 'cr-import') {
      importFile(t.files && t.files[0]);
      t.value = '';
    }
  }

  async function chooseComponent(i, v) {
    const s = schem();
    const inp = cur();
    const slot = s.s[i];
    if (!v) delete inp.comps[i];
    else if (v.startsWith('sim:')) inp.comps[i] = { kind: 'sim', id: v.slice(4), value: inp.mode === 'uniform' ? inp.uniform : 900, exp: 'max' };
    else if (v.startsWith('saved:')) {
      const name = v.slice(6);
      try {
        const it = await getSaved(name);
        inp.comps[i] = { kind: 'saved', name: it.name, target: it.target, props: it.props };
      } catch (e) {
        alert(e.message);
      }
    } else if (v === 'manual') {
      const prev = inp.comps[i];
      let base = prev && prev.props ? prev : null;
      if (!base) {
        const f = fitSchematics(slot)[0];
        base = f ? simulate(f, inp.mode === 'uniform' ? inp.uniform : 900, 'max') : { target: slot[2], props: [] };
      }
      inp.comps[i] = { kind: 'manual', target: base.target, props: base.props.map((p) => p.slice()) };
    }
    renderComponents();
    recompute();
  }

  function onClick(e) {
    const t = e.target.closest('button, [data-close]');
    if (!t) return;
    if (t.classList.contains('cr-prof')) {
      state.prof = t.dataset.prof;
      remember();
      renderProfs();
      renderList();
    } else if (t.classList.contains('cr-item')) selectSchematic(t.dataset.id);
    else if (t.classList.contains('cr-to-manual')) {
      const i = Number(t.dataset.slot);
      const sel = cur().comps[i];
      const f = bySchem[sel.id];
      const sim = simulate(f, sel.value, sel.exp);
      cur().comps[i] = { kind: 'manual', target: sim.target, props: sim.props.map((p) => p.slice()) };
      renderComponents();
      recompute();
    } else if (t.classList.contains('cr-prop-add')) {
      const name = (prompt('Stat name as the server knows it (e.g. armor_effectiveness, mindamage, kineticeffectiveness)') || '').trim();
      if (!/^[A-Za-z0-9_]{1,60}$/.test(name)) return;
      const sel = cur().comps[t.dataset.slot];
      if (!sel.props.some((p) => p[0] === name)) sel.props.push([name, 0, 0, '', false]);
      renderComponents();
    } else if (t.id === 'cr-saveload' || t.id === 'cr-save-quick') openPanel(t.id === 'cr-save-quick');
    else if (t.hasAttribute('data-close')) $('#cr-panel').hidden = true;
    else if (t.classList.contains('cr-load')) loadItem(t.dataset.name);
    else if (t.classList.contains('cr-del')) deleteItem(t.dataset.name);
    else if (t.id === 'cr-export') exportAll();
  }

  // ---------- saving ----------
  async function openPanel(focusSave) {
    const p = $('#cr-panel');
    p.hidden = false;
    $('#cr-panel-msg').textContent = '';
    const s = schem();
    $('#cr-save-form').hidden = !s;
    if (s) $('#cr-save-name').value = state.itemName || s.n;
    await loadSavedList();
    renderSaved();
    if (focusSave && s) $('#cr-save-name').select();
  }

  function renderSaved() {
    const q = ($('#cr-saved-filter').value || '').toLowerCase();
    const list = saved.filter((it) => !q || it.name.toLowerCase().includes(q) || (bySchem[it.schematic] && bySchem[it.schematic].n.toLowerCase().includes(q)));
    $('#cr-saved-list').innerHTML = list.length
      ? list
          .map(
            (it) =>
              `<li class="swg-build${it.name === state.itemName ? ' current' : ''}"><button type="button" class="swg-build-load cr-load" data-name="${esc(it.name)}"><span>${esc(it.name)}</span><span class="muted small">${esc(bySchem[it.schematic] ? bySchem[it.schematic].n : it.schematic)} · ${new Date(it.updatedAt).toLocaleDateString()}</span></button><button type="button" class="link small cr-del" data-name="${esc(it.name)}" aria-label="Delete ${esc(it.name)}">✕</button></li>`,
          )
          .join('')
      : '<li class="muted small">Nothing saved yet.</li>';
  }

  function itemDoc() {
    const s = schem();
    const inp = cur();
    const comps = {};
    for (const [i, sel] of Object.entries(inp.comps)) {
      if (!sel) continue;
      comps[i] = sel.kind === 'sim' ? { kind: 'sim', id: sel.id, value: sel.value, exp: sel.exp } : { kind: sel.kind, name: sel.name, target: sel.target, props: sel.props };
    }
    const props = result.props.map(([n, v, p, g, h]) => [n, Math.round(v * 1e4) / 1e4, p, g || '', !!h]);
    return {
      schematic: s.id,
      target: s.t,
      props,
      inputs: { mode: inp.mode, uniform: inp.uniform, manual: inp.manual, comps, assembly: inp.assembly, expMode: inp.expMode, exp: inp.exp },
    };
  }

  async function saveItem(name) {
    const msg = $('#cr-panel-msg');
    try {
      const r = await api('/crafted/' + encodeURIComponent(name), { method: 'PUT', body: JSON.stringify(itemDoc()) });
      state.itemName = r.name;
      delete savedCache[r.name.toLowerCase()];
      msg.textContent = 'Saved “' + r.name + '”.';
      $('#cr-item-name').textContent = 'Editing “' + r.name + '”';
      await loadSavedList();
      renderSaved();
      renderComponents();
    } catch (e) {
      msg.textContent = e.message;
    }
  }

  async function loadItem(name) {
    const msg = $('#cr-panel-msg');
    try {
      delete savedCache[name.toLowerCase()];
      const it = await getSaved(name);
      const s = bySchem[it.schematic];
      if (!s) throw new Error('That schematic is no longer in the data (' + it.schematic + ').');
      const inp = Object.assign(defaultInputs(), it.inputs || {});
      inp.comps = {};
      for (const [i, c] of Object.entries((it.inputs && it.inputs.comps) || {})) {
        if (c.kind === 'saved') {
          // use the saved component as it is now; fall back to the copy kept with this item
          try {
            const live = await getSaved(c.name);
            inp.comps[i] = { kind: 'saved', name: live.name, target: live.target, props: live.props };
          } catch {
            inp.comps[i] = { kind: 'saved', name: c.name, target: c.target, props: c.props || [], missing: true };
          }
        } else inp.comps[i] = c;
      }
      inputs[s.id] = inp;
      if (!inTab(s, state.prof)) {
        state.prof = s.p.find((p) => data.professions.some((x) => x.id === p)) || (s.p.includes('medic') ? 'doctor' : 'weaponsmith');
        renderProfs();
      }
      if (!s.st && !state.showAll) {
        state.showAll = true;
        $('#cr-show-all').checked = true;
      }
      renderList();
      state.itemName = it.name;
      selectSchematic(s.id, true);
      $('#cr-panel').hidden = true;
      const btn = document.querySelector(`.cr-item[data-id="${CSS.escape(s.id)}"]`);
      if (btn) btn.scrollIntoView({ block: 'nearest' });
    } catch (e) {
      msg.textContent = e.message;
    }
  }

  async function deleteItem(name) {
    if (!confirm('Delete “' + name + '”?')) return;
    try {
      await api('/crafted/' + encodeURIComponent(name), { method: 'DELETE' });
      delete savedCache[name.toLowerCase()];
      if (state.itemName === name) state.itemName = '';
      await loadSavedList();
      renderSaved();
      renderComponents();
    } catch (e) {
      $('#cr-panel-msg').textContent = e.message;
    }
  }

  async function exportAll() {
    const items = [];
    for (const it of saved) {
      try {
        items.push(await getSaved(it.name));
      } catch {
        /* skip */
      }
    }
    const blob = new Blob([JSON.stringify({ kind: 'swg-crafted', exportedAt: new Date().toISOString(), items }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'swg-crafted-items.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function importFile(file) {
    const msg = $('#cr-panel-msg');
    if (!file) return;
    try {
      const j = JSON.parse(await file.text());
      const items = Array.isArray(j.items) ? j.items : [];
      let n = 0;
      for (const it of items) {
        if (!it || !it.name || !bySchem[it.schematic]) continue;
        await api('/crafted/' + encodeURIComponent(it.name), { method: 'PUT', body: JSON.stringify({ schematic: it.schematic, target: it.target, props: it.props, inputs: it.inputs }) });
        delete savedCache[String(it.name).toLowerCase()];
        n++;
      }
      msg.textContent = `Imported ${n} item${n === 1 ? '' : 's'}.`;
      await loadSavedList();
      renderSaved();
      renderComponents();
    } catch (e) {
      msg.textContent = 'Import failed: ' + e.message;
    }
  }

  // ---------- start ----------
  async function start() {
    try {
      const res = await fetch('/swg/api/crafting', { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error('Could not load the schematics (' + res.status + ')');
      data = await res.json();
    } catch (e) {
      $('#cr-empty').innerHTML = `<p class="bad">${esc(e.message)}</p>`;
      return;
    }
    bySchem = {};
    byTarget = {};
    for (const s of data.schematics) {
      bySchem[s.id] = s;
      (byTarget[s.t] = byTarget[s.t] || []).push(s);
    }
    if (!data.professions.some((p) => p.id === state.prof)) state.prof = data.professions[0].id;
    $('#cr-show-all').checked = state.showAll;
    $('#cr-show-fixed').checked = state.showFixed;
    renderProfs();
    renderList();
    await loadSavedList();
    if (state.id && bySchem[state.id]) selectSchematic(state.id);

    document.addEventListener('input', onInput);
    document.addEventListener('change', onChange);
    document.addEventListener('click', onClick);
    $('#cr-search').addEventListener('input', (e) => {
      state.search = e.target.value;
      renderList();
    });
    $('#cr-saved-filter').addEventListener('input', renderSaved);
    $('#cr-save-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = $('#cr-save-name').value.trim();
      if (name) saveItem(name);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') $('#cr-panel').hidden = true;
    });
    document.addEventListener('swg:nfs', renderList);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
