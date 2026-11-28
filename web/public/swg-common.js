/* SWG pages: the "Include NFS content" switch in the sub-navigation.
 * Remembered in this browser; pages listen for the 'swg:nfs' event to redraw. */
(function () {
  'use strict';
  const KEY = 'swg.nfs';
  // an admin can turn NFS content off for a user: then there's no switch and it's always off
  const locked = !!document.querySelector('meta[name="swg-nfs"][content="off"]');
  const read = () => { if (locked) return false; try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; } };
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
