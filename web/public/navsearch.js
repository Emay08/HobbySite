// Nav-bar card search with autocomplete. Press "/" anywhere to jump to it.
(function () {
  const form = document.getElementById('nav-search');
  if (!form) return;
  const input = form.querySelector('input');
  const list = form.querySelector('.nav-suggest');
  const cache = new Map();
  let items = [];
  let active = -1;
  let controller = null;
  let timer = null;

  const cardUrl = (name) => '/mtgo/card/' + encodeURIComponent(name);

  function render() {
    list.replaceChildren();
    active = items.length ? 0 : -1;
    items.forEach((it, i) => {
      const li = document.createElement('li');
      li.className = 'nav-suggest-item' + (i === 0 ? ' active' : '');
      li.setAttribute('role', 'option');
      const name = document.createElement('span');
      name.textContent = it.name;
      li.append(name);
      if (it.label) {
        const tag = document.createElement('span');
        tag.className = 'tier tier-' + it.label;
        tag.textContent = it.label === 'owned' ? 'owned' : it.label + '-term';
        li.append(tag);
      }
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        location.href = cardUrl(it.name);
      });
      list.append(li);
    });
    list.hidden = !items.length;
    input.setAttribute('aria-expanded', String(!!items.length));
  }

  async function lookup(q) {
    const key = q.toLowerCase();
    if (cache.has(key)) {
      items = cache.get(key);
      return render();
    }
    if (controller) controller.abort(); // drop the slower, older request
    controller = new AbortController();
    try {
      const res = await fetch('/mtgo/api/suggest?q=' + encodeURIComponent(q), {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
        signal: controller.signal,
      });
      if (!res.ok) return;
      const data = await res.json();
      cache.set(key, data);
      if (input.value.trim().toLowerCase() === key) {
        items = data;
        render();
      }
    } catch (e) {
      /* aborted or offline */
    }
  }

  input.addEventListener('input', () => {
    const q = input.value.trim();
    clearTimeout(timer);
    if (q.length < 2) {
      items = [];
      return render();
    }
    timer = setTimeout(() => lookup(q), 60);
  });

  input.addEventListener('keydown', (e) => {
    const opts = list.querySelectorAll('.nav-suggest-item');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!opts.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length;
      opts.forEach((o, i) => o.classList.toggle('active', i === active));
    } else if (e.key === 'Escape') {
      list.hidden = true;
      input.blur();
    }
  });

  form.addEventListener('submit', (e) => {
    if (active >= 0 && items[active]) {
      e.preventDefault();
      location.href = cardUrl(items[active].name);
    } // otherwise the form goes to /mtgo/go?q=…, which picks the best match on the server
  });

  input.addEventListener('blur', () => setTimeout(() => (list.hidden = true), 120));
  input.addEventListener('focus', () => {
    if (items.length) list.hidden = false;
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });
})();
