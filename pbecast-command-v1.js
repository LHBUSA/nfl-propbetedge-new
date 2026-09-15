/* PropBetEdge NFL — PBEcast command layer (additive to PBEcast v6)
 *
 * v6 stays the single route authority and the only transport. This layer
 * adds three things on top of state v6 already holds, and runs no request
 * and no timer of its own:
 *
 *   SUNDAY BOARD     every game on v6's scoreboard lane at once — score,
 *                    clock, possession, down & distance, red zone — so a
 *                    multi-game Sunday is one screen, and a tap focuses a game
 *   AROUND THE LEAGUE  what changed between two consecutive scoreboard frames
 *                    (a score, a red-zone entry, a kickoff, a final), stamped
 *                    with the time PBEcast OBSERVED it, never a play time it
 *                    does not have
 *   KEY MOMENTS      scoring plays, turnovers, explosive plays and the drive
 *                    chart for the focused game, from v6's play log. For a
 *                    FINAL game this is PBE Replay v0: the live-source game log,
 *                    navigable by drive. Post-game enrichment (participants,
 *                    EPA, air yards) is labelled pending, not faked.
 *   PREGAME PREVIEW  for a scheduled game: pbecast-preview-v1.js (market,
 *                    PBE decision, availability, what changed) directly under
 *                    the hero; the full PBE decision follows it and the Sunday
 *                    board moves below the game
 *   GAME PULSE       mounted from pbecast-pulse-v1.js between the selected-game
 *                    surface and Key Moments; a tapped swing opens its play here
 *
 * WHAT IS NOT HERE, ON PURPOSE. No routes, no player dots, no ball flight.
 * Public NFL live data carries no player or ball coordinates; field position
 * is the published yard line and nothing is drawn between two published
 * states. See NFL_DATA_GAP_VS_MLB.md.
 *
 * Updates are event-driven: a MutationObserver on v6's own rail and workspace
 * nodes, which v6 only rewrites when their content changed.
 */
