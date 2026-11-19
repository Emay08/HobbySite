(function () {
  const zone = document.getElementById('dropzone');
  const input = document.getElementById('file');
  const status = document.getElementById('status');
  if (!zone) return;

  const fmtTix = (n) =>
    new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n) + ' tix';
  const fmtInt = (n) => new Intl.NumberFormat('en-US').format(n);

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
    for (const c of children) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return node;
  }

  function show(...nodes) {
    status.replaceChildren(...nodes);
    status.classList.remove('hidden');
  }

  ['dragenter', 'dragover'].forEach((ev) =>
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.add('over');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.remove('over');
    })
  );
  // Stop the browser from opening a file dropped outside the zone
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  zone.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) send(file);
  });
  input.addEventListener('change', () => {
    if (input.files[0]) send(input.files[0]);
    input.value = '';
  });

  async function send(file) {
    if (!/\.csv$/i.test(file.name)) {
      show(el('p', { class: 'error' }, 'That is not a .csv file.'));
      return;
    }
    zone.classList.add('busy');
    show(el('p', {}, el('span', { class: 'spinner' }), ' Uploading ', el('strong', {}, file.name), '…'));

    const body = new FormData();
    body.append('file', file);
    try {
      const res = await fetch('/mtgo/upload', {
        method: 'POST',
        body,
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      });
      const data = await res.json().catch(() => ({ error: `Server returned ${res.status}` }));
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      renderResult(file.name, data);
    } catch (err) {
      show(el('p', { class: 'error' }, err.message));
    } finally {
      zone.classList.remove('busy');
    }
  }

  function renderResult(name, d) {
    const nodes = [
      el('h3', {}, '✓ Collection updated'),
      el('p', { class: 'small muted' }, name),
      el(
        'div',
        { class: 'stats mini' },
        stat('Total value', fmtTix(d.totalValue)),
        stat('Cards', fmtInt(d.totalCards)),
        stat('Unique', fmtInt(d.uniqueCards))
      ),
      el(
        'p',
        { class: 'small' },
        `${fmtInt(d.diff.added)} new · ${fmtInt(d.diff.removed)} gone · ${fmtInt(d.diff.changed)} quantity changes`
      ),
    ];
    if (d.diff.sampleAdded.length) {
      nodes.push(el('p', { class: 'small muted' }, 'New: ' + d.diff.sampleAdded.map((c) => c.name).join(', ')));
    }
    if (d.diff.sampleRemoved.length) {
      nodes.push(el('p', { class: 'small muted' }, 'Gone: ' + d.diff.sampleRemoved.map((c) => c.name).join(', ')));
    }
    if (d.unpriced) {
      nodes.push(el('p', { class: 'small muted' }, `${fmtInt(d.unpriced)} entries have no price yet.`));
    }
    if (d.warnings.length) {
      const ul = el('ul', { class: 'small muted' });
      d.warnings.forEach((w) => ul.append(el('li', {}, w)));
      nodes.push(ul);
    }
    nodes.push(el('p', {}, el('a', { href: '/mtgo/collection', class: 'btn primary' }, 'View collection →')));
    show(...nodes);
  }

  function stat(label, value) {
    return el('div', { class: 'stat' }, el('span', { class: 'stat-label' }, label), el('span', { class: 'stat-value' }, value));
  }
})();
