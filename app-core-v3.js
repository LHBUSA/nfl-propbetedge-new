/* PropBetEdge NFL — standalone app core v3.1 */
(() => {
  'use strict';

  const aliases = {
    'season-history':'seasonhistory',
    season_history:'seasonhistory',
    superbowls:'sb',
    super_bowls:'sb'
  };

  const App = {
    VIEWS: {},
    current: 'home',
    booted: false,

    normalize(route) {
      const raw = String(route || 'home').replace(/^#/,'').trim().toLowerCase();
      return aliases[raw] || raw || 'home';
    },

    nav(route, options = {}) {
      const view = this.normalize(route);
      this.current = view;

      document.querySelectorAll('.sidebar-nav .nav-item').forEach(el => el.classList.remove('active'));
      document.getElementById(`nav-${view}`)?.classList.add('active');

      const sidebar = document.getElementById('sidebar');
      const overlay = document.getElementById('mobile-overlay');
      sidebar?.classList.remove('open');
      overlay?.classList.remove('open');

      try { if (typeof window.pbeMbnActive === 'function') window.pbeMbnActive(view); } catch (_) {}

      if (options.history !== false) {
        const url = new URL(location.href);
        url.hash = view === 'home' ? '' : view;
        history.replaceState({ view },'',url);
      }

      const renderer = this.VIEWS[view];
      if (typeof renderer === 'function') {
        try {
          renderer();
          window.scrollTo({ top:0, behavior:'instant' });
          window.dispatchEvent(new CustomEvent('pbe:route-changed',{ detail:{ route:view } }));
          return true;
        } catch (error) {
          console.error('PBE route render failed',view,error);
        }
      }

      const vc = document.getElementById('view-container');
      if (vc) vc.innerHTML = `<div class="view-loading"><div><div class="loading-mark"></div><div class="loading-text">Loading ${view.replace(/-/g,' ')}…</div></div></div>`;
      return false;
    },

    toggleMobile() {
      document.getElementById('sidebar')?.classList.toggle('open');
      document.getElementById('mobile-overlay')?.classList.toggle('open');
    },

    boot() {
      if (this.booted) return;
      this.booted = true;
      const route = routeFromLocation();
      setTimeout(() => this.nav(route,{ history:false }),0);
    }
  };

  function routeFromLocation() {
    const hash = String(location.hash || '').replace(/^#/,'');
    return App.normalize(hash || App.current || 'home');
  }

  window.App = App;

  // Compatibility stub for upgrade modules that expect the historical global.
  window.HomeView = window.HomeView || { render() {} };

  /* A deep-link can boot before page-loader has registered that route's renderer.
   * When the ordered upgrade loader finishes, ALWAYS render the requested route
   * again. Previously App.boot() returned early once booted, leaving the user on
   * a permanent Loading... shell after a hard refresh of #marketwatch, #pbecast,
   * #pbepicks and other late-loaded routes. */
  window.addEventListener('pbe:upgrades-ready',() => {
    if (!App.booted) {
      App.boot();
      return;
    }
    App.nav(routeFromLocation(),{ history:false });
  },{ once:true });

  document.addEventListener('DOMContentLoaded',() => {
    setTimeout(() => {
      if (!App.booted && typeof App.VIEWS.home === 'function') App.boot();
    },450);
  },{ once:true });

  window.addEventListener('hashchange',() => {
    const route = App.normalize(location.hash);
    if (route !== App.current) App.nav(route,{ history:false });
  });
})();
