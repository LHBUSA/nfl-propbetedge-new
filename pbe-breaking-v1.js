/* ============================================================================
   PropBetEdge NFL — PBE BREAKING v1
   ----------------------------------------------------------------------------
   ONE global rail, three event families, structurally docked in the sports
   shell between the brand bar and the scoreboard.

     NFL BREAKING   major verified league news          crimson
     GAME BREAK     a live scoring play, or a final     gold / live
     WEATHER ALERT  official NWS, a shift, or a watch   ice / official

   WHAT THIS IS NOT
   It is not the headline marquee that was removed. That was permanent motion
   carrying low-value text, which trains a reader to ignore the top of the page.
   This rail is ABSENT unless something qualifies — it collapses to zero height
   and occupies no chrome — and when it appears the shell grows. Nothing is ever
   overlaid on the page, the navigation or the Player DNA switcher.

   THE RULE THAT MATTERS MOST
   The product may not decide that something "sounds exciting" and call it
   breaking. Every event here traces to a field a source published:

     NEWS     is_breaking / impact_score / published_at, from /api/news-feed
     GAME     situation.last_play.scoring_play + play id, from /api/nfl-live
     WEATHER  an NWS alert id, or an Open-Meteo band transition

   If qualification fails there is no alert. Silence is better than fake
   urgency, and silence is the normal state.

   TRUST
   The upstream news service has a measured corruption issue: a duplicated
   fallback dek and an injected player tag. pbe-news-trust.js is the guard, and
   this rail respects it absolutely. The rail renders TITLE, SOURCE and TIME and
   deliberately renders NO summary at all — the headline is the breaking fact,
   and an unverified generated dek has no place in global chrome. A player is
   named only when the trust layer corroborates the name against the article's
   own visible text.
   ========================================================================== */
