/* Admin page: ask before deleting a user. */
document.addEventListener('submit', (e) => {
  const msg = e.target.dataset && e.target.dataset.confirm;
  if (msg && !confirm(msg)) e.preventDefault();
});