(() => {
  'use strict';

  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const arr = v => (Array.isArray(v) ? v : []);
  const num = v => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
  const v6 = () => window.PBEcastV6?.state || {};
  const sem = g => String(g?.status?.semantics || '').toUpperCase();
  const ET = { timeZone: 'America/New_York' };
  const etTime = v => { const d = new Date(v); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-US', { ...ET, hour: 'numeric', minute: '2-digit' }); };
  const etDay = v => { const d = new Date(v); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { ...ET, weekday: 'short', month: 'short', day: 'numeric' }); };
  const clock = t => new Date(t).toLocaleTimeString('en-US', { ...ET, hour: 'numeric', minute: '2-digit', second: '2-digit' });

  const local = { frame: null, feed: [], moment: 'scoring', openDrive: null, focusPlay: null, seeded: false, boardOpen: null, enrich: new Map() };

  /* ---- post-game enrichment (nflverse, next day) ---------------------------
     Fetched once per FINAL game, never polled. Keyed by ESPN play id, so it
     attaches to the plays v6 already holds without any matching. */
  function loadEnrich() {
    const d = v6().detail, g = d?.game;
    if (!g || sem(g) !== 'FINAL') return;
    const id = String(g.id);
    if (local.enrich.has(id)) return;
    const board = games().find(x => String(x.id) === id) || {};
    const season = board?.season?.year || g?.season?.year;
    const type = Number(board?.season?.type || g?.season?.type) === 3 ? 'POST' : 'REG';
    const week = board?.week;
    const away = (board.teams || g.teams)?.away?.abbreviation, home = (board.teams || g.teams)?.home?.abbreviation;
    /* The scoreboard lane (which carries the week) may land after the detail
       lane. Nothing is cached until the identity is complete, so the next
       render retries instead of remembering a race as a fact. */
    if (!season || !week || !away || !home) return;
    local.enrich.set(id, { state: 'loading' });
    const qs = new URLSearchParams({ event: id, season, week, type, away, home });
    /* nfl-replay Worker: one small R2 object per game, ingested once per
       nflverse update. The browser never downloads a season file. */
    const gateway = typeof NFL_API_GATEWAY !== 'undefined' ? NFL_API_GATEWAY : 'https://nfl-api.propbetedge.ai';
    fetch(`${gateway}/api/replay/enrich?${qs}`, { headers: { accept: 'application/json' } })
      .then(r => r.json().then(body => ({ ok: r.ok, body })))
      .then(({ body }) => local.enrich.set(id, body?.available ? { state: 'ok', data: body } : { state: 'unavailable', reason: body?.reason || body?.error || 'unavailable', data: body }))
      .catch(e => local.enrich.set(id, { state: 'error', reason: String(e?.message || e) }))
      .finally(() => render());
  }
  const enrichFor = () => local.enrich.get(String(v6().activeId || ''));
  const sign = (n, d = 2) => `${n > 0 ? '+' : ''}${Number(n).toFixed(d)}`;
  function enrichChips(p) {
    const e = enrichFor()?.data?.plays?.[String(p?.id)];
    if (!e) return '';
    const who = [e.passer_player_name, e.receiver_player_name].filter(Boolean).join(' → ') || e.rusher_player_name || '';
    const chips = [
      who ? `<b>${esc(who)}</b>` : '',
      e.epa != null ? `<span>EPA ${esc(sign(e.epa))}</span>` : '',
      e.wpa != null ? `<span>WPA ${esc(sign(e.wpa * 100, 1))}%</span>` : '',
      e.air_yards != null ? `<span>AIR ${esc(e.air_yards)}</span>` : '',
      e.yards_after_catch != null ? `<span>YAC ${esc(e.yards_after_catch)}</span>` : '',
      e.cpoe != null ? `<span>CPOE ${esc(sign(e.cpoe, 1))}</span>` : ''
    ].filter(Boolean).join('');
    return chips ? `<div class="pbekm-enr" title="Post-game enrichment · nflverse">${chips}</div>` : '';
  }
  const FEED_MAX = 24;

  /* ---- Sunday board -------------------------------------------------------- */
  /* situation.possession_text is the spot of the ball; v6 verifies it */
  const spotOf = g => window.PBEcastV6?.fieldPositionText?.(g) || '';
  function games() { return arr(v6().scoreboard?.games); }
  function tile(g) {
    const s = sem(g), a = g?.teams?.away || {}, h = g?.teams?.home || {}, sit = g?.situation || {};
    const active = String(g.id) === String(v6().activeId);
    const live = s === 'LIVE', fin = s === 'FINAL';
    const poss = live && sit.possession_id ? (String(sit.possession_id) === String(a.id) ? a.abbreviation : String(sit.possession_id) === String(h.id) ? h.abbreviation : null) : null;
    const status = live ? (g?.status?.short_detail || `Q${g?.status?.period || ''} ${g?.status?.clock || ''}`) : fin ? (g?.status?.short_detail || 'Final') : `${etDay(g.date)} · ${etTime(g.date)} ET`;
    const team = (t, side) => `<div class="pbecb-t${fin && t.winner ? ' is-win' : ''}${poss && poss === t.abbreviation ? ' has-ball' : ''}"><span>${poss && poss === t.abbreviation ? '<i class="pbecb-ball" aria-label="possession"></i>' : ''}${esc(t.abbreviation || side)}</span><b>${s === 'SCHEDULE' ? '' : esc(t.score ?? '—')}</b></div>`;
    return `<button type="button" class="pbecb-tile is-${s.toLowerCase()}${active ? ' is-active' : ''}${live && sit.red_zone === true ? ' is-rz' : ''}" data-game="${esc(g.id)}" aria-pressed="${active}">
      <span class="pbecb-st">${live ? '<i class="pbecb-dot" aria-hidden="true"></i>' : ''}${esc(status)}${!live && !fin ? (window.PBEBroadcast?.slot?.({ event: g.id, mode: 'text', lead: ' · ' }) || '') : ''}${live && sit.red_zone === true ? '<em>RED ZONE</em>' : ''}</span>
      ${team(a, 'AWY')}${team(h, 'HME')}
      ${live && (sit.down_distance_text || spotOf(g)) ? `<span class="pbecb-sit">${esc([sit.down_distance_text, spotOf(g)].filter(Boolean).join(' at '))}</span>` : ''}
    </button>`;
  }
  function boardHtml() {
    const list = games();
    if (!list.length) return '';
    const order = { LIVE: 0, SCHEDULE: 1, FINAL: 2 };
    const sorted = [...list].sort((x, y) => (order[sem(x)] ?? 3) - (order[sem(y)] ?? 3) || Date.parse(x.date) - Date.parse(y.date));
    const live = list.filter(g => sem(g) === 'LIVE').length;
    const rz = list.filter(g => sem(g) === 'LIVE' && g?.situation?.red_zone === true).length;
    const open = local.boardOpen ?? (live >= 1);
    const fetched = v6().scoreboard?.source?.fetched_at;
    return `<section class="pbecb" aria-label="Sunday board">
      <header><div><span class="pbecb-eye">SUNDAY BOARD · ${esc(list.length)} GAMES</span><h2>${live ? `${live} live${rz ? ` · ${rz} in the red zone` : ''}` : 'No games live'}</h2></div>
        <div class="pbecb-meta">${fetched ? `<span>SCOREBOARD ${esc(clock(fetched))} ET</span>` : ''}<button type="button" data-cb-toggle aria-expanded="${open}">${open ? 'Collapse' : 'Show all games'}</button></div></header>
      ${open ? `<div class="pbecb-grid">${sorted.map(tile).join('')}</div>` : ''}
      ${feedHtml()}
      <p class="pbecb-truth">Scores, clock, possession and down & distance are the published scoreboard. PBEcast draws no player or ball positions: public NFL live data carries none.</p>
    </section>`;
  }

  /* ---- around the league: diff of two scoreboard frames --------------------- */
  function snapshot(list) {
    const m = new Map();
    for (const g of list) m.set(String(g.id), { s: sem(g), a: num(g?.teams?.away?.score), h: num(g?.teams?.home?.score), rz: g?.situation?.red_zone === true, g });
    return m;
  }
  function diff(prev, next, at) {
    const out = [];
    for (const [id, n] of next) {
      const p = prev.get(id); if (!p) continue;
      const g = n.g, a = g?.teams?.away?.abbreviation || 'AWY', h = g?.teams?.home?.abbreviation || 'HME';
      const score = `${a} ${n.a ?? '—'}–${n.h ?? '—'} ${h}`;
      if (p.s === 'SCHEDULE' && n.s === 'LIVE') out.push({ id, at, kind: 'KICKOFF', text: `${a} @ ${h} is under way`, score });
      if (n.s === 'LIVE' || (p.s === 'LIVE' && n.s === 'FINAL')) {
        const da = (n.a ?? 0) - (p.a ?? 0), dh = (n.h ?? 0) - (p.h ?? 0);
        if (da > 0 || dh > 0) {
          /* The scoreboard gives points, not the play that scored them, so
             the feed reports the points and does not name the play. */
          if (da > 0) out.push({ id, at, kind: 'SCORE', text: `${a} +${da}`, score });
          if (dh > 0) out.push({ id, at, kind: 'SCORE', text: `${h} +${dh}`, score });
        }
        if (!p.rz && n.rz && n.s === 'LIVE') out.push({ id, at, kind: 'RED ZONE', text: `${window.PBEcastV6?.possessionTeam?.(g) || 'Offense'} inside the 20`, score });
      }
      if (p.s === 'LIVE' && n.s === 'FINAL') out.push({ id, at, kind: 'FINAL', text: `${a} @ ${h} is final`, score });
    }
    return out;
  }
  function observeFrame() {
    const list = games(); if (!list.length) return false;
    const next = snapshot(list);
    const at = Date.now();
    let changed = false;
    if (local.frame) {
      const events = diff(local.frame, next, at);
      if (events.length) { local.feed = [...events.reverse(), ...local.feed].slice(0, FEED_MAX); changed = true; }
    }
    local.frame = next;
    return changed;
  }
  function feedHtml() {
    if (!local.feed.length) return `<div class="pbecb-feed is-empty"><span class="pbecb-eye">AROUND THE LEAGUE</span><p>Scores, red-zone entries, kickoffs and finals across every game appear here as the scoreboard reports them during this session.</p></div>`;
    return `<div class="pbecb-feed"><span class="pbecb-eye">AROUND THE LEAGUE · OBSERVED THIS SESSION</span><ol>${local.feed.map(e => `<li class="k-${esc(e.kind.toLowerCase().replace(/[^a-z]+/g, '-'))}"><time>${esc(clock(e.at))}</time><b>${esc(e.kind)}</b><span>${esc(e.text)}</span><em>${esc(e.score)}</em><button type="button" data-game="${esc(e.id)}">Open →</button></li>`).join('')}</ol></div>`;
  }

  /* ---- key moments / replay v0 -------------------------------------------- */
  const TURNOVER = /intercept|fumble|turnover on downs|downs\b/i;
  function yardsOf(p) {
    const m = /for (-?\d+) (?:yds|yards?)/i.exec(String(p?.text || ''));
    return m ? Number(m[1]) : null;
  }
  function isExplosive(p) {
    const y = yardsOf(p);
    if (y === null) return false;
    const t = `${p?.type || ''}`;
    return y >= 20 && /pass|rush|reception|run/i.test(`${t} ${p?.text || ''}`) && !/penalty|punt|kickoff|field goal/i.test(t);
  }
  function moments(d) {
    const plays = arr(d?.plays);
    return {
      scoring: plays.filter(p => p?.scoring_play),
      turnovers: plays.filter(p => TURNOVER.test(`${p?.type || ''} ${p?.text || ''}`) && !/no play|penalty/i.test(String(p?.type || ''))),
      explosive: plays.filter(isExplosive)
    };
  }
  function playLine(p) {
    const meta = [p?.period ? `Q${p.period}` : null, p?.clock, p?.start?.down_distance_text].filter(Boolean).join(' · ');
    const score = p?.away_score != null && p?.home_score != null ? `${p.away_score}–${p.home_score}` : '';
    const id = String(p?.id ?? '');
    return `<li data-km-play="${esc(id)}"${id && id === local.focusPlay ? ' class="is-focus" tabindex="-1"' : ''}><span class="pbekm-meta">${esc(meta)}</span><p><b>${esc(p?.type || 'Play')}</b> ${esc(p?.text || '')}</p>${score ? `<em>${esc(score)}</em>` : ''}${enrichChips(p)}</li>`;
  }
  function driveChart(d) {
    const drives = arr(d?.drives);
    if (!drives.length) return '<p class="pbekm-none">No drives published for this game yet.</p>';
    return `<ol class="pbekm-drives">${drives.map((dr, i) => {
      const res = String(dr?.result || '').trim();
      const cls = /touchdown/i.test(res) ? 'td' : /field goal/i.test(res) && !/missed|blocked/i.test(res) ? 'fg' : /intercept|fumble|downs/i.test(res) ? 'to' : /punt/i.test(res) ? 'punt' : 'other';
      const open = local.openDrive === i;
      const plays = arr(dr?.plays);
      return `<li class="is-${cls}${dr?.is_current ? ' is-current' : ''}">
        <button type="button" data-km-drive="${i}" aria-expanded="${open}">
          ${dr?.team?.logo ? `<img src="${esc(dr.team.logo)}" width="22" height="22" alt="" loading="lazy" decoding="async">` : ''}
          <b>${esc(dr?.team?.abbreviation || '—')}</b>
          <span class="pbekm-res">${esc(res || (dr?.is_current ? 'In progress' : '—'))}</span>
          <span class="pbekm-dsc">${esc(dr?.description || '')}</span>
          <span class="pbekm-yl">${esc([dr?.start?.text, dr?.end?.text].filter(Boolean).join(' → '))}</span>
          <span class="pbekm-q">${esc(dr?.start?.period ? `Q${dr.start.period} ${dr.start.clock || ''}` : '')}</span>
        </button>
        ${open ? (plays.length ? `<ol class="pbekm-plays">${plays.map(playLine).join('')}</ol>` : '<p class="pbekm-none">The source lists no plays for this drive.</p>') : ''}
      </li>`;
    }).join('')}</ol>`;
  }
  function keyMomentsHtml() {
    const d = v6().detail; const g = d?.game;
    if (!g || sem(g) === 'SCHEDULE') return '';
    const final = sem(g) === 'FINAL';
    const m = moments(d);
    if (final) loadEnrich();
    const en = final ? enrichFor() : null;
    const ePlays = en?.state === 'ok' ? en.data.plays : null;
    /* Biggest swings exist only when win-probability deltas were published
       post-game; the live feed never had them. */
    const swings = ePlays ? arr(d?.plays).filter(p => Number.isFinite(ePlays[String(p.id)]?.wpa))
      .sort((a, b) => Math.abs(ePlays[String(b.id)].wpa) - Math.abs(ePlays[String(a.id)].wpa)).slice(0, 8) : [];
    const tabs = [['scoring', 'Scoring', m.scoring], ['turnovers', 'Turnovers', m.turnovers], ['explosive', 'Explosive 20+', m.explosive], ...(swings.length ? [['swings', 'Biggest swings', swings]] : []), ['drives', 'Drive chart', arr(d?.drives)]];
    const cur = tabs.find(t => t[0] === local.moment) || tabs[0];
    const body = cur[0] === 'drives' ? driveChart(d)
      : cur[0] === 'swings' ? `<ol class="pbekm-list">${cur[2].map(playLine).join('')}</ol>`
      : cur[2].length ? `<ol class="pbekm-list">${[...cur[2]].reverse().map(playLine).join('')}</ol>`
      : `<p class="pbekm-none">No ${esc(cur[1].toLowerCase())} plays in the published log${final ? '' : ' yet'}.</p>`;
    return `<section class="pbekm${final ? ' is-replay' : ''}" aria-label="${final ? 'PBE Replay' : 'Key moments'}">
      <header><div><span class="pbecb-eye">${final ? 'PBE REPLAY · FINAL · LIVE-SOURCE GAME LOG' : 'KEY MOMENTS · LIVE'}</span><h2>${final ? 'How this game was decided' : 'Jump to what mattered'}</h2></div>
        <div class="pbekm-tabs" role="tablist">${tabs.map(([k, l, rows]) => `<button type="button" role="tab" aria-selected="${cur[0] === k}" class="${cur[0] === k ? 'is-on' : ''}" data-km-tab="${k}">${esc(l)} <i>${esc(rows.length)}</i></button>`).join('')}</div></header>
      ${body}
      <footer class="pbekm-foot"><span class="pbekm-src">LIVE SOURCE · ESPN published play-by-play · ${esc(arr(d?.plays).length)} plays · ${esc(arr(d?.drives).length)} drives</span>${final ? enrichNote(en, d) : '<span class="pbekm-src">Explosive = 20+ yards stated in the play text.</span>'}</footer>
    </section>`;
  }

  function enrichNote(en, d) {
    if (!en || en.state === 'loading') return '<span class="pbekm-pending">POST-GAME ENRICHMENT · checking nflverse…</span>';
    if (en.state === 'ok') {
      const ids = arr(d?.plays).map(p => String(p.id));
      const joined = ids.filter(id => en.data.plays[id]).length;
      const when = en.data.source?.last_modified ? new Date(en.data.source.last_modified).toLocaleString('en-US', { ...ET, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET' : '';
      return `<span class="pbekm-enriched">POST-GAME ENRICHED · nflverse play-by-play (CC-BY-4.0)${when ? ` · published ${esc(when)}` : ''} · ${esc(joined)} of ${esc(ids.length)} ESPN plays joined by play id. EPA, WPA (for the team with the ball), air yards, YAC and CPOE are post-game values, not live.</span>`;
    }
    const why = en.reason === 'NOT_YET_PUBLISHED' ? 'nflverse has not published this game yet — it usually lands the next day'
      : en.reason === 'POST_GAME_ENRICHMENT_UNAVAILABLE' ? 'unavailable — the season has not been ingested and the source file exceeds the safe transitional bound'
      : `unavailable (${en.reason || 'unknown'})`;
    return `<span class="pbekm-pending">POST-GAME ENRICHMENT · ${esc(why)}. Nothing is shown until it is published.</span>`;
  }

  /* ---- mount ---------------------------------------------------------------- */
  function hostFor(root, name, afterSel) {
    let el = root.querySelector(`[data-pbecc-cast="${name}"]`);
    if (!el) {
      el = document.createElement('div');
      el.dataset.pbeccCast = name;
      const anchor = root.querySelector(afterSel);
      if (anchor) anchor.after(el); else root.appendChild(el);
    }
    return el;
  }
  function write(el, html) { if (el.dataset.sig !== html) { el.innerHTML = html; el.dataset.sig = html; } }
  function render() {
    const root = document.querySelector('.pbecast6'); if (!root) return;
    const activeId = String(v6().activeId || '');
    if (local.lastActive !== activeId) { local.openDrive = null; local.focusPlay = null; local.lastActive = activeId; }
    root.classList.add('has-board');
    const g = v6().detail?.game;
    /* The lifecycle is the selected game's own semantics: before kickoff the
       page is a pregame preview, so the game leads and the league board follows
       it; live and final keep the board above the game. */
    const pre = Boolean(g) && String(g.id) === activeId && sem(g) === 'SCHEDULE';
    const hero = root.querySelector('[data-cast6-hero]');
    const place = (el, after) => { if (after && el.previousElementSibling !== after) after.after(el); };
    const board = hostFor(root, 'board', '[data-cast6-rail]');
    place(board, pre ? root.querySelector('[data-cast6-workspace]') : root.querySelector('[data-cast6-rail]'));
    write(board, boardHtml());
    /* PREGAME: hero -> preview -> the full PBE decision. LIVE/FINAL: hero ->
       PBE decision (the locked call and its live progress read together). */
    const preview = hostFor(root, 'preview', '[data-cast6-hero]');
    place(preview, hero);
    write(preview, pre ? (window.PBEcastPreview?.html?.(window.PBEcastPreview.fromPage(v6())) || '') : '');
    const pick = hostFor(root, 'pick', '[data-cast6-hero]');
    place(pick, pre ? preview : hero);
    write(pick, g ? (window.PBECard?.gameModule?.({ away: g.teams?.away?.abbreviation, home: g.teams?.home?.abbreviation, espnId: g.id, surface: 'pbecast' }) || '') : '');
    /* what is happening -> how much did it matter -> show me the play:
       selected game, then Game Pulse, then Key Moments / PBE Replay. */
    const moments = hostFor(root, 'moments', '[data-cast6-action]');
    const pulse = hostFor(root, 'pulse', '[data-cast6-action]');
    place(pulse, pre ? pick : root.querySelector('[data-cast6-action]'));
    place(moments, pulse);
    window.PBEcastPulse?.mount?.(pulse, v6());
    write(moments, keyMomentsHtml());
  }

  /* A Game Pulse swing names a published play id. Open it where Key Moments
     already lists it (scoring, turnover, explosive), otherwise open the drive
     that contains it in the drive chart, then bring that play into view. */
  function focusPlay(id) {
    const d = v6().detail; if (!d || !id) return;
    const m = moments(d);
    const has = rows => rows.some(p => String(p?.id) === String(id));
    let tab = has(m.scoring) ? 'scoring' : has(m.turnovers) ? 'turnovers' : has(m.explosive) ? 'explosive' : 'drives';
    if (tab === 'drives') {
      const i = arr(d.drives).findIndex(dr => has(arr(dr?.plays)));
      if (i < 0) return;
      local.openDrive = i;
    }
    local.moment = tab; local.focusPlay = String(id);
    render();
    const el = document.querySelector(`.pbekm [data-km-play="${CSS.escape(String(id))}"]`);
    if (!el) return;
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    el.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' });
    el.focus?.({ preventScroll: true });
  }

  let watched = null;
  const nodeObserver = new MutationObserver(() => { observeFrame(); render(); });
  function watch() {
    const root = document.querySelector('.pbecast6');
    if (!root) { watched = null; nodeObserver.disconnect(); return; }
    if (watched === root) return;
    watched = root;
    nodeObserver.disconnect();
    /* v6 only rewrites these nodes when their content changed, so this is an
       event per real update, not a poll. childList only: our own writes live
       in sibling nodes and cannot retrigger it. */
    /* telemetry is rewritten when the detail lane's win-probability count
       changes, which is what Game Pulse needs to hear about */
    ['[data-cast6-rail]', '[data-cast6-hero]', '[data-cast6-telemetry]', '[data-cast6-workspace]'].forEach(sel => { const n = root.querySelector(sel); if (n) nodeObserver.observe(n, { childList: true }); });
    if (!local.seeded) { observeFrame(); local.seeded = true; }
    render();
    /* The pregame preview reads the command center's sources (market
       snapshot, injury report + changes, engine state). Shared, TTL-guarded
       reads — no new cadence. */
    ['changes', 'bestline', 'picks'].forEach(k => window.PBECommandCenter?.refresh?.(k)?.then?.(render));
  }
  const vcObserver = new MutationObserver(watch);
  function install() {
    const vc = document.getElementById('view-container'); if (!vc) return false;
    vcObserver.observe(vc, { childList: true });
    watch();
    return true;
  }

  document.addEventListener('click', e => {
    if (!e.target.closest?.('.pbecast6')) return;
    if (e.target.closest('[data-cb-toggle]')) { const live = games().some(g => sem(g) === 'LIVE'); local.boardOpen = !(local.boardOpen ?? live); render(); return; }
    const tab = e.target.closest('[data-km-tab]'); if (tab) { local.moment = tab.dataset.kmTab; render(); return; }
    const swing = e.target.closest('[data-pulse-play]'); if (swing) { focusPlay(swing.dataset.pulsePlay); return; }
    const drive = e.target.closest('[data-km-drive]'); if (drive) { const i = Number(drive.dataset.kmDrive); local.openDrive = local.openDrive === i ? null : i; render(); return; }
    const route = e.target.closest('[data-pbecc-cast] [data-route]'); if (route) { window.App?.nav?.(route.dataset.route); }
    /* [data-game] is handled by v6's own root listener: focus(). */
  });
  window.addEventListener('pbe:route-changed', () => setTimeout(watch, 0));
  window.addEventListener('pbe:card-ready', () => { if (document.querySelector('.pbecast6')) render(); });

  window.PBEcastCommand = { render, state: local, moments, diff, focusPlay };
  if (!install()) document.addEventListener('DOMContentLoaded', install, { once: true });
})();
