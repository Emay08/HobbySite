// Full-size card image that follows the mouse over anything with data-preview="<image url>"
// (card page image, version thumbnails, picker versions).
(function () {
  let box = null;
  let current = null;
  const W = 300;
  const H = Math.round((W * 680) / 488);

  function ensure() {
    if (box) return box;
    box = document.createElement('img');
    box.className = 'card-preview';
    box.alt = '';
    box.referrerPolicy = 'no-referrer';
    box.hidden = true;
    document.body.append(box);
    return box;
  }

  function place(e) {
    const pad = 18;
    let x = e.clientX + pad;
    let y = e.clientY - H / 3;
    if (x + W > window.innerWidth - 8) x = e.clientX - W - pad; // flip to the left near the edge
    y = Math.max(8, Math.min(y, window.innerHeight - H - 8));
    box.style.left = x + 'px';
    box.style.top = y + 'px';
  }

  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest && e.target.closest('[data-preview]');
    if (!t || !t.dataset.preview) return;
    if (matchMedia('(hover: none)').matches) return; // touch screens: no hover
    current = t;
    ensure();
    if (box.getAttribute('src') !== t.dataset.preview) box.src = t.dataset.preview;
    box.hidden = false;
    place(e);
  });
  document.addEventListener('mousemove', (e) => {
    if (current && box && !box.hidden) place(e);
  });
  document.addEventListener('mouseout', (e) => {
    if (!current) return;
    const to = e.relatedTarget;
    if (to && current.contains(to)) return;
    current = null;
    if (box) box.hidden = true;
  });
  document.addEventListener('scroll', () => box && (box.hidden = true), { passive: true });
})();
