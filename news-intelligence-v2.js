/* PropBetEdge NFL — News Intelligence v2
 * =============================================================================
 * WHAT THIS SURFACE IS
 *
 * An NFL newsroom whose editorial hierarchy is decided by what the product can
 * actually stand behind, and which connects a story to the research already in
 * the app.
 *
 * THE HIERARCHY IS NOT ARBITRARY. Measured against /api/news-feed?limit=100 on
 * 2026-09-04: 27 of 50 articles carried another article's summary, player tags
 * and team tags -- 16 of them the same Patrick Mahomes dek, six the same Aaron
 * Donald dek, five the same Jets dek. pbe-news-trust.js already suppresses a
 * summary that repeats across the payload, because a real dek is unique. That
 * same test is the honest editorial signal:
 *
 *   a story whose own summary survived the trust guard is article-specific
 *   editorial -> it can carry a lead or major treatment, a dek, entity chips
 *   and a research entry point.
 *
 *   a story whose summary was suppressed is, truthfully, a headline from a
 *   source at a time -> it belongs in the wire, where headline, source and
 *   time is the whole format and nothing is missing from it.
 *
 * That is why the page has three treatments rather than fifty identical cards:
 * the treatment states how much we can vouch for. It also means the page
 * degrades correctly. If the upstream feed is repaired tomorrow, more stories
 * qualify for major treatment automatically; if it degrades further, the page
 * becomes a clean wire instead of a wall of false attributions.
 *
 * ENTITY ATTRIBUTION. Players come from _trust.players, which are only the
 * names the article's own visible text corroborates. Teams are corroborated
 * here against NFL_TEAMS by city, nickname, full name or code appearing in
 * that text, because the previous build rendered raw a.teams and printed
 * "LAR SFO Aaron Donald" under a Falcons practice-squad signing and
 * "KC DEN Patrick Mahomes" under a 49ers inactive report. An uncorroborated
 * entity is dropped, never guessed at and never replaced.
 *
 * WHAT IS DELIBERATELY NOT BUILT. is_breaking is false on every row,
 * availability is null on every row, props is empty on every row, and
 * market_impact.band is CONTEXT on every row. So there is no BREAKING filter,
 * no MARKET RELEVANCE badge and no prop signal on this page. Those would be
 * taxonomy invented for the look of it.
 * ========================================================================== */
