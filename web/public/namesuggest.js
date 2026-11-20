// Live card-name suggestions for the spreadsheet import's name boxes.
// Each box keeps its own candidates (from when the file was uploaded) at the top and adds
// matches for what you type, ranked like the nav search (watch lists, owned, all of MTGO).
(function () {
  const inputs = document.querySelectorAll('input[data-name-suggest]');
  if (!inputs.length) return;
  const shared = document.createElement('datalist');
  shared.id = 'name-suggest-live';
  document.body.append(shared);
  const cache = new Map();
  let timer = null;
  let ctrl = null;

  async function names(q) {
    if (cache.has(q)) return cache.get(q);
    if (ctrl) ctrl.abort();
    ctrl = new AbortController();
    const res = await fetch('/mtgo/api/suggest?' + new URLSearchParams({ q, limit: '12' }), { credentials: 'same-origin', signal: ctrl.signal });
    const list = res.ok ? (await res.json()).map((x) => x.name) : [];
    cache.set(q, list);
    return list;
  }

  function fill(input, list) {
    const own = (input.dataset.candidates || '').split('|').filter(Boolean);
    const all = [...new Set([...own, ...list])];
    shared.replaceChildren(...all.map((n) => Object.assign(document.createElement('option'), { value: n })));
  }

  for (const input of inputs) {
    input.addEventListener('focus', () => {
      input.setAttribute('list', shared.id);
      fill(input, []);
    });
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) return fill(input, []);
      timer = setTimeout(async () => {
        try {
          fill(input, await names(q));
        } catch {
          /* aborted by a newer keystroke */
        }
      }, 120);
    });
  }
})();
