(function () {
  'use strict';

  if (window.PBEPrivacy && window.PBEPrivacy.version >= 1) return;

  var VERSION = 1;
  var COOKIE = 'pbe_privacy_v1';
  var COOKIE_MAX_AGE = 15552000; // 180 days
  var GA_ID = 'G-BRS48R8PG9';
  var ROOT_DOMAIN = '.propbetedge.ai';
  var host = String(location.hostname || '').toLowerCase();
  var isNetworkHost = host === 'propbetedge.ai' || host.endsWith('.propbetedge.ai');
  var isPreview = host.endsWith('.vercel.app') || host.endsWith('.workers.dev') || host.endsWith('.pages.dev') || host === 'localhost' || host === '127.0.0.1';
  var prod = isNetworkHost && !isPreview;
  var boot = document.currentScript;

  var config = {
    analytics: !boot || boot.dataset.pbeAnalytics !== 'false',
    surface: boot && boot.dataset.pbeSurface ? boot.dataset.pbeSurface : inferSurface(host),
    hashRoutes: Boolean(boot && boot.dataset.pbeHashRoutes === 'true'),
    sendPageView: !(boot && boot.dataset.pbeSendPageView === 'false')
  };

  var choice = readChoice();
  var gaLoaded = false;
  var clickInstalled = false;
  var hashInstalled = false;
  var settingsOpen = false;
  var callbacks = [];
  var footerObserver = null;

  function inferSurface(h) {
    if (h === 'propbetedge.ai' || h === 'www.propbetedge.ai') return 'hub';
    return h.split('.')[0] || 'network';
  }

  function readCookie(name) {
    var parts = String(document.cookie || '').split(';');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (p.indexOf(name + '=') === 0) return decodeURIComponent(p.slice(name.length + 1));
    }
    return '';
  }

  function readChoice() {
    var raw = readCookie(COOKIE);
    if (raw === 'v1.granted') return 'granted';
    if (raw === 'v1.denied') return 'denied';
    return null;
  }

  function writeChoice(next) {
    if (!prod) return;
    document.cookie = COOKIE + '=v1.' + next + '; Max-Age=' + COOKIE_MAX_AGE + '; Path=/; Domain=' + ROOT_DOMAIN + '; Secure; SameSite=Lax';
  }

  function deleteCookie(name) {
    var encoded = encodeURIComponent(name);
    document.cookie = encoded + '=; Max-Age=0; Path=/; SameSite=Lax';
    if (prod) document.cookie = encoded + '=; Max-Age=0; Path=/; Domain=' + ROOT_DOMAIN + '; Secure; SameSite=Lax';
  }

  function clearAnalyticsCookies() {
    String(document.cookie || '').split(';').forEach(function (p) {
      var name = p.split('=')[0].trim();
      if (name === '_ga' || name.indexOf('_ga_') === 0 || name === '_gid' || name === '_gat') deleteCookie(name);
    });
  }

  function ensureGtag() {
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
  }

  function track(name, params) {
    if (choice !== 'granted' || !prod || !config.analytics) return false;
    loadAnalytics();
    if (typeof window.gtag !== 'function') return false;
    window.gtag('event', name, params || {});
    return true;
  }

  function installNetworkClicks() {
    if (clickInstalled) return;
    clickInstalled = true;
    document.addEventListener('click', function (event) {
      if (choice !== 'granted') return;
      var target = event.target && event.target.closest ? event.target.closest('a[href]') : null;
      if (!target) return;
      try {
        var url = new URL(target.href, location.href);
        var targetHost = url.hostname.toLowerCase();
        if (targetHost !== host && (targetHost === 'propbetedge.ai' || targetHost.endsWith('.propbetedge.ai'))) {
          track('pbe_network_click', {
            pbe_surface: config.surface,
            source_host: host,
            target_host: targetHost,
            link_url: url.origin + url.pathname
          });
        }
      } catch (_) {}
    }, { capture: true });
  }

  function installHashViews() {
    if (!config.hashRoutes || hashInstalled) return;
    hashInstalled = true;
    var lastManualHash = '';
    var lastPopStateAt = 0;
    addEventListener('popstate', function () { lastPopStateAt = Date.now(); });
    addEventListener('hashchange', function () {
      if (choice !== 'granted' || Date.now() - lastPopStateAt < 250) return;
      var currentHash = location.hash || '#/';
      if (currentHash === lastManualHash) return;
      lastManualHash = currentHash;
      track('page_view', {
        page_title: document.title,
        page_location: location.href,
        page_path: location.pathname + location.search + currentHash,
        pbe_surface: config.surface,
        pbe_route_type: 'hash'
      });
    });
  }

  function loadAnalytics() {
    if (!prod || !config.analytics || choice !== 'granted') return false;
    ensureGtag();

    window.gtag('consent', 'default', {
      analytics_storage: 'granted',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      functionality_storage: 'granted',
      security_storage: 'granted'
    });

    if (!gaLoaded) {
      gaLoaded = true;
      window.gtag('js', new Date());
      window.gtag('set', { pbe_surface: config.surface });
      window.gtag('config', GA_ID, {
        cookie_domain: ROOT_DOMAIN,
        cookie_flags: 'SameSite=Lax;Secure',
        send_page_view: config.sendPageView
      });

      if (!document.querySelector('script[data-pbe-ga4-consented]')) {
        var tag = document.createElement('script');
        tag.async = true;
        tag.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(GA_ID);
        tag.dataset.pbeGa4Consented = '1';
        document.head.appendChild(tag);
      }
    } else {
      window.gtag('consent', 'update', { analytics_storage: 'granted' });
      window.gtag('set', { pbe_surface: config.surface });
    }

    installNetworkClicks();
    installHashViews();

    callbacks.splice(0).forEach(function (fn) {
      try { fn(); } catch (_) {}
    });
    return true;
  }

  function initAnalytics(next) {
    next = next || {};
    if (next.surface) config.surface = next.surface;
    if (typeof next.hashRoutes === 'boolean') config.hashRoutes = next.hashRoutes;
    if (typeof next.sendPageView === 'boolean') config.sendPageView = next.sendPageView;
    if (typeof next.analytics === 'boolean') config.analytics = next.analytics;
    if (choice === 'granted') return loadAnalytics();
    return false;
  }

  function whenAnalyticsAllowed(fn) {
    if (typeof fn !== 'function') return;
    if (choice === 'granted') {
      try { fn(); } catch (_) {}
    } else {
      callbacks.push(fn);
    }
  }

  function setAnalytics(allow, source) {
    var previous = choice;
    choice = allow ? 'granted' : 'denied';
    writeChoice(choice);

    if (allow) {
      loadAnalytics();
    } else {
      if (gaLoaded && typeof window.gtag === 'function') {
        window.gtag('consent', 'update', {
          analytics_storage: 'denied',
          ad_storage: 'denied',
          ad_user_data: 'denied',
          ad_personalization: 'denied'
        });
      }
      clearAnalyticsCookies();
    }

    closeBanner();
    closeSettings();
    window.dispatchEvent(new CustomEvent('pbe:privacychange', {
      detail: {
        analytics: choice,
        previous: previous,
        source: source || 'user',
        gpc: navigator.globalPrivacyControl === true
      }
    }));
  }

  function style() {
    if (document.getElementById('pbe-privacy-style')) return;
    var s = document.createElement('style');
    s.id = 'pbe-privacy-style';
    s.textContent = [
      '.pbe-privacy-banner{position:fixed;z-index:2147483000;left:16px;right:16px;bottom:16px;margin:auto;max-width:760px;background:#11130f;color:#f5f2e8;border:1px solid #4b4329;border-radius:16px;box-shadow:0 24px 70px rgba(0,0,0,.5);padding:18px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}',
      '.pbe-privacy-banner *,.pbe-privacy-dialog *{box-sizing:border-box}',
      '.pbe-privacy-title{font:800 17px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;margin:0 0 7px;color:#fff}',
      '.pbe-privacy-copy{font:400 13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:#c7ccc6;margin:0}',
      '.pbe-privacy-copy a{color:#dec45d;text-decoration:underline}',
      '.pbe-privacy-actions{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;margin-top:15px}',
      '.pbe-privacy-btn{appearance:none;border:1px solid #6d6447;background:#181b16;color:#f5f2e8;border-radius:9px;min-height:42px;padding:10px 15px;font:750 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;cursor:pointer}',
      '.pbe-privacy-btn.primary{background:#d4af37;color:#0b0d0b;border-color:#e4c963}',
      '.pbe-privacy-btn:focus-visible,.pbe-privacy-footer-btn:focus-visible{outline:3px solid #e4c963;outline-offset:3px}',
      '.pbe-privacy-overlay{position:fixed;z-index:2147483001;inset:0;background:rgba(0,0,0,.72);display:grid;place-items:center;padding:18px}',
      '.pbe-privacy-dialog{width:min(100%,520px);max-height:min(86vh,680px);overflow:auto;background:#11130f;color:#f5f2e8;border:1px solid #4b4329;border-radius:16px;box-shadow:0 24px 80px rgba(0,0,0,.6);padding:22px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}',
      '.pbe-privacy-row{margin:18px 0;padding:15px;border:1px solid #30352d;border-radius:11px;background:#0d100d}',
      '.pbe-privacy-row-head{display:flex;justify-content:space-between;gap:14px;align-items:center;font-weight:800}',
      '.pbe-privacy-always{font-size:11px;color:#8f978f;text-transform:uppercase;letter-spacing:.08em}',
      '.pbe-privacy-footer-row{display:flex;justify-content:center;align-items:center;padding:10px 16px 18px}',
      '.pbe-privacy-footer-btn{appearance:none;border:0;background:transparent;color:inherit;opacity:.72;text-decoration:underline;text-underline-offset:3px;font:600 12px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;cursor:pointer}',
      '@media(max-width:560px){.pbe-privacy-banner{left:10px;right:10px;bottom:10px;padding:16px}.pbe-privacy-actions{display:grid;grid-template-columns:1fr 1fr}.pbe-privacy-btn{width:100%;min-height:46px}.pbe-privacy-dialog{padding:18px}.pbe-privacy-actions.settings{grid-template-columns:1fr}}'
    ].join('');
    document.head.appendChild(s);
  }

  function closeBanner() {
    var el = document.getElementById('pbe-privacy-banner');
    if (el) el.remove();
  }

  function renderBanner() {
    if (!prod || choice || document.getElementById('pbe-privacy-banner')) return;
    style();
    var el = document.createElement('aside');
    el.id = 'pbe-privacy-banner';
    el.className = 'pbe-privacy-banner';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-labelledby', 'pbe-privacy-title');
    el.innerHTML =
      '<h2 class="pbe-privacy-title" id="pbe-privacy-title">Your privacy choices</h2>' +
      '<p class="pbe-privacy-copy">Necessary cookies keep sign-in, security and paid access working. With your permission, we also use Google Analytics to understand how PropBetEdge is used across the network. Site access is the same if you decline. <a href="https://propbetedge.ai/privacy">Privacy Policy</a></p>' +
      '<div class="pbe-privacy-actions">' +
        '<button class="pbe-privacy-btn" type="button" data-pbe-privacy-decline>Decline analytics</button>' +
        '<button class="pbe-privacy-btn primary" type="button" data-pbe-privacy-accept>Accept analytics</button>' +
      '</div>';
    el.querySelector('[data-pbe-privacy-decline]').addEventListener('click', function () { setAnalytics(false, 'banner'); });
    el.querySelector('[data-pbe-privacy-accept]').addEventListener('click', function () { setAnalytics(true, 'banner'); });
    document.body.appendChild(el);
  }

  function closeSettings() {
    var el = document.getElementById('pbe-privacy-overlay');
    if (el) el.remove();
    settingsOpen = false;
  }

  function openChoices() {
    if (!prod || settingsOpen) return;
    style();
    settingsOpen = true;
    var overlay = document.createElement('div');
    overlay.id = 'pbe-privacy-overlay';
    overlay.className = 'pbe-privacy-overlay';
    overlay.setAttribute('role', 'presentation');
    overlay.innerHTML =
      '<section class="pbe-privacy-dialog" role="dialog" aria-modal="true" aria-labelledby="pbe-privacy-settings-title">' +
        '<h2 class="pbe-privacy-title" id="pbe-privacy-settings-title">Privacy choices</h2>' +
        '<p class="pbe-privacy-copy">Your choice applies across PropBetEdge sites on this browser and can be changed at any time.</p>' +
        '<div class="pbe-privacy-row"><div class="pbe-privacy-row-head"><span>Necessary</span><span class="pbe-privacy-always">Always on</span></div><p class="pbe-privacy-copy">Used for sign-in, security, membership access and features you request.</p></div>' +
        '<div class="pbe-privacy-row"><div class="pbe-privacy-row-head"><span>Analytics</span><span class="pbe-privacy-always">' + (choice === 'granted' ? 'On' : 'Off') + '</span></div><p class="pbe-privacy-copy">Google Analytics helps us understand aggregate usage, navigation and feature engagement. We do not run third-party advertising pixels on PropBetEdge.</p></div>' +
        (navigator.globalPrivacyControl === true ? '<p class="pbe-privacy-copy"><strong>Global Privacy Control detected.</strong> PropBetEdge does not sell personal information or run third-party advertising pixels. We preserve this signal for any future sale/sharing controls.</p>' : '') +
        '<div class="pbe-privacy-actions settings">' +
          '<button class="pbe-privacy-btn" type="button" data-pbe-settings-off>Do not use analytics</button>' +
          '<button class="pbe-privacy-btn primary" type="button" data-pbe-settings-on>Use analytics</button>' +
          '<button class="pbe-privacy-btn" type="button" data-pbe-settings-close>Cancel</button>' +
        '</div>' +
        '<p class="pbe-privacy-copy" style="margin-top:14px"><a href="https://propbetedge.ai/privacy">Read the Privacy Policy</a></p>' +
      '</section>';
    overlay.addEventListener('click', function (event) { if (event.target === overlay) closeSettings(); });
    overlay.querySelector('[data-pbe-settings-off]').addEventListener('click', function () { setAnalytics(false, 'settings'); });
    overlay.querySelector('[data-pbe-settings-on]').addEventListener('click', function () { setAnalytics(true, 'settings'); });
    overlay.querySelector('[data-pbe-settings-close]').addEventListener('click', closeSettings);
    document.body.appendChild(overlay);
    overlay.querySelector('[data-pbe-settings-off]').focus();
  }

  function installFooterControl() {
    if (!prod || document.querySelector('[data-pbe-privacy-choices]')) return;
    var footer = document.querySelector('footer');
    if (!footer) return;
    style();
    var row = document.createElement('div');
    row.className = 'pbe-privacy-footer-row';
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'pbe-privacy-footer-btn';
    button.dataset.pbePrivacyChoices = '1';
    button.textContent = 'Privacy choices';
    button.addEventListener('click', openChoices);
    row.appendChild(button);
    footer.appendChild(row);
  }

  function watchFooter() {
    installFooterControl();
    if (!document.body || footerObserver) return;
    footerObserver = new MutationObserver(function () { installFooterControl(); });
    footerObserver.observe(document.body, { childList: true, subtree: true });
  }

  function onReady() {
    watchFooter();
    if (!choice) renderBanner();
    else if (choice === 'granted') loadAnalytics();
  }

  document.addEventListener('click', function (event) {
    var trigger = event.target && event.target.closest ? event.target.closest('[data-pbe-privacy-choices]') : null;
    if (!trigger) return;
    event.preventDefault();
    openChoices();
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && settingsOpen) closeSettings();
  });

  window.PBEPrivacy = {
    version: VERSION,
    analyticsAllowed: function () { return choice === 'granted'; },
    initAnalytics: initAnalytics,
    track: track,
    whenAnalyticsAllowed: whenAnalyticsAllowed,
    setAnalytics: setAnalytics,
    openChoices: openChoices,
    state: function () {
      return {
        analytics: choice,
        gpc: navigator.globalPrivacyControl === true,
        production: prod,
        surface: config.surface
      };
    }
  };

  initAnalytics(config);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady, { once: true });
  else onReady();
})();