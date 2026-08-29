/* PropBetEdge NFL — dashboard v7 truth sanitizer.
   Removes only fact cards whose rendered source value is explicitly unavailable.
   No DOM rewrites, no polling, no self-triggering render loop. */
(() => {
  'use strict';

  const BAD = /^(?:null|undefined|n\/a|na|—|-|\?|null\s*\/\s*null|undefined\s*\/\s*undefined)$/i;

  function invalid(value) {
    const text = String(value || '').trim();
    if (!text) return true;
    if (BAD.test(text)) return true;
    const parts = text.split('/').map(part => part.trim());
    return parts.length > 1 && parts.every(part => !part || BAD.test(part));
  }

  function sanitize(root = document) {
    root.querySelectorAll('.pbe7-livefacts > div').forEach(card => {
      const value = card.querySelector('strong')?.textContent || '';
      if (invalid(value)) card.remove();
    });
    const wrap = root.querySelector('.pbe7-livefacts');
    if (wrap && !wrap.children.length) wrap.remove();
  }

  function install() {
    sanitize();
    const host = document.getElementById('view-container');
    if (!host) return;
    let queued = false;
    const observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        sanitize(host);
      });
    });
    observer.observe(host, { childList: true, subtree: true });
    window.PBE7TruthSanitizer = { sanitize, observer };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();
