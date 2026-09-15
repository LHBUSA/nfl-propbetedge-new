/* PropBetEdge NFL — PBEcast pregame preview (additive to PBEcast v6)
 *
 * One game, one route, one lifecycle:
 *   SCHEDULE -> PREGAME PREVIEW   (this module, directly under the hero)
 *   LIVE     -> LIVE PBECAST      (v6 command center; this module renders nothing)
 *   FINAL    -> REPLAY / FINAL    (Key Moments / PBE Replay; nothing here)
 *
 * The hero above it already carries WHO / WHEN / WHERE / CONDITIONS (teams,
 * records, kickoff ET + countdown, venue, broadcast, weather). The preview
 * answers the rest in one row: MARKET · PBE INTELLIGENCE · AVAILABILITY ·
 * WHAT CHANGED.
 *
 * Every value comes from an authority that already exists; nothing is
 * computed that another surface does not already publish:
 *   market         Best Line snapshot (nfl-intel /api/best-line via
 *                  PBECommandCenter.store.bestline), joined by
 *                  PBECommandCenter.marketFor (both team names + kickoff)
 *   PBE decision   PBE Card store (PBECard.forGame, ESPN id or team pair) and
 *                  the engine state the dashboard already reads
 *   availability   What Changed availability rows, keyed by ESPN event id
 *   what changed   What Changed rows whose game id is this game
 * No odds are recomputed, no second weather or injury source, no pick made up
 * to fill a tile. An absent source says so.
 *
 * IDENTITY. The model is built only from v6's detail for the selected id
 * (detail.game.id === activeId). Availability and changes are read by that id;
 * a market event must match both team names and the kickoff. A game with no
 * row in a source shows that source's empty state, never another game's rows.
 *
 * The model functions are pure (tests/pbecast-preview.test.mjs). The browser
 * wrapper reads the globals and is called by pbecast-command-v1.js render().
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && typeof root.document !== 'undefined') root.PBEcastPreview = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const arr = v => (Array.isArray(v) ? v : []);
  const num = v => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
  const norm = v => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const sem = g => String(g?.status?.semantics || '').toUpperCase();
  const ET = { timeZone: 'America/New_York' };

  const american = v => { const n = num(v); return n === null ? '' : `${n > 0 ? '+' : ''}${Math.round(n)}`; };
  const signedLine = v => { const n = num(v); return n === null ? '' : n === 0 ? 'PK' : `${n > 0 ? '+' : ''}${n}`; };
  function ago(iso, now) {
    const t = Date.parse(iso || ''); if (!Number.isFinite(t)) return '';
    const s = Math.max(0, Math.round((now - t) / 1000));
    if (s < 90) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }
  const etDay = v => { const d = new Date(v); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { ...ET, weekday: 'short', month: 'short', day: 'numeric' }); };

  /* ---- countdown ------------------------------------------------------------ */
  /* Only where it helps: inside a week, and never after the scheduled kickoff
     (a late start is the scoreboard's to report, not a negative clock). */
  function countdown(kickoff, now = Date.now()) {
    const k = Date.parse(kickoff || '');
    if (!Number.isFinite(k)) return null;
    const ms = k - now;
    if (ms <= 0) return { text: 'Kickoff time reached · awaiting the scoreboard', started: true };
    if (ms > 7 * 86400000) return null;
    const m = Math.floor(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
    return { text: d ? `Kickoff in ${d}d ${h}h` : h ? `Kickoff in ${h}h ${mm}m` : `Kickoff in ${Math.max(1, mm)}m`, started: false };
  }

  /* ---- market --------------------------------------------------------------- */
  /* event: one Best Line snapshot event already joined to this game.
     Sides are keyed by full team name; OVER/UNDER for totals. */
  function marketModel({ event, snapshot, game, loaded, error, now = Date.now() }) {
    const fresh = snapshot?.captured_at ? {
      captured_at: snapshot.captured_at,
      label: snapshot.captured_at_et || '',
      ago: ago(snapshot.captured_at, now),
      ingest_unavailable: snapshot?.ingest?.status === 'LATEST_INGEST_UNAVAILABLE'
    } : null;
    if (!loaded) return { state: error ? 'error' : 'loading', error: error || null, fresh };
    if (!event) return { state: 'not_posted', fresh };
    const away = game?.teams?.away || {}, home = game?.teams?.home || {};
    /* the join is the caller's, but an event for any other matchup is refused here too */
    if (norm(event.away) !== norm(away.display_name) || norm(event.home) !== norm(home.display_name)) return { state: 'not_posted', fresh, rejected: true };
    const abbr = side => (norm(side) === norm(event.away) ? away.abbreviation : norm(side) === norm(event.home) ? home.abbreviation : null);
    const m = event.markets || {};
    const sides = market => Object.values(m[market] || {}).filter(s => s && s.consensus);
    const quote = (s, withLine) => ({
      team: abbr(s.side), side: s.side,
      line: withLine ? num(s.consensus.line) : null, price: num(s.consensus.price),
      best: s.best ? { line: withLine ? num(s.best.line) : null, price: num(s.best.price), book: s.best.book || null } : null
    });
    const spread = sides('spread').map(s => quote(s, true)).filter(q => q.team && q.line !== null)
      .sort((a, b) => a.line - b.line);                                  // favourite first
    const moneyline = sides('moneyline').map(s => quote(s, false)).filter(q => q.team && q.price !== null)
      .sort((a, b) => a.price - b.price);
    const total = ['OVER', 'UNDER'].map(k => (m.total?.[k]?.consensus ? { ...quote(m.total[k], true), team: k === 'OVER' ? 'O' : 'U' } : null)).filter(Boolean);
    return {
      state: 'posted', event_id: event.id, books: num(event.books), started: event.started === true, fresh,
      spread: spread.length ? spread : null,
      moneyline: moneyline.length ? moneyline : null,
      total: total.length ? total : null
    };
  }

  /* ---- availability ----------------------------------------------------------- */
  const STATUS_RANK = { OUT: 0, SUSPENDED: 0, INJURED_RESERVE: 1, DOUBTFUL: 1, QUESTIONABLE: 2 };
  const POS_RANK = { QB: 0, RB: 1, WR: 2, TE: 3 };
  const STALE_MS = 14 * 86400000;
  function availabilityModel({ rows, game, loaded, error, now = Date.now() }) {
    if (!loaded) return { state: error ? 'error' : 'loading', error: error || null };
    const list = arr(rows).filter(r => r && r.player?.name && r.status in STATUS_RANK);
    const teamOrder = [game?.teams?.away?.abbreviation, game?.teams?.home?.abbreviation].filter(Boolean);
    const count = team => {
      const mine = list.filter(r => r.team?.abbreviation === team);
      return {
        team,
        out: mine.filter(r => r.status === 'OUT' || r.status === 'SUSPENDED' || r.status === 'INJURED_RESERVE').length,
        doubtful: mine.filter(r => r.status === 'DOUBTFUL').length,
        questionable: mine.filter(r => r.status === 'QUESTIONABLE').length
      };
    };
    const ranked = [...list].sort((a, b) =>
      (a.player.prop_relevant === true ? 0 : 1) - (b.player.prop_relevant === true ? 0 : 1)
      || STATUS_RANK[a.status] - STATUS_RANK[b.status]
      || (POS_RANK[a.player.position] ?? 9) - (POS_RANK[b.player.position] ?? 9)
      || (Date.parse(b.updated_at || '') || 0) - (Date.parse(a.updated_at || '') || 0));
    const shape = r => ({
      status: r.status, name: r.player.name, position: r.player.position || null, team: r.team?.abbreviation || null,
      injury: r.injury?.type || null,
      stale: Number.isFinite(Date.parse(r.updated_at || '')) && now - Date.parse(r.updated_at) > STALE_MS ? etDay(r.updated_at) : null
    });
    return {
      state: list.length ? 'listed' : 'clear',
      total: list.length,
      teams: teamOrder.map(count),
      top: ranked.slice(0, 3).map(shape),
      all: ranked.map(shape)
    };
  }

  /* ---- what changed ------------------------------------------------------------ */
  const SEV = { HIGH: 0, MEDIUM: 1 };
  function changesModel({ data, gameId, loaded, error, now = Date.now() }) {
    if (!loaded) return { state: error ? 'error' : 'loading', error: error || null };
    const id = String(gameId);
    const rows = arr(data?.changes).filter(c => String(c?.game?.id) === id && c.actionable !== false && c.severity in SEV
      && !(c.kind === 'INJURY_STATUS' && c.status === 'ACTIVE'));
    rows.sort((a, b) => SEV[a.severity] - SEV[b.severity] || (Date.parse(b.observed_at || '') || 0) - (Date.parse(a.observed_at || '') || 0));
    const prefix = new RegExp(`^${String(rows[0]?.game?.matchup || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[—-]\\s*`);
    return {
      state: rows.length ? 'changed' : 'quiet',
      window_hours: num(data?.window_hours),
      total: rows.length,
      top: rows.slice(0, 3).map(c => ({
        kind: c.kind, status: String(c.status || '').replace(/_/g, ' '), severity: c.severity,
        headline: c.kind === 'INJURY_STATUS' && c.player?.name
          ? `${c.player.name}${c.player.position ? ` (${c.player.position}${c.team?.abbreviation ? ` · ${c.team.abbreviation}` : ''})` : ''}`
          : String(c.headline || '').replace(prefix, ''),
        detail: c.detail || null,
        when: `${c.observed_basis === 'SOURCE_TIMESTAMP' ? 'updated' : 'observed'} ${ago(c.observed_at, now)}`
      }))
    };
  }

  /* ---- PBE intelligence -------------------------------------------------------- */
  /* hit: PBECard.forGame(...) -> { cards (Pro), previews (public, locked) }.
     engine: the dashboard's PBE Picks state (publication, engine_health). */
  function pbeModel({ hit, loaded, error, engine }) {
    const gated = String(engine?.publication || '').toUpperCase() === 'GATED';
    const engineNote = engine ? (gated ? 'Official publication gated · engine in validation mode' : 'Engine publishing official picks') : null;
    if (!loaded) return { state: error ? 'error' : 'loading', error: error || null, engineNote };
    const cards = arr(hit?.cards).filter(c => c.lifecycle !== 'FINAL');
    const previews = arr(hit?.previews).filter(p => p.lifecycle !== 'FINAL');
    const scope = x => (x.publication_scope === 'official' ? 'official' : 'validation');
    if (cards.length) {
      return {
        state: 'decisions', locked: false, engineNote,
        official: cards.filter(c => scope(c) === 'official').length,
        rows: cards.slice(0, 3).map(c => ({ scope: scope(c), label: c.label || null, market: c.market, selection: c.selection?.display || null, lifecycle: c.lifecycle, revised: (c.lineage?.revision || 1) > 1 }))
      };
    }
    if (previews.length) {
      return {
        state: 'decisions', locked: true, engineNote,
        official: previews.filter(p => scope(p) === 'official').length,
        rows: previews.slice(0, 3).map(p => ({ scope: scope(p), label: p.label || null, market: p.market, selection: null, lifecycle: p.lifecycle, revised: num(p.revisions) > 0 }))
      };
    }
    return { state: 'none', engineNote };
  }

  /* ---- the whole preview ---------------------------------------------------------- */
  /* Returns null unless the selected game is scheduled and detail belongs to it. */
  function model(input) {
    const { detail, activeId } = input;
    const g = detail?.game;
    if (!g || !activeId || String(g.id) !== String(activeId) || sem(g) !== 'SCHEDULE') return null;
    const now = input.now ?? Date.now();
    return {
      game_id: String(g.id),
      matchup: `${g.teams?.away?.abbreviation || 'AWY'} @ ${g.teams?.home?.abbreviation || 'HME'}`,
      market: marketModel({ ...input.market, game: g, now }),
      pbe: pbeModel(input.pbe || {}),
      availability: availabilityModel({ ...input.availability, game: g, now }),
      changes: changesModel({ ...input.changes, gameId: g.id, now })
    };
  }

  /* ---- HTML ------------------------------------------------------------------------ */
  const MARKET_NAME = { moneyline: 'Moneyline', spread: 'Spread', total: 'Total', h2h: 'Moneyline', totals: 'Total', spreads: 'Spread' };
  function tile(key, eye, meta, body, foot = '') {
    return `<article class="pbepv-tile is-${key}" data-pv-tile="${key}"><header><span class="pbepv-eye">${eye}</span>${meta ? `<span class="pbepv-meta">${meta}</span>` : ''}</header><div class="pbepv-body">${body}</div>${foot ? `<footer>${foot}</footer>` : ''}</article>`;
  }
  const state = (title, detail = '') => `<div class="pbepv-state"><b>${esc(title)}</b>${detail ? `<small>${esc(detail)}</small>` : ''}</div>`;

  function marketHtml(mk) {
    const fresh = mk.fresh ? `SNAPSHOT ${esc(mk.fresh.label)}${mk.fresh.ago ? ` · ${esc(mk.fresh.ago)}` : ''}` : '';
    const foot = `${fresh ? `<span>${fresh}${mk.fresh?.ingest_unavailable ? ' · <b>LATEST INGEST UNAVAILABLE</b>' : ''} · NOT LIVE</span>` : ''}<button type="button" data-route="bestline">Best Line →</button>`;
    if (mk.state === 'loading') return tile('market', 'MARKET', '', state('Reading the market snapshot'), foot);
    if (mk.state === 'error') return tile('market', 'MARKET', '', state('Market snapshot unavailable', mk.error || ''), foot);
    if (mk.state === 'not_posted') return tile('market', 'MARKET', '', state('Not posted', 'No sportsbook market for this game in the latest snapshot. Nothing is estimated.'), foot);
    const best = q => (q.best && q.best.book && (q.best.price !== q.price || q.best.line !== q.line)
      ? `<small>best ${esc(q.line !== null ? `${q.team === 'O' || q.team === 'U' ? `${q.team} ${q.best.line}` : signedLine(q.best.line)} ` : '')}${esc(american(q.best.price))} · ${esc(q.best.book)}</small>` : '');
    const row = (label, quotes, fmt) => `<div class="pbepv-mrow"><dt>${label}</dt><dd>${quotes
      ? quotes.map(q => `<span class="pbepv-q"><b>${esc(fmt(q))}</b>${q.price !== null ? `<i>${esc(american(q.price))}</i>` : ''}${best(q)}</span>`).join('')
      : '<span class="pbepv-na">Not posted</span>'}</dd></div>`;
    const body = `<dl class="pbepv-market">
      ${row('Spread', mk.spread, q => `${q.team} ${signedLine(q.line)}`)}
      ${row('Moneyline', mk.moneyline, q => q.team)}
      ${row('Total', mk.total, q => `${q.team} ${q.line}`)}
    </dl>`;
    return tile('market', 'MARKET · CONSENSUS', mk.books ? `${esc(mk.books)} BOOKS` : '', body, foot);
  }

  function pbeHtml(p) {
    const foot = `${p.engineNote ? `<span>${esc(p.engineNote)}</span>` : ''}<button type="button" data-route="pbepicks">PBE Picks →</button>`;
    if (p.state === 'loading') return tile('pbe', 'PBE INTELLIGENCE', '', state('Reading PBE decisions'), foot);
    if (p.state === 'error') return tile('pbe', 'PBE INTELLIGENCE', '', state('PBE decisions unavailable', 'A failed read is never shown as "no pick".'), foot);
    if (p.state === 'none') return tile('pbe', 'PBE INTELLIGENCE', '', state('No PBE decision on this game', 'Nothing has cleared the engine’s threshold for this matchup. No pick is shown until one is issued.'), foot);
    const scopeLabel = r => (r.scope === 'official' ? 'OFFICIAL PBE PICK' : 'VALIDATION SIGNAL');
    const body = `<ul class="pbepv-picks">${p.rows.map(r => `<li class="is-${esc(r.scope)}"><span class="pbepv-scope">${esc(scopeLabel(r))}</span><b>${esc(MARKET_NAME[r.market] || r.market || 'Market')}</b>${r.selection ? `<strong>${esc(r.selection)}</strong>` : '<em>Selection · NFL Pro</em>'}<small>${esc(String(r.lifecycle || '').toLowerCase())}${r.revised ? ' · revised' : ''}</small></li>`).join('')}</ul>
      ${p.official ? '' : '<p class="pbepv-note">Validation signals are real pre-game decisions, not Official PBE Picks.</p>'}
      ${p.locked ? '<button type="button" class="pbepv-unlock" data-pbec-upgrade>Unlock the selection</button>' : ''}`;
    return tile('pbe', 'PBE INTELLIGENCE', `${esc(p.rows.length)} ON THIS GAME`, body, `${p.engineNote ? `<span>${esc(p.engineNote)}</span>` : ''}<button type="button" data-pv-jump="pick">Full decision ↓</button>`);
  }

  function availabilityHtml(av, gameId) {
    const foot = '<button type="button" data-route="injuries">Injuries →</button>';
    if (av.state === 'loading') return tile('availability', 'AVAILABILITY', '', state('Reading the injury report'), foot);
    if (av.state === 'error') return tile('availability', 'AVAILABILITY', '', state('Injury report unavailable', av.error || ''), foot);
    if (av.state === 'clear') return tile('availability', 'AVAILABILITY', 'ESPN INJURY REPORT', state('No restrictive designations', 'Neither team lists a player OUT, DOUBTFUL or QUESTIONABLE for this game.'), foot);
    const counts = `<div class="pbepv-counts">${av.teams.map(t => `<div><b>${esc(t.team)}</b><span class="s-out">${esc(t.out)} OUT</span><span class="s-doubtful">${esc(t.doubtful)} D</span><span class="s-questionable">${esc(t.questionable)} Q</span></div>`).join('')}</div>`;
    const line = r => `<li><em class="s-${esc(r.status.toLowerCase())}">${esc(r.status.replace(/_/g, ' '))}</em><span>${esc(r.name)}</span><small>${esc([r.position, r.team, r.injury].filter(Boolean).join(' · '))}${r.stale ? ` · last updated ${esc(r.stale)}` : ''}</small></li>`;
    const body = `${counts}<ul class="pbepv-inj">${av.top.map(line).join('')}</ul>
      ${av.total > av.top.length ? `<details class="pbepv-more" data-pv-more="${esc(gameId)}"><summary>All ${esc(av.total)} designations</summary><ul class="pbepv-inj">${av.all.slice(av.top.length).map(line).join('')}</ul></details>` : ''}`;
    return tile('availability', 'AVAILABILITY', 'ESPN INJURY REPORT', body, foot);
  }

  function changesHtml(ch, gameId) {
    const foot = `<button type="button" data-route="changes" data-changes-game="${esc(gameId)}">What Changed →</button>`;
    if (ch.state === 'loading') return tile('changes', 'WHAT CHANGED', '', state('Reading sources'), foot);
    if (ch.state === 'error') return tile('changes', 'WHAT CHANGED', '', state('What Changed unavailable', ch.error || ''), foot);
    if (ch.state === 'quiet') return tile('changes', 'WHAT CHANGED', '', state(`No material changes${ch.window_hours ? ` in the last ${ch.window_hours}h` : ''}`, 'Every source answered; nothing on this game crossed the materiality bar.'), foot);
    const body = `<ol class="pbepv-changes">${ch.top.map(c => `<li class="is-${esc(String(c.severity).toLowerCase())}"><em>${esc(c.status)}</em><div><b>${esc(c.headline)}</b>${c.detail ? `<small>${esc(c.detail)}</small>` : ''}<small class="pbepv-when">${esc(c.when)}</small></div></li>`).join('')}</ol>`;
    return tile('changes', 'WHAT CHANGED', `${esc(ch.total)} ON THIS GAME`, body, foot);
  }

  function html(m) {
    if (!m) return '';
    return `<section class="pbepv" aria-label="Pregame preview · ${esc(m.matchup)}" data-preview-game="${esc(m.game_id)}">
      <div class="pbepv-grid">${marketHtml(m.market)}${pbeHtml(m.pbe)}${availabilityHtml(m.availability, m.game_id)}${changesHtml(m.changes, m.game_id)}</div>
    </section>`;
  }

  /* ---- browser wrapper: read the existing authorities -------------------------------- */
  function fromPage(v6State) {
    const cc = root.PBECommandCenter, card = root.PBECard;
    const d = v6State?.detail, g = d?.game;
    if (!g) return null;
    const bl = cc?.store?.bestline || {}, chg = cc?.store?.changes || {}, picks = cc?.store?.picks || {};
    const event = bl.data ? (cc?.marketFor?.({ teams: g.teams, date: g.date }) || null) : null;
    card?.ensure?.();
    return model({
      detail: d, activeId: v6State.activeId,
      market: { event, snapshot: bl.data, loaded: Boolean(bl.data), error: bl.error },
      pbe: { hit: card?.forGame?.({ away: g.teams?.away?.abbreviation, home: g.teams?.home?.abbreviation, espnId: g.id }), loaded: Boolean(card?.store?.data), error: card?.store?.data ? null : card?.store?.error, engine: picks.data },
      availability: { rows: chg.data?.availability?.[String(g.id)], loaded: Boolean(chg.data), error: chg.error },
      changes: { data: chg.data, loaded: Boolean(chg.data), error: chg.error }
    });
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('click', e => {
      const jump = e.target.closest?.('.pbepv [data-pv-jump]');
      if (jump) {
        const el = document.querySelector('.pbecast6 [data-pbecc-cast="pick"]');
        el?.scrollIntoView({ block: 'start', behavior: root.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 'auto' : 'smooth' });
        return;
      }
      /* Navigation itself is the command layer's ([data-pbecc-cast] [data-route]);
         this only carries the game to What Changed, the same key the dashboard uses. */
      const route = e.target.closest?.('.pbepv [data-changes-game]');
      if (route) { try { sessionStorage.setItem('pbe.changes.game', route.dataset.changesGame); } catch (_) {} }
    });
  }

  return { countdown, marketModel, availabilityModel, changesModel, pbeModel, model, html, fromPage };
});
