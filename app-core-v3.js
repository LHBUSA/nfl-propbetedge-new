/* PropBetEdge NFL — standalone app core v3.2 */
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

      document.getElementById('sidebar')?.classList.remove('open');
      document.getElementById('mobile-overlay')?.classList.remove('open');

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
          renderFailure(view,'Workspace render failed.');
          return false;
        }
      }

      renderLoading(view);
      window.dispatchEvent(new CustomEvent('pbe:route-missing',{ detail:{ route:view } }));
      return false;
    },

    toggleMobile() {
      document.getElementById('sidebar')?.classList.toggle('open');
      document.getElementById('mobile-overlay')?.classList.toggle('open');
    },

    boot() {
      if (this.booted) return;
      this.booted = true;
      setTimeout(() => this.nav(routeFromLocation(),{ history:false }),0);
    }
  };

  function routeFromLocation() {
    const hash = String(location.hash || '').replace(/^#/,'');
    return App.normalize(hash || App.current || 'home');
  }

  function renderLoading(view){
    const vc=document.getElementById('view-container');
    if(!vc)return;
    vc.innerHTML=`<div class="view-loading" data-pbe-loading-route="${escapeHtml(view)}"><div><div class="loading-mark"></div><div class="loading-text">Loading ${escapeHtml(view.replace(/-/g,' '))}…</div></div></div>`;
  }

  function renderFailure(view,message){
    const vc=document.getElementById('view-container');
    if(!vc)return;
    vc.innerHTML=`<div class="view-loading pbe-load-failed"><div><div class="loading-text">${escapeHtml(message)}</div><button type="button" onclick="App.nav('${escapeJs(view)}',{history:false})">Retry workspace</button></div></div>`;
  }

  function escapeHtml(value){return String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
  function escapeJs(value){return String(value??'').replace(/\\/g,'\\\\').replace(/'/g,"\\'")}

  window.App = App;
  window.HomeView = window.HomeView || { render() {} };
  window.PBEAppCore = { routeFromLocation, renderFailure };

  window.addEventListener('pbe:upgrades-ready',() => {
    if (!App.booted) App.boot();
    else App.nav(routeFromLocation(),{ history:false });
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
