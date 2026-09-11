/* PropBetEdge NFL — Sunday Command Center (dashboard layer)
 *
 * Answers, at the top of the dashboard, the only question a game-day visitor
 * brings: WHAT IS HAPPENING IN THE NFL RIGHT NOW, AND WHAT CHANGED?
 *
 *   slate     every game on the current scoreboard, grouped LIVE / NEXT /
 *             FINAL, with live situation straight from the scoreboard and the
 *             snapshot consensus line for games still to kick off
 *   loop      where we are in the week: TODAY -> WHAT CHANGED -> GAME -> MARKET
 *             -> PBE PICK -> LIVE PBECAST -> RESULT -> TRACK RECORD -> REPLAY
 *   changes   the top sourced changes from the nfl-intel Worker (/api/changes)
 *   picks     the PBE Picks engine's own state, verbatim (gated is gated)
 *   best line where shopping beats the consensus number today
 *
 * OWNERSHIP. dashboard-v7 owns the route, the cadence and the scoreboard.
 * It renders two empty slots and calls mount() after every paint and tick()
 * after every poll. This module owns what goes in the slots and decides, per
 * source, whether its own data is stale. It runs no timer of its own, so a
 * hidden tab or another route costs nothing here.
 *
 * TRUTH. Nothing here is inferred. A game with no market in the snapshot has
 * no line; a gated engine says GATED; an unavailable source says so with its
 * reason rather than rendering an empty list that reads as "nothing changed".
 */
