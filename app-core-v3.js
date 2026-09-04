/* PropBetEdge NFL — standalone app core v3.2 */
(() => {
  'use strict';

  const aliases = {
    'season-history':'seasonhistory',
    season_history:'seasonhistory',
    superbowls:'sb',
    super_bowls:'sb'
  };

  let App = null;
  const rawViews = {};
  const views = new Proxy(rawViews, {
    set(target, prop, value) {
      target[prop] = value;
      const route = String(prop);
      queueMicrotask(() => {
        if (!App || typeof value !== 'function') return;
        if (App.current === route || App.pendingRoute === route) App.replayCurrent();
      });
      return true;
    }
  });

  /* ---- Deep-link contract -------------------------------------------------
     PropBetEdge News is the top of the funnel, so an article has to be able to
     land a reader on the intelligence that article is about, not just on the
     surface. ?event= already resolved across Market Watch, Model Lab, Matchups,
     Usage, Simulator, SGP Lab and PropChain; this adds the player and team
     halves and gives every consumer one place to read them.

       https://nfl.propbetedge.ai/?event=<id>#marketwatch
       https://nfl.propbetedge.ai/?player=Drake%20Maye#propboard
       https://nfl.propbetedge.ai/?team=SEA#teams

     Params are read from the query string, and also from a query appended to
     the hash (#propboard?player=...) so a link can carry both without the
     server ever seeing it. The routing contract itself is unchanged: nav()
     still takes a route, and VIEWS still maps route -> renderer. */
  function readParams() {
    const out = {};
    try {
      new URLSearchParams(location.search).forEach((v, k) => { out[k] = v; });
      const hash = String(location.hash || '').replace(/^#/, '');
      const q = hash.indexOf('?');
      if (q > -1) new URLSearchParams(hash.slice(q + 1)).forEach((v, k) => { out[k] = v; });
    } catch (_) {}
    return out;
  }

  App = {
    VIEWS: views,
    current: 'home',
    booted: false,
    pendingRoute: null,
    params: readParams(),

    normalize(route) {
      const raw = String(route || 'home').replace(/^#/,'').split('?')[0].trim().toLowerCase();
      return aliases[raw] || raw || 'home';
    },

    /* Canonical deep link, for the news site and for internal cross-links. */
    link(route, params) {
      const url = new URL(location.origin + '/');
      Object.entries(params || {}).forEach(([k, v]) => {
        if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, String(v));
      });
      url.hash = this.normalize(route) === 'home' ? '' : this.normalize(route);
      return url.href;
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
      this.params = readParams();

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
    App.params = readParams();
    const route = App.normalize(location.hash);
    if (route !== App.current) App.nav(route,{ history:false });
  });

  /* An article linking to a player opens the unified player drawer once the
     research module has registered. The drawer already carries market, model,
     news and archive with their own provenance, so it is the right landing
     surface for "see this player's research" rather than a bare route. */
  window.addEventListener('pbe:upgrades-ready',() => {
    const player = App.params.player;
    if (!player) return;
    let tries = 0;
    const open = () => {
      if (typeof window.PBEPlayerResearch?.show === 'function') {
        try { window.PBEPlayerResearch.show(player); } catch (error) { console.warn('[pbe-deeplink-player]',error?.message||error); }
        return;
      }
      if (tries++ < 20) setTimeout(open,150);
    };
    setTimeout(open,400);
  },{ once:true });
})();
