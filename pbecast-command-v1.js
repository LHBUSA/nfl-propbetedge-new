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
 *   BEFORE KICKOFF   for a scheduled game: its injury designations, weather
 *                    and consensus line, from the command center's sources
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

  const local = { frame: null, feed: [], moment: 'scoring', openDrive: null, seeded: false, boardOpen: null };
  const FEED_MAX = 24;

  /* ---- Sunday board -------------------------------------------------------- */
  function games() { return arr(v6().scoreboard?.games); }
  function tile(g) {
    const s = sem(g), a = g?.teams?.away || {}, h = g?.teams?.home || {}, sit = g?.situation || {};
    const active = String(g.id) === String(v6().activeId);
    const live = s === 'LIVE', fin = s === 'FINAL';
    const poss = live && sit.possession_id ? (String(sit.possession_id) === String(a.id) ? a.abbreviation : String(sit.possession_id) === String(h.id) ? h.abbreviation : null) : null;
    const status = live ? (g?.status?.short_detail || `Q${g?.status?.period || ''} ${g?.status?.clock || ''}`) : fin ? (g?.status?.short_detail || 'Final') : `${etDay(g.date)} · ${etTime(g.date)} ET`;
    const team = (t, side) => `<div class="pbecb-t${fin && t.winner ? ' is-win' : ''}${poss && poss === t.abbreviation ? ' has-ball' : ''}"><span>${poss && poss === t.abbreviation ? '<i class="pbecb-ball" aria-label="possession"></i>' : ''}${esc(t.abbreviation || side)}</span><b>${s === 'SCHEDULE' ? '' : esc(t.score ?? '—')}</b></div>`;
    return `<button type="button" class="pbecb-tile is-${s.toLowerCase()}${active ? ' is-active' : ''}${live && sit.red_zone === true ? ' is-rz' : ''}" data-game="${esc(g.id)}" aria-pressed="${active}">
      <span class="pbecb-st">${live ? '<i class="pbecb-dot" aria-hidden="true"></i>' : ''}${esc(status)}${live && sit.red_zone === true ? '<em>RED ZONE</em>' : ''}</span>
      ${team(a, 'AWY')}${team(h, 'HME')}
      ${live && (sit.down_distance_text || sit.possession_text) ? `<span class="pbecb-sit">${esc([sit.down_distance_text, sit.possession_text].filter(Boolean).join(' · '))}</span>` : ''}
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
        if (!p.rz && n.rz && n.s === 'LIVE') out.push({ id, at, kind: 'RED ZONE', text: `${g?.situation?.possession_text || 'Offense'} inside the 20`, score });
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
    return `<li><span class="pbekm-meta">${esc(meta)}</span><p><b>${esc(p?.type || 'Play')}</b> ${esc(p?.text || '')}</p>${score ? `<em>${esc(score)}</em>` : ''}</li>`;
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
    const tabs = [['scoring', 'Scoring', m.scoring], ['turnovers', 'Turnovers', m.turnovers], ['explosive', 'Explosive 20+', m.explosive], ['drives', 'Drive chart', arr(d?.drives)]];
    const cur = tabs.find(t => t[0] === local.moment) || tabs[0];
    const body = cur[0] === 'drives' ? driveChart(d)
      : cur[2].length ? `<ol class="pbekm-list">${[...cur[2]].reverse().map(playLine).join('')}</ol>`
      : `<p class="pbekm-none">No ${esc(cur[1].toLowerCase())} plays in the published log${final ? '' : ' yet'}.</p>`;
    return `<section class="pbekm${final ? ' is-replay' : ''}" aria-label="${final ? 'PBE Replay' : 'Key moments'}">
      <header><div><span class="pbecb-eye">${final ? 'PBE REPLAY · FINAL · LIVE-SOURCE GAME LOG' : 'KEY MOMENTS · LIVE'}</span><h2>${final ? 'How this game was decided' : 'Jump to what mattered'}</h2></div>
        <div class="pbekm-tabs" role="tablist">${tabs.map(([k, l, rows]) => `<button type="button" role="tab" aria-selected="${cur[0] === k}" class="${cur[0] === k ? 'is-on' : ''}" data-km-tab="${k}">${esc(l)} <i>${esc(rows.length)}</i></button>`).join('')}</div></header>
      ${body}
      <footer class="pbekm-foot"><span class="pbekm-src">SOURCE · ESPN published play-by-play · ${esc(arr(d?.plays).length)} plays · ${esc(arr(d?.drives).length)} drives</span>${final ? '<span class="pbekm-pending">POST-GAME ENRICHMENT · PENDING — structured passer/rusher/receiver, EPA, air yards and win-probability deltas from nflverse arrive after the game and are not shown until they do.</span>' : '<span class="pbekm-src">Explosive = 20+ yards stated in the play text.</span>'}</footer>
    </section>`;
  }

  /* ---- before kickoff (scheduled game) -------------------------------------- */
  function beforeKickoffHtml() {
    const d = v6().detail; const g = d?.game;
    if (!g || sem(g) !== 'SCHEDULE') return '';
    const cc = window.PBECommandCenter;
    const changes = cc?.store?.changes?.data;
    const rows = arr(changes?.availability?.[String(g.id)]);
    const wx = arr(changes?.changes).filter(c => c.kind === 'GAME_STATUS' && String(c.game?.id) === String(g.id));
    const game = games().find(x => String(x.id) === String(g.id)) || { teams: g.teams, date: g.date };
    const ev = cc?.marketFor?.(game);
    const sp = ev ? Object.values(ev.markets?.spread || {}).filter(Boolean) : [];
    const tot = ev?.markets?.total?.OVER;
    const fav = sp.find(s => Number(s?.consensus?.line) < 0);
    const favAbbr = fav ? (String(fav.side).toLowerCase() === String(ev.away).toLowerCase() ? game?.teams?.away?.abbreviation : game?.teams?.home?.abbreviation) : null;
    return `<section class="pbekm is-preview" aria-label="Before kickoff">
      <header><div><span class="pbecb-eye">BEFORE KICKOFF</span><h2>What this game rests on</h2></div><div class="pbekm-tabs"><button type="button" data-route="changes">What Changed →</button><button type="button" data-route="bestline">Best Line →</button></div></header>
      <div class="pbekm-pre">
        <div><span class="pbecb-eye">MARKET CONSENSUS · SNAPSHOT</span>${ev ? `<b>${fav ? `${esc(favAbbr)} ${esc(fav.consensus.line)}` : 'Pick’em'}${tot?.consensus?.line != null ? ` · O/U ${esc(tot.consensus.line)}` : ''}</b><small>${esc(ev.books)} books · captured ${esc(cc?.store?.bestline?.data?.captured_at_et || '')}</small>` : `<b>—</b><small>${cc?.store?.bestline?.data ? 'No market for this game in the snapshot.' : 'Market snapshot not loaded.'}</small>`}</div>
        <div><span class="pbecb-eye">AVAILABILITY · ESPN INJURY REPORT</span>${changes ? (rows.length ? `<ul>${rows.slice(0, 10).map(r => `<li><em class="s-${esc(r.status.toLowerCase())}">${esc(r.status)}</em> ${esc(r.player.name)} <small>${esc([r.player.position, r.team.abbreviation].filter(Boolean).join(' · '))}</small></li>`).join('')}</ul>${rows.length > 10 ? `<small>+${rows.length - 10} more on What Changed</small>` : ''}` : '<small>No restrictive designations on the report.</small>') : '<small>Injury report not loaded.</small>'}${wx.length ? `<p class="pbekm-alert">${esc(wx[0].headline)}</p>` : ''}</div>
      </div>
    </section>`;
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
    if (local.lastActive !== activeId) { local.openDrive = null; local.lastActive = activeId; }
    root.classList.add('has-board');
    write(hostFor(root, 'board', '[data-cast6-rail]'), boardHtml());
    /* Before kickoff the current-play and drive panels are empty by
       definition, so the pre-game context goes directly under the hero. */
    const pre = sem(v6().detail?.game) === 'SCHEDULE';
    const moments = hostFor(root, 'moments', '[data-cast6-action]');
    const anchor = root.querySelector(pre ? '[data-cast6-hero]' : '[data-cast6-action]');
    if (anchor && moments.previousElementSibling !== anchor) anchor.after(moments);
    write(moments, keyMomentsHtml() || beforeKickoffHtml());
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
    ['[data-cast6-rail]', '[data-cast6-hero]', '[data-cast6-workspace]'].forEach(sel => { const n = root.querySelector(sel); if (n) nodeObserver.observe(n, { childList: true }); });
    if (!local.seeded) { observeFrame(); local.seeded = true; }
    render();
    /* PBEcast needs the command center's sources for BEFORE KICKOFF. They
       are shared, TTL-guarded reads — no new cadence. */
    ['changes', 'bestline'].forEach(k => window.PBECommandCenter?.refresh?.(k)?.then?.(render));
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
    const drive = e.target.closest('[data-km-drive]'); if (drive) { const i = Number(drive.dataset.kmDrive); local.openDrive = local.openDrive === i ? null : i; render(); return; }
    const route = e.target.closest('[data-pbecc-cast] [data-route]'); if (route) { window.App?.nav?.(route.dataset.route); }
    /* [data-game] is handled by v6's own root listener: focus(). */
  });
  window.addEventListener('pbe:route-changed', () => setTimeout(watch, 0));

  window.PBEcastCommand = { render, state: local, moments, diff };
  if (!install()) document.addEventListener('DOMContentLoaded', install, { once: true });
})();
