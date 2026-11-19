// Fills the live vendor columns on a card page.
(function () {
  const status = document.getElementById('live-status');
  if (!status || status.dataset.enabled !== '1') {
    document.querySelectorAll('td.live').forEach((td) => (td.textContent = '—'));
    return;
  }
  const name = status.dataset.name;

  const money = (n) => (n == null ? '—' : n < 0.1 ? n.toFixed(3) : n.toFixed(2));
  const key = (set, foil) => `${String(set || '').toUpperCase()}|${foil ? 1 : 0}`;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  fetch('/mtgo/api/live?name=' + encodeURIComponent(name), { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
    .then(render)
    .catch((err) => {
      status.textContent = 'Live prices unavailable: ' + err.message;
      document.querySelectorAll('td.live').forEach((td) => (td.textContent = '—'));
    });

  function render(data) {
    const rows = Array.from(document.querySelectorAll('tr[data-version]'));
    const versionsPerKey = {};
    document.querySelectorAll('table.versions tr[data-version]').forEach((tr) => {
      const k = key(tr.dataset.set, tr.dataset.foil === '1');
      versionsPerKey[k] = (versionsPerKey[k] || 0) + 1;
    });

    // Cardhoarder: matched by MTGO ID (their card id is the MTGO catalog ID)
    const ch = data.vendors.cardhoarder || { ok: false, error: 'no data' };
    const chById = {};
    if (ch.ok) ch.rows.forEach((r) => (chById[r.mtgoId] = r));

    // Dojo: matched by set + foil, only when that's unambiguous on both sides
    const dj = data.vendors.dojo || { ok: false, error: 'no data' };
    const djByKey = {};
    if (dj.ok) dj.rows.forEach((r) => (djByKey[key(r.set, r.foil)] = djByKey[key(r.set, r.foil)] || []).push(r));
    const usedDojo = new Set();

    for (const tr of rows) {
      const id = tr.dataset.version;
      const k = key(tr.dataset.set, tr.dataset.foil === '1');
      const chRow = chById[id] || null;
      const djCandidates = djByKey[k] || [];
      const djRow = djCandidates.length === 1 && versionsPerKey[k] === 1 ? djCandidates[0] : null;
      if (djRow) usedDojo.add(djRow);

      tr.querySelectorAll('td.live').forEach((td) => {
        const vendor = td.dataset.vendor;
        const field = td.dataset.field;
        const src = vendor === 'cardhoarder' ? ch : dj;
        const row = vendor === 'cardhoarder' ? chRow : djRow;
        td.classList.remove('best');
        if (!src.ok) {
          td.textContent = '!';
          td.title = src.error;
          td.classList.add('muted');
          return;
        }
        if (!row) {
          td.textContent = '—';
          return;
        }
        const v = row[field];
        td.textContent = field === 'stock' ? (v == null ? '—' : String(v)) : money(v);
        if (field === 'stock' && v === 0) td.classList.add('muted');
        td.dataset.value = v == null ? '' : v;
      });

      // Best offers: lowest sell (cheapest to buy), highest buy (best to sell to)
      const pick = (field, better) => {
        const cells = Array.from(tr.querySelectorAll(`td.live[data-field="${field}"]`)).filter((td) => td.dataset.value !== '' && td.dataset.value != null);
        if (cells.length < 2) return;
        const best = cells.reduce((a, b) => (better(+b.dataset.value, +a.dataset.value) ? b : a));
        best.classList.add('best');
      };
      pick('sell', (a, b) => a < b);
      pick('buy', (a, b) => a > b);
    }

    // Dojo rows we couldn't place
    if (dj.ok) {
      const left = dj.rows.filter((r) => !usedDojo.has(r));
      const box = document.getElementById('unmatched'); // not shown: only GoatBots' versions count
      if (left.length && box) {
        const tbody = box.querySelector('tbody');
        for (const r of left) {
          const tr = el('tr');
          const a = el('a', null, r.label);
          a.href = r.url;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          const td0 = el('td');
          td0.append(a, r.foil ? el('span', 'foil', ' ✦') : '');
          tr.append(td0, el('td', null, r.set), el('td', 'num', money(r.sell)), el('td', 'num', money(r.buy)), el('td', 'num small', r.stock == null ? '—' : String(r.stock)));
          tbody.append(tr);
        }
        box.classList.remove('hidden');
      }
    }

    const time = new Date(data.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const problems = [];
    if (!ch.ok) problems.push('Cardhoarder: ' + ch.error);
    if (!dj.ok) problems.push('Dojo: ' + dj.error);
    status.textContent = `Live prices from ${time}${data.cached ? ' (cached)' : ''}.` + (problems.length ? ' ' + problems.join(' · ') : '') + ' Best offers are highlighted.';
  }
})();
