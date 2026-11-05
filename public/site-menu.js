(() => {
  for (const menu of document.querySelectorAll('.site-menu')) {
    document.addEventListener('click', e => { if (!menu.contains(e.target)) menu.open = false; });
    menu.addEventListener('keydown', e => { if (e.key === 'Escape') { menu.open = false; menu.querySelector('summary')?.focus(); } });
    menu.querySelectorAll('a').forEach(a => a.addEventListener('click', () => { menu.open = false; }));
  }
  const adminLinks = document.querySelectorAll('[data-admin-nav]');
  if (adminLinks.length) fetch('/api/auth/me', {credentials:'same-origin',cache:'no-store'}).then(r => r.ok ? r.json() : null).then(data => {
    if (data?.user?.role === 'admin') adminLinks.forEach(link => { link.hidden = false; });
  }).catch(() => {});
})();
