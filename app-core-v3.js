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

  /* ---- Terminal route authority ------------------------------------------
     Several routes are built from stacked generations that all register the
     same VIEWS key (PBEcast had four: a ui-v2 placeholder, v4, v5 and v6).
     Because this Proxy replays the active route on every registration, and
     because the upgrade loader replays the pending route after every module,
     each generation repainted the live route in turn on a deep link. That is
     the PBEcast refresh flash: placeholder -> v4 -> v5 -> v6, every load.

     The loader therefore publishes window.PBEUpgrades: which routes still
     have a terminal authority in flight, and when each one lands. Until a
     declared route's authority has installed, nothing may paint that route
     and nothing may boot into it — the document's own .view-loading state
     stands instead. Once the authority has installed it OWNS the route: a
     later generic or compatibility module cannot take it back.

     This is a readiness contract, not a delay. Routes that declare no
     terminal authority are unaffected and behave exactly as before. */
  function upgrades() { return window.PBEUpgrades || null; }
  function routeIsDeclared(route) {
    const up = upgrades();
    return !!(up && typeof up.declares === 'function' && up.declares(route));
  }
  function routeAuthorityReady(route) {
    const up = upgrades();
    if (!up || up.failed) return true;      // no loader present, or the loader genuinely failed
    if (typeof up.ready !== 'function') return true;
    return up.ready(route);
  }
  function routeAuthorityOwned(route) {
    return routeIsDeclared(route) && routeAuthorityReady(route);
  }

  const views = new Proxy(rawViews, {
    set(target, prop, value) {
      const route = String(prop);
      if (typeof rawViews[route] === 'function' && value !== rawViews[route] && routeAuthorityOwned(route)) {
        console.warn('[pbe-route-ownership] refused reassignment of',route,'— terminal authority already installed');
        return true;
      }
      target[prop] = value;
      queueMicrotask(() => {
        if (!App || typeof value !== 'function') return;
        if (!App.booted) { App.bootWhenReady(); return; }
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

    /* Is this route paintable right now? A route whose terminal authority is
       still in flight is not: painting it would show a generation the loader
       is about to replace. */
    routeReady(route) { return routeAuthorityReady(this.normalize(route)); },

    renderRegistered(view) {
      const renderer = this.VIEWS[view];
      if (typeof renderer !== 'function') return false;
      if (!routeAuthorityReady(view)) return false;
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

    /* The route this document was actually opened on. Boot readiness is
       decided against it, never against 'home': deciding a #pbecast deep
       link's boot on whether the dashboard happened to register yet is the
       race this replaces. */
    bootRoute() {
      return this.normalize(String(location.hash || '').replace(/^#/,'') || this.current || 'home');
    },

    canBoot() {
      const view = this.bootRoute();
      return routeAuthorityReady(view) && typeof this.VIEWS[view] === 'function';
    },

    /* Boot the moment the opened route can actually be painted by the module
       that owns it, and not before. Called on every view registration, on
       every terminal-authority landing, and when the loader settles either
       way — so there is no timer anywhere in this path. */
    bootWhenReady() {
      if (this.booted) { this.replayCurrent(); return false; }
      if (!this.canBoot()) return false;
      this.boot();
      return true;
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
      const route = this.bootRoute();
      /* Claim the route before the deferred nav runs. Otherwise App.current
         is still 'home' for that gap, and any module registering the home
         view inside it would replay a dashboard over a deep link that is
         about to become something else. */
      this.current = route;
      this.pendingRoute = route;
      setTimeout(() => this.nav(route,{ history:false }),0);
    }
  };

  window.App = App;

  // Compatibility stubs for upgrade modules that expect the historical globals to exist.
  window.HomeView = window.HomeView || { render() {} };

  /* ---- Boot lifecycle -----------------------------------------------------
     Three signals drive it, all of them facts rather than timings:

       pbe:route-authority-ready  a declared route's terminal module installed
       pbe:upgrades-ready         the loader finished the whole manifest
       pbe:upgrades-failed        the loader gave up; nothing more is coming

     plus every VIEWS registration (see the Proxy above). The DOMContentLoaded
     path is the genuine-absence fallback only: if no upgrade loader ever
     announced itself there is nothing to wait for, so boot on what we have.
     Until one of these fires, the document's own .view-loading state stands. */
  window.addEventListener('pbe:route-authority-ready',() => { App.bootWhenReady(); });
  window.addEventListener('pbe:upgrades-ready',() => {
    App.boot();
    setTimeout(() => App.replayCurrent(),0);
  });
  window.addEventListener('pbe:upgrades-failed',() => {
    App.boot();
    setTimeout(() => App.replayCurrent(),0);
  });
  document.addEventListener('DOMContentLoaded',() => {
    if (window.PBEUpgrades) { App.bootWhenReady(); return; }
    if (!App.booted) App.boot(); else App.replayCurrent();
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
