/* PropBetEdge NFL — Injury Editorial authority v3
 * Reframes the injuries route as a PropBetEdge article desk. The newsroom
 * remains the factual data source; this module only selects injury coverage,
 * requires canonical PropBetEdge article paths, and renders editorial UI.
 */
(() => {
  'use strict';

  let burstToken = 0;

  const esc = value => String(value ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const clean = value => String(value || '').replace(/\s+/g,' ').trim();

  function timeAgo(value) {
    if (!value) return 'time unavailable';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return 'time unavailable';
    const seconds = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  function canonicalUrl(article) {
    const slug = clean(article?.slug).replace(/^\/+|\/+$/g,'');
    if (slug) return `https://propbetedge.ai/news/nfl/${slug}`;
    const raw = clean(article?.url);
    if (!raw) return null;
    try {
      const url = new URL(raw, 'https://propbetedge.ai');
      if (!/(^|\.)propbetedge\.ai$/i.test(url.hostname)) return null;
      if (!/^\/news\/nfl\//i.test(url.pathname)) return null;
      return url.href;
    } catch {
      return null;
    }
  }

  function injurySignal(article) {
    const title = clean(article?.title);
    const summary = clean(article?.summary);
    const text = `${title} ${summary}`;
    const strong = /\b(injur(?:y|ies|ed)|injured reserve|reserve[\/-]pup|pup(?:\s+list)?|nfi|ir(?:\s+list)?|acl|mcl|achilles|hamstring|ankle|knee|shoulder|concussion|surgery|rehab|recovery|sidelined|questionable|doubtful|inactive|out through|out for|will not play|won't play|miss(?:es|ing)?\s+(?:week|game|season)|return(?:s|ed)?\s+to\s+practice)\b/i;
    if (strong.test(text)) return true;
    const topic = clean(article?.topic_kind).toLowerCase();
    return topic === 'injury' && /\b(health|availability|depth|absence|status|return|week|season)\b/i.test(text);
  }

  function uniqueArticles(rows) {
    const seen = new Set();
    return rows.filter(article => {
      const url = canonicalUrl(article);
      if (!url || !injurySignal(article) || seen.has(url)) return false;
      seen.add(url);
      article.__pbeEditorialUrl = url;
      return true;
    }).sort((a,b) => new Date(b.published_at || 0) - new Date(a.published_at || 0));
  }

  function tokens(value) {
    const stop = new Set(['about','after','before','their','there','these','those','with','from','into','over','under','week','season','player','players','team','teams','will','have','has','been','this','that','they','what','where','when','while','without']);
    return new Set(clean(value).toLowerCase().replace(/[^a-z0-9' ]/g,' ').split(/\s+/).filter(word => word.length >= 4 && !stop.has(word)));
  }

  function deckFor(article, summaryCounts) {
    const summary = clean(article?.summary);
    if (summary.length < 36) return '';
    if ((summaryCounts.get(summary.toLowerCase()) || 0) > 1) return '';
    const titleTokens = tokens(article?.title);
    const summaryTokens = tokens(summary);
    const overlap = [...titleTokens].filter(token => summaryTokens.has(token)).length;
    if (titleTokens.size >= 3 && overlap === 0) return '';
    return summary.length > 230 ? `${summary.slice(0,227).trim()}…` : summary;
  }

  function summaryCounts(rows) {
    const map = new Map();
    rows.forEach(article => {
      const summary = clean(article?.summary).toLowerCase();
      if (!summary) return;
      map.set(summary, (map.get(summary) || 0) + 1);
    });
    return map;
  }

  function contextChips(article, limit = 4) {
    const values = [];
    (article?.teams || []).slice(0,2).forEach(team => values.push(`<span>${esc(team)}</span>`));
    (article?.players || []).slice(0,2).forEach(player => values.push(`<span class="person">${esc(player)}</span>`));
    return values.slice(0,limit).join('');
  }

  function articleImage(article, className, eager = false) {
    const src = clean(article?.image_url);
    if (!src) return `<div class="${className} is-placeholder"><span>PROPBETEDGE</span></div>`;
    return `<div class="${className}"><img src="${esc(src)}" alt="${esc(article?.image_alt || article?.title || 'NFL injury coverage')}" ${eager?'fetchpriority="high"':'loading="lazy"'} decoding="async"></div>`;
  }

  function byline(article) {
    const author = clean(article?.author) || 'PropBetEdge Editorial Team';
    return `By ${esc(author)} · ${esc(timeAgo(article?.published_at))}`;
  }

  function leadStory(article, counts) {
    if (!article) return `<div class="pbe13-editorial-empty"><strong>No current injury features</strong><span>The PropBetEdge newsroom is live, but no canonical NFL injury article currently matches the editorial filter.</span></div>`;
    const deck = deckFor(article, counts);
    return `<article class="pbe13-editorial-lead">
      <a class="pbe13-editorial-lead-link" href="${esc(article.__pbeEditorialUrl)}" target="_blank" rel="noopener" aria-label="Read ${esc(article.title)} on PropBetEdge">
        ${articleImage(article,'pbe13-editorial-lead-media',true)}
      </a>
      <div class="pbe13-editorial-lead-body">
        <div class="pbe13-editorial-eyebrow">FEATURED INJURY STORY</div>
        <h2>${esc(article.title)}</h2>
        ${deck?`<p>${esc(deck)}</p>`:''}
        <div class="pbe13-editorial-meta">${byline(article)}</div>
        <div class="pbe13-editorial-chips">${contextChips(article)}</div>
        <a class="pbe13-editorial-cta" href="${esc(article.__pbeEditorialUrl)}" target="_blank" rel="noopener">Read the full story on PropBetEdge <span>↗</span></a>
      </div>
    </article>`;
  }

  function storyCard(article, counts) {
    const deck = deckFor(article, counts);
    const team = clean(article?.teams?.[0]);
    return `<a class="pbe13-editorial-card" href="${esc(article.__pbeEditorialUrl)}" target="_blank" rel="noopener">
      ${articleImage(article,'pbe13-editorial-card-media')}
      <div class="pbe13-editorial-card-body">
        <div class="pbe13-editorial-card-kicker"><span>${team?esc(team):'NFL'}</span><span>${esc(timeAgo(article?.published_at))}</span></div>
        <h3>${esc(article.title)}</h3>
        ${deck?`<p>${esc(deck)}</p>`:''}
        <div class="pbe13-editorial-meta">${byline(article)}</div>
        <div class="pbe13-editorial-chips">${contextChips(article,3)}</div>
      </div>
    </a>`;
  }

  function shell(state, rows) {
    const counts = summaryCounts(rows);
    const lead = rows[0] || null;
    const rest = rows.slice(1);
    const status = state?.error ? 'EDITORIAL FEED UNAVAILABLE' : `${rows.length} CURRENT INJURY STORIES`;
    return `<header class="pbe13-hero pbe13-editorial-hero">
      <div>
        <div class="pbe13-kicker">PROPBETEDGE EDITORIAL · NFL INJURIES</div>
        <h1 class="pbe13-title">Injuries change everything.</h1>
        <div class="pbe13-copy">The injury stories that matter — what happened, who it changes, and what to watch next. Full NFL injury coverage from PropBetEdge Editorial.</div>
      </div>
      <aside class="pbe13-statusbox"><b>LATEST COVERAGE</b><span>${esc(status)}${state?.fetchedAt?` · refreshed ${esc(timeAgo(state.fetchedAt))}`:''}</span></aside>
    </header>
    <div class="pbe13-editorial-note"><strong>Editorial coverage:</strong> reporting and analysis from PropBetEdge articles. This is not the official NFL practice/game injury report, and no status is inferred beyond what the underlying reporting supports.</div>
    ${state?.error?`<div class="pbe13-editorial-empty"><strong>Injury coverage unavailable</strong><span>${esc(state.error)}</span></div>`:leadStory(lead,counts)}
    ${!state?.error?`<div class="pbe13-feed pbe13-editorial-feed" style="grid-template-columns:1fr"><section class="pbe13-editorial-latest">
      <div class="pbe13-editorial-section-head"><div><span>PROPBETEDGE EDITORIAL</span><h2>Latest injury coverage</h2></div><a href="https://propbetedge.ai/news/nfl" target="_blank" rel="noopener">All NFL news ↗</a></div>
      ${rest.length?`<div class="pbe13-editorial-grid">${rest.map(article=>storyCard(article,counts)).join('')}</div>`:`<div class="pbe13-editorial-empty compact"><span>No additional injury stories are currently available.</span></div>`}
    </section></div>`:''}`;
  }

  function enhance() {
    if (window.App?.current !== 'injuries') return false;
    const state = window.PBENewsroomV2?.state;
    const root = document.querySelector('.pbe13-news');
    if (!state || !root || state.loading) return false;
    const rows = uniqueArticles(Array.isArray(state.articles) ? state.articles : []);
    const signature = `${state.error||''}|${state.fetchedAt||''}|${rows.map(article=>article.id||article.__pbeEditorialUrl).join('|')}`;
    if (root.dataset.pbeInjuryEditorialSignature === signature && root.classList.contains('pbe13-injury-editorial')) return true;
    root.classList.add('pbe13-injury-v2','pbe13-injury-editorial');
    root.dataset.pbeInjuryEditorialSignature = signature;
    root.innerHTML = shell(state, rows);
    return true;
  }

  function burst() {
    const token = ++burstToken;
    [0,70,180,420,900,1600,2600].forEach(delay => setTimeout(() => {
      if (token === burstToken) enhance();
    }, delay));
  }

  window.addEventListener('pbe:route-changed', burst);
  window.addEventListener('pbe:upgrades-ready', burst);
  document.addEventListener('DOMContentLoaded', burst, { once: true });
  if (document.readyState !== 'loading') burst();

  window.PBEInjuryIntelV2 = { enhance, burst, canonicalUrl, injurySignal };
})();