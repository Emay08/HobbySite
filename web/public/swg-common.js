/* SWG pages: the "Include NFS content" switch in the sub-navigation.
 * Remembered in this browser; pages listen for the 'swg:nfs' event to redraw. */
(function () {
  'use strict';
  const KEY = 'swg.nfs';
  const read = () => { try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; } };
  window.SwgNfs = { on: read };
  function wire() {
    const box = document.getElementById('swg-nfs');
    if (!box) return;
    box.checked = read();
    box.addEventListener('change', () => {
      try { localStorage.setItem(KEY, box.checked ? 'on' : 'off'); } catch { /* ignore */ }
      document.dispatchEvent(new CustomEvent('swg:nfs', { detail: { on: box.checked } }));
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
