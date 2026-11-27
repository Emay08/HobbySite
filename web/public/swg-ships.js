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

  // the build being worked on survives trips to the Loot / Crafting pages (this tab only)
  const session = {
    get(k) { try { return JSON.parse(sessionStorage.getItem('swg.' + k)); } catch { return null; } },
    set(k, v) { try { if (v == null) sessionStorage.removeItem('swg.' + k); else sessionStorage.setItem('swg.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
  };
  const LT = window.SwgLoot; // slot ↔ component type

  const TRASH_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const EDIT_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false"><path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  /** A trash-can icon button (the icon is a fixed string, not user data). */
  function trashButton(label, onclick) {
    const b = el('button', { type: 'button', class: 'icon-btn', title: label, 'aria-label': label, onclick });
    b.innerHTML = TRASH_SVG;
    return b;
  }
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
    if (kind === 'weapon') {
      // launcher slots are named for what they hold
      const lk = ship() ? launcherKind(slot) : null;
      if (lk) {
        const same = Object.keys(build.components).filter((s2) => launcherKind(s2) === lk);
        const label = lk === 'countermeasure' ? 'Countermeasure Launcher' : 'Ordnance';
        return same.length > 1 ? label + ' ' + (same.indexOf(slot) + 1) : label;
      }
      return 'Weapon ' + (i + 1) + (ship() && (ship().turrets || []).includes(slot) ? ' · Turret' : '');
    }
    if (kind === 'armor') return 'Armor ' + (i === 0 ? '(front)' : i === 1 ? '(back)' : i + 1);
    if (kind === 'shield') return i ? 'Shield ' + (i + 1) : 'Shield';
    if (kind === 'droid_interface') return 'Droid interface';
    return kind.charAt(0).toUpperCase() + kind.slice(1);
  }
  const STAT_LABEL = {
    hitpoints: 'Hitpoints', armor: 'Armor', mass: 'Mass', speed: 'Speed', acceleration: 'Acceleration', deceleration: 'Deceleration',
    pitch: 'Pitch', yaw: 'Yaw', roll: 'Roll', pitchRate: 'Pitch rate', yawRate: 'Yaw rate', rollRate: 'Roll rate',
    regen: 'Regen', front: 'Front', back: 'Back', rechargeRate: 'Recharge', energy: 'Energy', energyUsage: 'Energy use',
    energyGeneration: 'Generation', energyMaintenance: 'Reactor drain', rate: 'Refire (s)', drain: 'Drain / shot', droidSpeed: 'Command speed', reLevel: 'RE level',
    minDamage: 'Min damage', maxDamage: 'Max damage', shieldEfficiency: 'Vs shields', armorEfficiency: 'Vs armor', ammo: 'Ammo', ammo_type: 'Ammo type',
  };
  const STAT_ORDER = ['reLevel', 'mass', 'hitpoints', 'armor', 'energyMaintenance', 'droidSpeed', 'energyGeneration', 'speed', 'acceleration', 'deceleration', 'pitchRate', 'yawRate', 'rollRate', 'pitch', 'yaw', 'roll',
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
    const list = ships.filter((s) => (!faction || s.faction === faction) && (window.SwgNfs.on() || !s.nfs));
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
      [th('Shield regen'), cell('shieldRegen', 2), th('Reactor load', 'Reactor drain of all components (engine and weapons × their overload energy use) / reactor generation × reactor overload'), (() => {
        const td = pair('energyUse', 'reactorOutput', 0);
        if (st.energyUse != null && st.reactorOutput != null && st.energyUse > st.reactorOutput) td.classList.add('bad');
        return td;
      })()],
      [th('Capacitor', 'Capacitor energy × capacitor overload efficiency'), cell('capEnergy', 0), th('Cap recharge', 'Capacitor recharge × capacitor overload efficiency'), cell('capRecharge', 1, '/s')],
      [th('DPS vs shields', 'Guns only (no missiles or countermeasures): each gun\u2019s average damage ÷ refire time × weapon overload × its effectiveness vs shields'), cell('dpsShields', 1),
        th('Gun drain', 'Capacitor energy the guns use per second of fire'), cell('gunDrain', 1, '/s')],
      [th('DPS vs armor', 'Guns only: each gun\u2019s average damage ÷ refire time × weapon overload × its effectiveness vs armor'), cell('dpsArmor', 1),
        th('Sustained fire', 'Seconds of continuous fire before the capacitor is empty'), cell('sustain', 1, ' s')],
      [th('Booster', 'Booster energy / energy use per second'), pair('boosterEnergy', 'boosterUse', 1), el('th'), el('td')],
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
          // clicking the level that's already on turns the overload off
          onclick: () => { if (o.on && o.level === lv) o.on = false; else { o.level = lv; o.on = true; } touch(); },
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
    for (const slot of slotOrder()) {
      const c = build.components[slot];
      const kind = C.slotKind(slot);
      const empty = C.isEmpty(c);
      const tile = el('article', {
        class: 'swg-slot swg-k-' + kind + (menuSlot === slot ? ' picked' : '') + (empty ? ' empty' : ''), tabindex: '0', role: 'button', 'aria-haspopup': 'dialog',
        draggable: 'true', 'data-slot': slot,
        'aria-label': slotLabel(slot) + ': ' + (empty ? 'empty' : c.source === 'default' ? pretty(c.name) : c.name) + '. Change component',
        onclick: (e) => openMenu(slot, e.currentTarget),
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMenu(slot, e.currentTarget); } },
      });
      // corner tools: edit (looted parts and RE projects open on the Loot page), remove
      const tools = el('span', { class: 'swg-slot-tools' });
      if (c.source === 'loot' || c.source === 're') {
        const edit = el('a', {
          draggable: 'false',
          class: 'icon-btn icon-edit', href: '/swg/loot?slot=' + encodeURIComponent(slot) + '&edit=' + encodeURIComponent(c.name),
          title: 'Edit ' + c.name + ' on the Loot page', 'aria-label': 'Edit ' + c.name,
        });
        edit.innerHTML = EDIT_SVG;
        tools.append(edit);
      }
      if (!empty) tools.append(trashButton('Remove the ' + slotLabel(slot).toLowerCase() + ' component', () => removePart(slot)));
      for (const b of tools.children) {
        b.addEventListener('click', (e) => e.stopPropagation()); // not the slot menu
        b.addEventListener('keydown', (e) => e.stopPropagation());
      }
      const head = el('header', { class: 'swg-slot-head' },
        el('span', { class: 'swg-slot-name' }, slotLabel(slot)),
        el('span', { class: 'swg-slot-right' },
          c.source === 'default' ? el('img', { src: '/static/swg-frog.png', class: 'swg-frog', alt: 'Default part', title: 'Character builder terminal default — not a real part' }) : null,
          tools));
      if (empty) {
        tile.append(head, el('div', { class: 'swg-part' }, el('strong', { class: 'muted' }, 'Empty')), el('p', { class: 'small muted', style: 'margin:0' }, 'Click to add a component.'));
        box.append(tile);
        continue;
      }
      const title = c.source === 'default'
        ? el('div', { class: 'swg-part' }, el('strong', null, pretty(c.name)), el('code', { class: 'small muted' }, c.name))
        : el('div', { class: 'swg-part' }, el('strong', null, c.name), el('span', { class: 'swg-src' }, SOURCE_LABEL[c.source] || c.source), ' ', el('code', { class: 'small muted' }, c.code || ''));
      if (kind === 'weapon') {
        const wk = C.weaponKind(c);
        if (wk !== 'gun') title.append(el('span', { class: 'swg-tag small' }, wk));
      }
      const dl = el('dl', { class: 'swg-attrs small' });
      // hitpoints / armor only matter on the armor plating slots
      const hidden = kind === 'armor' ? [] : ['hitpoints', 'armor'];
      if (kind === 'engine') hidden.push('acceleration', 'deceleration');
      const keys = Object.keys(c).filter((k) => !['name', 'source', 'code', 'lootType'].includes(k) && typeof c[k] === 'number' && !hidden.includes(k));
      const pcts = partPercentiles(slot, c);
      keys.sort((a, b) => (STAT_ORDER.indexOf(a) + 1 || 99) - (STAT_ORDER.indexOf(b) + 1 || 99));
      if (!keys.includes('mass')) dl.append(el('dt', null, 'Mass'), el('dd', { class: 'muted' }, '—'));
      for (const k of keys) {
        if ((k === 'ammo' || k === 'ammo_type' || /Efficiency$/.test(k)) && !c[k]) continue;
        const dd = el('dd', null, fmt(c[k], c[k] >= 100 ? 0 : 2));
        if (pcts[k] != null) {
          dd.style.color = pctColor(pcts[k]);
          dd.title = Math.round(pcts[k] * 100) + 'th percentile of the looted RE ' + c.reLevel + ' ' + LT.TYPES[c.lootType || LT.typeForSlot(slot)].label.toLowerCase() + ' range, with the +' + Math.round(LT.reBonus(c.reLevel) * 100) + '% RE bonus applied';
        }
        dl.append(el('dt', null, STAT_LABEL[k] || k), dd);
      }
      tile.append(head, title, dl);
      box.append(tile);
    }
  }

  // ---------- tile layout and drag & drop ----------
  // One drag does both: drop on the middle of a tile that takes the same kind of part (gun ↔ gun,
  // ordnance ↔ ordnance, shield ↔ shield…) to swap the two parts; drop on a tile's left or right
  // edge (or anywhere on a tile that can't take the part) to move the dragged tile there.
  // The tile order is remembered per ship type, on the server (and in this browser for a fast start).
  let layouts = store.get('layouts') || {}; // ship id → [slot, …]
  function slotOrder() {
    const keys = Object.keys(build.components);
    const saved = (layouts[build.ship] || []).filter((k) => keys.includes(k));
    return saved.concat(keys.filter((k) => !saved.includes(k)));
  }
  function saveLayout(order) {
    if (order) layouts[build.ship] = order;
    else delete layouts[build.ship];
    store.set('layouts', layouts);
    api('/prefs/layout/' + encodeURIComponent(build.ship), { method: 'PUT', body: JSON.stringify({ order: order || [] }) }).catch(() => {});
    renderSlots();
    renderLayoutReset();
  }
  function renderLayoutReset() {
    const b = $('#swg-layout-reset');
    if (b) b.hidden = !(layouts[build.ship] && layouts[build.ship].length);
  }
  /** Can the part in slot a go in slot b (and the other way round)? */
  function swappable(a, b) {
    return a !== b && C.slotKind(a) === C.slotKind(b) && launcherKind(a) === launcherKind(b);
  }
  let dragSlot = null;
  let dropAt = null; // { slot, mode: 'swap' | 'before' | 'after' }
  function clearDropMarks() {
    for (const t of document.querySelectorAll('.swg-slot.drop-swap, .swg-slot.drop-before, .swg-slot.drop-after')) t.classList.remove('drop-swap', 'drop-before', 'drop-after');
  }
  function wireDragging(box) {
    box.addEventListener('dragstart', (e) => {
      const t = e.target.closest && e.target.closest('.swg-slot');
      if (!t) return;
      dragSlot = t.dataset.slot;
      closeMenu();
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragSlot);
      requestAnimationFrame(() => t.classList.add('dragging'));
      for (const o of box.querySelectorAll('.swg-slot')) if (swappable(dragSlot, o.dataset.slot)) o.classList.add('can-swap');
    });
    box.addEventListener('dragover', (e) => {
      if (!dragSlot) return;
      const t = e.target.closest && e.target.closest('.swg-slot');
      if (!t) return;
      e.preventDefault();
      const slot = t.dataset.slot;
      const r = t.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      let mode;
      if (slot === dragSlot) mode = null;
      else if (swappable(dragSlot, slot) && x > 0.25 && x < 0.75) mode = 'swap';
      else mode = x < 0.5 ? 'before' : 'after';
      if (dropAt && dropAt.slot === slot && dropAt.mode === mode) return;
      clearDropMarks();
      dropAt = mode ? { slot, mode } : null;
      if (mode) t.classList.add('drop-' + mode);
      e.dataTransfer.dropEffect = 'move';
    });
    box.addEventListener('drop', (e) => {
      if (!dragSlot || !dropAt) return;
      e.preventDefault();
      const { slot, mode } = dropAt;
      if (mode === 'swap') {
        const a = build.components[dragSlot];
        build.components[dragSlot] = build.components[slot];
        build.components[slot] = a;
        touch();
      } else {
        const order = slotOrder().filter((k) => k !== dragSlot);
        order.splice(order.indexOf(slot) + (mode === 'after' ? 1 : 0), 0, dragSlot);
        saveLayout(order);
      }
    });
    box.addEventListener('dragend', () => {
      dragSlot = null;
      dropAt = null;
      clearDropMarks();
      for (const t of box.querySelectorAll('.swg-slot.dragging, .swg-slot.can-swap')) t.classList.remove('dragging', 'can-swap');
    });
  }

  // ---------- how good a looted / RE part's stats are ----------
  /** red (0) → yellow (0.5) → green (1) */
  const pctColor = (p) => 'hsl(' + Math.round(120 * p) + ', 75%, 58%)';
  let lootItems = null; // loaded on first need
  let lootLoading = null;
  function needLoot() {
    if (lootItems || lootLoading) return;
    lootLoading = api('/loot').then((d) => { lootItems = d.items; renderSlots(); }).catch(() => { lootItems = []; });
  }
  /**
   * field → 0–1: where each stat of a looted or RE part sits between the worst and best roll of
   * every looted component of its type and RE level, with that level's RE bonus applied to both
   * ends. Default, crafted and empty parts: none.
   */
  function partPercentiles(slot, c) {
    const out = {};
    if (!LT || !(c.source === 'loot' || c.source === 're') || !(c.reLevel >= 1)) return out;
    if (!lootItems) { needLoot(); return out; }
    const type = c.lootType || LT.typeForSlot(slot);
    const items = lootItems.filter((it) => it.type === type && it.tier === c.reLevel);
    if (!items.length) return out;
    const bonus = LT.reBonus(c.reLevel);
    for (const [k, meta] of Object.entries(LT.STATS)) {
      if (typeof c[meta.ship] !== 'number' || out[meta.ship] != null) continue;
      const r = LT.statRange(items, k);
      if (!r) continue;
      // the range as it would be after reverse engineering: + bonus, or − bonus where lower is better
      const f = r.lower ? 1 - bonus : 1 + bonus;
      const worst = r.worst * f, best = r.best * f;
      out[meta.ship] = Math.abs(best - worst) < 1e-12 ? 1 : Math.max(0, Math.min(1, (c[meta.ship] - worst) / (best - worst)));
    }
    return out;
  }

  function renderName() {
    $('#swg-build-name').textContent = buildName ? buildName + (dirty ? ' · unsaved changes' : '') : '';
  }
  function renderAll() {
    if (!ship()) return;
    renderLayoutReset();
    const sn = $('#swg-shipname');
    if (sn && document.activeElement !== sn) sn.value = build.shipName || '';
    session.set('work', { build, buildName, dirty });
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

  // ---------- slot menu: swap a component ----------
  const LAUNCHER_LABEL = { missile: 'missile launcher', countermeasure: 'countermeasure launcher' };
  const SOURCE_LABEL = { loot: 'Looted', re: 'RE project', crafted: 'Crafted', default: 'Default' };
  let menuSlot = null;
  let menuEl = null;
  function closeMenu() {
    if (menuEl) menuEl.remove();
    menuEl = null;
    if (menuSlot) { menuSlot = null; renderSlots(); }
  }
  function openMenu(slot, anchor) {
    if (menuSlot === slot) return closeMenu();
    closeMenu();
    menuSlot = slot;
    const type = LT ? LT.typeForSlot(slot) : null;
    const c = build.components[slot];
    const launcher = launcherKind(slot);
    const list = el('ul', { class: 'swg-build-list' }, el('li', { class: 'muted small' }, 'Loading saved components…'));
    const craftHref = '/swg/crafting?slot=' + encodeURIComponent(slot) + (launcher ? '&launcher=' + launcher : '');
    menuEl = el('div', { class: 'swg-menu card', role: 'dialog', 'aria-label': 'Change ' + slotLabel(slot) },
      el('div', { class: 'swg-panel-head' }, el('h3', null, slotLabel(slot)), el('button', { type: 'button', class: 'link', 'aria-label': 'Close', onclick: closeMenu }, '✕')),
      el('div', { class: 'swg-menu-actions' },
        type && !launcher ? el('a', { class: 'btn', href: '/swg/loot?slot=' + encodeURIComponent(slot) }, 'New looted component…') : null,
        el('a', { class: 'btn', href: craftHref }, launcher ? 'New crafted ' + LAUNCHER_LABEL[launcher] + '…' : 'New crafted component…'),
        c.source !== 'default' && ship().slots[slot] && !ship().slots[slot].empty ? el('button', { type: 'button', class: 'btn', onclick: () => restoreDefault(slot) }, 'Put the default part back') : null,
        null),
      launcher ? el('p', { class: 'small muted', style: 'margin:.2rem 0 .3rem' }, 'This slot holds a ' + LAUNCHER_LABEL[launcher] + ': only the default part or a crafted ' + LAUNCHER_LABEL[launcher] + ' fits.') : null,
      el('p', { class: 'small muted', style: 'margin:.2rem 0 .3rem' }, 'Load a saved component'),
      list);
    document.body.append(menuEl);
    const r = anchor.getBoundingClientRect();
    const w = menuEl.offsetWidth;
    // anchored to the tile in page coordinates: it scrolls with the page, so a long menu can be
    // scrolled into view
    menuEl.style.left = window.scrollX + Math.max(12, Math.min(document.documentElement.clientWidth - w - 12, r.left)) + 'px';
    menuEl.style.top = window.scrollY + r.bottom + 8 + 'px';
    renderSlots();
    fillSavedList(slot, type, list, launcher);
  }
  async function fillSavedList(slot, type, list, launcher) {
    if (!type) { list.replaceChildren(el('li', { class: 'muted small' }, 'No saved components fit this slot.')); return; }
    try {
      // launcher slots take only crafted launchers of the same kind; gun slots never take launchers
      const all = (await api('/components?type=' + type + (launcher ? '&kind=crafted' : ''))).components;
      const components = all.filter((sc) => (sc.launcher || null) === launcher);
      if (menuSlot !== slot) return;
      list.replaceChildren();
      if (!components.length) list.append(el('li', { class: 'muted small' }, launcher ? 'No saved crafted ' + LAUNCHER_LABEL[launcher] + 's yet.' : 'No saved ' + LT.TYPES[type].label.toLowerCase() + 's yet.'));
      const m = C.massUsage(ship(), build);
      const cur = build.components[slot];
      const base = m.used - (typeof cur.mass === 'number' ? cur.mass : 0);
      for (const sc of components) {
        const over = typeof sc.mass === 'number' && base + sc.mass > m.max;
        list.append(el('li', { class: 'swg-build' + (over ? ' over' : ''), title: over ? 'Would put the ship over its mass limit' : '' },
          el('button', { type: 'button', class: 'swg-build-load', onclick: () => useSaved(sc.name, slot) },
            el('span', { class: 'strong' }, sc.name),
            el('span', { class: 'muted small' }, (SOURCE_LABEL[sc.kind] || sc.kind) + ' · RE ' + sc.tier + (typeof sc.mass === 'number' ? ' · mass ' + fmt(sc.mass, 0) : '') + ' · ' + new Date(sc.updatedAt).toLocaleDateString()))));
      }
    } catch (err) {
      list.replaceChildren(el('li', { class: 'bad small' }, err.message));
    }
  }
  function removePart(slot) {
    build.components[slot] = { source: 'empty' };
    closeMenu();
    touch();
  }
  function restoreDefault(slot) {
    build.components[slot] = { ...ship().slots[slot], source: 'default' };
    closeMenu();
    touch();
  }
  /** Saved component → the part the builder shows */
  function partFromSaved(doc) {
    const code = doc.kind === 're'
      ? (doc.components || []).length + '-part RE project'
      : (doc.itemIds || []).length === 1 ? doc.itemIds[0] : (doc.itemIds || []).length + ' possible components';
    return { ...doc.ship, name: doc.name, code, source: doc.kind, lootType: doc.type };
  }
  /** Slot for a component type: the given one if it fits, else a slot still holding a default part, else the first. */
  /** 'missile' / 'countermeasure' when the ship's stock part in a weapon slot is a launcher, else null */
  function launcherKind(slot) {
    const stock = ship().slots[slot];
    if (C.slotKind(slot) !== 'weapon' || !stock) return null;
    if (stock.launcher) return stock.launcher; // an empty ordnance slot
    const k = C.weaponKind(stock);
    return k === 'gun' ? null : k;
  }
  function slotFor(type, wanted, launcher = null) {
    const slots = Object.keys(build.components).filter((s) => LT.typeForSlot(s) === type && launcherKind(s) === launcher);
    if (wanted && slots.includes(wanted)) return wanted;
    return slots.find((s) => C.isEmpty(build.components[s])) || slots.find((s) => build.components[s].source === 'default') || slots[0] || null;
  }
  async function useSaved(name, wantedSlot) {
    try {
      const { component: doc } = await api('/components/' + encodeURIComponent(name));
      const slot = slotFor(doc.type, wantedSlot, doc.launcher || null);
      if (!slot) {
        $('#swg-build-name').textContent = ship().name + ' has no slot for ' + (doc.launcher ? 'a ' + LAUNCHER_LABEL[doc.launcher] : 'a ' + LT.TYPES[doc.type].label.toLowerCase()) + '.';
        return;
      }
      build.components[slot] = partFromSaved(doc);
      closeMenu();
      touch();
    } catch (err) {
      $('#swg-build-name').textContent = err.message;
    }
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
          el('button', { type: 'button', class: 'link small', title: 'Save the current build under this name', onclick: () => overwriteBuild(b.name) }, 'Overwrite'),
          trashButton('Delete ' + b.name, () => deleteBuild(b.name))));
      }
    } catch (err) {
      ul.replaceChildren();
      msg(err.message, true);
    }
  }
  function openPanel() {
    panel.hidden = false;
    msg('');
    $('#swg-save-name').value = (build.shipName || '').trim() || buildName || ''; // the ship's name, if it has one
    $('#swg-save-name').focus();
    refreshList();
  }
  const closePanel = () => { panel.hidden = true; };
  async function overwriteBuild(name) {
    if (!confirm('Overwrite the saved build “' + name + '” with the build on screen?')) return;
    await putBuild(name);
  }
  async function saveBuild(e) {
    e.preventDefault();
    const name = $('#swg-save-name').value.trim();
    if (!name) return msg('Give the build a name.', true);
    await putBuild(name);
  }
  async function putBuild(name) {
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
      build = C.ensureSlots(s, { ship: s.id, shipName: b.shipName || '', overloads: { ...fresh.overloads, ...b.overloads }, components: b.components || fresh.components });
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
    wireDragging($('#swg-slots'));
    document.addEventListener('swg:nfs', () => renderShipSelect()); // NFS content switched on / off
    $('#swg-layout-reset').addEventListener('click', () => saveLayout(null));
    // the server copy of the tile layouts wins (it follows you between computers)
    api('/prefs').then((p) => {
      if (p && p.layouts) { layouts = p.layouts; store.set('layouts', layouts); if (ship()) { renderSlots(); renderLayoutReset(); } }
    }).catch(() => {});
    $('#swg-shipname').addEventListener('input', (e) => {
      build.shipName = e.target.value;
      dirty = true;
      session.set('work', { build, buildName, dirty });
      renderName();
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
    const work = session.get('work');
    const last = shipById(store.get('ship'));
    if (work && work.build && shipById(work.build.ship)) {
      build = C.ensureSlots(shipById(work.build.ship), work.build);
      buildName = work.buildName || null;
      dirty = !!work.dirty;
      if (faction && shipById(build.ship).faction !== faction) { faction = null; store.set('faction', null); renderFactions(); }
    } else if (last && (!faction || last.faction === faction)) {
      build = C.defaultBuild(last);
    }
    renderShipSelect();
    renderAll();

    // back from the Loot page: /swg/ships?use=<saved component>&slot=<slot>
    const qs = new URLSearchParams(location.search);
    if (qs.get('use')) {
      history.replaceState(null, '', location.pathname);
      await useSaved(qs.get('use'), qs.get('slot'));
    }

    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menuEl) closeMenu(); });
    document.addEventListener('mousedown', (e) => {
      if (menuEl && !menuEl.contains(e.target) && !e.target.closest('.swg-slot')) closeMenu();
    });
  }
  init();
})();
