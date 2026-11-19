// Card search pickers (no inline scripts: the site's CSP only allows files from /static).
(function () {
  const fmt = (n) => (n == null ? '—' : n.toFixed(2) + ' tix');
  const debounce = (fn, ms) => {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  };
  function el(tag, cls, ...kids) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    for (const k of kids) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return n;
  }

  const pickers = new Map();

  document.querySelectorAll('[data-picker]').forEach((root) => {
    const input = root.querySelector('.picker-input');
    const hidden = root.querySelector('.picker-value');
    const list = root.querySelector('.picker-results');
    const chosen = root.querySelector('.picker-chosen');
    const ownedOnly = root.dataset.ownedOnly === '1';
    let results = [];
    let active = -1;
    let reqId = 0;

    const api = { root, value: null, onChange: [] };
    pickers.set(root.id, api);

    // Two steps: card names (ranked like the nav search: watch lists, owned, then all of
    // MTGO), then the versions of the chosen name.
    let mode = 'names';
    let names = [];
    let pickedName = null;

    async function loadNames(q) {
      const id = ++reqId;
      const qs = new URLSearchParams({ q, limit: '12' });
      if (ownedOnly) qs.set('owned', '1');
      const res = await fetch('/mtgo/api/suggest?' + qs, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
      if (id !== reqId) return;
      names = res.ok ? await res.json() : [];
      mode = 'names';
      render();
    }

    async function load(params) {
      const id = ++reqId;
      const qs = new URLSearchParams(params);
      if (ownedOnly) qs.set('owned', '1');
      const res = await fetch('/mtgo/api/cards?' + qs, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
      if (id !== reqId) return; // a newer search has started
      results = res.ok ? await res.json() : [];
      mode = 'versions';
      if (pickedName && results.length === 1) return choose(results[0]);
      render();
    }

    function pickName(n) {
      pickedName = n;
      input.value = n;
      load({ name: n });
    }

    function render() {
      list.replaceChildren();
      active = -1;
      if (mode === 'names') {
        if (!names.length) list.append(el('li', 'picker-empty', input.value.trim().length < 2 ? 'Type at least 2 letters' : 'No matches'));
        names.forEach((n, i) => {
          const li = el('li', 'picker-option picker-name', el('span', 'po-name', n.name), n.label ? el('span', 'tier tier-' + n.label, n.label === 'owned' ? 'owned' : n.label + '-term') : '');
          li.setAttribute('role', 'option');
          li.dataset.index = i;
          li.addEventListener('mousedown', (e) => {
            e.preventDefault();
            pickName(n.name);
          });
          li.addEventListener('mouseenter', () => setActive(i));
          list.append(li);
        });
        if (names.length) setActive(0);
        list.classList.remove('hidden');
        input.setAttribute('aria-expanded', 'true');
        return;
      }
      if (pickedName) {
        const backLi = el('li', 'picker-back small muted', `← ${results.length} version${results.length === 1 ? '' : 's'} of ${pickedName} — pick one`);
        backLi.addEventListener('mousedown', (e) => {
          e.preventDefault();
          pickedName = null;
          loadNames(input.value.trim());
        });
        list.append(backLi);
      }
      if (!results.length) {
        list.append(el('li', 'picker-empty', input.value.trim().length < 2 && !api.printingsName ? 'Type at least 2 letters' : 'No matches'));
      }
      results.forEach((c, i) => {
        const thumb = c.imgSmall ? Object.assign(el('img', 'ver-thumb'), { src: c.imgSmall, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' }) : el('span', 'ver-thumb ver-thumb-none');
        const li = el(
          'li',
          'picker-option' + (c.label !== undefined ? ' picker-version' : ''),
          c.label !== undefined
            ? el('span', 'po-name', thumb, el('span', '', c.foil ? el('span', 'foil', '✦ ') : '', c.label || c.name, c.collector ? el('span', 'muted small', ` #${c.collector}`) : ''))
            : el('span', 'po-name', c.name, c.foil ? el('span', 'foil', ' ✦') : ''),
          el('span', 'setcode', c.set || '?'),
          el('span', 'po-owned muted small', c.owned ? `own ${c.owned}` : ''),
          el('span', 'po-price num', fmt(c.price))
        );
        li.setAttribute('role', 'option');
        li.addEventListener('mousedown', (e) => {
          e.preventDefault();
          choose(c);
        });
        li.dataset.index = i;
        if (c.imgLarge) li.dataset.preview = c.imgLarge; // hover shows the card (cardpreview.js)
        li.addEventListener('mouseenter', () => setActive(i));
        list.append(li);
      });
      if (results.length) setActive(0);
      list.classList.remove('hidden');
      input.setAttribute('aria-expanded', 'true');
    }

    function setActive(i) {
      const opts = list.querySelectorAll('.picker-option');
      active = i;
      opts.forEach((o, j) => o.classList.toggle('active', j === i));
    }

    function close() {
      list.classList.add('hidden');
      input.setAttribute('aria-expanded', 'false');
    }

    function choose(c) {
      api.value = c;
      hidden.value = c.mtgoId;
      input.value = '';
      input.classList.add('hidden');
      chosen.replaceChildren(
        el('span', 'po-name', c.name, c.foil ? el('span', 'foil', ' ✦ foil') : ''),
        el('span', 'setcode', c.set || '?'),
        el('span', 'num', fmt(c.price)),
        Object.assign(el('button', 'link small', 'change'), { type: 'button', onclick: clear })
      );
      chosen.classList.remove('hidden');
      close();
      api.onChange.forEach((f) => f(c));
    }

    function clear() {
      api.value = null;
      pickedName = null;
      hidden.value = '';
      chosen.classList.add('hidden');
      input.classList.remove('hidden');
      input.focus();
      api.onChange.forEach((f) => f(null));
    }
    api.clear = clear;

    const search = debounce(() => {
      const q = input.value.trim();
      if (q.length < 2) {
        if (api.printingsName) return load({ name: api.printingsName });
        results = [];
        return render();
      }
      pickedName = null;
      loadNames(q);
    }, 120);

    input.addEventListener('input', search);
    input.addEventListener('focus', () => {
      if (api.printingsName && !input.value.trim()) load({ name: api.printingsName });
      else if (names.length || results.length) render();
    });
    input.addEventListener('blur', () => setTimeout(close, 120));
    input.addEventListener('keydown', (e) => {
      const opts = list.querySelectorAll('.picker-option');
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!opts.length) return;
        setActive((active + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length);
        opts[active].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault(); // never submit the form from the search box
        if (mode === 'names') {
          const n = names[active >= 0 ? active : 0];
          if (n) pickName(n.name);
        } else if (active >= 0 && results[active]) choose(results[active]);
        else if (results.length === 1) choose(results[0]);
      } else if (e.key === 'Escape') {
        close();
      }
    });
  });

  // "Wanted version" pickers list every printing of the owned card's name.
  pickers.forEach((api) => {
    const sourceId = api.root.dataset.printingsOf;
    const source = sourceId && pickers.get(sourceId);
    if (!source) return;
    const input = api.root.querySelector('.picker-input');
    source.onChange.push((c) => {
      api.printingsName = c ? c.name : null;
      if (api.value && (!c || api.value.name !== c.name)) api.clear();
      input.placeholder = c ? `Other printings of ${c.name}…` : 'Search card name…';
      if (c) input.focus();
    });
  });

  // Don't submit a form whose picker hasn't been filled in.
  document.querySelectorAll('form').forEach((form) => {
    const required = form.querySelectorAll('[data-picker] .picker-value');
    if (!required.length) return;
    form.addEventListener('submit', (e) => {
      for (const h of required) {
        if (!h.value) {
          e.preventDefault();
          const input = h.closest('[data-picker]').querySelector('.picker-input');
          input.classList.add('invalid');
          input.focus();
          return;
        }
      }
    });
  });

  // Inline edit forms: reveal on "edit" click
  document.querySelectorAll('[data-toggle]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.toggle);
      if (target) target.classList.toggle('hidden');
    })
  );
})();