(() => {
  'use strict';

  const state = { loading:false, articles:[], query:'', topic:'all', team:'all', fetchedAt:null };

  const esc = v => String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const norm = v => String(v ?? '').toLowerCase().replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim();
  const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const impact = a => num(a?.impact_score);
  const relevance = a => num(a?.relevance_score);

  async function fetchJson(url) {
    const r = await fetch(url, { cache:'no-store', headers:{ Accept:'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  /* ---- time -------------------------------------------------------------- */
  function stamp(v) {
    const d = new Date(v);
    if (!v || Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('en-US', { timeZone:'America/New_York', hour:'numeric', minute:'2-digit' });
  }
  function dayKey(v) {
    const d = new Date(v);
    if (!v || Number.isNaN(d.getTime())) return 'undated';
    return d.toLocaleDateString('en-US', { timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit' });
  }
  function dayLabel(v) {
    const d = new Date(v);
    if (!v || Number.isNaN(d.getTime())) return 'Undated';
    const key = dayKey(v);
    if (key === dayKey(Date.now())) return 'Today';
    if (key === dayKey(Date.now() - 864e5)) return 'Yesterday';
    return d.toLocaleDateString('en-US', { timeZone:'America/New_York', weekday:'long', month:'short', day:'numeric' });
  }
  function ago(v) {
    const d = new Date(v);
    if (!v || Number.isNaN(d.getTime())) return '';
    const m = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000));
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
  }

  /* ---- topic ------------------------------------------------------------- */
  const TOPIC_LABEL = {
    injury:'Injury', transaction:'Transaction', roster:'Roster',
    discipline:'Discipline', frontoffice:'Front office', general:'League'
  };
  function topicOf(a) {
    const t = String(a?.topic_kind || 'general').toLowerCase();
    if (/injury|return/.test(t)) return 'injury';
    if (/trade|signing|transaction|release|waiver/.test(t)) return 'transaction';
    if (/lineup|depth|starter|callup|call_up|practice/.test(t)) return 'roster';
    if (/discipline|suspend/.test(t)) return 'discipline';
    if (/frontoffice|front_office/.test(t)) return 'frontoffice';
    return 'general';
  }
  const topicLabel = a => TOPIC_LABEL[topicOf(a)] || 'League';

  /* ---- trust ------------------------------------------------------------- */
  const trust = a => a?._trust || null;
  /* A dek only exists when the guard let this article keep its own summary. */
  const dek = a => (trust(a) ? trust(a).summary : (a?.summary || '')) || '';
  const suppressed = a => Boolean(trust(a)?.summarySuppressed);
  /* An article we can vouch for: its editorial is its own. */
  const isEditorial = a => Boolean(dek(a));

  /* Corroboration is scoped to what the reader can actually see.
     pbe-news-trust.js corroborates an entity against the article's title plus
     whatever summary survived its duplicate test. That is the right test for a
     lead or a major, which display both. A wire row displays the headline and
     nothing else, so justifying a chip there with a dek the row does not print
     would put a claim on screen that the screen does not support -- measured
     as two cases in the live feed: "NYG" under a Caleb Downs headline that
     names only the Cowboys, and "Daniel Jones" under a Richardson headline.
     Passing 'title' narrows the evidence to the headline alone.

     Filtering and selected-game matching deliberately keep the full scope: a
     story is about the teams it is about whether or not a given treatment
     prints them. */
  function playersOf(a, scope) {
    const t = trust(a);
    const list = (t ? t.players : (Array.isArray(a?.players) ? a.players : [])) || [];
    if (scope !== 'title') return list;
    const hay = norm(a?.title);
    return list.filter(name => String(name || '').split(/\s+/)
      .filter(part => part.replace(/[^a-z]/gi, '').length > 3)
      .some(part => hay.includes(norm(part))));
  }

  /* Corroborated teams. The guard passes teams through untouched by design --
     it has no team vocabulary -- but this page does, via NFL_TEAMS, so a code
     is only shown when the article's own text names that franchise. */
  let TEAM_INDEX = null;
  function teamIndex() {
    if (TEAM_INDEX && TEAM_INDEX.length) return TEAM_INDEX;
    const map = (typeof window !== 'undefined' && window.NFL_TEAMS) || {};
    TEAM_INDEX = Object.entries(map).map(([abbr, t]) => {
      const name = String(t?.name || '');
      const nickname = name.split(/\s+/).slice(-1)[0] || '';
      const terms = [name, t?.city, nickname, abbr].map(norm).filter(v => v && v.length > 1);
      return { abbr:String(abbr).toUpperCase(), name, terms:[...new Set(terms)] };
    });
    return TEAM_INDEX;
  }
  function teamsOf(a, scope) {
    const declared = (Array.isArray(a?.teams) ? a.teams : []).map(x => String(x).toUpperCase());
    if (!declared.length) return [];
    const hay = scope === 'title' ? norm(a?.title) : norm(a?.title) + ' ' + norm(dek(a));
    if (!hay.trim()) return [];
    const index = teamIndex();
    if (!index.length) return [];
    return declared.filter(code => {
      const row = index.find(t => t.abbr === code);
      if (!row) return false;
      /* A short term (a code, or a city like "LA") is only accepted as a whole
         word, so "NE" does not match "Nebraska" and "SF" does not match a
         substring of another token. */
      return row.terms.some(term => term.length <= 3
        ? new RegExp(`(^| )${term}( |$)`).test(hay)
        : hay.includes(term));
    });
  }
  const teamName = code => teamIndex().find(t => t.abbr === code)?.name || code;

  /* ---- selected game ----------------------------------------------------- */
  function selectedTeams() {
    const sel = window.PBEEventSelector?.state;
    const e = sel?.current || sel?.events?.find(x => x.id === sel?.selectedId);
    if (!e) return new Set();
    const names = [e.away, e.home].filter(Boolean).map(v => norm(v));
    const out = new Set();
    teamIndex().forEach(t => {
      if (names.some(n => n === norm(t.name) || t.terms.some(term => term.length > 3 && n.includes(term)))) out.add(t.abbr);
    });
    return out;
  }
  function inSelectedGame(a) {
    const picked = selectedTeams();
    if (!picked.size) return false;
    return teamsOf(a).some(code => picked.has(code));
  }

  /* ---- imagery ----------------------------------------------------------- */
  /* Every row in this feed carries an image_url, so having an image is not by
     itself a signal of anything. Scale is the signal: the lead gets the largest
     frame, majors get a contained one, the wire gets none. A wire row is not a
     card missing its picture.

     CROP. object-fit:cover crops along one axis only, and which axis depends on
     the source aspect relative to the FRAME. Comparing against the frame is
     what puts the bias on the axis actually being cut: a source taller than its
     frame is pulled up towards helmets and faces, which sit in the upper third
     of almost every action photograph; a source wider than its frame keeps its
     horizontal centre, the conservative choice when the subject's position in
     the frame is unknown.

     QUALITY. An asset that would have to be stretched past 1.35x its natural
     width is dropped rather than shown soft -- the frame collapses and the
     story keeps its headline, which is better than a blurred photograph. */
  const imageOf = a => String(a?.image_url || '').trim();
  const FOCUS = "var b=this.getBoundingClientRect();var f=b.width/b.height,r=this.naturalWidth/this.naturalHeight;this.style.objectPosition=r<f?'50% 26%':'50% 50%';if(this.naturalWidth&&b.width>this.naturalWidth*1.35){this.closest('[data-pbe-media]').classList.add('is-lowres')}";
  const DROP = "this.closest('[data-pbe-media]').classList.add('is-lowres')";

  /* ---- ordering ---------------------------------------------------------- */
  function matchesFilters(a) {
    const q = state.query.trim().toLowerCase();
    if (q) {
      const hay = [a.title, dek(a), a.source, ...playersOf(a), ...teamsOf(a)]
        .map(v => String(v || '').toLowerCase()).join(' ');
      if (!hay.includes(q)) return false;
    }
    if (state.topic === 'selected') { if (!inSelectedGame(a)) return false; }
    else if (state.topic !== 'all' && topicOf(a) !== state.topic) return false;
    if (state.team !== 'all' && !teamsOf(a).includes(state.team)) return false;
    return true;
  }
  const byTime = (a, b) => new Date(b.published_at || 0) - new Date(a.published_at || 0);
  const byWeight = (a, b) => impact(b) - impact(a) || relevance(b) - relevance(a) || byTime(a, b);

  function composition() {
    const rows = state.articles.filter(matchesFilters);
    const editorial = rows.filter(isEditorial).sort(byWeight);
    const lead = editorial[0] || rows.slice().sort(byWeight)[0] || null;
    const majors = editorial.filter(a => a !== lead).slice(0, 3);
    const promoted = new Set([lead, ...majors].filter(Boolean));
    const wire = rows.filter(a => !promoted.has(a)).sort(byTime);
    return { rows, lead, majors, wire };
  }

  /* ---- entity chips and research paths ----------------------------------- */
  function chips(a, small, scope) {
    const teams = teamsOf(a, scope).slice(0, 3);
    const players = playersOf(a, scope).slice(0, 3);
    if (!teams.length && !players.length) return '';
    const sz = small ? ' sm' : '';
    return `<div class="pbe27-chips">${
      teams.map(code => `<button type="button" class="pbe27-chip team${sz}" data-team="${esc(code)}" title="${esc(teamName(code))} research">${esc(code)}</button>`).join('')
    }${
      players.map(nm => `<button type="button" class="pbe27-chip player${sz}" data-player="${esc(nm)}">${esc(nm)}</button>`).join('')
    }</div>`;
  }

  /* One or two destinations, chosen from what this story actually resolves to.
     Seven CTAs under every headline is marketing; this is the shortest useful
     path from a development to the research that prices it. */
  function paths(a) {
    const out = [];
    const players = playersOf(a);
    const teams = teamsOf(a);
    const topic = topicOf(a);
    if (topic === 'injury') out.push(['route', 'injuries', 'Injury Intelligence']);
    if (inSelectedGame(a)) out.push(['route', 'pbecast', 'Game Center']);
    if (players.length) out.push(['player', players[0], `${players[0].split(/\s+/).slice(-1)[0]} research`]);
    if (!out.length && teams.length) out.push(['team', teams[0], `${teamName(teams[0])} research`]);
    if (out.length < 2 && players.length && topic !== 'injury') out.push(['route', 'usage', 'Usage research']);
    return out.slice(0, 2);
  }
  function pathButtons(a) {
    const list = paths(a);
    if (!list.length) return '';
    return `<div class="pbe27-paths">${list.map(([kind, value, label]) =>
      `<button type="button" class="pbe27-path" data-path="${esc(kind)}" data-value="${esc(value)}">${esc(label)}<i>&rarr;</i></button>`
    ).join('')}</div>`;
  }

  const sourceLine = a => `${esc(a.source || 'source unavailable')}${a.published_at ? ` &middot; ${esc(ago(a.published_at))}` : ''}`;

  function railLine(a) {
    return `<div class="pbe27-rail">
      <span class="pbe27-topic ${esc(topicOf(a))}">${esc(topicLabel(a))}</span>
      ${inSelectedGame(a) ? '<span class="pbe27-selected">Selected game</span>' : ''}
      <span class="pbe27-time">${esc(stamp(a.published_at))} ET</span>
    </div>`;
  }

  /* ---- treatments -------------------------------------------------------- */
  function leadStory(a) {
    if (!a) return '<div class="pbe27-empty">No current NFL story matches these filters.</div>';
    const img = imageOf(a);
    return `<article class="pbe27-lead">
      ${img ? `<a class="pbe27-lead-media" data-pbe-media ${a.url ? `href="${esc(a.url)}" target="_blank" rel="noopener"` : 'href="javascript:void(0)"'}><img src="${esc(img)}" alt="${esc(a.image_alt || a.title || '')}" fetchpriority="high" decoding="async" onload="${esc(FOCUS)}" onerror="${esc(DROP)}"></a>` : ''}
      <div class="pbe27-lead-copy">
        ${railLine(a)}
        <h2 class="pbe27-lead-title">${a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a>` : esc(a.title)}</h2>
        ${dek(a) ? `<p class="pbe27-dek">${esc(dek(a))}</p>` : ''}
        <div class="pbe27-byline">${sourceLine(a)}</div>
        ${chips(a)}
        ${pathButtons(a)}
      </div>
    </article>`;
  }

  function majorStory(a) {
    const img = imageOf(a);
    return `<article class="pbe27-major">
      ${img ? `<a class="pbe27-major-media" data-pbe-media ${a.url ? `href="${esc(a.url)}" target="_blank" rel="noopener"` : 'href="javascript:void(0)"'}><img src="${esc(img)}" alt="${esc(a.image_alt || a.title || '')}" loading="lazy" decoding="async" onload="${esc(FOCUS)}" onerror="${esc(DROP)}"></a>` : ''}
      <div class="pbe27-major-copy">
        ${railLine(a)}
        <h3 class="pbe27-major-title">${a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a>` : esc(a.title)}</h3>
        ${dek(a) ? `<p class="pbe27-dek">${esc(dek(a))}</p>` : ''}
        <div class="pbe27-byline">${sourceLine(a)}</div>
        ${chips(a, true)}
        ${pathButtons(a)}
      </div>
    </article>`;
  }

  /* A wire row is complete. Headline, source and time is the entire format, so
     a story with nothing else to say is not visibly missing anything. */
  function wireRow(a) {
    /* A wire row prints its headline and nothing else, so only the headline
       may justify a chip on it. */
    const players = playersOf(a, 'title').slice(0, 2);
    const teams = teamsOf(a, 'title').slice(0, 2);
    return `<article class="pbe27-wire-row${inSelectedGame(a) ? ' is-selected' : ''}">
      <time class="pbe27-wire-time">${esc(stamp(a.published_at))}</time>
      <span class="pbe27-wire-topic ${esc(topicOf(a))}" data-source="${esc(a.source || 'source unavailable')}">${esc(topicLabel(a))}</span>
      <div class="pbe27-wire-main">
        <h4 class="pbe27-wire-title">${a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a>` : esc(a.title)}</h4>
        ${(teams.length || players.length) ? `<div class="pbe27-wire-ents">${
          teams.map(c => `<button type="button" class="pbe27-chip team sm" data-team="${esc(c)}" title="${esc(teamName(c))} research">${esc(c)}</button>`).join('')
        }${
          players.map(n => `<button type="button" class="pbe27-chip player sm" data-player="${esc(n)}">${esc(n)}</button>`).join('')
        }</div>` : ''}
      </div>
      <span class="pbe27-wire-source">${esc(a.source || 'source unavailable')}</span>
    </article>`;
  }

  function wireSection(rows) {
    if (!rows.length) return '';
    const groups = [];
    for (const a of rows) {
      const key = dayKey(a.published_at);
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.items.push(a);
      else groups.push({ key, label: dayLabel(a.published_at), items:[a] });
    }
    /* One truthful line about withheld source summaries, stated once for the
       whole wire instead of repeated under every row that has none. */
    const withheld = rows.filter(suppressed).length;
    return `<section class="pbe27-wire">
      <div class="pbe27-section-head">
        <h2>Live wire</h2>
        <span>${esc(String(rows.length))} stories &middot; newest first</span>
      </div>
      ${withheld ? `<p class="pbe27-wire-note">${esc(String(withheld))} of these carry no source summary specific to the story, so they are shown as headline, source and time only.</p>` : ''}
      ${groups.map(g => `<div class="pbe27-wire-day"><div class="pbe27-wire-daylabel">${esc(g.label)}</div>${g.items.map(wireRow).join('')}</div>`).join('')}
    </section>`;
  }

  /* ---- filters ----------------------------------------------------------- */
  function filterBar() {
    const counts = {};
    state.articles.forEach(a => { const t = topicOf(a); counts[t] = (counts[t] || 0) + 1; });
    const selected = state.articles.filter(inSelectedGame).length;
    /* Only topics the feed actually classifies get a chip. Nothing is listed
       that would resolve to zero, and no category is invented. */
    const order = ['injury', 'transaction', 'roster', 'discipline', 'frontoffice', 'general'];
    const chipsHtml = [['all', 'All', state.articles.length]]
      .concat(order.filter(t => counts[t]).map(t => [t, TOPIC_LABEL[t], counts[t]]))
      .concat(selected ? [['selected', 'Selected game', selected]] : [])
      .map(([key, label, n]) => `<button type="button" class="pbe27-filter${state.topic === key ? ' active' : ''}" data-topic="${esc(key)}">${esc(label)}<b>${esc(String(n))}</b></button>`)
      .join('');

    const teamCodes = [...new Set(state.articles.flatMap(teamsOf))].sort();
    return `<div class="pbe27-controls">
      <div class="pbe27-filters" role="group" aria-label="Filter stories by kind">${chipsHtml}</div>
      <div class="pbe27-controls-right">
        ${teamCodes.length ? `<select id="pbe27-team" class="pbe27-select" aria-label="Filter by team">
          <option value="all">All teams</option>
          ${teamCodes.map(c => `<option value="${esc(c)}" ${state.team === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
        </select>` : ''}
        <input id="pbe27-search" class="pbe27-search" type="search" placeholder="Search headline, player, team, source" value="${esc(state.query)}" aria-label="Search stories">
      </div>
    </div>`;
  }

  /* ---- masthead ---------------------------------------------------------- */
  function masthead() {
    const counts = {};
    state.articles.forEach(a => { const t = topicOf(a); counts[t] = (counts[t] || 0) + 1; });
    /* Each filter chip already carries its own count, so this line is a
       one-glance summary rather than a second copy of the taxonomy. */
    const parts = [
      `${state.articles.length} current stories`,
      counts.injury ? `${counts.injury} injury` : '',
      counts.transaction ? `${counts.transaction} transactions` : ''
    ].filter(Boolean);
    return `<header class="pbe27-masthead">
      <div class="pbe27-mast-id">
        <span class="pbe27-eyebrow">NFL &middot; Live news + impact</span>
        <h1 class="pbe27-wordmark">News Intelligence</h1>
      </div>
      <div class="pbe27-mast-now">
        <span class="pbe27-now-line">${esc(parts.join(' · '))}</span>
        ${state.fetchedAt ? `<span class="pbe27-now-stamp">Updated ${esc(ago(state.fetchedAt))}</span>` : ''}
      </div>
    </header>`;
  }

  /* ---- shell ------------------------------------------------------------- */
  function shell() {
    if (!state.articles.length) {
      return `<section class="pbe27">${masthead()}<div class="pbe27-empty">No current NFL news is being returned. No synthetic fallback is used.</div></section>`;
    }
    const { rows, lead, majors, wire } = composition();
    return `<section class="pbe27">
      ${masthead()}
      ${filterBar()}
      ${rows.length ? `<div class="pbe27-top">
        ${leadStory(lead)}
        ${majors.length ? `<div class="pbe27-majors">${majors.map(majorStory).join('')}</div>` : ''}
      </div>
      ${wireSection(wire)}` : '<div class="pbe27-empty">No current NFL story matches these filters.</div>'}
    </section>`;
  }

  function renderShell() {
    const vc = document.getElementById('view-container');
    if (!vc) return;
    vc.innerHTML = shell();
    wireEvents();
  }

  function wireEvents() {
    const host = document.querySelector('.pbe27');
    if (!host) return;
    host.querySelectorAll('[data-topic]').forEach(btn => btn.addEventListener('click', () => {
      state.topic = btn.dataset.topic || 'all';
      renderShell();
    }));
    document.getElementById('pbe27-team')?.addEventListener('change', e => {
      state.team = e.currentTarget.value || 'all';
      renderShell();
    });
    document.getElementById('pbe27-search')?.addEventListener('input', e => {
      const caret = e.currentTarget.selectionStart;
      state.query = e.currentTarget.value || '';
      renderShell();
      /* renderShell replaces the input, so focus and caret are restored. */
      const next = document.getElementById('pbe27-search');
      if (next) { next.focus(); try { next.setSelectionRange(caret, caret); } catch {} }
    });
    /* Entity chips and research paths land on the research surfaces the app
       already has, rather than on a bare route. */
    host.querySelectorAll('[data-player]').forEach(el => el.addEventListener('click', () => {
      if (window.PBEPlayerResearch?.show) window.PBEPlayerResearch.show(el.dataset.player);
      else window.App?.nav('usage');
    }));
    host.querySelectorAll('[data-team]').forEach(el => el.addEventListener('click', () => {
      if (window.PBETeamsV2?.openTeam) window.PBETeamsV2.openTeam(el.dataset.team);
      else window.App?.nav('teams');
    }));
    host.querySelectorAll('[data-path]').forEach(el => el.addEventListener('click', () => {
      const kind = el.dataset.path, value = el.dataset.value;
      if (kind === 'player') { if (window.PBEPlayerResearch?.show) window.PBEPlayerResearch.show(value); else window.App?.nav('usage'); return; }
      if (kind === 'team') { if (window.PBETeamsV2?.openTeam) window.PBETeamsV2.openTeam(value); else window.App?.nav('teams'); return; }
      window.App?.nav(value);
    }));
  }

  async function render() {
    if (state.loading) return;
    state.loading = true;
    const vc = document.getElementById('view-container');
    if (!vc) { state.loading = false; return; }
    vc.innerHTML = '<section class="pbe27"><div class="pbe27-empty">Loading current NFL newsroom intelligence…</div></section>';
    try {
      const payload = await fetchJson('/api/news-feed?limit=100');
      const raw = Array.isArray(payload?.articles) ? payload.articles : [];
      state.articles = window.PBENewsTrust?.prepare(raw) || raw;
      state.fetchedAt = Date.now();
      renderShell();
    } catch (error) {
      vc.innerHTML = `<section class="pbe27"><div class="pbe27-empty">News Intelligence unavailable: ${esc(error instanceof Error ? error.message : String(error))}</div></section>`;
    } finally {
      state.loading = false;
    }
  }

  function install() {
    if (!window.App?.VIEWS) return false;
    App.VIEWS.newsintel = render;
    const group = document.getElementById('intelligence-nav-group');
    if (group && !document.getElementById('nav-newsintel')) {
      const trades = document.getElementById('nav-trades');
      const a = document.createElement('a');
      a.className = 'nav-item';
      a.id = 'nav-newsintel';
      a.href = 'javascript:void(0)';
      a.onclick = () => App.nav('newsintel');
      a.innerHTML = '<span class="ni-icon">▤</span> News Intelligence <span class="nav-badge" style="color:#f16b78;background:rgba(241,107,120,.06)">NEWS</span>';
      trades?.insertAdjacentElement('afterend', a);
    }
    return true;
  }

  window.PBENewsIntel = { render, state };
  install();
  document.addEventListener('DOMContentLoaded', install, { once:true });
  window.addEventListener('pbe:event-changed', () => {
    if (document.querySelector('.pbe27') && !state.loading) renderShell();
  });
})();