(() => {
  'use strict';

  const TTL = { changes: 120000, picks: 300000, bestline: 300000 };
  /* The community is Discord, not an internal forum. Permanent invite to the
     PropBetEdge.ai server (verified 2026-09-11: no expiry), the same one the
     MLB product links. */
  const PROPBETEDGE_DISCORD_URL = 'https://discord.gg/kb5zCTHbME';
  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const arr = v => (Array.isArray(v) ? v : []);
  const num = v => (v === null || v === undefined || v === '' ? NaN : Number(v));
  const norm = v => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  const store = {
    changes: { data: null, error: null, at: 0, busy: null },
    picks: { data: null, error: null, at: 0, busy: null },
    bestline: { data: null, error: null, at: 0, busy: null }
  };
  store.open = {};
  /* What Changed and Best Line are owned Cloudflare Workers (nfl-intel)
     behind the NFL gateway — no Vercel function in the path. PBE Picks keeps
     its existing entitlement-aware read path. */
  const GATEWAY = typeof NFL_API_GATEWAY !== 'undefined' ? NFL_API_GATEWAY : 'https://nfl-api.propbetedge.ai';
  const URLS = { changes: `${GATEWAY}/api/changes`, picks: '/api/pbe-picks', bestline: `${GATEWAY}/api/best-line?days=8` };

  async function getJson(url) {
    const r = await fetch(url, { cache: 'no-store', headers: { accept: 'application/json' } });
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch (_) {}
    if (!r.ok) throw new Error(body?.error || `${r.status}`);
    if (!body) throw new Error('non_json_response');
    return body;
  }

  /* One request per source per TTL, shared by every caller; concurrent
     callers await the same promise instead of issuing a second request. */
  function refresh(key, force = false) {
    const s = store[key];
    if (s.busy) return s.busy;
    if (!force && s.at && Date.now() - s.at < TTL[key]) return Promise.resolve(s.data);
    s.busy = getJson(URLS[key])
      .then(d => { s.data = d; s.error = null; return d; })
      .catch(e => { s.error = e instanceof Error ? e.message : String(e); return s.data; })
      .finally(() => { s.at = Date.now(); s.busy = null; paint(); });
    return s.busy;
  }

  /* ---- formatting -------------------------------------------------------- */
  const ET = { timeZone: 'America/New_York' };
  function etTime(v) { const d = new Date(v); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-US', { ...ET, hour: 'numeric', minute: '2-digit' }); }
  function etDay(v) { const d = new Date(v); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { ...ET, weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase(); }
  function ago(v) {
    const t = Date.parse(v || ''); if (!Number.isFinite(t)) return '';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 90) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }
  function stamp(v) { const t = etTime(v); return t ? `${etDay(v).split(',')[0]} ${t} ET` : ''; }
  const american = v => { const n = num(v); return Number.isFinite(n) ? `${n > 0 ? '+' : ''}${Math.round(n)}` : '—'; };
  const signed = v => { const n = num(v); return Number.isFinite(n) ? `${n > 0 ? '+' : ''}${n % 1 ? n.toFixed(1) : n}` : '—'; };
  function logo(team, size = 28) {
    const src = team?.logo;
    const label = team?.abbreviation || 'NFL';
    return src
      ? `<img src="${esc(src)}" width="${size}" height="${size}" alt="" loading="lazy" decoding="async">`
      : `<b class="pbecc-logo-fallback" aria-hidden="true">${esc(label.slice(0, 3))}</b>`;
  }

  /* ---- scoreboard (owned by dashboard-v7) --------------------------------- */
  function v7() { return window.PBEDashboardV7?.state || {}; }
  function games() { return arr(v7().scoreboard?.games); }
  const sem = g => String(g?.status?.semantics || '').toUpperCase();

  /* Lifecycle phase, from facts on the scoreboard only. */
  function phase(list = games()) {
    const now = Date.now();
    if (list.some(g => sem(g) === 'LIVE')) return 'LIVE';
    const next = list.filter(g => sem(g) === 'SCHEDULE').map(g => Date.parse(g.date)).filter(Number.isFinite).sort((a, b) => a - b)[0];
    const lastFinal = list.filter(g => sem(g) === 'FINAL').map(g => Date.parse(g.date)).filter(Number.isFinite).sort((a, b) => b - a)[0];
    /* Post-game is the morning after, not the whole week: a Thursday final
       must not outrank Sunday's kickoffs on Friday. */
    if (lastFinal && now - lastFinal < 12 * 3600000 && (!next || next - now > 12 * 3600000)) return 'POST';
    if (next && next - now < 36 * 3600000) return 'PRE';
    return 'WEEK';
  }
  const PHASE_COPY = {
    LIVE: ['GAME DAY · LIVE', 'Games are in progress. Scores and situation come straight from the live scoreboard.'],
    PRE: ['PRE-KICK', 'Assumptions can still change: injury designations, weather and the market move until kickoff.'],
    POST: ['POST-GAME', 'Results are final. Grades, track record and the game log are where the week gets settled.'],
    WEEK: ['MIDWEEK', 'The next slate is forming. Markets, injury reports and research are building toward kickoff.']
  };

  /* The week as a loop. Each step is a real destination; the active step is
     decided by the phase above, never by a clock guess. */
  const LOOP = [
    ['home', 'Today', ['WEEK']],
    ['changes', 'What changed', ['PRE']],
    ['games', 'Game', []],
    ['bestline', 'Market', ['PRE']],
    ['pbepicks', 'PBE Pick', []],
    ['pbecast', 'Live PBEcast', ['LIVE']],
    ['trackrecord', 'Result', ['POST']],
    ['trackrecord', 'Track record', []],
    ['pbecast', 'Replay', ['POST']],
    ['games', 'Next week', []]
  ];
  function loopHtml() {
    const p = phase();
    const [label, copy] = PHASE_COPY[p];
    return `<nav class="pbecc-loop" aria-label="The NFL week">
      <div class="pbecc-loop-phase"><span class="pbecc-eyebrow">${esc(label)}</span><p>${esc(copy)}</p></div>
      <a class="pbecc-discord" href="${PROPBETEDGE_DISCORD_URL}" target="_blank" rel="noopener">Talk the slate in the PropBetEdge Discord ↗</a>
      <ol>${LOOP.map(([route, name, phases], i) => `<li><button type="button" data-route="${route}" class="${phases.includes(p) ? 'is-now' : ''}"${phases.includes(p) ? ' aria-current="step"' : ''}><i>${String(i + 1).padStart(2, '0')}</i>${esc(name)}</button></li>`).join('')}</ol>
    </nav>`;
  }

  /* ---- market join ------------------------------------------------------- */
  /* ESPN game -> odds snapshot event. Two id spaces: match on both full team
     names AND a kickoff within 12 hours, never on names alone. */
  function marketFor(game) {
    const events = arr(store.bestline.data?.events);
    const a = norm(game?.teams?.away?.display_name), h = norm(game?.teams?.home?.display_name);
    const k = Date.parse(game?.date || '');
    return events.find(e => norm(e.away) === a && norm(e.home) === h && Number.isFinite(k) && Math.abs(Date.parse(e.kickoff) - k) < 12 * 3600000) || null;
  }
  function lineFor(event, game) {
    if (!event) return '';
    const away = game?.teams?.away?.abbreviation || 'AWY', home = game?.teams?.home?.abbreviation || 'HME';
    const sp = event.markets?.spread || {}, tot = event.markets?.total || {};
    const fav = Object.values(sp).filter(Boolean).find(s => num(s?.consensus?.line) < 0);
    const favAbbr = fav ? (norm(fav.side) === norm(event.away) ? away : home) : null;
    const total = tot.OVER?.consensus?.line;
    const parts = [];
    if (fav) parts.push(`${favAbbr} ${signed(fav.consensus.line)}`);
    else if (Object.values(sp).some(s => num(s?.consensus?.line) === 0)) parts.push('PK');
    if (Number.isFinite(num(total))) parts.push(`O/U ${num(total)}`);
    return parts.join(' · ');
  }

  /* ---- slate ------------------------------------------------------------- */
  function situation(g) {
    const s = g?.situation || {};
    const bits = [];
    if (s.down_distance_text) bits.push(esc(s.down_distance_text));
    if (s.possession_text) bits.push(esc(s.possession_text));
    return bits.join(' · ');
  }
  function injuryCount(g) {
    const rows = arr(store.changes.data?.availability?.[String(g.id)]);
    const out = rows.filter(r => r.status === 'OUT' || r.status === 'DOUBTFUL' || r.status === 'SUSPENDED').length;
    const q = rows.filter(r => r.status === 'QUESTIONABLE').length;
    return { out, q, total: rows.length };
  }
  function gameCard(g, groupKey) {
    const s = sem(g), a = g?.teams?.away || {}, h = g?.teams?.home || {};
    const live = s === 'LIVE', fin = s === 'FINAL';
    const status = live ? (g?.status?.short_detail || `Q${g?.status?.period || ''} ${g?.status?.clock || ''}`)
      /* the NEXT group's heading already carries the day, so its cards say
         only the time; later games keep the day */
      : fin ? (g?.status?.short_detail || 'FINAL') : groupKey === 'next' ? `${etTime(g.date)} ET` : `${etDay(g.date)} · ${etTime(g.date)} ET`;
    const rz = live && g?.situation?.red_zone === true;
    const ev = !live && !fin ? marketFor(g) : null;
    const line = lineFor(ev, g);
    const inj = injuryCount(g);
    const score = t => (s === 'SCHEDULE' ? '' : `<strong>${esc(t?.score ?? '—')}</strong>`);
    const win = t => (fin && t?.winner ? ' is-winner' : '');
    return `<article class="pbecc-game is-${s.toLowerCase()}${rz ? ' is-redzone' : ''}" data-game="${esc(g.id)}">
      <header><span class="pbecc-status">${live ? '<i class="pbecc-dot" aria-hidden="true"></i>' : ''}${esc(status)}</span>${rz ? '<b class="pbecc-rz">RED ZONE</b>' : ''}</header>
      <div class="pbecc-teams">
        <div class="pbecc-team${win(a)}">${logo(a)}<span>${esc(a.abbreviation || 'AWY')}</span>${score(a)}</div>
        <div class="pbecc-team${win(h)}">${logo(h)}<span>${esc(h.abbreviation || 'HME')}</span>${score(h)}</div>
      </div>
      <footer>
        ${live && situation(g) ? `<span class="pbecc-sit">${situation(g)}</span>` : ''}
        ${!live && !fin ? `<span class="pbecc-line">${line ? esc(line) : '<em>No line in snapshot</em>'}</span>` : ''}
        ${inj.total && !fin ? `<button type="button" class="pbecc-inj" data-route="changes" data-changes-game="${esc(g.id)}">${inj.out ? `${inj.out} OUT` : ''}${inj.out && inj.q ? ' · ' : ''}${inj.q ? `${inj.q} Q` : ''}</button>` : ''}
        <button type="button" class="pbecc-cast" data-cast="${esc(g.id)}">${live ? 'Live PBEcast' : fin ? 'Replay' : 'Preview'} →</button>
      </footer>
      ${window.PBECard?.gameBadge?.({ away: a.abbreviation, home: h.abbreviation, espnId: g.id }) || ''}
    </article>`;
  }
  function slateHtml() {
    const list = games();
    const src = v7().scoreboard?.source;
    if (!list.length) {
      const err = v7().error;
      return `<section class="pbecc-slate"><div class="pbecc-head"><div><span class="pbecc-eyebrow">THE SLATE</span><h2>What's on</h2></div></div>
        <div class="pbecc-empty">${err ? `<b>Scoreboard unavailable</b><span>${esc(err)}. No games are substituted.</span>` : '<b>Loading the current slate</b><span>Reading the live scoreboard.</span>'}</div></section>`;
    }
    const live = list.filter(g => sem(g) === 'LIVE');
    const sched = list.filter(g => sem(g) === 'SCHEDULE').sort((x, y) => Date.parse(x.date) - Date.parse(y.date));
    const fin = list.filter(g => sem(g) === 'FINAL').sort((x, y) => Date.parse(y.date) - Date.parse(x.date));
    const firstKick = sched.length ? Date.parse(sched[0].date) : null;
    const next = sched.filter(g => Date.parse(g.date) - firstKick < 3 * 3600000);
    const later = sched.filter(g => !next.includes(g));
    const groups = [];
    if (live.length) groups.push(['LIVE NOW', live, 'live']);
    if (next.length) groups.push([live.length ? 'NEXT KICKOFFS' : `NEXT KICKOFF · ${etDay(next[0].date)} ${etTime(next[0].date)} ET`, next, 'next']);
    if (!live.length && fin.length && phase(list) === 'POST') groups.unshift(['FINAL', fin, 'final']);
    else if (fin.length) groups.push(['FINAL', fin, 'final']);
    if (later.length) groups.push(['LATER THIS WEEK', later, 'later']);
    const fetched = src?.fetched_at ? `SCOREBOARD · ${etTime(src.fetched_at)} ET` : 'SCOREBOARD';
    const marketNote = store.bestline.data?.captured_at
      ? `LINES · SNAPSHOT ${esc(store.bestline.data.captured_at_et || stamp(store.bestline.data.captured_at))}${store.bestline.data?.ingest?.status === 'LATEST_INGEST_UNAVAILABLE' ? ' · LATEST INGEST UNAVAILABLE' : ''}`
      : store.bestline.error ? 'LINES · UNAVAILABLE' : '';
    return `<section class="pbecc-slate" aria-label="Current NFL slate">
      <div class="pbecc-head"><div><span class="pbecc-eyebrow">THE SLATE · ${esc(list.length)} GAMES</span><h2>${live.length ? `${live.length} live now` : next.length ? 'Next up' : 'This week'}</h2></div>
        <div class="pbecc-meta"><span>${esc(fetched)}</span>${marketNote ? `<span>${marketNote}</span>` : ''}<button type="button" data-route="games">Full slate →</button></div></div>
      ${groups.map(([label, rows, key]) => {
        /* What is happening now stays open; what is later, or already over
           outside the post-game window, folds so the next kickoff is never
           pushed below the fold by a finished Thursday game. */
        const folded = key === 'later' || (key === 'final' && phase(list) !== 'POST');
        const grid = `<div class="pbecc-grid">${rows.map(g => gameCard(g, key)).join('')}</div>`;
        return folded
          ? `<details class="pbecc-group is-${key}"${store.open?.[key] ? ' open' : ''} data-cc-fold="${key}"><summary><h3>${esc(label)} · ${esc(rows.length)}</h3></summary>${grid}</details>`
          : `<div class="pbecc-group is-${key}"><h3>${esc(label)}</h3>${grid}</div>`;
      }).join('')}
    </section>`;
  }

  /* ---- what changed ------------------------------------------------------ */
  const STATUS_CLASS = { OUT: 'neg', SUSPENDED: 'neg', DOUBTFUL: 'neg', QUESTIONABLE: 'warn', INJURED_RESERVE: 'neg', ACTIVE: 'pos', DELAYED: 'neg', POSTPONED: 'neg', KEY_NUMBER: 'model', MOVED: 'model' };
  function changeRow(c) {
    const status = String(c.status || '').replace(/_/g, ' ');
    const who = c.player?.name || c.game?.matchup || '';
    const sub = c.kind === 'MARKET_MOVE' ? c.headline.split(' — ').slice(1).join(' — ')
      : [c.player?.position, c.team?.abbreviation, c.game?.matchup ? `${c.game.matchup}${c.game.semantics === 'FINAL' ? ' (final)' : ''}` : 'No game on current slate'].filter(Boolean).join(' · ');
    const when = c.observed_basis === 'SOURCE_TIMESTAMP' ? `updated ${ago(c.observed_at)}` : `observed ${ago(c.observed_at)}`;
    const affected = pickAffected(c);
    return `<li class="pbecc-change is-${String(c.severity || 'LOW').toLowerCase()}">
      <span class="pbecc-badge ${STATUS_CLASS[c.status] || ''}">${esc(status)}</span>
      <div><b>${esc(who)}</b><small>${esc(sub)}</small>${affected ? `<em class="pbecc-affected">PBE PICK AFFECTED · ${esc(affected)}</em>` : ''}</div>
      <span class="pbecc-src">${esc(c.source?.label || 'Source')} · ${esc(when)}</span>
    </li>`;
  }
  function changesHtml() {
    const s = store.changes;
    const head = `<div class="pbecc-head"><div><span class="pbecc-eyebrow">WHAT CHANGED</span><h2>Assumptions on the move</h2></div><button type="button" data-route="changes">All changes →</button></div>`;
    if (!s.data && !s.error) return `<section class="pbecc-panel pbecc-changes">${head}<div class="pbecc-empty"><b>Reading sources</b><span>Injury report, scoreboard and market tape.</span></div></section>`;
    if (!s.data) return `<section class="pbecc-panel pbecc-changes">${head}<div class="pbecc-empty is-error"><b>What Changed is unavailable</b><span>${esc(s.error)}. Nothing is shown rather than an empty list that would read as "no changes".</span></div></section>`;
    const actionable = arr(s.data.changes).filter(c => c.actionable !== false && c.severity !== 'LOW' && !(c.kind === 'INJURY_STATUS' && c.status === 'ACTIVE'));
    const src = s.data.sources || {};
    const chip = (label, x) => `<span class="pbecc-srcchip ${x?.available ? 'ok' : 'off'}">${esc(label)} · ${x?.available ? esc(etTime(x.fetched_at) + ' ET') : 'UNAVAILABLE'}</span>`;
    return `<section class="pbecc-panel pbecc-changes">${head}
      <div class="pbecc-srcs">${chip('INJURY REPORT', src.injuries)}${chip('SCOREBOARD', src.scoreboard)}${chip('MARKET TAPE', src.market)}</div>
      ${actionable.length ? `<ol class="pbecc-changelist">${actionable.slice(0, 6).map(changeRow).join('')}</ol>` : `<div class="pbecc-empty"><b>No material changes in the last ${esc(s.data.window_hours)}h</b><span>Every source above answered. Nothing crossed the materiality bar.</span></div>`}
      ${src.market && !src.market.available ? `<p class="pbecc-note">Market movement: unavailable on this deployment (${esc(String(src.market.reason || '').replace(/_/g, ' '))}). Injury and game-status changes are unaffected.</p>` : ''}
      <p class="pbecc-note">Designations show the time the source last updated its note. Status-to-status transitions need the change ledger and are not claimed.</p>
    </section>`;
  }

  /* An official PBE Pick whose game just took a HIGH-severity change: a QB or
     prop-position player ruled out/doubtful, a disrupted game, a spread
     through a key number. Official game picks are team markets, so the join is
     the game (nflverse id <-> ESPN matchup, same team pair), never a name
     guess. Computed only for a Pro session that already holds its picks —
     nothing proprietary is fetched for anyone else. */
  const NFLVERSE = { LAR: 'LA', WSH: 'WAS' };
  function pickGameKey(row) {
    const m = /^\d{4}_\d{2}_([A-Z]{2,3})_([A-Z]{2,3})$/.exec(String(row?.game_id || ''));
    return m ? `${m[1]}|${m[2]}` : null;
  }
  function changeGameKey(c) {
    const m = /^([A-Z]{2,3}) @ ([A-Z]{2,3})$/.exec(String(c?.game?.matchup || ''));
    return m ? `${NFLVERSE[m[1]] || m[1]}|${NFLVERSE[m[2]] || m[2]}` : null;
  }
  function pickAffected(c) {
    if (c.severity !== 'HIGH' || c.actionable === false || window.PBEPro?.state?.pro !== true) return '';
    const key = changeGameKey(c); if (!key) return '';
    /* The PBE Card store holds decisions only for a verified Pro session. */
    const rows = arr(window.PBECard?.cards?.());
    const hit = rows.find(r => pickGameKey(r) === key && r.lifecycle !== 'FINAL');
    return hit ? `${String(hit.market || 'OPEN').toUpperCase()} · ${hit.selection?.display || ''}`.trim() : '';
  }

  /* ---- picks + track record --------------------------------------------- */
  function picksHtml() {
    const s = store.picks, d = s.data;
    const head = `<div class="pbecc-head"><div><span class="pbecc-eyebrow">PBE PICKS · TRACK RECORD</span><h2>The engine, as it stands</h2></div></div>`;
    if (!d) return `<section class="pbecc-panel pbecc-picks">${head}<div class="pbecc-empty ${s.error ? 'is-error' : ''}"><b>${s.error ? 'ENGINE STATE UNAVAILABLE' : 'Reading engine state'}</b><span>${s.error ? `${esc(s.error)}. A failed read is never shown as "no picks".` : 'Publication gate, sample and verified record.'}</span></div></section>`;
    const official = d.decisions?.official || {};
    const gated = String(d.publication || '').toUpperCase() === 'GATED';
    const bar = (have, need) => { const pct = Math.max(0, Math.min(100, (num(have) / num(need)) * 100 || 0)); return `<span class="pbecc-bar"><i style="width:${pct.toFixed(1)}%"></i></span>`; };
    return `<section class="pbecc-panel pbecc-picks">${head}
      <div class="pbecc-engine ${gated ? 'is-gated' : 'is-live'}"><b>${esc(d.engine_state || (gated ? 'ENGINE GATED' : 'ENGINE LIVE'))}</b><span>${esc(d.engine_health ? `Runtime ${d.engine_health}` : '')}${d.champion_version != null ? ` · Champion v${esc(d.champion_version)}` : ''}</span></div>
      <dl class="pbecc-kpis">
        <div><dt>Official picks this season</dt><dd>${esc(official.total ?? 0)}</dd></div>
        <div><dt>Open</dt><dd>${esc(official.open ?? 0)}</dd></div>
        <div><dt>Official graded</dt><dd>${esc(official.graded ?? 0)}</dd></div>
      </dl>
      <div class="pbecc-gate">
        <div><span>Graded validation sample</span><b>${esc(d.graded_sample ?? 0)} / ${esc(d.graded_sample_required ?? 100)}</b>${bar(d.graded_sample, d.graded_sample_required || 100)}</div>
        <div><span>Weeks observed</span><b>${esc(d.distinct_weeks ?? 0)} / ${esc(d.distinct_weeks_required ?? 4)}</b>${bar(d.distinct_weeks, d.distinct_weeks_required || 4)}</div>
      </div>
      <p class="pbecc-note">${gated
        ? 'Official publication stays gated until the validation sample and observation window are both met. Until then the engine’s real pre-game decisions reach NFL Pro as PBE Validation Signals on Today’s PBE Card; none is called official and none enters the Official Track Record.'
        : 'Only the production champion publishes. Every official pick is locked at issuance and graded from final results.'}</p>
      <div class="pbecc-actions"><button type="button" data-route="pbepicks">PBE Picks →</button><button type="button" data-route="trackrecord">Verified track record →</button></div>
    </section>`;
  }

  /* ---- best line teaser --------------------------------------------------- */
  /* Where the best available number beats the consensus number — the value of
     shopping, with no model involved. Spread/total: a better number. Moneyline:
     a better price at the same bet. */
  function shoppingEdges() {
    const out = [];
    for (const e of arr(store.bestline.data?.events)) {
      if (e.started) continue;
      for (const market of ['spread', 'total', 'moneyline']) {
        for (const s of Object.values(e.markets?.[market] || {})) {
          if (!s?.best || !s.consensus) continue;
          let gain = 0, label = '';
          if (market === 'moneyline') {
            const b = num(s.best.price), c = num(s.consensus.price);
            const pay = x => (x > 0 ? x / 100 : 100 / -x);
            if (!Number.isFinite(b) || !Number.isFinite(c) || b === c) continue;
            gain = (pay(b) - pay(c)) / pay(c) * 10; label = `${american(b)} vs ${american(c)} consensus`;
          } else {
            const b = num(s.best.line), c = num(s.consensus.line);
            if (!Number.isFinite(b) || !Number.isFinite(c)) continue;
            gain = market === 'total' && s.side === 'OVER' ? c - b : market === 'total' ? b - c : b - c;
            if (gain <= 0) continue;
            const pk = x => (x === 0 ? 'PK' : signed(x));
            label = `${market === 'total' ? `${s.side === 'OVER' ? 'O' : 'U'} ${b}` : pk(b)} (${american(s.best.price)}) vs ${market === 'total' ? c : pk(c)} consensus`;
          }
          if (gain > 0) out.push({ e, market, s, gain, label });
        }
      }
    }
    return out.sort((a, b) => b.gain - a.gain).slice(0, 4);
  }
  function teamShort(name) {
    const g = games().find(x => norm(x?.teams?.away?.display_name) === norm(name) || norm(x?.teams?.home?.display_name) === norm(name));
    const t = g ? (norm(g.teams.away.display_name) === norm(name) ? g.teams.away : g.teams.home) : null;
    return t?.abbreviation || String(name || '').split(' ').pop();
  }
  function bestLineHtml() {
    const s = store.bestline;
    const head = `<div class="pbecc-head"><div><span class="pbecc-eyebrow">BEST LINE</span><h2>Shop the number</h2></div><button type="button" data-route="bestline">Best Line →</button></div>`;
    if (!s.data) return `<section class="pbecc-panel pbecc-bestline">${head}<div class="pbecc-empty ${s.error ? 'is-error' : ''}"><b>${s.error ? 'Market snapshot unavailable' : 'Reading the market snapshot'}</b><span>${s.error ? esc(s.error) : 'Every book in the latest scheduled capture.'}</span></div></section>`;
    const rows = shoppingEdges();
    return `<section class="pbecc-panel pbecc-bestline">${head}
      <p class="pbecc-fresh">SNAPSHOT ${esc(s.data.captured_at_et || stamp(s.data.captured_at))} · ${esc(ago(s.data.captured_at))}${s.data.ingest?.status === 'LATEST_INGEST_UNAVAILABLE' ? ' · <b>LATEST INGEST UNAVAILABLE</b>' : ''} · NOT LIVE</p>
      ${rows.length ? `<ol class="pbecc-shop">${rows.map(r => `<li><div><b>${esc(r.market === 'total' ? 'Total' : `${teamShort(r.s.side)} ${r.market === 'spread' ? 'spread' : 'moneyline'}`)} <i>${esc(`${teamShort(r.e.away)} @ ${teamShort(r.e.home)} · ${etDay(r.e.kickoff).split(',')[0]}`)}</i></b><small>${esc(r.label)}</small></div><span>${esc(r.s.best.book)}</span></li>`).join('')}</ol>`
        : '<div class="pbecc-empty"><b>Every book agrees</b><span>No best price beats the consensus number in this snapshot.</span></div>'}
      <p class="pbecc-note">Best available price versus market consensus. Neither is a PropBetEdge model opinion.</p>
    </section>`;
  }

  /* ---- mount / paint ------------------------------------------------------ */
  function slot(name) { return document.querySelector(`.pbehome7 [data-cc-slot="${name}"]`); }
  function write(host, html) { if (host && host.dataset.sig !== html) { host.innerHTML = html; host.dataset.sig = html; } }
  function paint() {
    const top = slot('top'), intel = slot('intel');
    if (!top && !intel) return;
    write(top, `<div class="pbecc">${slateHtml()}${window.PBECard?.dashboardHtml?.() || ''}</div>`);
    write(intel, `<div class="pbecc pbecc-intel">${loopHtml()}<div class="pbecc-cols">${changesHtml()}<div class="pbecc-stack">${picksHtml()}${bestLineHtml()}</div></div></div>`);
  }

  /* Called by dashboard-v7 after it paints. Paints from what is already held
     and refreshes only what has gone stale. */
  function mount() {
    paint();
    tick();
  }
  function tick() {
    if (!slot('top') && !slot('intel')) return;
    if (document.visibilityState === 'hidden') return;
    ['changes', 'picks', 'bestline'].forEach(k => refresh(k));
  }

  /* Routing from inside the slots. PBEcast focus uses the one-shot session
     handoff PBEcast v6 consumes on mount, so the chosen game opens — not
     whatever PBEcast would otherwise pick. */
  document.addEventListener('click', event => {
    const root = event.target.closest?.('.pbecc');
    if (!root) return;
    const cast = event.target.closest('[data-cast]');
    if (cast) {
      event.preventDefault();
      try { sessionStorage.setItem('pbe.pbecast.focus', JSON.stringify({ game_id: cast.dataset.cast })); } catch (_) {}
      window.App?.nav?.('pbecast');
      return;
    }
    const route = event.target.closest('[data-route]');
    if (route) {
      event.preventDefault();
      if (route.dataset.changesGame) { try { sessionStorage.setItem('pbe.changes.game', route.dataset.changesGame); } catch (_) {} }
      window.App?.nav?.(route.dataset.route);
    }
  });
  window.addEventListener('pbe:pro-state', () => paint());
  /* Today's PBE Card and the game badges repaint when the card lands. */
  window.addEventListener('pbe:card-ready', () => paint());
  /* Remember a fold the reader opened, so the next repaint keeps it open. */
  document.addEventListener('toggle', e => {
    const d = e.target; if (!d?.matches?.('.pbecc [data-cc-fold]')) return;
    store.open[d.dataset.ccFold] = d.open;
  }, true);

  /* The same loop, compact, on every surface that is a step in it — so a
     reader on PBE Picks can see that Track Record is where it settles and
     Replay is where it is reviewed. It lives outside #view-container, so no
     route render can wipe it, and it is hidden everywhere else. */
  const STRIP_ROUTES = new Set(['changes', 'games', 'bestline', 'pbepicks', 'pbecast', 'trackrecord']);
  function routeStrip(route) {
    const vc = document.getElementById('view-container'); if (!vc?.parentElement) return;
    let strip = document.getElementById('pbe-loop-strip');
    if (!STRIP_ROUTES.has(route)) { if (strip) strip.hidden = true; return; }
    if (!strip) {
      strip = document.createElement('nav');
      strip.id = 'pbe-loop-strip'; strip.className = 'pbecc pbecc-strip'; strip.setAttribute('aria-label', 'The NFL week');
      vc.parentElement.insertBefore(strip, vc);
    }
    const seen = new Set();
    const steps = LOOP.filter(([r, name]) => { const k = `${r}|${name}`; if (seen.has(k)) return false; seen.add(k); return true; });
    const html = `<ol>${steps.map(([r, name], i) => {
      const here = r === route && !(r === 'pbecast' && name === 'Replay') && !(r === 'trackrecord' && name === 'Result') && !(r === 'games' && name === 'Next week');
      return `<li><button type="button" data-route="${r}" class="${here ? 'is-here' : ''}"${here ? ' aria-current="page"' : ''}><i>${String(i + 1).padStart(2, '0')}</i>${esc(name)}</button></li>`;
    }).join('')}</ol>`;
    if (strip.dataset.sig !== html) { strip.innerHTML = html; strip.dataset.sig = html; }
    strip.hidden = false;
  }
  window.addEventListener('pbe:route-changed', e => routeStrip(e?.detail?.route || window.App?.current));

  window.PBECommandCenter = { mount, tick, paint, refresh, store, phase, marketFor, pickAffected };
})();
