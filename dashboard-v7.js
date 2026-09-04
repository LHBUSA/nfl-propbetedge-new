/* PropBetEdge NFL — dashboard v7
 * Authoritative homepage renderer. Unique class namespace prevents legacy visual layers
 * from fighting the production homepage.
 */
(() => {
  'use strict';

  const LIVE_API = '/api/nfl-live';
  const NEWS_API = '/api/news-feed?limit=12';
  const STADIUM = 'https://images.unsplash.com/photo-1781650104690-a5309d91a26b?auto=format&fit=crop&fm=webp&q=62&w=1400';
  const previous = window.PBEDashboardV6?.state || window.PBEDashboardV5?.state || {};

  const state = {
    scoreboard: previous.scoreboard || null,
    detail: previous.detail || null,
    news: Array.isArray(previous.news) ? previous.news : [],
    featured: previous.featured || null,
    error: null,
    poll: null,
    lastMarkup: '',
    installed: false,
  };

  const esc = value => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const arr = value => Array.isArray(value) ? value : [];

  function sportsDay() {
    const d = new Date(Date.now() - 3 * 3600000);
    return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).replaceAll('-', '');
  }

  async function getJson(url) {
    const response = await fetch(url, { cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`${response.status}`);
    return response.json();
  }

  function newsItems(payload) {
    if (Array.isArray(payload)) return payload;
    for (const key of ['articles', 'items', 'news', 'data', 'results']) {
      if (Array.isArray(payload?.[key])) return payload[key];
    }
    return [];
  }

  function titleOf(x) { return x?.title || x?.headline || x?.name || ''; }
  function summaryOf(x) { return x?.summary || x?.description || x?.dek || x?.excerpt || ''; }
  /* Never render a dek the trust guard could not corroborate. See
     pbe-news-trust.js -- upstream currently serves a fallback dek on aggregated
     wire stories, and printing it states things that are not true. */
  function trustedSummary(x) {
    return window.PBENewsTrust ? (window.PBENewsTrust.safeSummary(x) || '') : summaryOf(x);
  }
  function urlOf(x) { return x?.url || x?.canonical_url || x?.article_url || x?.link || ''; }
  function dateOf(x) { return x?.published_at || x?.publishedAt || x?.published || x?.date || x?.created_at || ''; }
  function topicOf(x) { return x?.topic_kind || x?.kind || x?.category || 'NFL'; }
  function sourceOf(x) { return x?.source || x?.provenance?.upstream || 'PropBetEdge News'; }

  /* Direct newsroom photography first; the proxy remains a fallback. The old homepage
   * did the reverse, which meant a proxy failure created a dead black hero even when
   * the original source image was perfectly usable. */
  function imagesOf(x) {
    const values = [x?.original_image_url, x?.image_url, x?.featured_image, x?.thumbnail_url]
      .filter(Boolean).map(String);
    return [...new Set(values)];
  }

  function imageTag(x, cls, eager = false) {
    const candidates = imagesOf(x);
    const primary = candidates[0] || STADIUM;
    const fallback = candidates[1] || STADIUM;
    return `<img class="${cls}" src="${esc(primary)}" data-fallback="${esc(fallback)}" data-stadium="${esc(STADIUM)}" alt="${esc(x?.image_alt || titleOf(x) || 'NFL newsroom')}" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async">`;
  }

  function fmtDate(value) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York'
    }) + ' ET';
  }

  function chooseFeatured(games) {
    return games.find(g => g?.status?.semantics === 'LIVE')
      || games.find(g => g?.status?.semantics === 'SCHEDULE')
      || [...games].reverse().find(g => g?.status?.semantics === 'FINAL')
      || games[0]
      || null;
  }

  function score(team, semantics) {
    return semantics === 'SCHEDULE' ? '—' : (team?.score ?? '—');
  }

  /* A game that has not kicked off has no score, and a placeholder rendered at
     70-106px was reserving the hero's most prominent slot for a non-value.
     Pre-game, the kickoff time IS the headline fact, so it takes the slot. */
  function kickoffParts(game) {
    const d = new Date(game?.date);
    if (Number.isNaN(d.getTime())) return null;
    const opts = { timeZone: 'America/New_York' };
    return {
      time: d.toLocaleString('en-US', { ...opts, hour: 'numeric', minute: '2-digit' }),
      day: d.toLocaleString('en-US', { ...opts, weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase()
    };
  }

  function heroValue(game, semantics, away, home) {
    if (semantics !== 'SCHEDULE') {
      return `<div class="pbe7-score"><strong>${esc(score(away, semantics))}</strong><span>:</span><strong>${esc(score(home, semantics))}</strong></div>`;
    }
    const k = kickoffParts(game);
    if (!k) return `<div class="pbe7-kickoff"><span class="pbe7-kickoff-label">KICKOFF</span><strong>TBD</strong></div>`;
    return `<div class="pbe7-kickoff"><span class="pbe7-kickoff-label">KICKOFF · ${esc(k.day)}</span><strong>${esc(k.time)}</strong><span class="pbe7-kickoff-tz">ET</span></div>`;
  }

  function statusText(game) {
    const s = game?.status || {};
    if (s.semantics === 'LIVE') return s.short_detail || s.detail || `Q${s.period || ''} ${s.clock || ''}`;
    if (s.semantics === 'FINAL') return s.short_detail || 'FINAL';
    return s.short_detail || fmtDate(game?.date) || 'SCHEDULED';
  }

  function teamRecord(team) {
    return arr(team?.records).find(r => r?.summary)?.summary || '';
  }

  function teamBlock(team, side) {
    const name = team?.display_name || team?.name || (side === 'away' ? 'Away' : 'Home');
    const abbr = team?.abbreviation || name.slice(0, 3).toUpperCase();
    return `<div class="pbe7-team ${side}">
      <div class="pbe7-team-logo">${team?.logo ? `<img src="${esc(team.logo)}" alt="${esc(name)} logo" decoding="async">` : `<b>${esc(abbr)}</b>`}</div>
      <div class="pbe7-team-copy"><strong>${esc(abbr)}</strong><span>${esc(name)}</span><small>${esc(teamRecord(team))}</small></div>
    </div>`;
  }

  function leaders() {
    const rows = arr(state.detail?.leaders);
    const selected = [];
    [/pass/i, /rush/i, /receiv/i].forEach(rx => {
      const hit = rows.find(row => rx.test(`${row?.category || ''} ${row?.display_name || ''}`));
      if (hit && !selected.includes(hit)) selected.push(hit);
    });
    rows.forEach(row => { if (selected.length < 3 && !selected.includes(row)) selected.push(row); });
    return selected.slice(0, 3);
  }

  function leaderStrip() {
    const rows = leaders().filter(row => row?.athlete?.name);
    if (!rows.length) return '';
    return `<div class="pbe7-leaders">${rows.map(row => `<div class="pbe7-leader">
      ${row?.athlete?.headshot ? `<img src="${esc(row.athlete.headshot)}" alt="${esc(row.athlete.name)}" decoding="async">` : ''}
      <div><span>${esc(row.display_name || row.category || 'Game leader')}</span><b>${esc(row.athlete.name)}</b><strong>${esc(row.value || '')}</strong></div>
    </div>`).join('')}</div>`;
  }

  function liveFacts(game) {
    const semantics = game?.status?.semantics || '';
    if (semantics !== 'LIVE') return '';
    const sit = state.detail?.game?.situation || game?.situation || {};
    const facts = [];
    if (sit?.down_distance_text) facts.push(['DOWN', sit.down_distance_text]);
    if (sit?.possession_text) facts.push(['BALL', sit.possession_text]);
    if (typeof sit?.red_zone === 'boolean') facts.push(['RED ZONE', sit.red_zone ? 'YES' : 'NO']);
    if (Number.isFinite(Number(sit?.away_timeouts)) || Number.isFinite(Number(sit?.home_timeouts))) {
      facts.push(['TIMEOUTS', `${Number.isFinite(Number(sit?.away_timeouts)) ? sit.away_timeouts : '—'} / ${Number.isFinite(Number(sit?.home_timeouts)) ? sit.home_timeouts : '—'}`]);
    }
    if (!facts.length) return '';
    return `<div class="pbe7-livefacts">${facts.map(([label, value]) => `<div><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('')}</div>`;
  }

  function hero() {
    const game = state.featured;
    if (!game) {
      return `<section class="pbe7-hero pbe7-hero-empty"><div><span>NFL INTELLIGENCE OS</span><h1>The live NFL layer is standing by.</h1><p>No current game is available to feature. News, markets and research remain available below.</p></div></section>`;
    }

    const semantics = game?.status?.semantics || 'NFL';
    const away = game?.teams?.away || {};
    const home = game?.teams?.home || {};
    const venue = [game?.venue?.name, [game?.venue?.city, game?.venue?.state].filter(Boolean).join(', '), arr(game?.broadcast).join(' / ')]
      .filter(Boolean).join(' · ');
    const source = state.detail?.source?.provider || state.scoreboard?.source?.provider || 'NFL live source';

    return `<section class="pbe7-hero" style="--pbe7-away:#${esc(String(away?.color || '15263d').replace('#',''))};--pbe7-home:#${esc(String(home?.color || '31233f').replace('#',''))}">
      <div class="pbe7-hero-noise"></div>
      <div class="pbe7-hero-top"><div class="pbe7-live-pill ${semantics === 'LIVE' ? 'live' : ''}">${semantics === 'LIVE' ? '<i></i>' : ''}${esc(semantics)} · FEATURED GAME</div><div class="pbe7-source">${esc(source)}</div></div>
      <div class="pbe7-matchup">
        ${teamBlock(away, 'away')}
        <div class="pbe7-scorebox">
          ${heroValue(game, semantics, away, home)}
          ${semantics === 'SCHEDULE' ? '' : `<div class="pbe7-status">${esc(statusText(game))}</div>`}
          <div class="pbe7-venue">${esc(venue || fmtDate(game?.date) || 'NFL game')}</div>
          <div class="pbe7-actions"><button class="pbe7-primary" data-cast="${esc(game.id)}">${semantics === 'LIVE' ? '⚡ Open Live PBEcast' : 'Open PBEcast'}</button><button data-route="propboard">Open Prop Board</button><button data-route="games">Full Slate</button></div>
        </div>
        ${teamBlock(home, 'home')}
      </div>
      ${liveFacts(game)}
      ${leaderStrip()}
    </section>`;
  }

  function news() {
    const pool = state.news.filter(item => titleOf(item)).slice(0, 10);
    if (!pool.length) {
      return `<section class="pbe7-panel pbe7-news-panel"><header><div><span>NEWSROOM</span><h2>NFL Intelligence Wire</h2></div><small>Source-linked · no synthetic replacements</small></header><div class="pbe7-empty">News feed temporarily unavailable.</div></section>`;
    }

    const lead = pool.find(item => imagesOf(item).length) || pool[0];
    const rest = pool.filter(item => item !== lead).slice(0, 5);
    const leadUrl = urlOf(lead);

    return `<section class="pbe7-panel pbe7-news-panel">
      <header><div><span>PROPBETEDGE NEWSROOM</span><h2>NFL Intelligence Wire</h2></div><small>${esc(String(pool.length))} current stories · real source imagery</small></header>
      <div class="pbe7-news-layout">
        <a class="pbe7-lead-story" ${leadUrl ? `href="${esc(leadUrl)}" target="_blank" rel="noopener"` : 'href="javascript:void(0)"'}>
          <div class="pbe7-lead-media">${imageTag(lead, 'pbe7-lead-img', true)}<div class="pbe7-lead-shade"></div></div>
          <div class="pbe7-lead-copy"><div class="pbe7-story-meta"><span>${esc(topicOf(lead))}</span><b>${esc(sourceOf(lead))}</b></div><h3>${esc(titleOf(lead))}</h3>${trustedSummary(lead) ? `<p>${esc(trustedSummary(lead).slice(0, 240))}</p>` : ''}<time>${esc(fmtDate(dateOf(lead)))}</time></div>
        </a>
        <div class="pbe7-news-list">${rest.map(item => {
          const url = urlOf(item);
          return `<a class="pbe7-news-item" ${url ? `href="${esc(url)}" target="_blank" rel="noopener"` : 'href="javascript:void(0)"'}>
            <div class="pbe7-news-thumb">${imageTag(item, 'pbe7-news-img')}</div>
            <div class="pbe7-news-copy"><div class="pbe7-story-meta"><span>${esc(topicOf(item))}</span><time>${esc(fmtDate(dateOf(item)))}</time></div><h4>${esc(titleOf(item))}</h4>${trustedSummary(item) ? `<p>${esc(trustedSummary(item).slice(0, 125))}</p>` : ''}</div>
          </a>`;
        }).join('')}</div>
      </div>
    </section>`;
  }

  function tools() {
    const pro = Boolean(window.PBEPro?.state?.pro);
    const signedIn = Boolean(window.PBEPro?.state?.user);
    const items = [
      ['pbecast', '⚡', 'PBEcast', 'Live game center', 'Drives, play-by-play, possession context and prop progress.', 'LIVE'],
      ['propboard', '↗', 'Prop Board', 'Market board', 'Current sportsbook numbers across supported player props.', 'MARKET'],
      ['marketwatch', '◌', 'Market Watch', 'Cross-book intelligence', 'Dispersion, movement and local market baselines.', 'PRO'],
      ['picks', '◇', 'Model Lab', 'PBE model layer', 'Fair line, probability and transparent model-gap analysis.', 'PRO'],
      ['simulator', '⌁', 'Line Simulator', 'Sensitivity engine', 'Move the market number and inspect model response.', 'PRO'],
      ['sgplab', '⎇', 'SGP Lab', 'Same-game builder', 'Build legs without pretending correlation math is proven.', 'PRO'],
    ];

    return `<aside class="pbe7-panel pbe7-rail">
      <header><div><span>PRODUCT</span><h2>PBE Intelligence</h2></div><small>One NFL operating system</small></header>
      <div class="pbe7-tools">${items.map(([route, icon, name, kicker, desc, badge]) => `<button class="pbe7-tool" data-route="${route}"><div class="pbe7-tool-top"><i>${icon}</i><span class="${badge === 'PRO' ? 'pro' : ''}">${badge}</span></div><small>${kicker}</small><b>${name}</b><p>${desc}</p><em>Open module →</em></button>`).join('')}</div>
      <a class="pbe7-engine-link" href="javascript:void(0)" data-route="pbepicks">
        <span class="pbe7-engine-eyebrow">HOW THE MODEL WORKS</span>
        <strong>We don't publish opinions. We make the market prove us wrong.</strong>
        <em>Read the decision system →</em>
      </a>
      <div class="pbe7-pro-card ${pro ? 'active' : ''}"><div><span>${pro ? 'NFL PRO ACTIVE' : 'NFL PRO'}</span><strong>${pro ? 'Premium intelligence unlocked.' : signedIn ? 'Your account is ready to upgrade.' : 'Unlock the proprietary PBE layer.'}</strong><p>${pro ? 'Model-backed Pro modules are available on this signed-in email.' : '$9.99/week or $99 Season Pass. One email ties sign-in and Stripe entitlement together.'}</p></div><button data-pro>${pro ? 'View Account' : signedIn ? 'Choose Plan' : 'Sign In · Pro'}</button></div>
    </aside>`;
  }

  function markup() {
    return `<section class="pbehome7" data-stale="${state.error ? 'true' : 'false'}">${hero()}<div class="pbe7-main">${news()}${tools()}</div></section>`;
  }

  function wire(root) {
    root.querySelectorAll('[data-route]').forEach(el => el.addEventListener('click', () => window.App?.nav?.(el.dataset.route)));
    root.querySelectorAll('[data-cast]').forEach(el => el.addEventListener('click', () => {
      const id = el.dataset.cast;
      window.App?.nav?.('pbecast');
      setTimeout(() => window.PBEcastV5?.focus?.(id) || window.PBEcastV4?.focus?.(id), 180);
    }));
    root.querySelector('[data-pro]')?.addEventListener('click', () => window.PBEPro?.open?.('account'));

    root.querySelectorAll('img[data-fallback]').forEach(img => {
      img.addEventListener('error', () => {
        const fallback = img.dataset.fallback;
        const stadium = img.dataset.stadium;
        if (fallback && img.src !== fallback && !img.dataset.usedFallback) {
          img.dataset.usedFallback = '1';
          img.src = fallback;
          return;
        }
        if (stadium && !img.dataset.usedStadium) {
          img.dataset.usedStadium = '1';
          img.src = stadium;
          return;
        }
        img.classList.add('image-failed');
      });
    });
  }

  function render() {
    const container = document.getElementById('view-container');
    if (!container) return;
    const html = markup();
    const current = container.querySelector('.pbehome7');
    if (current && html === state.lastMarkup) {
      current.dataset.stale = state.error ? 'true' : 'false';
      return;
    }
    container.innerHTML = html;
    state.lastMarkup = html;
    wire(container.querySelector('.pbehome7'));
  }

  async function load() {
    clearTimeout(state.poll);
    state.error = null;
    try {
      const scoreboard = await getJson(`${LIVE_API}?date=${sportsDay()}`);
      const featured = chooseFeatured(arr(scoreboard?.games));
      const [detailResult, newsResult] = await Promise.allSettled([
        featured?.id ? getJson(`${LIVE_API}?event=${encodeURIComponent(featured.id)}`) : Promise.resolve(null),
        getJson(NEWS_API),
      ]);
      state.scoreboard = scoreboard;
      state.featured = featured;
      if (detailResult.status === 'fulfilled') state.detail = detailResult.value;
      if (newsResult.status === 'fulfilled') state.news = window.PBENewsTrust?.prepare(newsItems(newsResult.value)) || newsItems(newsResult.value);
      render();
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      render();
    }
    state.poll = setTimeout(() => {
      if (document.querySelector('.pbehome7')) load();
    }, 20000);
  }

  function install() {
    if (!window.App?.VIEWS) return false;
    if (window.PBEDashboardV5?.state?.poll) clearTimeout(window.PBEDashboardV5.state.poll);
    if (window.PBEDashboardV6?.state?.poll) clearTimeout(window.PBEDashboardV6.state.poll);
    App.VIEWS.home = load;
    state.installed = true;
    if (document.querySelector('.pbehome5,.pbehome7')) load();
    return true;
  }

  window.addEventListener('pbe:pro-state', () => {
    if (document.querySelector('.pbehome7')) render();
  });

  window.PBEDashboardV7 = { load, state };
  if (!install()) document.addEventListener('DOMContentLoaded', () => install(), { once: true });
})();