(() => {
  'use strict';

  /* ---- CONSTANTS — every threshold named, none scattered ---------------- */

  const CONFIG = {
    /* NEWS ELIGIBILITY. Two independent doors, both requiring recency: an
       impact score is a property of the story, not of its freshness, so a
       month-old 92 is not breaking news. */
    news: {
      breaking_max_age_min: 120,        // is_breaking === true AND <= 2 hours
      high_impact_min_score: 80,        // impact_score >= 80 ...
      high_impact_max_age_min: 60,      // ... AND <= 60 minutes
      major_impact_score: 90,           // outranks a live scoring play
      poll_ms: 120000,
      /* Topics that are genuinely league news. A topic outside this set needs
         is_breaking from the source; it is never promoted on score alone. */
      major_topics: ['injury', 'inactive', 'trade', 'signing', 'suspension',
                     'roster', 'depth_chart', 'transaction', 'announcement']
    },

    /* GAME ELIGIBILITY. A scoring play, ranked. An ordinary extra point does
       not take the one global rail. */
    game: {
      poll_ms: 20000,
      rank: { TOUCHDOWN: 0, SAFETY: 1, FIELD_GOAL: 2 },
      suppress_kinds: ['EXTRA_POINT', 'TWO_POINT'],
      final_enabled: true
    },

    weather: { poll_ms: 900000 },       // 15 min; the route decides per game

    /* LIFECYCLE. Visible durations, then the rail hands over or collapses. */
    visible_ms: {
      NFL_BREAKING: 38000,
      GAME_BREAK: 16000,
      GAME_FINAL: 15000,
      WEATHER_ALERT: 30000,
      WEATHER_SHIFT: 22000,
      WEATHER_WATCH: 18000
    },

    queue_max: 5,
    /* A higher-priority event may take the rail from a lower one, but not
       before the reader has had a moment with what is already there. */
    min_dwell_ms: 4000,
    /* Session memory so a route change does not replay a touchdown. */
    storage_key: 'pbe.breaking.seen.v1',
    dismiss_key: 'pbe.breaking.dismissed.v1',
    memory_max: 400
  };

  /* PRIORITY. Lower number wins the rail. One alert owns it at a time; the
     rest queue. A routine rain forecast must never displace a star QB ruled
     out, and this table is the only place that ordering is expressed. */
  const PRIORITY = {
    NWS_EMERGENCY: 1,      // official Extreme/Severe warning at the venue
    NFL_BREAKING_MAJOR: 2, // is_breaking AND high impact
    GAME_BREAK: 3,         // touchdown / safety / field goal
    WEATHER_SHIFT: 4,      // the forecast materially changed
    NFL_BREAKING: 5,       // ordinary is_breaking
    WEATHER_WATCH: 6,      // a significant condition, unchanged
    GAME_FINAL: 7
  };

  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const REDUCED = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const IMG_FAIL = "this.classList.add('is-broken');this.removeAttribute('src')";

  /* ---- state ------------------------------------------------------------- */

  const state = {
    queue: [],            // qualified, not yet shown
    current: null,        // the one event that owns the rail
    seen: new Set(),      // event keys ever queued this session
    dismissed: new Set(), // event keys the reader closed
    lastPlay: new Map(),  // game_id -> play id, for GAME BREAK dedupe
    lastStatus: new Map(),// game_id -> semantics, for FINAL detection
    weatherBands: new Map(),  // event_id -> band key
    weatherAlerts: new Set(), // NWS alert ids already raised
    timers: { hide: null, news: null, game: null, weather: null },
    started: false,
    mounted: false,
    paused: false
  };

  /* Session memory. A reader moving QB DNA -> WR DNA -> Props must not be
     shown the same touchdown four times, so the identity of what has been
     seen outlives the view and the module instance. */
  function loadMemory() {
    for (const [key, set] of [[CONFIG.storage_key, state.seen],
                              [CONFIG.dismiss_key, state.dismissed]]) {
      try {
        const raw = sessionStorage.getItem(key);
        if (raw) for (const id of JSON.parse(raw)) set.add(id);
      } catch { /* private mode, or storage disabled — memory is per-page then */ }
    }
  }
  function saveMemory(key, set) {
    try {
      const arr = [...set].slice(-CONFIG.memory_max);
      sessionStorage.setItem(key, JSON.stringify(arr));
    } catch { /* nothing to do; the in-memory set still works for this page */ }
  }

  /* ---- formatting -------------------------------------------------------- */

  function agoLabel(iso) {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return '';
    const mins = Math.round((Date.now() - t) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const h = Math.round(mins / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
  }
  function kickoffLabel(iso, withDay = false) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
        weekday: 'short', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(iso));
      const g = t => (parts.find(x => x.type === t) || {}).value || '';
      const time = `${g('hour')}:${g('minute')} ${g('dayPeriod')} ET`;
      return withDay ? `${g('weekday')}, ${g('month')} ${g('day')} · ${time}` : time;
    } catch { return ''; }
  }
  /* '2026-01-11T19:00' (venue local) -> 'Jan 11 · 7 PM'. The raw stamp is a
     machine token; a reader who asked WHEN deserves a clock. */
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function localStamp(stamp, withDate = true) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(stamp || ''));
    if (!m) return String(stamp || '');
    const h = Number(m[4]), mm = m[5];
    const clock = `${h % 12 || 12}${mm !== '00' ? ':' + mm : ''} ${h < 12 ? 'AM' : 'PM'}`;
    return withDate ? `${MON[Number(m[2]) - 1]} ${Number(m[3])} · ${clock}` : clock;
  }
  function windowLabel(w) {
    if (!w || !Array.isArray(w.window_local) || w.window_local.length < 2) return '';
    const [a, b] = w.window_local;
    const sameDay = String(a).slice(0, 10) === String(b).slice(0, 10);
    return `${localStamp(a)} – ${localStamp(b, !sameDay)} local`;
  }
  /* A change is a BEFORE and an AFTER. The unit decides how the pair reads:
     a probability is two percentages, a temperature two degrees, wind two
     numbers sharing one unit, and a band transition two words. */
  function deltaParts(c) {
    const f = c.from, t = c.to;
    const numeric = Number.isFinite(Number(f)) && Number.isFinite(Number(t));
    if (c.field === 'precip_probability' || c.unit === 'percentage points') {
      return { from: `${f}%`, to: `${t}%`, unit: '' };
    }
    if (c.unit === '°F' || c.field === 'temp') {
      return { from: `${Math.round(f)}°F`, to: `${Math.round(t)}°F`, unit: '' };
    }
    if (numeric) return { from: String(Math.round(f)), to: String(Math.round(t)), unit: c.unit || '' };
    return { from: String(f).replace(/_/g, ' '), to: String(t).replace(/_/g, ' '), unit: '' };
  }
  const DELTA_LABEL = { wind: 'Wind', gust: 'Gusts', precip_probability: 'Precip chance',
    temp: 'Temperature', snow: 'Snow', rain: 'Rain', cold: 'Cold', weather_family: 'Conditions' };
  function shiftHtml(c, cls = 'pbeb-shift') {
    if (!c || c.from === undefined || c.to === undefined) return '';
    const d = deltaParts(c);
    return `<span class="${cls}"><b>${esc(d.from)}</b><i aria-hidden="true">→</i>
      <b>${esc(d.to)}</b>${d.unit ? `<u>${esc(d.unit)}</u>` : ''}</span>`;
  }

  /* ---- identity media ---------------------------------------------------
     Real crests and real photographs, or nothing. No initials disc, no PBE
     mark standing in for a club, no generated face. An unknown headshot is
     simply omitted. */
  const ABBR_ALIAS = { LA: 'LAR', WAS: 'WSH', OAK: 'LV', SD: 'LAC', STL: 'LAR' };
  function crest(abbr, size = 26) {
    const a = ABBR_ALIAS[String(abbr || '').toUpperCase()] || String(abbr || '').toUpperCase();
    if (!/^[A-Z]{2,3}$/.test(a)) return '';
    const url = `https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/${a.toLowerCase()}.png`;
    /* eager, not lazy. The rail only renders when it is on screen, so a crest
       here is visible the instant it exists; deferring it just means the alert
       appears with a hole where the club should be. */
    return `<img class="pbeb-crest" src="${esc(url)}" alt="${esc(a)}" width="${size}"
      height="${size}" loading="eager" decoding="async" onerror="${IMG_FAIL}">`;
  }
  function face(url, name) {
    if (!url) return '';   // never fabricated
    return `<img class="pbeb-face" src="${esc(url)}" alt="${esc(name || '')}" width="34"
      height="34" loading="eager" decoding="async" onerror="${IMG_FAIL}">`;
  }

  /* ======================================================================
     NEWS
     ====================================================================== */

  function newsAgeMinutes(item) {
    const t = new Date(item.published_at).getTime();
    if (!Number.isFinite(t)) return Infinity;   // undated is never "recent"
    return (Date.now() - t) / 60000;
  }

  /**
   * Deterministic eligibility. Returns a reason either way so a story that did
   * not qualify can be explained rather than guessed at.
   */
  function qualifyNews(item) {
    const age = newsAgeMinutes(item);
    const score = Number(item.impact_score);
    const N = CONFIG.news;

    if (!item.title) return { ok: false, reason: 'no title — the headline IS the fact' };
    if (!Number.isFinite(new Date(item.published_at).getTime())) {
      return { ok: false, reason: 'no published_at — recency cannot be established' };
    }

    if (item.is_breaking === true && age <= N.breaking_max_age_min) {
      const major = Number.isFinite(score) && score >= N.major_impact_score;
      return { ok: true, door: 'is_breaking', major,
        priority: major ? PRIORITY.NFL_BREAKING_MAJOR : PRIORITY.NFL_BREAKING,
        reason: `is_breaking and ${Math.round(age)}m old (<= ${N.breaking_max_age_min}m)` };
    }
    if (Number.isFinite(score) && score >= N.high_impact_min_score
        && age <= N.high_impact_max_age_min) {
      return { ok: true, door: 'impact_score', major: score >= N.major_impact_score,
        priority: score >= N.major_impact_score
          ? PRIORITY.NFL_BREAKING_MAJOR : PRIORITY.NFL_BREAKING,
        reason: `impact_score ${score} and ${Math.round(age)}m old (<= ${N.high_impact_max_age_min}m)` };
    }

    if (item.is_breaking === true) {
      return { ok: false, reason: `is_breaking but ${Math.round(age)}m old, over the `
        + `${N.breaking_max_age_min}m limit — age is not overridden by the flag` };
    }
    if (Number.isFinite(score) && score >= N.high_impact_min_score) {
      return { ok: false, reason: `impact_score ${score} but ${Math.round(age)}m old, over the `
        + `${N.high_impact_max_age_min}m limit — an old story is not promoted on score alone` };
    }
    return { ok: false, reason: 'neither is_breaking nor a recent high impact score' };
  }

  function newsEvent(item, q) {
    /* The trust layer decides what may be NAMED. The rail shows no summary at
       all, so a duplicated fallback dek cannot reach it by construction; the
       remaining risk is an injected player tag, and only a corroborated name
       survives. */
    const t = (window.PBENewsTrust && window.PBENewsTrust.trust(item)) || null;
    const players = t ? t.players : [];
    const canonical = item.url
      && /^https:\/\/propbetedge\.ai\/news\/nfl\//i.test(item.url) ? item.url : null;

    const cta = [];
    if (canonical) cta.push({ label: 'READ UPDATE', href: canonical, kind: 'article' });
    else cta.push({ label: 'OPEN NEWS INTELLIGENCE', route: 'newsintel', kind: 'route' });
    /* Player DNA hand-off, offered only when a corroborated name resolves to a
       stable identity in one of the four products. A loose name match would
       send a reader to the wrong athlete, so no match means no button. */
    const dna = players.length ? resolvePlayerDna(players[0]) : null;
    if (dna) cta.push({ label: `VIEW ${dna.short} DNA`, route: dna.route,
                        player_id: dna.gsis_id, kind: 'playerdna' });

    return {
      key: `news:${item.id}`,
      family: 'NEWS', kind: 'NFL_BREAKING',
      priority: q.priority,
      label: 'NFL BREAKING',
      headline: item.title,
      /* No summary. Deliberate. */
      source: item.source || null,
      ts: item.published_at,
      teams: (t ? t.teams : item.teams) || [],
      players,
      cta,
      visible_ms: CONFIG.visible_ms.NFL_BREAKING,
      provenance: {
        semantics: 'NEWS', article_id: item.id, published_at: item.published_at,
        is_breaking: item.is_breaking === true,
        impact_score: Number.isFinite(Number(item.impact_score)) ? Number(item.impact_score) : null,
        source: item.source || null, canonical_url: canonical,
        qualified_by: q.door, qualification: q.reason,
        summary_rendered: false,
        summary_policy: 'the rail renders the title only; an upstream dek is never shown here',
        entity_policy: t
          ? 'names shown only where pbe-news-trust corroborated them against the article text'
          : 'trust layer unavailable — no player named'
      }
    };
  }

  /* Player DNA identity resolution. Populated lazily from the four product
     lists; until they load, no hand-off is offered rather than a guess. */
  const DNA_INDEX = { byName: new Map(), rows: new Map(), loaded: false, ready: null };
  const DNA_PRODUCTS = [
    { route: 'qbdna', short: 'QB', noun: 'quarterback', api: '/api/qb-dna?list=1' },
    { route: 'wrdna', short: 'WR', noun: 'receiver', api: '/api/wr-dna?list=1' },
    { route: 'rbdna', short: 'RB', noun: 'running back', api: '/api/rb-dna?list=1' },
    { route: 'tedna', short: 'TE', noun: 'tight end', api: '/api/te-dna?list=1' }
  ];
  function loadDnaIndex() {
    if (DNA_INDEX.ready) return DNA_INDEX.ready;
    DNA_INDEX.ready = (async () => {
      for (const p of DNA_PRODUCTS) {
        try {
          const r = await fetch(p.api, { headers: { accept: 'application/json' } });
          if (!r.ok) continue;
          const j = await r.json();
          const rows = [];
          for (const pl of (j.players || [])) {
            if (!pl.gsis_id || !pl.name) continue;
            rows.push({
              route: p.route, short: p.short, gsis_id: pl.gsis_id, name: pl.name,
              team: pl.team_2026 || null, market: pl.market_priced_2026 === true,
              games: Number(pl.games) || 0,
              headshot: (pl.media && pl.media.headshot_url) || null
            });
            const k = String(pl.name).toLowerCase().trim();
            /* An exact full-name key only. A surname key would collide across
               real players and send a reader to the wrong athlete, which is
               worse than offering nothing. Collisions are dropped entirely. */
            if (DNA_INDEX.byName.has(k)) { DNA_INDEX.byName.set(k, null); continue; }
            DNA_INDEX.byName.set(k, { route: p.route, short: p.short,
                                      gsis_id: pl.gsis_id, name: pl.name });
          }
          DNA_INDEX.rows.set(p.route, rows);
        } catch { /* a product list that will not load simply offers no hand-off */ }
      }
      DNA_INDEX.loaded = true;
    })();
    return DNA_INDEX.ready;
  }
  function resolvePlayerDna(name) {
    const k = String(name || '').toLowerCase().trim();
    return DNA_INDEX.byName.get(k) || null;
  }
  /* MATCHUP RESOLUTION. Given the two clubs in a game, the players each
     Player DNA product can answer for on those rosters — the ones the market
     is pricing this season, the same first group the switcher shows. This is
     a roster fact read from the product's own index, not a guess: a club with
     no priced player at a position contributes nothing, and a position with
     nothing on either side is omitted rather than filled with an arbitrary
     name. */
  const DNA_PER_TEAM = 2;
  function resolveMatchupDna(away, home) {
    const sides = [away, home].map(t => String(t || '').toUpperCase()).filter(Boolean);
    return DNA_PRODUCTS.map(p => {
      const rows = DNA_INDEX.rows.get(p.route) || [];
      const players = []; let more = 0;
      for (const side of sides) {
        const mine = rows.filter(r => r.market && r.team === side)
          .sort((a, b) => b.games - a.games || a.name.localeCompare(b.name));
        players.push(...mine.slice(0, DNA_PER_TEAM));
        more += Math.max(0, mine.length - DNA_PER_TEAM);
      }
      return { route: p.route, short: p.short, noun: p.noun, players, more };
    });
  }

  async function pollNews() {
    try {
      const r = await fetch('/api/news-feed?limit=25', { headers: { accept: 'application/json' } });
      if (!r.ok) return;
      const j = await r.json();
      const items = j.items || j.articles || j.rows || [];
      if (window.PBENewsTrust) window.PBENewsTrust.prepare(items);
      for (const item of items) {
        const q = qualifyNews(item);
        if (!q.ok) continue;
        offer(newsEvent(item, q));
      }
    } catch { /* the rail stays silent rather than reporting its own plumbing */ }
  }

  /* ======================================================================
     GAME
     ====================================================================== */

  /**
   * Classify a scoring play from its STRUCTURED fields. The published text is
   * displayed, never mined: inferring "touchdown" from prose when the feed
   * carries a type and a score value would be manufacturing a classification.
   * When the structured fields do not classify it, we say so and still show
   * the play the source published.
   */
  function classifyPlay(p) {
    const type = String(p.type || '').toLowerCase();
    const v = Number(p.score_value);
    if (type.includes('touchdown') || (Number.isFinite(v) && v === 6)) {
      return { kind: 'TOUCHDOWN', label: 'TOUCHDOWN', rank: 0, classified: true };
    }
    if (type.includes('safety')) return { kind: 'SAFETY', label: 'SAFETY', rank: 1, classified: true };
    if (type.includes('field goal') || (Number.isFinite(v) && v === 3)) {
      return { kind: 'FIELD_GOAL', label: 'FIELD GOAL', rank: 2, classified: true };
    }
    if (type.includes('extra point') || (Number.isFinite(v) && v === 1)) {
      return { kind: 'EXTRA_POINT', label: 'EXTRA POINT', rank: 9, classified: true };
    }
    if (type.includes('two-point') || type.includes('two point')) {
      return { kind: 'TWO_POINT', label: 'TWO-POINT', rank: 9, classified: true };
    }
    /* Structured fields were not enough. The play is still real and its
       published text still stands; it simply is not labelled by us. */
    return { kind: 'SCORING_PLAY', label: 'SCORING PLAY', rank: 3, classified: false };
  }

  function gameEvent(g, p, cls) {
    const home = (g.teams && g.teams.home) || {};
    const away = (g.teams && g.teams.away) || {};
    /* A participant headshot only where the feed supplies a real one. */
    const who = (p.participants || []).find(x => x.headshot) || null;
    return {
      key: `play:${g.id}:${p.id}`,
      family: 'GAME', kind: 'GAME_BREAK',
      priority: PRIORITY.GAME_BREAK,
      label: 'GAME BREAK', live: true,
      headline: cls.label,
      play_text: p.text || p.short_text || null,
      classified: cls.classified,
      game: {
        id: g.id,
        home: { abbr: home.abbreviation, score: p.home_score ?? home.score },
        away: { abbr: away.abbreviation, score: p.away_score ?? away.score },
        period: p.period ?? (g.status && g.status.period),
        clock: p.clock ?? (g.status && g.status.clock)
      },
      participant: who ? { name: who.name, headshot: who.headshot, position: who.position } : null,
      cta: [{ label: 'WATCH IN PBECAST', route: 'pbecast', game_id: g.id,
              play_id: p.id, kind: 'pbecast' }],
      visible_ms: CONFIG.visible_ms.GAME_BREAK,
      provenance: {
        semantics: 'LIVE GAME', game_id: g.id, play_id: p.id,
        scoring_play: true, score_value: p.score_value ?? null,
        period: p.period ?? null, clock: p.clock ?? null,
        home_score: p.home_score ?? null, away_score: p.away_score ?? null,
        source: 'ESPN live feed via /api/nfl-live',
        classification: cls.classified ? `structured play type "${p.type}"`
          : 'structured type did not classify this play; the published text is shown unchanged',
        text_policy: 'the published play text is displayed verbatim and is not interpreted'
      }
    };
  }

  function finalEvent(g) {
    const home = (g.teams && g.teams.home) || {};
    const away = (g.teams && g.teams.away) || {};
    return {
      key: `final:${g.id}`,
      family: 'GAME', kind: 'GAME_FINAL',
      priority: PRIORITY.GAME_FINAL,
      /* Not "BREAKING". A final score is a result, and calling every result
         breaking news is how a rail stops meaning anything. */
      label: 'GAME FINAL',
      headline: `${away.abbreviation} ${away.score} — ${home.abbreviation} ${home.score}`,
      game: {
        id: g.id,
        home: { abbr: home.abbreviation, score: home.score },
        away: { abbr: away.abbreviation, score: away.score }
      },
      cta: [{ label: 'OPEN PBECAST', route: 'pbecast', game_id: g.id, kind: 'pbecast' }],
      visible_ms: CONFIG.visible_ms.GAME_FINAL,
      provenance: {
        semantics: 'FINAL', game_id: g.id, source: 'ESPN live feed via /api/nfl-live',
        status: (g.status && g.status.semantics) || 'FINAL',
        claim_policy: 'a final score is reported as a result; no game is described as a '
                    + 'comeback, an upset or a game-winner without evidence for that claim'
      }
    };
  }

  function ingestScoreboard(payload) {
    for (const g of (payload.games || [])) {
      const sem = (g.status && g.status.semantics) || null;
      const prevStatus = state.lastStatus.get(g.id);

      const p = g.situation && g.situation.last_play;
      if (p && p.scoring_play === true && p.id) {
        const seenPlay = state.lastPlay.get(g.id);
        if (seenPlay !== p.id) {
          state.lastPlay.set(g.id, p.id);
          const cls = classifyPlay(p);
          if (!CONFIG.game.suppress_kinds.includes(cls.kind)) {
            offer(gameEvent(g, p, cls));
          }
        }
      }

      if (CONFIG.game.final_enabled && sem === 'FINAL' && prevStatus && prevStatus !== 'FINAL') {
        offer(finalEvent(g));
      }
      if (sem) state.lastStatus.set(g.id, sem);
    }
  }

  async function pollGames() {
    try {
      const r = await fetch('/api/nfl-live', { headers: { accept: 'application/json' } });
      if (!r.ok) return;
      ingestScoreboard(await r.json());
    } catch { /* silence */ }
  }

  /* ======================================================================
     WEATHER
     ====================================================================== */

  function weatherEventToRail(e) {
    const kind = e.kind;                       // WEATHER_ALERT | _SHIFT | _WATCH
    const official = Boolean(e.official);
    const severe = official && ['Extreme', 'Severe'].includes(e.severity);
    const priority = severe ? PRIORITY.NWS_EMERGENCY
      : kind === 'WEATHER_ALERT' ? PRIORITY.WEATHER_SHIFT
      : kind === 'WEATHER_SHIFT' ? PRIORITY.WEATHER_SHIFT
      : PRIORITY.WEATHER_WATCH;

    const cta = [];
    if (e.cta && e.cta.href) cta.push({ label: e.cta.label, href: e.cta.href, kind: 'external' });
    cta.push({ label: 'VIEW WEATHER', kind: 'weather-detail', game_id: e.game.game_id,
               event_id: e.game.event_id });

    return {
      key: e.event_key,
      family: 'WEATHER', kind,
      priority,
      label: official ? 'NWS WEATHER ALERT'
        : kind === 'WEATHER_SHIFT' ? 'WEATHER SHIFT' : 'WEATHER WATCH',
      official, severity: e.severity || null,
      certainty: e.certainty || null, urgency: e.urgency || null,
      effective: e.effective || null, expires: e.expires || null,
      headline: e.headline,
      detail: e.detail || null,
      changes: e.changes || null,
      window: e.window || null,
      bands: e.bands || null,
      game: e.game,
      cta,
      visible_ms: CONFIG.visible_ms[kind] || CONFIG.visible_ms.WEATHER_WATCH,
      provenance: e.provenance
    };
  }

  async function pollWeather() {
    try {
      const prev = [...state.weatherBands.entries()].map(([k, v]) => `${k}:${v}`).join(',');
      const seen = [...state.weatherAlerts].join(',');
      const qs = new URLSearchParams();
      if (prev) qs.set('prev', prev);
      if (seen) qs.set('seen_alerts', seen);
      const r = await fetch('/api/weather-watch' + (qs.toString() ? `?${qs}` : ''),
        { headers: { accept: 'application/json' } });
      if (!r.ok) return;
      const j = await r.json();
      for (const g of (j.games || [])) {
        if (g.bands) {
          state.weatherBands.set(g.event_id,
            `${g.bands.wind}/${g.bands.gust}/${g.bands.cold}/${g.bands.snow}/${g.bands.rain}`);
        }
        for (const a of (g.nws || [])) state.weatherAlerts.add(a.id);
      }
      for (const e of (j.events || [])) offer(weatherEventToRail(e));
    } catch { /* silence */ }
  }

  /* ======================================================================
     QUEUE · PRIORITY · LIFECYCLE
     ====================================================================== */

  /**
   * Offer an event to the rail. Most offers are refused, and every refusal has
   * a reason: already seen, already dismissed, or crowded out by better events.
   */
  function offer(ev) {
    if (!ev || !ev.key) return { accepted: false, reason: 'no event key' };
    if (state.dismissed.has(ev.key)) {
      return { accepted: false, reason: 'dismissed by the reader' };
    }
    if (state.seen.has(ev.key)) {
      return { accepted: false, reason: 'already shown this session' };
    }
    if (state.current && state.current.key === ev.key) {
      return { accepted: false, reason: 'currently on the rail' };
    }
    if (state.queue.some(q => q.key === ev.key)) {
      return { accepted: false, reason: 'already queued' };
    }

    state.seen.add(ev.key);
    saveMemory(CONFIG.storage_key, state.seen);
    ev.queued_at = Date.now();
    state.queue.push(ev);

    /* SUNDAY FLOOD CONTROL. Eight games can score inside a minute. The queue
       is sorted by priority then by age, and anything past the cap is dropped
       from the BOTTOM — the lowest-priority, oldest, least valuable event —
       so a touchdown is never displaced by a rain forecast that arrived first. */
    state.queue.sort((a, b) => a.priority - b.priority || a.queued_at - b.queued_at);
    let dropped = 0;
    while (state.queue.length > CONFIG.queue_max) { state.queue.pop(); dropped++; }

    /* PREEMPTION. A strictly higher-priority event does not wait behind a field
       goal for sixteen seconds — an official tornado warning or a starting
       quarterback ruled out is the reason this rail exists. The displaced event
       is put BACK in the queue rather than lost, and a minimum dwell stops the
       current card being yanked away before it can be read. */
    let preempted = false;
    if (state.current && ev.priority < state.current.priority
        && Date.now() - state.current.shown_at >= CONFIG.min_dwell_ms) {
      const displaced = state.current;
      state.current = null;
      state.queue.push(displaced);
      state.queue.sort((a, b) => a.priority - b.priority || a.queued_at - b.queued_at);
      while (state.queue.length > CONFIG.queue_max) state.queue.pop();
      preempted = true;
    }

    if (!state.current) show(state.queue.shift());
    return { accepted: true, queued: state.queue.length, dropped, preempted };
  }

  function show(ev) {
    if (!ev) return;
    state.current = ev;
    ev.shown_at = Date.now();
    render();
    clearTimeout(state.timers.hide);
    state.timers.hide = setTimeout(next, ev.visible_ms);
  }

  function next() {
    clearTimeout(state.timers.hide);
    state.current = null;
    if (state.queue.length) show(state.queue.shift());
    else render();                      // collapses to zero height
  }

  function dismiss() {
    if (!state.current) return;
    /* Dismissal is BY EVENT ID. This event will not return; a different one
       still can, because the reader closed a card, not the feature. */
    state.dismissed.add(state.current.key);
    saveMemory(CONFIG.dismiss_key, state.dismissed);
    next();
  }

  /* ======================================================================
     RENDER
     ====================================================================== */

  function mount() {
    const slot = document.getElementById('pbe-breaking-slot');
    if (!slot) return null;
    state.mounted = true;
    return slot;
  }

  function ctaHtml(cta) {
    return cta.map((c, i) => {
      const primary = i === 0 ? ' is-primary' : '';
      if (c.href) {
        return `<a class="pbeb-cta${primary}" href="${esc(c.href)}" target="_blank"
          rel="noopener noreferrer">${esc(c.label)} <em aria-hidden="true">↗</em></a>`;
      }
      return `<button type="button" class="pbeb-cta${primary}" data-cta="${esc(String(i))}">
        ${esc(c.label)} <em aria-hidden="true">→</em></button>`;
    }).join('');
  }

  function newsBody(ev) {
    const teams = (ev.teams || []).slice(0, 2).filter(t => /^[A-Za-z]{2,3}$/.test(String(t)));
    return `
      <div class="pbeb-key">NFL BREAKING</div>
      <div class="pbeb-main">
        <div class="pbeb-headline">${esc(ev.headline)}</div>
        <div class="pbeb-meta">
          ${teams.map(t => crest(t, 18)).join('')}
          ${ev.source ? `<span class="pbeb-src">${esc(ev.source)}</span>` : ''}
          <span class="pbeb-time">${esc(agoLabel(ev.ts))}</span>
          ${ev.players.length ? `<span class="pbeb-who">${esc(ev.players[0])}</span>` : ''}
        </div>
      </div>
      <div class="pbeb-ctas">${ctaHtml(ev.cta)}</div>`;
  }

  function gameBody(ev) {
    const g = ev.game;
    const clock = [g.period ? `Q${g.period}` : null, g.clock].filter(Boolean).join(' · ');
    return `
      <div class="pbeb-key"><i class="pbeb-dot"></i>GAME BREAK<span>LIVE</span></div>
      <div class="pbeb-main">
        <div class="pbeb-score">
          <span class="pbeb-side">${crest(g.away.abbr, 22)}<b>${esc(g.away.abbr)}</b>
            <em>${esc(g.away.score ?? '')}</em></span>
          <span class="pbeb-side">${crest(g.home.abbr, 22)}<b>${esc(g.home.abbr)}</b>
            <em>${esc(g.home.score ?? '')}</em></span>
          ${clock ? `<span class="pbeb-clock">${esc(clock)}</span>` : ''}
          <span class="pbeb-tag">${esc(ev.headline)}</span>
        </div>
        ${ev.play_text ? `<div class="pbeb-play">
          ${ev.participant ? face(ev.participant.headshot, ev.participant.name) : ''}
          <span>${esc(ev.play_text)}</span></div>` : ''}
      </div>
      <div class="pbeb-ctas">${ctaHtml(ev.cta)}</div>`;
  }

  function finalBody(ev) {
    const g = ev.game;
    return `
      <div class="pbeb-key">GAME FINAL</div>
      <div class="pbeb-main">
        <div class="pbeb-score">
          <span class="pbeb-side">${crest(g.away.abbr, 22)}<b>${esc(g.away.abbr)}</b>
            <em>${esc(g.away.score ?? '')}</em></span>
          <span class="pbeb-side">${crest(g.home.abbr, 22)}<b>${esc(g.home.abbr)}</b>
            <em>${esc(g.home.score ?? '')}</em></span>
          <span class="pbeb-tag">FINAL</span>
        </div>
      </div>
      <div class="pbeb-ctas">${ctaHtml(ev.cta)}</div>`;
  }

  const WX_ICON = {
    snow: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1v14M2 4.5l12 7M14 4.5l-12 7" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>',
    rain: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 9a3 3 0 0 1 .4-6 4 4 0 0 1 7.5 1A2.6 2.6 0 0 1 12 9z" fill="currentColor" opacity=".55"/><path d="M5.5 11.5 4.7 14M8 11.5 7.2 14M10.5 11.5 9.7 14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none"/></svg>',
    wind: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 5.5h8a2 2 0 1 0-2-2M1.5 9h11a2 2 0 1 1-2 2M1.5 12.5h6" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>',
    cold: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 9.2V3a1.5 1.5 0 0 1 3 0v6.2a3 3 0 1 1-3 0z" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>',
    warning: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.6 15 14H1z" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round"/><path d="M8 6v3.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="11.7" r=".9" fill="currentColor"/></svg>'
  };

  function wxIcon(ev) {
    if (ev.official) return WX_ICON.warning;
    const b = ev.bands || {};
    if (b.snow && b.snow !== 'none' && b.snow !== 'unknown') return WX_ICON.snow;
    if (b.rain && b.rain !== 'none' && b.rain !== 'unknown') return WX_ICON.rain;
    if (b.cold && b.cold !== 'none' && b.cold !== 'unknown') return WX_ICON.cold;
    return WX_ICON.wind;
  }

  /* The key label, with a compact form for a phone. Only the official alert
     needs one: 'NWS WEATHER ALERT' plus its severity plus 'VIEW OFFICIAL
     ALERT' cannot share a 390px row, and the severity is repeated in full
     inside the drawer. The accessible name of the rail is unaffected — it is
     set from ev.label on the rail itself. */
  function keyLabel(long, short) {
    if (!short || short === long) return esc(long);
    return `<span class="pbeb-kl">${esc(long)}</span><span class="pbeb-ks" aria-hidden="true">${esc(short)}</span>`;
  }

  function weatherFacts(w) {
    const facts = [];
    if (!w) return facts;
    if (w.temp_f !== null && w.temp_f !== undefined) facts.push(`${Math.round(w.temp_f)}°F`);
    if (w.precip_probability_pct !== null && w.precip_probability_pct !== undefined) {
      facts.push(`${w.precip_probability_pct}% precip`);
    }
    if (w.wind_mph !== null && w.wind_mph !== undefined) facts.push(`${Math.round(w.wind_mph)} mph wind`);
    if (w.gust_mph !== null && w.gust_mph !== undefined) facts.push(`gusts ${Math.round(w.gust_mph)}`);
    return facts;
  }

  function weatherBody(ev) {
    const g = ev.game;
    const facts = weatherFacts(ev.window);
    /* A shift's whole value is the BEFORE and AFTER, so it travels with the
       headline rather than being buried in the metadata. */
    const shift = shiftHtml((ev.changes || [])[0]);
    const short = ev.official ? 'NWS ALERT' : null;

    return `
      <div class="pbeb-key">${wxIcon(ev)}${keyLabel(ev.label, short)}${
        ev.severity ? `<span>${esc(ev.severity)}</span>` : ''}</div>
      <div class="pbeb-main">
        <div class="pbeb-headline pbeb-wxh"><span class="pbeb-tag">${esc(ev.headline)}</span>${shift}</div>
        <div class="pbeb-meta">
          <span class="pbeb-match">${crest(g.away_team, 16)}<b>${esc(g.away_team)} @ ${esc(g.home_team)}</b>${crest(g.home_team, 16)}</span>
          ${facts.length ? `<span class="pbeb-facts">${facts.map(f => `<i>${esc(f)}</i>`).join('')}</span>` : ''}
          ${g.kickoff_utc ? `<span class="pbeb-time pbeb-kick">Kickoff · ${esc(kickoffLabel(g.kickoff_utc, true))}</span>` : ''}
          ${ev.official
            ? `<span class="pbeb-src pbeb-wxsrc">National Weather Service</span>`
            : `<span class="pbeb-src pbeb-wxsrc">Forecast · Open-Meteo</span>`}
        </div>
        ${ev.detail ? `<div class="pbeb-nws">${esc(ev.detail)}</div>` : ''}
      </div>
      <div class="pbeb-ctas">${ctaHtml(ev.cta)}</div>`;
  }

  function render() {
    const slot = document.getElementById('pbe-breaking-slot');
    if (!slot) return;
    const ev = state.current;

    if (!ev) {
      /* Collapses to nothing. No placeholder, no reserved band, no permanent
         chrome for a feature that is usually silent. */
      slot.innerHTML = '';
      slot.hidden = true;
      document.documentElement.classList.remove('pbe-breaking-on');
      return;
    }

    slot.hidden = false;
    document.documentElement.classList.add('pbe-breaking-on');
    const tone = ev.family === 'NEWS' ? 'news'
      : ev.kind === 'GAME_FINAL' ? 'final'
      : ev.family === 'GAME' ? 'game'
      : ev.official ? 'nws'
      : ev.kind === 'WEATHER_SHIFT' ? 'shift' : 'watch';

    const body = ev.family === 'NEWS' ? newsBody(ev)
      : ev.kind === 'GAME_FINAL' ? finalBody(ev)
      : ev.family === 'GAME' ? gameBody(ev)
      : weatherBody(ev);

    slot.innerHTML = `<div class="pbeb" data-tone="${tone}" role="status" aria-live="polite">
      <div class="pbeb-inner" data-open="1" tabindex="0" role="button"
        aria-label="${esc(ev.label)}: ${esc(ev.headline)}">${body}</div>
      <button type="button" class="pbeb-x" data-dismiss aria-label="Dismiss this alert">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"
          stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
      ${state.queue.length ? `<div class="pbeb-more">+${state.queue.length}</div>` : ''}
    </div>`;

    wire(slot, ev);
    /* One tasteful transition when the event changes. Never a loop, and
       nothing at all when the reader has asked for reduced motion. */
    if (!REDUCED) {
      const el = slot.querySelector('.pbeb');
      el && el.animate([{ opacity: 0, transform: 'translateY(-6px)' },
                        { opacity: 1, transform: 'none' }],
                       { duration: 240, easing: 'cubic-bezier(.2,.7,.3,1)' });
    }
  }

  function runCta(c, ev, opener) {
    if (c.kind === 'weather-detail') return openWeatherDetail(ev, opener);
    if (c.route) {
      /* PBEcast deep-link: focus the game, and carry the play id so an Arcade
         replay can target it later. Not a dependency now — the current cast
         experience is enough, and a consumer that ignores the play id still
         lands on the right game. */
      if (c.game_id) {
        try { sessionStorage.setItem('pbe.pbecast.focus',
          JSON.stringify({ game_id: c.game_id, play_id: c.play_id || null })); } catch {}
      }
      if (c.player_id) {
        try { sessionStorage.setItem('pbe.playerdna.focus',
          JSON.stringify({ route: c.route, player_id: c.player_id,
                           event_id: c.event_id || null, source: ev.kind })); } catch {}
      }
      if (window.App && typeof App.nav === 'function') App.nav(c.route);
      else location.hash = c.route;
    }
  }

  function wire(slot, ev) {
    slot.querySelector('[data-dismiss]')?.addEventListener('click', e => {
      e.stopPropagation(); dismiss();
    });
    slot.querySelectorAll('[data-cta]').forEach(b =>
      b.addEventListener('click', e => {
        e.stopPropagation();
        runCta(ev.cta[Number(b.dataset.cta)], ev, b);
      }));
    /* Tapping the rail runs the primary action — the whole surface is the
       target on a phone, where a 13px link is not. */
    const inner = slot.querySelector('[data-open]');
    inner?.addEventListener('click', () => {
      const primary = ev.cta[0];
      if (primary && primary.href) window.open(primary.href, '_blank', 'noopener');
      else if (primary) runCta(primary, ev, inner);
    });
    inner?.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inner.click(); }
    });
  }

  /* ---- WEATHER DETAIL DRAWER --------------------------------------------
     A compact surface, not another product page. It uses the same body-level
     modal root as the Player DNA switcher, so exactly one element in the
     document owns "above everything" and the two can never fight.

     It answers five questions, in this order, because that is the order a
     reader asks them: WHY did this fire (the lead), WHAT GAME and WHEN (the
     head), WHAT IS FORECAST (the grid), WHO does it touch (Player DNA for the
     two clubs), and WHAT SOURCE (the foot). */
  let drawerState = null;
  function closeWeatherDetail() {
    if (!drawerState) return;
    const d = drawerState; drawerState = null;
    document.removeEventListener('keydown', d.onKey, true);
    d.root.innerHTML = '';
    document.body.style.overflow = d.prevOverflow;
    document.body.style.paddingRight = d.prevPad;
    document.body.classList.remove('pdna-modal-open');
    if (d.returnFocusTo && document.body.contains(d.returnFocusTo)) {
      try { d.returnFocusTo.focus({ preventScroll: true }); } catch { d.returnFocusTo.focus(); }
    }
  }

  function officialHtml(alerts) {
    const when = iso => { try { return kickoffLabel(iso, true); } catch { return ''; } };
    return alerts.map(a => `<div class="pbeb-dalert">
      <div class="pbeb-dalert-k">${esc(a.event || 'Official alert')}</div>
      ${a.headline ? `<div class="pbeb-dalert-h">${esc(a.headline)}</div>` : ''}
      <div class="pbeb-dnws-grid">
        ${[['Severity', a.severity], ['Certainty', a.certainty], ['Urgency', a.urgency],
           ['Effective', a.effective ? when(a.effective) : null],
           ['Expires', (a.ends || a.expires) ? when(a.ends || a.expires) : null],
           ['Issued by', a.sender || 'National Weather Service']]
          .filter(([, v]) => v).map(([k, v]) => `<div class="pbeb-dnws-cell">
            <div class="pbeb-dk">${esc(k)}</div><div class="pbeb-dnws-v">${esc(v)}</div></div>`).join('')}
      </div>
      ${a.area ? `<div class="pbeb-dalert-s">${esc(a.area)}</div>` : ''}
      ${a.url ? `<div class="pbeb-dlinks"><a class="pbeb-cta is-primary" href="${esc(a.url)}" target="_blank"
        rel="noopener noreferrer">VIEW OFFICIAL ALERT <em aria-hidden="true">↗</em></a></div>` : ''}
    </div>`).join('');
  }

  function dnaSectionHtml(g) {
    const groups = resolveMatchupDna(g.away_team, g.home_team).filter(x => x.players.length);
    if (!groups.length) {
      /* Nothing resolved for either club. The products are still one tap
         away, but no name is offered that the index did not supply. */
      return `<p class="pbeb-dnote">${DNA_INDEX.loaded
        ? 'No market-priced player on either roster resolves in the Player DNA index for this game.'
        : 'The Player DNA index has not loaded yet.'}</p>
        <div class="pbeb-dlinks">${DNA_PRODUCTS.map(p =>
          `<button type="button" class="pbeb-cta" data-dna="${p.route}">${p.short} DNA <em aria-hidden="true">→</em></button>`).join('')}</div>`;
    }
    return groups.map(x => `<div class="pbeb-dpos">
      <div class="pbeb-dpos-k">${esc(x.short)} DNA</div>
      <div class="pbeb-dchips">
        ${x.players.map(p => `<button type="button" class="pbeb-chip" data-dna="${esc(x.route)}"
            data-player="${esc(p.gsis_id)}" title="Open ${esc(x.short)} DNA for ${esc(p.name)}">
          ${p.headshot ? `<img class="pbeb-chip-face" src="${esc(p.headshot)}" alt="" width="30" height="30"
            loading="lazy" decoding="async" onerror="${IMG_FAIL}">` : ''}
          <span class="pbeb-chip-copy"><b>${esc(p.name)}</b>
            <em>${esc(p.team || '')}${p.games ? ` · ${p.games} games` : ' · no NFL history'}</em></span>
          <i aria-hidden="true">→</i></button>`).join('')}
        ${x.more ? `<button type="button" class="pbeb-chip is-more" data-dna="${esc(x.route)}">
          +${x.more} more ${esc(x.short)} <em aria-hidden="true">→</em></button>` : ''}
      </div></div>`).join('');
  }

  async function openWeatherDetail(ev, opener) {
    closeWeatherDetail();
    if (window.PBEPlayerDNA && window.PBEPlayerDNA.closePicker) window.PBEPlayerDNA.closePicker();
    const root = (window.PBEPlayerDNA && window.PBEPlayerDNA.modalRoot)
      ? window.PBEPlayerDNA.modalRoot()
      : (() => {
          let r = document.getElementById('pbe-player-dna-modal-root');
          if (!r) { r = document.createElement('div'); r.id = 'pbe-player-dna-modal-root';
                    document.body.appendChild(r); }
          return r;
        })();

    const g = ev.game;
    let detail = null;
    try {
      const r = await fetch(`/api/weather-watch?event_id=${encodeURIComponent(g.event_id)}`,
        { headers: { accept: 'application/json' } });
      if (r.ok) detail = ((await r.json()).games || [])[0] || null;
    } catch { /* the drawer degrades to the event's own snapshot */ }
    /* The hand-off needs the index; wait for it briefly rather than render a
       drawer that offers nobody and fills in a second later. */
    try { await Promise.race([loadDnaIndex(), new Promise(r => setTimeout(r, 1500))]); } catch {}

    const w = (detail && detail.window) || ev.window || null;
    const roof = (detail && detail.roof) || (g.roof || null);
    const nws = (detail && detail.nws && detail.nws.length) ? detail.nws
      : ev.official ? [{
          event: ev.headline, headline: ev.detail, severity: ev.severity,
          certainty: ev.certainty, urgency: ev.urgency, effective: ev.effective,
          expires: ev.expires,
          url: ((ev.cta || []).find(c => c.kind === 'external') || {}).href || null
        }] : [];
    const tone = ev.official ? 'nws' : ev.kind === 'WEATHER_SHIFT' ? 'shift' : 'watch';
    const fetchedAt = (detail && detail.forecast_fetched_at)
      || (ev.provenance && ev.provenance.fetched_at) || null;

    const row = (k, v, sub) => `<div class="pbeb-drow${v === null || v === undefined ? ' is-empty' : ''}">
      <div class="pbeb-dk">${esc(k)}</div>
      <div class="pbeb-dv">${v === null || v === undefined ? 'Not available' : esc(v)}</div>
      ${sub ? `<div class="pbeb-ds">${esc(sub)}</div>` : ''}</div>`;

    /* THE LEAD — why this alert exists, before anything else. */
    const changes = ev.changes || [];
    const lead = ev.official
      ? `<section class="pbeb-dlead">
          <div class="pbeb-dlead-k">Official warning · carried verbatim</div>
          ${officialHtml(nws)}
        </section>`
      : `<section class="pbeb-dlead">
          <div class="pbeb-dlead-k">${changes.length ? 'What changed' : 'Forecast condition'}</div>
          <div class="pbeb-dlead-h">${esc(ev.headline)}</div>
          <div class="pbeb-dlead-s">${changes.length
            ? 'since the last accepted forecast for the kickoff window'
            : 'across the kickoff window · a forecast, not an observation'}</div>
          ${changes.length ? `<div class="pbeb-ddeltas">${changes.map(c => `<div class="pbeb-ddelta">
              <span class="pbeb-ddelta-f">${esc(DELTA_LABEL[c.field] || String(c.field).replace(/_/g, ' '))}</span>
              ${shiftHtml(c, 'pbeb-ddelta-v')}
              ${Number.isFinite(Number(c.delta)) ? `<em>${c.field === 'temp' ? '−' : '+'}${esc(c.delta)}${
                c.unit === 'percentage points' ? ' pts' : c.unit === '°F' ? '°F' : c.unit ? ' ' + esc(c.unit) : ''}</em>` : ''}
            </div>`).join('')}</div>` : ''}
        </section>`;

    root.innerHTML = `<div class="pdna-modal pbeb-modal" role="dialog" aria-modal="true"
      aria-label="${esc(ev.label)}: ${esc(g.away_team)} at ${esc(g.home_team)}">
      <div class="pdna-modal-panel pbeb-panel" data-tone="${tone}">
        <header class="pbeb-dhead">
          <div class="pbeb-dmatch">${crest(g.away_team, 28)}
            <b>${esc(g.away_team)} @ ${esc(g.home_team)}</b>${crest(g.home_team, 28)}</div>
          <button type="button" class="pbeb-dx" data-close aria-label="Close">✕</button>
        </header>
        <div class="pbeb-dsub">
          <span class="pbeb-dpill">${wxIcon(ev)}${esc(ev.label)}${ev.severity ? ` · ${esc(ev.severity)}` : ''}</span>
          ${g.venue ? `<span>${esc(g.venue)}</span>` : ''}
          ${g.kickoff_utc ? `<span>Kickoff · ${esc(kickoffLabel(g.kickoff_utc, true))}</span>` : ''}
          ${roof ? `<span class="pbeb-roof" data-state="${esc(roof.state)}">${esc(roof.label)}</span>` : ''}
        </div>
        ${roof && roof.reason ? `<p class="pbeb-dnote pbeb-droof">${esc(roof.reason)}</p>` : ''}
        <div class="pbeb-dbody">
        ${lead}

        <section class="pbeb-dsec">
          <h4>Forecast for the kickoff window</h4>
          ${w ? `<div class="pbeb-dgrid">
            ${row('Temperature', w.temp_f === null ? null : `${Math.round(w.temp_f)}°F`,
                  w.apparent_temp_f === null ? '' : `feels like ${Math.round(w.apparent_temp_f)}°F`)}
            ${row('Precip chance', w.precip_probability_pct === null ? null
                  : `${w.precip_probability_pct}%`, 'worst hour in the window')}
            ${row('Rain', w.rain_in === null ? null : `${w.rain_in}"`, 'modelled accumulation')}
            ${row('Snow', w.snowfall_in === null ? null : `${w.snowfall_in}"`, 'modelled accumulation')}
            ${row('Wind', w.wind_mph === null ? null : `${Math.round(w.wind_mph)} mph`, 'worst hour')}
            ${row('Gusts', w.gust_mph === null ? null : `${Math.round(w.gust_mph)} mph`, 'worst hour')}
          </div>
          <p class="pbeb-dnote">${esc(windowLabel(w))} · kickoff −1h to +3h ·
            ${esc(w.hours_resolved)} of ${esc(w.hours_requested)} forecast hours resolved${
            w.hours_resolved < w.hours_requested ? ' — the window is incomplete' : ''}.</p>`
          : `<p class="pbeb-dnote">${esc((detail && (detail.unresolved || [])[0]
              && detail.unresolved[0].reason) || 'no forecast resolved for this game')}</p>`}
        </section>

        <section class="pbeb-dsec pbeb-ddna">
          <h4>Player DNA for this game</h4>
          <p class="pbeb-dnote">These are the conditions. Player DNA holds what each
            player has actually done in them, with the sample size attached.</p>
          ${dnaSectionHtml(g)}
        </section>
        </div>

        <footer class="pbeb-dfoot">
          ${fetchedAt ? `<span>Forecast fetched ${esc(agoLabel(fetchedAt))}</span>` : ''}
          <span>Weather data by Open-Meteo.com, licensed CC BY 4.0</span>
          <span>Official alerts from the National Weather Service, carried verbatim</span>
          <span>FORECAST — modelled values for the kickoff window, not an observation
            of conditions at the stadium. No market movement is attributed to weather.</span>
        </footer>
      </div>
    </div>`;

    /* The page behind a modal must not scroll, and must not jump when the
       scrollbar disappears — the same discipline as the player switcher. */
    const sbw = window.innerWidth - document.documentElement.clientWidth;
    const prevOverflow = document.body.style.overflow;
    const prevPad = document.body.style.paddingRight;
    document.body.style.overflow = 'hidden';
    if (sbw > 0) document.body.style.paddingRight = `${sbw}px`;
    document.body.classList.add('pdna-modal-open');
    const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); closeWeatherDetail(); } };
    document.addEventListener('keydown', onKey, true);
    drawerState = { root, onKey, prevOverflow, prevPad,
                    returnFocusTo: opener || document.querySelector('#pbe-breaking-slot .pbeb-cta') };

    root.querySelector('[data-close]')?.addEventListener('click', closeWeatherDetail);
    root.querySelector('.pbeb-modal')?.addEventListener('mousedown', e => {
      if (e.target === e.currentTarget) closeWeatherDetail();
    });
    root.querySelectorAll('[data-dna]').forEach(b => b.addEventListener('click', () => {
      const r = b.dataset.dna, pid = b.dataset.player || null;
      closeWeatherDetail();
      try {
        if (pid) sessionStorage.setItem('pbe.playerdna.focus',
          JSON.stringify({ route: r, player_id: pid, event_id: g.event_id || null, source: ev.kind }));
        else sessionStorage.removeItem('pbe.playerdna.focus');
      } catch {}
      if (window.App && typeof App.nav === 'function') App.nav(r); else location.hash = r;
    }));
    root.querySelector('[data-close]')?.focus();
  }

  /* ======================================================================
     LIFECYCLE
     ====================================================================== */

  function start() {
    if (state.started) return;
    state.started = true;
    loadMemory();
    mount();
    render();
    loadDnaIndex();

    const tick = (fn, ms, key) => {
      fn();
      state.timers[key] = setInterval(() => {
        if (document.visibilityState === 'visible' && !state.paused) fn();
      }, ms);
    };
    tick(pollNews, CONFIG.news.poll_ms, 'news');
    tick(pollGames, CONFIG.game.poll_ms, 'game');
    tick(pollWeather, CONFIG.weather.poll_ms, 'weather');
  }

  function stop() {
    for (const k of ['news', 'game', 'weather']) clearInterval(state.timers[k]);
    clearTimeout(state.timers.hide);
    state.started = false;
  }

  /* The rail is GLOBAL. It lives in the shell, not in a view, so a route
     change re-renders nothing and restarts no timer — which is exactly why
     moving QB DNA -> WR DNA -> Props cannot replay an alert. (An earlier
     listener here re-rendered on a route event the router never dispatches;
     it was dead, and had it been live it would have replayed the entrance
     transition on every navigation.) */

  window.PBEBreaking = {
    start, stop, state, offer, dismiss, next,
    CONFIG, PRIORITY,
    /* Exposed so the fixture harness can drive every path deterministically
       without a live slate, a live wire or a live storm. */
    _test: { qualifyNews, newsEvent, classifyPlay, gameEvent, finalEvent,
             ingestScoreboard, weatherEventToRail, render, openWeatherDetail,
             closeWeatherDetail, agoLabel, resolvePlayerDna, resolveMatchupDna,
             loadDnaIndex, deltaParts, windowLabel, DNA_INDEX }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
  window.addEventListener('pbe:upgrades-ready', () => { mount(); render(); });
})();
