/* PropBetEdge — Google Preferred Sources control (port of propbetedge-news-site
 * src/components/preferred-source.js).
 *
 * Our own markup, visible on first paint; nothing waits on Google's async
 * publisher.js. One delegated document click listener covers every control the
 * footer (or any later render) inserts, and cannot double-bind.
 *
 * Source policy (google.com/preferences/source, checked 2026-09-30):
 *   eligible:   propbetedge.ai, mlb.propbetedge.ai, ufc.propbetedge.ai -> SDK, own host
 *   not listed: nfl/nba/wnba/nhl/tennis/soccer.propbetedge.ai        -> deeplink to propbetedge.ai
 * The SDK always targets the current page, so it is only loaded on hosts Google
 * lists. nfl.propbetedge.ai is not listed: the control is the deeplink to the
 * parent source and publisher.js is never loaded here.
 */
(() => {
  'use strict';

  const PARENT_SOURCE = 'propbetedge.ai';
  const ELIGIBLE_SOURCES = new Set(['propbetedge.ai', 'mlb.propbetedge.ai', 'ufc.propbetedge.ai']);
  const SDK_SRC = 'https://news.google.com/swg/js/v1/publisher.js';
  const SPORT = 'nfl';

  let sdkApi = null;
  let installed = false;

  function target(host = location.hostname) {
    const h = String(host || '').toLowerCase().replace(/^www\./, '');
    if (ELIGIBLE_SOURCES.has(h)) return { source: h, sdk: true };
    return { source: PARENT_SOURCE, sdk: false };
  }

  function deeplink(source = target().source) {
    return `https://www.google.com/preferences/source?q=${encodeURIComponent(source)}`;
  }

  function escapeAttr(value) {
    return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  /* surface: 'footer' | 'article' | 'homepage'. The href is the working
     fallback, so the control works with the SDK blocked or before JS binds. */
  function render({ surface = 'footer', sport = SPORT } = {}) {
    const attrs = `href="${escapeAttr(deeplink())}" target="_blank" rel="noopener" data-pbe-preferred-source data-surface="${escapeAttr(surface)}" data-sport="${escapeAttr(sport)}"`;
    return `<div class="pbe-psrc pbe-psrc--${escapeAttr(surface)}">
      <div class="pbe-psrc-copy">
        <span class="pbe-psrc-eyebrow">Google Search</span>
        <strong>Make PropBetEdge a preferred source</strong>
        <span>See more PropBetEdge reporting in Google.</span>
      </div>
      <a class="pbe-psrc-btn" ${attrs} aria-label="Add PropBetEdge as a preferred source in Google Search (opens Google)">Add as preferred source</a>
    </div>`;
  }

  function mount() {
    if (installed) return;
    installed = true;
    document.addEventListener('click', onClick);
    if (!target().sdk) return;
    (self.PREFERRED_SOURCE = self.PREFERRED_SOURCE || []).push((api) => {
      api.init({ theme: 'dark', lang: 'en' });
      sdkApi = api;
    });
    if (!document.querySelector(`script[src="${SDK_SRC}"]`)) {
      const s = document.createElement('script');
      s.async = true;
      s.src = SDK_SRC;
      s.setAttribute('preferred-sources-control', 'manual');
      document.head.appendChild(s);
    }
  }

  function onClick(event) {
    const el = event.target?.closest?.('[data-pbe-preferred-source]');
    if (!el) return;
    let method = 'deeplink_fallback';
    const plain = event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
    if (plain && sdkApi && target().sdk) {
      try {
        sdkApi.addPreferredSource();
        method = 'sdk';
        event.preventDefault();
      } catch (_) { /* the deeplink href opens instead */ }
    }
    if (typeof window.gtag === 'function') {
      window.gtag('event', 'preferred_source_click', {
        surface: el.dataset.surface || 'footer',
        sport: el.dataset.sport || SPORT,
        method,
      });
    }
  }

  window.PBEPreferredSource = { render, mount, target, deeplink };
  mount();
})();
