/* SWG ship builder page. Math lives in swg-calc.js (window.SwgCalc). */
(function () {
  'use strict';
  const C = window.SwgCalc;
  const $ = (sel, el) => (el || document).querySelector(sel);
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
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem('swg.' + k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem('swg.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  const FACTION_LABEL = { rebel: 'Rebel', imperial: 'Imperial', freelancer: 'Freelancer' };
  let ships = [];
  let faction = store.get('faction') || null;
  let build = null; // current build
  let buildName = null; // name it was loaded / saved as
  let dirty = false;

  const shipById = (id) => ships.find((s) => s.id === id);
  const ship = () => shipById(build && build.ship);

  // ---------- formatting ----------
  const fmt = (v, d = 1) => {
    if (v == null) return '—';
    if (v === Infinity) return '∞';
    const r = C.round(v, d);
    return r.toLocaleString('en-US', { maximumFractionDigits: d });
  };
  const pretty = (code) =>
    String(code || '')
      .replace(/^(rct|eng|shd|arm|cap|bst|wpn|ddi)_/, '')
      .replace(/_s0?(\d+)$/, ' mk$1')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  function slotLabel(slot) {
    const kind = C.slotKind(slot);
    const i = Number((slot.match(/_(\d+)$/) || [])[1] || 0);
    if (kind === 'weapon') return 'Weapon ' + (i + 1);
    if (kind === 'armor') return 'Armor ' + (i === 0 ? '(front)' : i === 1 ? '(back)' : i + 1);
    if (kind === 'shield') return i ? 'Shield ' + (i + 1) : 'Shield';
    if (kind === 'droid_interface') return 'Droid interface';
    return kind.charAt(0).toUpperCase() + kind.slice(1);
  }
  const STAT_LABEL = {
    hitpoints: 'Hitpoints', armor: 'Armor', mass: 'Mass', speed: 'Speed', acceleration: 'Acceleration', deceleration: 'Deceleration',
    pitch: 'Pitch', yaw: 'Yaw', roll: 'Roll', pitchRate: 'Pitch rate', yawRate: 'Yaw rate', rollRate: 'Roll rate',
    regen: 'Regen', front: 'Front', back: 'Back', rechargeRate: 'Recharge', energy: 'Energy', energyUsage: 'Energy use',
    energyGeneration: 'Generation', energyMaintenance: 'Drain', rate: 'Refire (s)', drain: 'Drain / shot',
    minDamage: 'Min damage', maxDamage: 'Max damage', shieldEfficiency: 'Vs shields', armorEfficiency: 'Vs armor', ammo: 'Ammo', ammo_type: 'Ammo type',
  };
  const STAT_ORDER = ['mass', 'hitpoints', 'armor', 'energyMaintenance', 'energyGeneration', 'speed', 'acceleration', 'deceleration', 'pitchRate', 'yawRate', 'rollRate', 'pitch', 'yaw', 'roll',
    'front', 'back', 'regen', 'energy', 'rechargeRate', 'energyUsage', 'minDamage', 'maxDamage', 'rate', 'drain', 'shieldEfficiency', 'armorEfficiency', 'ammo', 'ammo_type'];

  // ---------- ship selection ----------
  function renderFactions() {
    for (const b of document.querySelectorAll('.swg-faction')) {
      const on = b.dataset.faction === faction;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }
  function renderShipSelect() {
    const sel = $('#swg-ship');
    const list = ships.filter((s) => !faction || s.faction === faction);
    sel.replaceChildren();
    const groups = faction ? [faction] : ['rebel', 'imperial', 'freelancer'];
    for (const g of groups) {
      const items = list.filter((s) => s.faction === g);
      if (!items.length) continue;
      const og = el('optgroup', { label: FACTION_LABEL[g] });
      for (const s of items) og.append(el('option', { value: s.id, text: s.name }));
      sel.append(og);
    }
    if (build && list.some((s) => s.id === build.ship)) sel.value = build.ship;
    else if (list.length) selectShip(list[0].id);
  }
  function selectShip(id) {
    const s = shipById(id);
    if (!s) return;
    build = C.defaultBuild(s); // new ship: stock parts, overloads off
    buildName = null;
    dirty = false;
    store.set('ship', id);
    $('#swg-ship').value = id;
    renderAll();
  }

  // ---------- summary table ----------
  function renderStats() {
    const s = ship();
    const st = C.shipStats(s, build);
    const base = C.shipStats(s, { ...build, overloads: C.emptyOverloads() });
    const mass = C.massUsage(s, build);
    const cell = (key, d, unit) => {
      const v = st[key];
      const changed = base[key] != null && v != null && Math.abs(v - base[key]) > 1e-9;
      const td = el('td', { class: 'swg-v' + (changed ? ' up' : '') }, fmt(v, d) + (v != null && unit ? unit : ''));
      if (changed) td.title = 'Without overloads: ' + fmt(base[key], d);
      return td;
    };
    const pair = (a, b, d) => {
      const td = el('td', { class: 'swg-v' }, fmt(st[a], d) + ' / ' + fmt(st[b], d));
      const changed = [a, b].some((k) => base[k] != null && st[k] != null && Math.abs(st[k] - base[k]) > 1e-9);
      if (changed) {
        td.classList.add('up');
        td.title = 'Without overloads: ' + fmt(base[a], d) + ' / ' + fmt(base[b], d);
      }
      return td;
    };
    const th = (t, tip) => el('th', { title: tip }, t);
    const rows = [
      [th('Speed', 'Engine speed × chassis speed modifier (' + fmt(s.attributes.maxSpeed, 2) + ') × engine overload'), cell('speed', 1),
        th('Boost speed', 'Speed + booster speed'), cell('boostSpeed', 1)],
      [th('Accel / decel'), pair('acceleration', 'deceleration', 1), th('Pitch / yaw / roll', 'Engine pitch / yaw / roll rates (°/s)'),
        el('td', { class: 'swg-v' }, [st.pitchRate, st.yawRate, st.rollRate].map((v) => fmt(v, 0)).join(' / '))],
      [th('Chassis HP'), cell('chassisHitpoints', 0), th('Mass', 'Component mass / chassis maximum'),
        el('td', { class: 'swg-v' + (mass.over ? ' bad' : '') }, (mass.known ? fmt(mass.used, 0) : '—') + ' / ' + fmt(mass.max, 0))],
      [th('Armor F / B'), pair('armorFront', 'armorBack', 0), th('Shield F / B'), pair('shieldFront', 'shieldBack', 0)],
      [th('Shield regen'), cell('shieldRegen', 2), th('Reactor output', 'Reactor energy generation × reactor overload'), cell('reactorOutput', 0)],
      [th('Capacitor'), cell('capEnergy', 0), th('Cap recharge', 'Capacitor recharge × capacitor overload efficiency'), cell('capRecharge', 1, '/s')],
      [th('DPS', 'Guns only: average damage ÷ refire time × weapon overload (missiles and countermeasures left out)'), cell('dps', 1),
        th('Gun drain', 'Capacitor energy the guns use per second of fire'), cell('gunDrain', 1, '/s')],
      [th('Sustained fire', 'Seconds of continuous fire before the capacitor is empty'), cell('sustain', 1, ' s'),
        th('Booster', 'Booster energy / energy use per second'), pair('boosterEnergy', 'boosterUse', 1)],
    ];
    $('#swg-stats').replaceChildren(el('tbody', null, rows.map((r) => el('tr', null, r))));
  }

  // ---------- overloads ----------
  function renderOverloads() {
    const box = $('#swg-overloads');
    box.replaceChildren();
    for (const key of C.OVERLOAD_KEYS) {
      const o = build.overloads[key];
      const row = el('div', { class: 'swg-ol' + (o.on ? ' on' : '') });
      row.append(
        el('button', {
          type: 'button', class: 'swg-ol-title', 'aria-pressed': String(o.on),
          onclick: () => { o.on = !o.on; touch(); },
        }, el('span', { class: 'swg-ol-dot', 'aria-hidden': 'true' }), C.OVERLOADS[key].label),
      );
      const levels = el('div', { class: 'swg-ol-levels', role: 'group', 'aria-label': C.OVERLOADS[key].label + ' level' });
      for (let lv = 1; lv <= 4; lv++) {
        levels.append(el('button', {
          type: 'button', class: 'swg-ol-lv' + (o.on && o.level === lv ? ' sel' : ''), 'aria-pressed': String(o.on && o.level === lv),
          title: C.overloadEffect(key, lv),
          onclick: () => { o.level = lv; o.on = true; touch(); },
        }, String(lv)));
      }
      row.append(levels, el('div', { class: 'swg-ol-fx small' + (o.on ? '' : ' muted') }, o.on ? C.overloadEffect(key, o.level) : 'Off'));
      box.append(row);
    }
  }

  // ---------- mass bar ----------
  function renderMass() {
    const s = ship();
    const m = C.massUsage(s, build);
    const bar = $('#swg-mass-bar');
    const over = m.used > m.max;
    // when over, the whole bar is the used mass and the red part is the excess
    const fillPct = over ? (m.max / m.used) * 100 : m.pct * 100;
    bar.classList.toggle('over', over);
    $('.swg-mass-fill', bar).style.width = fillPct + '%';
    $('.swg-mass-over', bar).style.width = over ? 100 - fillPct + '%' : '0';
    bar.setAttribute('aria-valuemax', String(m.max));
    bar.setAttribute('aria-valuenow', String(m.used));
    $('#swg-mass-text').textContent = fmt(m.used, 0) + ' / ' + fmt(m.max, 0) + (over ? ' · over by ' + fmt(m.over, 0) + ' (' + fmt((m.used / m.max - 1) * 100, 1) + '%)' : ' · ' + fmt(m.pct * 100, 1) + '%');
    $('#swg-mass-text').classList.toggle('bad', over);
    $('#swg-mass-note').textContent = m.known < m.total
      ? (m.total - m.known) + ' of ' + m.total + ' components have no mass yet (the stock parts in the server scripts don’t list one).'
      : '';
  }

  // ---------- component tiles ----------
  function renderSlots() {
    const box = $('#swg-slots');
    box.replaceChildren();
    for (const [slot, c] of Object.entries(build.components)) {
      const kind = C.slotKind(slot);
      const tile = el('article', { class: 'swg-slot swg-k-' + kind });
      const head = el('header', { class: 'swg-slot-head' },
        el('span', { class: 'swg-slot-name' }, slotLabel(slot)),
        c.source === 'default' ? el('img', { src: '/static/swg-frog.png', class: 'swg-frog', alt: 'Default part', title: 'Character builder terminal default — not a real part' }) : null);
      const title = el('div', { class: 'swg-part' }, el('strong', null, pretty(c.name)), el('code', { class: 'small muted' }, c.name));
      if (kind === 'weapon') {
        const wk = C.weaponKind(c);
        if (wk !== 'gun') title.append(el('span', { class: 'swg-tag small' }, wk));
      }
      const dl = el('dl', { class: 'swg-attrs small' });
      // hitpoints / armor only matter on the armor plating slots
      const hidden = kind === 'armor' ? [] : ['hitpoints', 'armor'];
      const keys = Object.keys(c).filter((k) => k !== 'name' && k !== 'source' && typeof c[k] === 'number' && !hidden.includes(k));
      keys.sort((a, b) => (STAT_ORDER.indexOf(a) + 1 || 99) - (STAT_ORDER.indexOf(b) + 1 || 99));
      if (!keys.includes('mass')) dl.append(el('dt', null, 'Mass'), el('dd', { class: 'muted' }, '—'));
      for (const k of keys) {
        if ((k === 'ammo' || k === 'ammo_type' || /Efficiency$/.test(k)) && !c[k]) continue;
        dl.append(el('dt', null, STAT_LABEL[k] || k), el('dd', null, fmt(c[k], c[k] >= 100 ? 0 : 2)));
      }
      tile.append(head, title, dl);
      box.append(tile);
    }
  }

  function renderName() {
    $('#swg-build-name').textContent = buildName ? buildName + (dirty ? ' · unsaved changes' : '') : '';
  }
  function renderAll() {
    if (!ship()) return;
    renderStats();
    renderOverloads();
    renderMass();
    renderSlots();
    renderName();
  }
  function touch() {
    dirty = true;
    renderAll();
  }

  // ---------- save / load panel ----------
  const panel = $('#swg-panel');
  const msg = (t, bad) => { const m = $('#swg-panel-msg'); m.textContent = t || ''; m.classList.toggle('bad', !!bad); };
  async function api(path, opts) {
    const res = await fetch('/swg/api' + path, { ...opts, headers: { accept: 'application/json', 'content-type': 'application/json' } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Request failed (' + res.status + ')');
    return body;
  }
  async function refreshList() {
    const ul = $('#swg-build-list');
    ul.replaceChildren(el('li', { class: 'muted small' }, 'Loading…'));
    try {
      const { builds } = await api('/builds');
      ul.replaceChildren();
      if (!builds.length) ul.append(el('li', { class: 'muted small' }, 'No saved builds yet.'));
      for (const b of builds) {
        const s = shipById(b.ship);
        ul.append(el('li', { class: 'swg-build' + (b.name === buildName ? ' current' : '') },
          el('button', { type: 'button', class: 'swg-build-load', onclick: () => loadBuild(b.name) },
            el('span', { class: 'strong' }, b.name),
            el('span', { class: 'muted small' }, (s ? s.name : b.ship) + ' · ' + new Date(b.updatedAt).toLocaleDateString())),
          el('button', { type: 'button', class: 'link small', title: 'Delete', 'aria-label': 'Delete ' + b.name, onclick: () => deleteBuild(b.name) }, 'Delete')));
      }
    } catch (err) {
      ul.replaceChildren();
      msg(err.message, true);
    }
  }
  function openPanel() {
    panel.hidden = false;
    msg('');
    $('#swg-save-name').value = buildName || '';
    $('#swg-save-name').focus();
    refreshList();
  }
  const closePanel = () => { panel.hidden = true; };
  async function saveBuild(e) {
    e.preventDefault();
    const name = $('#swg-save-name').value.trim();
    if (!name) return msg('Give the build a name.', true);
    try {
      const r = await api('/builds/' + encodeURIComponent(name), { method: 'PUT', body: JSON.stringify(build) });
      buildName = r.name;
      dirty = false;
      renderName();
      msg('Saved “' + r.name + '”.');
      refreshList();
    } catch (err) { msg(err.message, true); }
  }
  async function loadBuild(name) {
    if (dirty && !confirm('Discard unsaved changes to the current build?')) return;
    try {
      const { build: b } = await api('/builds/' + encodeURIComponent(name));
      const s = shipById(b.ship);
      if (!s) return msg('That build uses a ship that is no longer in the list.', true);
      const fresh = C.defaultBuild(s);
      build = { ship: s.id, overloads: { ...fresh.overloads, ...b.overloads }, components: b.components || fresh.components };
      buildName = b.name;
      dirty = false;
      if (faction && s.faction !== faction) { faction = null; store.set('faction', null); renderFactions(); }
      renderShipSelect();
      $('#swg-ship').value = s.id;
      store.set('ship', s.id);
      renderAll();
      closePanel();
    } catch (err) { msg(err.message, true); }
  }
  async function deleteBuild(name) {
    if (!confirm('Delete the saved build “' + name + '”?')) return;
    try {
      await api('/builds/' + encodeURIComponent(name), { method: 'DELETE' });
      if (name === buildName) { buildName = null; renderName(); }
      msg('Deleted “' + name + '”.');
      refreshList();
    } catch (err) { msg(err.message, true); }
  }

  // ---------- wiring ----------
  async function init() {
    for (const b of document.querySelectorAll('.swg-faction')) {
      b.addEventListener('click', () => {
        faction = faction === b.dataset.faction ? null : b.dataset.faction; // click again = all ships
        store.set('faction', faction);
        renderFactions();
        renderShipSelect();
      });
    }
    $('#swg-ship').addEventListener('change', (e) => {
      if (dirty && !confirm('Switching ships starts a new build. Discard unsaved changes?')) { e.target.value = build.ship; return; }
      selectShip(e.target.value);
    });
    $('#swg-saveload').addEventListener('click', () => (panel.hidden ? openPanel() : closePanel()));
    $('[data-close]', panel).addEventListener('click', closePanel);
    $('#swg-save-form').addEventListener('submit', saveBuild);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) closePanel(); });
    document.addEventListener('mousedown', (e) => {
      if (!panel.hidden && !panel.contains(e.target) && !$('#swg-saveload').contains(e.target)) closePanel();
    });

    try {
      ships = (await api('/ships')).ships;
    } catch (err) {
      $('#swg-stats').replaceChildren(el('tr', null, el('td', { class: 'bad' }, 'Could not load the ship list: ' + err.message)));
      return;
    }
    renderFactions();
    const last = shipById(store.get('ship'));
    if (last && (!faction || last.faction === faction)) {
      build = C.defaultBuild(last);
    }
    renderShipSelect();
    renderAll();
  }
  init();
})();
