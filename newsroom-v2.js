/* PropBetEdge NFL — current Injury + Transaction Intelligence
 * Source semantics: NEWS. Never relabeled as official practice/game status.
 */
(() => {
  'use strict';

  const API = typeof NFL_API_GATEWAY !== 'undefined' ? NFL_API_GATEWAY : 'https://nfl-api.propbetedge.ai';
  const DEFAULT_EVENT = '8c94552d022acec4a0458d70c19d3da9';
  const TRANSACTION_STYLE = './transactions-production-v1.css?v=20260908a';
  const state = {
    articles: [],
    fetchedAt: null,
    currentTeams: new Set(),
    currentEventLabel: '',
    search: '',
    team: 'all',
    sort: 'latest',
    loading: false,
    error: null
  };

  const esc = value => String(value ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

  const currentEventId = () => new URLSearchParams(location.search).get('event') || localStorage.getItem('pbe_nfl_event') || DEFAULT_EVENT;

  function ensureTransactionStyles() {
    if (document.querySelector('link[data-pbe-transactions-v1]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = TRANSACTION_STYLE;
    link.dataset.pbeTransactionsV1 = '1';
    document.head.appendChild(link);
  }

  function timeAgo(value) {
    if (!value) return 'time unavailable';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return 'time unavailable';
    const seconds = Math.max(0, Math.floor((Date.now()-d.getTime())/1000));
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds/60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes/60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.floor(hours/24)}d ago`;
  }

  async function fetchJson(url) {
    const response = await fetch(url,{cache:'no-store',headers:{Accept:'application/json'}});
    if (!response.ok) {
      const detail = await response.text().catch(()=> '');
      throw new Error(`${response.status}${detail ? ` · ${detail.slice(0,140)}` : ''}`);
    }
    return response.json();
  }

  /* Corroborated views of an article. A suppressed summary is null, not the
     shared one; an uncorroborated player is dropped, not guessed at. Teams are
     corroborated against NFL_TEAMS by name, city, nickname or code appearing in
     the text the reader can see. */
  const trustOf = a => a?._trust || null;
  const safeSummary = a => (trustOf(a) ? trustOf(a).summary : (a?.summary || '')) || '';
  const safePlayers = a => (trustOf(a) ? trustOf(a).players : (Array.isArray(a?.players) ? a.players : [])) || [];
  let TEAM_TERMS = null;

  function teamTerms() {
    if (TEAM_TERMS && TEAM_TERMS.length) return TEAM_TERMS;
    const map = (typeof window !== 'undefined' && window.NFL_TEAMS) || {};
    TEAM_TERMS = Object.entries(map).map(([abbr,t]) => {
      const name = String(t?.name || '');
      const terms = [name, t?.city, name.split(/\s+/).slice(-1)[0], abbr]
        .map(v => String(v || '').toLowerCase().replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim())
        .filter(v => v.length > 1);
      return { abbr:String(abbr).toUpperCase(), terms:[...new Set(terms)] };
    });
    return TEAM_TERMS;
  }

  function safeTeams(a) {
    const declared = (Array.isArray(a?.teams) ? a.teams : []).map(x => String(x).toUpperCase());
    if (!declared.length) return [];
    const hay = `${a?.title || ''} ${safeSummary(a)}`.toLowerCase().replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim();
    if (!hay) return [];
    const index = teamTerms();
    if (!index.length) return [];
    return declared.filter(code => {
      const row = index.find(t => t.abbr === code);
      if (!row) return false;
      return row.terms.some(term => term.length <= 3
        ? new RegExp(`(^| )${term}( |$)`).test(hay)
        : hay.includes(term));
    });
  }

  function teamRecord(code) {
    return ((typeof window !== 'undefined' && window.NFL_TEAMS) || {})[String(code || '').toUpperCase()] || null;
  }

  function teamLogo(code) {
    const raw = String(code || '').toUpperCase();
    const key = raw === 'WAS' || raw === 'WSH' ? 'wsh' : raw.toLowerCase();
    return /^[a-z]{2,3}$/.test(key) ? `https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/${encodeURIComponent(key)}.png` : '';
  }

  function teamChip(code) {
    const team = teamRecord(code);
    const src = teamLogo(code);
    if (!team) return `<span class="pbe13-tag">${esc(code)}</span>`;
    return `<span class="pbe13-tag pbe26-team-tag" style="--team-accent:${esc(team.color || '#d4af37')}">${src?`<img class="pbe26-team-crest" src="${esc(src)}" alt="" aria-hidden="true" loading="lazy" decoding="async">`:''}<span>${esc(code)}</span></span>`;
  }

  function teamIdentity(code) {
    const team = teamRecord(code);
    const src = teamLogo(code);
    if (!team) return esc(code);
    return `<span class="pbe26-team-identity">${src?`<img class="pbe26-team-crest" src="${esc(src)}" alt="" aria-hidden="true" loading="lazy" decoding="async">`:''}<span><strong>${esc(team.name)}</strong><small>${esc(code)} · ${esc(team.conf)} ${esc(team.div)}</small></span></span>`;
  }

  function injuryArticle(a) {
    const topic = String(a.topic_kind || '').toLowerCase();
    if (topic === 'injury') return true;
    const text = `${a.title || ''} ${safeSummary(a)}`.toLowerCase();
    return /\b(injury|injured|ankle|hamstring|knee|concussion|sidelined|questionable|doubtful|ir\b|injured reserve|rehab|surgery|return from injury|will not play|won't play|out for|miss(?:es|ing)?|sprain|strain)\b/i.test(text);
  }

  function transactionArticle(a) {
    const topic = String(a.topic_kind || '').toLowerCase();
    if (['trade','signing','transaction','lineup','discipline','frontoffice','front_office','release','waiver'].includes(topic)) return true;
    const text = `${a.title || ''} ${safeSummary(a)}`.toLowerCase();
    return /\b(trade|traded|trading|signs?\b|signed|signing|contract|extension|waive|waived|waiver|release|released|roster|acquire|acquired|cut\b|cuts\b|suspend|suspended|depth chart|starter|starting job|promoted|activated)\b/i.test(text);
  }

  function impact(a) {
    const n = Number(a.impact_score);
    return Number.isFinite(n) ? n : 0;
  }

  function currentEventHit(a) {
    return safeTeams(a).some(team => state.currentTeams.has(team));
  }

  function uniqueTeams(list) {
    return [...new Set(list.flatMap(safeTeams))].sort();
  }

  function uniquePlayers(list) {
    return [...new Set(list.flatMap(safePlayers))];
  }

  function frequency(list,key) {
    const map = new Map();
    /* "Affected players" is a claim about who a story is about, so it counts
       corroborated entities only. */
    const pick = key === 'players' ? safePlayers : key === 'teams' ? safeTeams : (a => Array.isArray(a[key]) ? a[key] : []);
    list.forEach(a => pick(a).forEach(value => {
      const name = String(value || '').trim();
      if (!name) return;
      const current = map.get(name) || {name,count:0,maxImpact:0};
      current.count += 1;
      current.maxImpact = Math.max(current.maxImpact,impact(a));
      map.set(name,current);
    }));
    return [...map.values()].sort((a,b)=>b.maxImpact-a.maxImpact || b.count-a.count || a.name.localeCompare(b.name));
  }

  function baseList(mode) {
    const predicate = mode === 'injuries' ? injuryArticle : transactionArticle;
    return state.articles.filter(predicate);
  }

  function visible(mode) {
    const q = state.search.trim().toLowerCase();
    let rows = baseList(mode).filter(a => {
      const searchOk = !q || [a.title,safeSummary(a),a.source,...safePlayers(a),...safeTeams(a)].some(v=>String(v||'').toLowerCase().includes(q));
      const teamOk = state.team === 'all' || safeTeams(a).includes(state.team);
      return searchOk && teamOk;
    });
    if (state.sort === 'impact') rows.sort((a,b)=>impact(b)-impact(a) || new Date(b.published_at||0)-new Date(a.published_at||0));
    else if (state.sort === 'current') rows.sort((a,b)=>Number(currentEventHit(b))-Number(currentEventHit(a)) || new Date(b.published_at||0)-new Date(a.published_at||0));
    else rows.sort((a,b)=>new Date(b.published_at||0)-new Date(a.published_at||0));
    return rows;
  }

  function tags(a,mode) {
    const values = [];
    safeTeams(a).slice(0,4).forEach(team => values.push(mode === 'transactions' ? teamChip(team) : `<span class="pbe13-tag">${esc(team)}</span>`));
    safePlayers(a).slice(0,3).forEach(player => values.push(`<span class="pbe13-tag accent">${esc(player)}</span>`));
    if (mode === 'injuries' && a.topic_kind) values.push(`<span class="pbe13-tag">${esc(String(a.topic_kind).toUpperCase())}</span>`);
    return values.join('');
  }

  function summary(mode,list) {
    const teams = uniqueTeams(list);
    const players = uniquePlayers(list);
    const highImpact = list.filter(a=>impact(a)>=4).length;
    const current = list.filter(currentEventHit).length;
    const labels = mode === 'transactions'
      ? ['Stories in view','Teams in feed','Players referenced','Impact score 4+','Selected-event overlap']
      : ['Current matching stories','Teams affected','Players referenced','Impact score 4+','Selected-event team stories'];
    return `<div class="pbe13-summary">
      <div class="pbe13-stat"><b>${list.length}</b><span>${labels[0]}</span></div>
      <div class="pbe13-stat"><b>${teams.length}</b><span>${labels[1]}</span></div>
      <div class="pbe13-stat"><b>${players.length}</b><span>${labels[2]}</span></div>
      <div class="pbe13-stat"><b class="accent">${highImpact}</b><span>${labels[3]}</span></div>
      <div class="pbe13-stat"><b>${current}</b><span>${labels[4]}</span></div>
    </div>`;
  }

  function affectedPanel(mode,list) {
    const playerFreq = frequency(list,'players').slice(0,7);
    const teamFreq = frequency(list,'teams').slice(0,5).map(item=>({...item,isTeam:true}));
    const chosen = mode === 'injuries' ? playerFreq : [...teamFreq,...playerFreq].slice(0,8);
    const title = mode === 'injuries' ? 'Affected Players' : 'Transaction activity';
    const meta = mode === 'injuries' ? 'News frequency + max impact' : 'Story frequency · max impact';
    return `<aside class="pbe13-side"><div class="pbe13-side-head"><strong>${title}</strong><span>${meta}</span></div><div class="pbe13-affected">${chosen.length ? chosen.map(item=>`<div class="pbe13-aff-row" ${item.isTeam?`data-team="${esc(item.name)}" style="--team-accent:${esc(teamRecord(item.name)?.color || '#d4af37')}"`:''}><div><div class="pbe13-aff-name">${item.isTeam?teamIdentity(item.name):esc(item.name)}</div><div class="pbe13-aff-meta">${item.count} current stor${item.count===1?'y':'ies'}</div></div><div class="pbe13-impact">${item.maxImpact || '—'}</div></div>`).join('') : '<div class="pbe13-empty-side">No affected entities are available in the current filtered news set.</div>'}</div></aside>`;
  }

  function leadCard(mode,a) {
    if (!a) return `<article class="pbe13-lead"><div class="pbe13-lead-topic">NEWS UNAVAILABLE</div><h2>No current ${mode==='injuries'?'injury':'transaction'} stories match this view.</h2><p>PropBetEdge will not substitute old hardcoded rows when the real current feed is empty.</p></article>`;
    return `<article class="pbe13-lead"><div class="pbe13-lead-topic">${esc(String(a.topic_kind||mode).toUpperCase())}${currentEventHit(a)?'<span class="pbe13-current">CURRENT EVENT</span>':''}</div><h2>${esc(a.title)}</h2>${safeSummary(a)?`<p>${esc(safeSummary(a))}</p>`:''}<div class="pbe13-source">${esc(a.source || 'source unavailable')} · ${esc(timeAgo(a.published_at))} · impact ${esc(impact(a)||'—')}</div><div class="pbe13-tags">${tags(a,mode)}</div><div class="pbe13-lead-actions">${a.url?`<a class="pbe13-action primary" href="${esc(a.url)}">Read full story ↗</a>`:''}<button class="pbe13-action" onclick="App.nav('propboard')">Open Prop Board</button></div></article>`;
  }

  function card(mode,a) {
    return `<article class="pbe13-card"><div class="pbe13-card-top"><span class="pbe13-card-topic">${esc(String(a.topic_kind||mode).toUpperCase())}${currentEventHit(a)?'<span class="pbe13-current">CURRENT EVENT</span>':''}</span><span class="pbe13-card-time">${esc(timeAgo(a.published_at))}</span></div><h3>${esc(a.title)}</h3>${safeSummary(a)?`<p>${esc(safeSummary(a))}</p>`:''}<div class="pbe13-tags">${tags(a,mode)}</div><div class="pbe13-card-foot"><span class="pbe13-card-source">${esc(a.source || 'source unavailable')} · impact ${esc(impact(a)||'—')}</span>${a.url?`<a class="pbe13-card-link" href="${esc(a.url)}">Open ↗</a>`:''}</div></article>`;
  }

  function feed(mode,list) {
    if (!list.length) return `<div class="pbe13-empty"><div><strong>No current matching news</strong><p>The newsroom is connected, but the current filters produced no factual ${mode==='injuries'?'injury':'transaction'} stories. No synthetic fallback is used.</p></div></div>`;
    const head = mode === 'transactions'
      ? `<div class="pbe26-feed-head"><strong>Transaction ledger</strong><span>${Math.max(0,list.length-1)} additional stor${list.length-1===1?'y':'ies'} · source attributed</span></div>`
      : '';
    return `${head}<div class="pbe13-feed">${list.slice(1).map(a=>card(mode,a)).join('')}</div>`;
  }

  function transactionDesk(list) {
    return `<div class="pbe26-deskbar"><span class="pbe26-desk-name">Transaction desk</span><div class="pbe26-desk-counts"><span><b>${list.length}</b> stories in view</span><span>source attributed</span><span>no synthetic fallback</span></div></div>`;
  }

  function shell(mode) {
    const all = visible(mode);
    const teams = uniqueTeams(baseList(mode));
    const lead = all[0] || null;
    const isTransactions = mode === 'transactions';
    const accent = mode === 'injuries' ? '#f16b78' : '#e9c75a';
    const soft = mode === 'injuries' ? 'rgba(241,107,120,.10)' : 'rgba(212,175,55,.10)';
    const title = mode === 'injuries' ? 'Injury intelligence' : 'NFL transactions';
    const emphasis = mode === 'injuries' ? 'without fake status.' : 'roster movement, sourced.';
    const copy = mode === 'injuries'
      ? 'Current NFL injury developments from the real PropBetEdge newsroom, including affected players, teams, source, publish time and impact. This page uses NEWS semantics until a structured official practice/game-status feed is attached.'
      : 'Trades, signings, releases, waivers, lineup decisions and other roster movement from the current PropBetEdge newsroom. Every story keeps its NEWS provenance, published source and timestamp; no synthetic transaction rows are added.';
    const semantic = isTransactions ? 'NEWSROOM · SOURCE-ATTRIBUTED · CURRENT FEED' : 'NEWS · PROPBET-NEWS-API';
    const status = state.error ? 'UNAVAILABLE' : (isTransactions ? 'TRANSACTION FEED' : 'CURRENT NEWS');
    const sectionClass = `pbe13-news${isTransactions?' pbe13-transactions':''}`;
    return `<section class="${sectionClass}" style="--accent:${accent};--accent-soft:${soft}"><header class="pbe13-hero"><div><div class="pbe13-kicker">PROPBETEDGE NFL · ${isTransactions?'TRANSACTION INTELLIGENCE':'CURRENT NEWS INTELLIGENCE'}</div><h1 class="pbe13-title">${title}.<br><em>${emphasis}</em></h1><div class="pbe13-copy">${copy}</div><span class="pbe13-semantic">${semantic}</span></div><aside class="pbe13-statusbox"><b>${status}</b><span>${state.error?'The newsroom adapter did not return a usable response.':`${all.length} matching stories · fetched ${timeAgo(state.fetchedAt)}${state.currentEventLabel?` · selected ${state.currentEventLabel}`:''}`}</span></aside></header>${mode==='injuries'?`<div class="pbe13-note"><strong>Important:</strong> these are news-confirmed injury developments. They are not yet the official NFL practice/game injury report, and the UI does not infer Questionable / Doubtful / Out status unless an attached source explicitly provides it.</div>`:(isTransactions?transactionDesk(all):'')}<div id="pbe13-summary">${summary(mode,all)}</div><section class="pbe13-controls"><input id="pbe13-search" class="pbe13-input" type="search" placeholder="${isTransactions?'Search transaction, player, team or source…':'Search player, team, source or headline…'}" value="${esc(state.search)}"><select id="pbe13-team" class="pbe13-select"><option value="all">${isTransactions?'All teams in feed':'All affected teams'}</option>${teams.map(team=>`<option value="${esc(team)}" ${state.team===team?'selected':''}>${esc(team)}</option>`).join('')}</select><select id="pbe13-sort" class="pbe13-select"><option value="latest" ${state.sort==='latest'?'selected':''}>Latest first</option><option value="impact" ${state.sort==='impact'?'selected':''}>Highest impact</option><option value="current" ${state.sort==='current'?'selected':''}>Selected event first</option></select></section>${state.error?`<div class="pbe13-empty"><div><strong>News intelligence unavailable</strong><p>${esc(state.error)}</p></div></div>`:`<div class="pbe13-featured">${leadCard(mode,lead)}${affectedPanel(mode,all)}</div><div id="pbe13-feed">${feed(mode,all)}</div>`}</section>`;
  }

  async function ensureData() {
    if (state.articles.length || state.loading) return;
    state.loading = true;
    state.error = null;
    try {
      const [news,board] = await Promise.all([
        fetchJson('/api/news-feed?limit=100'),
        fetchJson(`${API}/api/odds/board?event_id=${encodeURIComponent(currentEventId())}&markets=player_pass_yds`).catch(()=>null)
      ]);
      /* The upstream feed serves one article's summary, player tags and team
         tags on many rows -- measured at 27 of 50 on 2026-09-04. This surface
         states medical facts about named players, so it must not render or
         reason over borrowed text. pbe-news-trust.js annotates each row with
         the summary and players its own visible text supports; everything
         downstream reads _trust rather than the raw fields. */
      const raw = Array.isArray(news?.articles) ? news.articles : [];
      state.articles = window.PBENewsTrust?.prepare(raw) || raw;
      state.fetchedAt = news?.fetched_at || new Date().toISOString();
      if (board) {
        const event = board.event || {};
        const away = event.away_team || event.away || '';
        const home = event.home_team || event.home || '';
        state.currentEventLabel = away && home ? `${away} @ ${home}` : '';
        const names = [away,home].filter(Boolean).map(String);
        Object.values(window.NFL_TEAMS || {}).forEach(team => {
          if (names.some(name => name.toLowerCase() === String(team.name).toLowerCase() || name.toLowerCase().includes(String(team.city).toLowerCase()))) state.currentTeams.add(team.abbr);
        });
      }
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.loading = false;
    }
  }

  async function renderMode(mode) {
    if (mode === 'transactions') ensureTransactionStyles();
    const vc = document.getElementById('view-container');
    if (!vc) return;
    if (!state.articles.length && !state.error) vc.innerHTML = `<section class="pbe13-news"><div class="pbe13-empty"><div><strong>Connecting current NFL newsroom</strong><p>Loading factual current stories from the PropBetEdge newsroom adapter.</p></div></div></section>`;
    await ensureData();
    vc.innerHTML = shell(mode);
    wire(mode);
  }

  function refresh(mode) {
    const vc = document.getElementById('view-container');
    if (!vc) return;
    vc.innerHTML = shell(mode);
    wire(mode);
  }

  function wire(mode) {
    document.getElementById('pbe13-search')?.addEventListener('input',e=>{state.search=e.currentTarget.value||'';refresh(mode)});
    document.getElementById('pbe13-team')?.addEventListener('change',e=>{state.team=e.currentTarget.value||'all';refresh(mode)});
    document.getElementById('pbe13-sort')?.addEventListener('change',e=>{state.sort=e.currentTarget.value||'latest';refresh(mode)});
  }

  function install() {
    if (!window.App?.VIEWS) return false;
    App.VIEWS.injuries = () => renderMode('injuries');
    App.VIEWS.trades = () => renderMode('transactions');
    const inj = document.getElementById('nav-injuries');
    const trades = document.getElementById('nav-trades');
    if (inj) inj.innerHTML = '<span class="ni-icon">＋</span> Injury Intelligence <span class="nav-badge" style="color:#f16b78;background:rgba(241,107,120,.07)">NEWS</span>';
    if (trades) trades.innerHTML = '<span class="ni-icon">⇄</span> Transactions <span class="nav-badge" style="color:#e9c75a;background:rgba(212,175,55,.07)">NEWS</span>';
    return true;
  }

  window.PBENewsroomV2 = { renderInjuries:()=>renderMode('injuries'), renderTransactions:()=>renderMode('transactions'), state };
  install();
  document.addEventListener('DOMContentLoaded',install,{once:true});
})();
