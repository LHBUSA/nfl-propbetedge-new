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
    pendingRoute: null,

    normalize(route) {
      const raw = String(route || 'home').replace(/^#/,'').trim().toLowerCase();
      return aliases[raw] || raw || 'home';
    },

    renderRegistered(view) {
      const renderer = this.VIEWS[view];
      if (typeof renderer !== 'function') return false;
      try {
        this.pendingRoute = null;
        renderer();
        window.scrollTo({ top:0, behavior:'instant' });
        window.dispatchEvent(new CustomEvent('pbe:route-changed',{ detail:{ route:view } }));
        return true;
      } catch (error) {
        console.error('PBE route render failed',view,error);
        return false;
      }
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

      if (this.renderRegistered(view)) return;

      this.pendingRoute = view;
      const vc = document.getElementById('view-container');
      if (vc) vc.innerHTML = `<div class="view-loading" data-pbe-pending-route="${view}"><div><div class="loading-mark"></div><div class="loading-text">Loading ${view.replace(/-/g,' ')}…</div></div></div>`;
      window.dispatchEvent(new CustomEvent('pbe:route-missing',{ detail:{ route:view } }));
    },

    registerView(route, renderer) {
      const view = this.normalize(route);
      if (typeof renderer !== 'function') return false;
      this.VIEWS[view] = renderer;
      if (this.current === view || this.pendingRoute === view) {
        queueMicrotask(() => {
          if (this.current === view && typeof this.VIEWS[view] === 'function') this.renderRegistered(view);
        });
      }
      return true;
    },

    replayCurrent() {
      const view = this.normalize(this.current || location.hash || 'home');
      if (typeof this.VIEWS[view] === 'function') return this.renderRegistered(view);
      return false;
    },

    toggleMobile() {
      document.getElementById('sidebar')?.classList.toggle('open');
      document.getElementById('mobile-overlay')?.classList.toggle('open');
    },

    boot() {
      if (this.booted) {
        this.replayCurrent();
        return;
      }
      this.booted = true;
      const hash = String(location.hash || '').replace(/^#/,'');
      const route = this.normalize(hash || this.current || 'home');
      setTimeout(() => this.nav(route,{ history:false }),0);
    }
  };

  window.App = App;

  // Compatibility stubs for upgrade modules that expect the historical globals to exist.
  window.HomeView = window.HomeView || { render() {} };

  window.addEventListener('pbe:view-registered',event => {
    const route = App.normalize(event?.detail?.route || '');
    if (route && App.current === route) App.replayCurrent();
  });
  window.addEventListener('pbe:upgrades-ready',() => {
    App.boot();
    setTimeout(() => App.replayCurrent(),0);
  });
  document.addEventListener('DOMContentLoaded',() => {
    setTimeout(() => {
      if (!App.booted && typeof App.VIEWS.home === 'function') App.boot();
      else App.replayCurrent();
    },450);
  },{ once:true });
  window.addEventListener('hashchange',() => {
    const route = App.normalize(location.hash);
    if (route !== App.current) App.nav(route,{ history:false });
  });
})();
