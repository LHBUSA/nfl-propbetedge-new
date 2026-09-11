/* PropBetEdge NFL — WHAT CHANGED (#changes)
 *
 * The first-class change layer: every assumption behind an NFL bet that a
 * source has just moved, tied to the player, team and game it touches and one
 * tap from the prop, the game and PBEcast.
 *
 *   injury designations   ESPN injury records (core API), ingested by nfl-intel
 *   game disruptions      nfl-current game state
 *   market moves          nfl-intel market history (consensus per odds ingest)
 *   weather               NWS alerts + forecast bands, snapshotted by nfl-intel
 *
 * All four arrive in one response from the nfl-intel Cloudflare Worker
 * (/api/changes through the NFL gateway).
 *
 * The change data is shared with the dashboard's command center through
 * PBECommandCenter.refresh('changes'): one request serves both surfaces.
 *
 * Rules the page keeps:
 *   - every row names its source and the source's own time
 *   - "updated" is never written as "changed from": prior designations are
 *     not in the report, and the page says so
 *   - an unavailable source is named as unavailable, never shown as silence
 *   - weather never claims conditions at a stadium, and an indoor venue is
 *     labelled indoor rather than hidden
 */
(() => {
  'use strict';

  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const arr = v => (Array.isArray(v) ? v : []);
  const GAME_KEY = 'pbe.changes.game';
  const DNA = { QB: 'qbdna', WR: 'wrdna', RB: 'rbdna', TE: 'tedna' };

  const narrow = () => window.matchMedia?.('(max-width: 768px)').matches;
  const ui = { kind: 'all', scope: 'material', game: 'all', propOnly: false, limit: 0 };
  const pageSize = () => (narrow() ? 20 : 60);

  const ET = { timeZone: 'America/New_York' };
  const etTime = v => { const d = new Date(v); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-US', { ...ET, hour: 'numeric', minute: '2-digit' }); };
  const etDay = v => { const d = new Date(v); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { ...ET, weekday: 'short', month: 'short', day: 'numeric' }); };
  const stamp = v => (etTime(v) ? `${etDay(v)} · ${etTime(v)} ET` : '—');
  function ago(v) {
    const t = Date.parse(v || ''); if (!Number.isFinite(t)) return '';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 90) return 'just now'; if (s < 3600) return `${Math.round(s / 60)}m ago`; if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }

  const cc = () => window.PBECommandCenter;
  const changesStore = () => cc()?.store?.changes || { data: null, error: 'command_center_not_loaded' };
  const active = () => window.App?.current === 'changes' && Boolean(document.querySelector('.pbewc'));

  /* Weather is part of the /api/changes payload: the nfl-intel Worker keeps
     the snapshots (and the prior one a WEATHER SHIFT is measured against). */
  const weatherData = () => changesStore().data?.weather || null;

  /* ---- rows --------------------------------------------------------------- */
  const STATUS_CLASS = { OUT: 'neg', SUSPENDED: 'neg', DOUBTFUL: 'neg', INJURED_RESERVE: 'neg', QUESTIONABLE: 'warn', ACTIVE: 'pos', DELAYED: 'neg', POSTPONED: 'neg', CANCELED: 'neg', KEY_NUMBER: 'model', MOVED: 'model', WEATHER_ALERT: 'warn', WEATHER_WATCH: 'warn', WEATHER_SHIFT: 'warn' };
  function badge(status) { return `<span class="pbewc-badge ${STATUS_CLASS[status] || ''}">${esc(String(status || '').replace(/_/g, ' '))}</span>`; }
  function playerLinks(p, game) {
    const links = [];
    if (p?.name && p.prop_relevant) links.push(`<button type="button" data-wc-prop="${esc(p.name)}">Market & research →</button>`);
    const dna = DNA[String(p?.position || '').toUpperCase()];
    if (dna) links.push(`<button type="button" data-route="${dna}">${esc(p.position)} DNA →</button>`);
    if (game?.id) links.push(`<button type="button" data-wc-cast="${esc(game.id)}">${game.semantics === 'LIVE' ? 'Live PBEcast' : game.semantics === 'FINAL' ? 'Game log' : 'PBEcast'} →</button>`);
    return links.join('');
  }
  function injuryDetail(c) {
    const i = c.injury || {};
    const parts = [i.type, i.location && i.location !== i.type ? i.location : null, i.detail, i.side].filter(Boolean);
    const ret = i.return_date ? `Reported return window: ${i.return_date}` : '';
    return [parts.join(' · '), ret].filter(Boolean).join(' — ');
  }
  function itemHtml(c) {
    const affected = cc()?.pickAffected?.(c) || '';
    const who = c.kind === 'INJURY_STATUS' ? c.player?.name : c.kind === 'MARKET_MOVE' ? (c.game?.matchup || c.market?.selection) : c.game?.matchup;
    const context = c.kind === 'INJURY_STATUS'
      ? [c.player?.position, c.team?.abbreviation, c.game ? `${c.game.matchup} · ${c.game.semantics === 'FINAL' ? 'final' : `${etDay(c.game.kickoff)} ${etTime(c.game.kickoff)} ET`}` : 'No game on the current slate'].filter(Boolean).join(' · ')
      : c.kind === 'MARKET_MOVE' ? c.headline.split(' — ').slice(1).join(' — ') : (c.detail || '');
    const basis = c.observed_basis === 'SOURCE_TIMESTAMP' ? 'updated' : 'observed';
    const img = c.player?.headshot ? `<img src="${esc(c.player.headshot)}" width="44" height="44" alt="" loading="lazy" decoding="async">` : `<span class="pbewc-ph" aria-hidden="true">${esc((c.team?.abbreviation || c.game?.matchup || 'NFL').slice(0, 3))}</span>`;
    const move = c.market ? `<p class="pbewc-move">${esc(c.market.market)} · ${esc(c.market.selection)} · ${c.market.from.line ?? c.market.from.price} → <b>${c.market.to.line ?? c.market.to.price}</b> (${c.market.delta > 0 ? '+' : ''}${esc(c.market.delta)} ${esc(c.market.unit)}) · ${esc(c.market.from.books)}→${esc(c.market.to.books)} books · since ${c.market.basis === 'PREVIOUS_BATCH' ? 'previous capture' : 'first capture'} ${esc(stamp(c.market.from.captured_at))}</p>` : '';
    return `<li class="pbewc-item is-${String(c.severity || 'LOW').toLowerCase()}${c.actionable === false ? ' is-history' : ''}" data-kind="${esc(c.kind)}">
      <div class="pbewc-media">${img}</div>
      <div class="pbewc-body">
        <div class="pbewc-top">${badge(c.status)}<b>${esc(who || '')}</b>${c.actionable === false ? '<span class="pbewc-hist">GAME FINAL · HISTORY</span>' : ''}${affected ? `<span class="pbewc-affected">PBE PICK AFFECTED · ${esc(affected)}</span>` : ''}</div>
        <p class="pbewc-context">${esc(context)}</p>
        ${c.kind === 'INJURY_STATUS' && injuryDetail(c) ? `<p class="pbewc-injury">${esc(injuryDetail(c))}</p>` : ''}
        ${move}
        ${c.kind === 'INJURY_STATUS' && c.detail ? `<blockquote class="pbewc-note"><span>Source note</span>${esc(c.detail)}</blockquote>` : ''}
        <div class="pbewc-foot"><span class="pbewc-src">${esc(c.source?.label || 'Source')} · ${basis} ${esc(stamp(c.observed_at))} (${esc(ago(c.observed_at))})</span><div class="pbewc-links">${c.kind === 'INJURY_STATUS' ? playerLinks(c.player, c.game) : c.game?.id ? `<button type="button" data-wc-cast="${esc(c.game.id)}">PBEcast →</button>` : ''}${c.kind === 'MARKET_MOVE' ? '<button type="button" data-route="bestline">Best Line →</button>' : ''}</div></div>
      </div>
    </li>`;
  }

  function weatherItems() {
    const games = arr(changesStore().data?.games);
    const wx = weatherData();
    if (!wx?.available) return [];
    return arr(wx.events).map(ev => {
      const g = games.find(x => String(x.id) === String(ev?.game?.event_id || ev?.game?.game_id));
      return {
        id: `wx:${ev.event_key}`,
        kind: 'WEATHER',
        status: ev.kind || 'WEATHER_ALERT',
        /* An alert for a fixed-roof venue is real and stays visible, but the
           conditions do not reach the field, so it is never material. */
        severity: ev.game?.roof?.weather_applies === false ? 'LOW' : ev.official && /severe|extreme/i.test(ev.severity || '') ? 'HIGH' : 'MEDIUM',
        observed_at: ev.effective || ev.observed_at || wx.fetched_at,
        observed_basis: ev.effective ? 'SOURCE_TIMESTAMP' : 'OBSERVED_BY_PBE',
        source: { label: ev.provenance?.source || (ev.official ? 'National Weather Service' : 'Open-Meteo forecast') },
        headline: ev.headline,
        detail: [ev.detail, ev.game?.roof && ev.game.roof.weather_applies === false ? `${ev.game.roof.label}: ${ev.game.roof.reason}` : null].filter(Boolean).join(' — '),
        cta: ev.cta,
        game: g ? { id: g.id, matchup: g.matchup, kickoff: g.kickoff, semantics: g.semantics } : ev.game ? { id: ev.game.event_id, matchup: ev.game.matchup, kickoff: ev.game.kickoff_utc, semantics: 'SCHEDULE' } : null,
        indoor: ev.game?.roof?.weather_applies === false
      };
    });
  }
  function weatherHtml(w) {
    return `<li class="pbewc-item is-${w.severity.toLowerCase()}" data-kind="WEATHER">
      <div class="pbewc-media"><span class="pbewc-ph" aria-hidden="true">WX</span></div>
      <div class="pbewc-body">
        <div class="pbewc-top">${badge(w.status)}<b>${esc(w.game?.matchup || '')} · ${esc(w.headline || 'Weather')}</b>${w.indoor ? '<span class="pbewc-hist">INDOOR VENUE</span>' : ''}</div>
        <p class="pbewc-context">${esc(w.detail || '')}</p>
        <div class="pbewc-foot"><span class="pbewc-src">${esc(w.source.label)} · effective ${esc(stamp(w.observed_at))}</span><div class="pbewc-links">${w.cta?.href ? `<a href="${esc(w.cta.href)}" target="_blank" rel="noopener">${esc(w.cta.label || 'Official alert')} ↗</a>` : ''}${w.game?.id ? `<button type="button" data-wc-cast="${esc(w.game.id)}">PBEcast →</button>` : ''}</div></div>
      </div>
    </li>`;
  }

  /* ---- filters ------------------------------------------------------------ */
  function filtered(all) {
    return all.filter(c => {
      if (ui.kind !== 'all') {
        if (ui.kind === 'injury' && c.kind !== 'INJURY_STATUS') return false;
        if (ui.kind === 'game' && c.kind !== 'GAME_STATUS') return false;
        if (ui.kind === 'market' && c.kind !== 'MARKET_MOVE') return false;
        if (ui.kind === 'weather' && c.kind !== 'WEATHER') return false;
      }
      if (ui.scope === 'material' && (c.severity === 'LOW' || c.actionable === false)) return false;
      if (ui.game !== 'all' && String(c.game?.id) !== ui.game) return false;
      if (ui.propOnly && c.kind === 'INJURY_STATUS' && !c.player?.prop_relevant) return false;
      return true;
    });
  }
  function filterBar(data, total, shown) {
    const games = arr(data?.games).filter(g => g.semantics !== 'FINAL');
    const btn = (key, value, label) => `<button type="button" class="${ui[key] === value ? 'is-on' : ''}" data-wc-set="${key}:${value}" aria-pressed="${ui[key] === value}">${esc(label)}</button>`;
    return `<div class="pbewc-filters" role="toolbar" aria-label="Filter changes">
      <div class="pbewc-seg">${btn('kind', 'all', 'All')}${btn('kind', 'injury', 'Injuries')}${btn('kind', 'game', 'Game status')}${btn('kind', 'market', 'Market')}${btn('kind', 'weather', 'Weather')}</div>
      <div class="pbewc-seg">${btn('scope', 'material', 'Material')}${btn('scope', 'all', 'Everything')}</div>
      <label class="pbewc-select"><span>Game</span><select data-wc-game><option value="all">All games</option>${games.map(g => `<option value="${esc(g.id)}"${ui.game === String(g.id) ? ' selected' : ''}>${esc(g.matchup)} · ${esc(etDay(g.kickoff))}</option>`).join('')}</select></label>
      <label class="pbewc-check"><input type="checkbox" data-wc-prop-only${ui.propOnly ? ' checked' : ''}> Prop positions only</label>
      <span class="pbewc-count">${esc(shown)} of ${esc(total)}</span>
    </div>`;
  }

  /* ---- availability by game ---------------------------------------------- */
  /* ESPN's own report shows each team's 25 most recent records; the core API
     keeps every current record, so some designations here were last touched
     weeks ago. They are ESPN's current designation and stay listed — with
     their update date, so an old note never reads as fresh. */
  const AGED_MS = 14 * 86400000;
  const aged = r => Date.now() - Date.parse(r.updated_at || '') > AGED_MS;
  function availabilityHtml(data) {
    const games = arr(data?.games).filter(g => g.semantics !== 'FINAL' && (ui.game === 'all' || String(g.id) === ui.game));
    const avail = data?.availability || {};
    if (!games.length) return '';
    return `<section class="pbewc-avail"><header><span class="pbewc-eyebrow">GAME AVAILABILITY</span><h2>Who is in doubt, game by game</h2><p>Current OUT, DOUBTFUL, SUSPENDED and QUESTIONABLE designations from the ESPN injury report for every game still to be played.</p></header>
      <div class="pbewc-avail-grid">${games.map(g => {
        const rows = arr(avail[g.id]).filter(r => !ui.propOnly || r.player?.prop_relevant);
        return `<article class="pbewc-game"><header><b>${esc(g.matchup)}</b><span>${esc(etDay(g.kickoff))} · ${esc(etTime(g.kickoff))} ET</span></header>
          ${rows.length ? `<ul>${rows.map(r => `<li class="${aged(r) ? 'is-aged' : ''}">${badge(r.status)}<span><b>${esc(r.player.name)}</b><small>${esc([r.player.position, r.team.abbreviation].filter(Boolean).join(' · '))}${aged(r) ? ` · last updated ${esc(etDay(r.updated_at))}` : ''}</small></span></li>`).join('')}</ul>` : '<p class="pbewc-none">No restrictive designations on the report.</p>'}
          <footer><button type="button" data-wc-cast="${esc(g.id)}">PBEcast →</button></footer></article>`;
      }).join('')}</div></section>`;
  }

  /* ---- page ---------------------------------------------------------------- */
  function sourceChips(data) {
    const s = data?.sources || {};
    const chip = (label, x, extra = '') => `<span class="pbewc-chip ${x?.available ? 'ok' : 'off'}" title="${esc(x?.reason || x?.error || '')}">${esc(label)} · ${x?.available ? `${esc(etTime(x.fetched_at))} ET${extra}` : 'UNAVAILABLE'}</span>`;
    const wxd = weatherData();
    const wx = wxd?.available ? { available: true, fetched_at: wxd.fetched_at } : { available: false, reason: wxd?.reason || 'not_in_payload' };
    return `<div class="pbewc-chips">${chip('ESPN INJURY REPORT', s.injuries, s.injuries?.entries ? ` · ${s.injuries.entries} entries` : '')}${chip('SCOREBOARD', s.scoreboard)}${chip('MARKET TAPE', s.market, s.market?.batches ? ` · ${s.market.batches} captures` : '')}${chip('WEATHER', wx)}</div>`;
  }
  function markup() {
    const st = changesStore();
    const data = st.data;
    const head = `<header class="pbewc-hero"><span class="pbewc-eyebrow">WHAT CHANGED · ${esc(data ? `${data.window_hours}H WINDOW` : 'SOURCED CHANGES')}</span><h1>Every assumption that just moved</h1>
      <p>Injury designations, game disruptions, market moves and official weather — each tied to its player, team and game, each with its source and the source's own time.</p>${data ? sourceChips(data) : ''}</header>`;
    if (!data) {
      return `<section class="pbewc">${head}<div class="${st.error ? 'pbewc-unavailable' : 'pbewc-empty'}"><b>${st.error ? 'What Changed is unavailable' : 'Reading sources…'}</b><span>${st.error ? `${esc(st.error)}. A failed read is shown as a failure, never as "nothing changed".` : 'ESPN injury report, scoreboard, market tape and weather.'}</span>${st.error ? '<button type="button" data-wc-retry>Retry</button>' : ''}</div></section>`;
    }
    const all = [...arr(data.changes), ...weatherItems()];
    const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    const rows = filtered(all).sort((a, b) => (a.actionable === false) - (b.actionable === false) || rank[a.severity] - rank[b.severity] || Date.parse(b.observed_at || 0) - Date.parse(a.observed_at || 0));
    const shown = rows.slice(0, ui.limit || pageSize());
    const marketNote = data.sources?.market && !data.sources.market.available
      ? `<p class="pbewc-note"><b>Market movement is unavailable on this deployment</b> (${esc(String(data.sources.market.reason || '').replace(/_/g, ' '))}). It is not being reported as "no moves".</p>` : '';
    return `<section class="pbewc">${head}
      ${filterBar(data, all.length, rows.length)}
      ${marketNote}
      <p class="pbewc-note">${esc(data.transitions?.note || '')}</p>
      ${shown.length ? `<ol class="pbewc-list">${shown.map(c => (c.kind === 'WEATHER' ? weatherHtml(c) : itemHtml(c))).join('')}</ol>${rows.length > shown.length ? `<div class="pbewc-more"><button type="button" data-wc-more>Show ${Math.min(pageSize(), rows.length - shown.length)} more</button><span>${shown.length} of ${rows.length} shown</span></div>` : ''}`
        : `<div class="pbewc-empty"><b>Nothing matches these filters</b><span>Every source answered; nothing in the ${esc(data.window_hours)}h window meets the current filter.</span></div>`}
      ${availabilityHtml(data)}
    </section>`;
  }

  function paint() {
    const vc = document.getElementById('view-container'); if (!vc || window.App?.current !== 'changes') return;
    const html = markup();
    const root = vc.querySelector('.pbewc');
    if (root && root.dataset.sig === html) return;
    const y = window.scrollY;
    vc.innerHTML = html;
    vc.querySelector('.pbewc').dataset.sig = html;
    if (root) window.scrollTo(0, y);
  }

  async function load() {
    try { const g = sessionStorage.getItem(GAME_KEY); if (g) { ui.game = g; sessionStorage.removeItem(GAME_KEY); } } catch (_) {}
    if (window.App?.params?.game) ui.game = String(window.App.params.game);
    paint();
    await cc()?.refresh?.('changes');
    paint();
  }

  document.addEventListener('click', e => {
    const root = e.target.closest?.('.pbewc'); if (!root) return;
    const set = e.target.closest('[data-wc-set]');
    if (set) { const [k, v] = set.dataset.wcSet.split(':'); ui[k] = v; ui.limit = 0; paint(); return; }
    if (e.target.closest('[data-wc-more]')) { ui.limit = (ui.limit || pageSize()) + pageSize(); paint(); return; }
    const cast = e.target.closest('[data-wc-cast]');
    if (cast) { try { sessionStorage.setItem('pbe.pbecast.focus', JSON.stringify({ game_id: cast.dataset.wcCast })); } catch (_) {} window.App?.nav?.('pbecast'); return; }
    const prop = e.target.closest('[data-wc-prop]');
    /* The unified player drawer carries this player's current market, model
       entitlement, news and archive with their own provenance — the prop
       layer for a name, without leaving the change that raised it. */
    if (prop) {
      if (typeof window.PBEPlayerResearch?.show === 'function') window.PBEPlayerResearch.show(prop.dataset.wcProp);
      else location.hash = `propboard?player=${encodeURIComponent(prop.dataset.wcProp)}`;
      return;
    }
    if (e.target.closest('[data-wc-retry]')) { cc()?.refresh?.('changes', true).then(paint); return; }
    const route = e.target.closest('[data-route]');
    if (route) window.App?.nav?.(route.dataset.route);
  });
  document.addEventListener('change', e => {
    if (!e.target.closest?.('.pbewc')) return;
    if (e.target.matches('[data-wc-game]')) { ui.game = e.target.value; paint(); }
    if (e.target.matches('[data-wc-prop-only]')) { ui.propOnly = e.target.checked; paint(); }
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && active()) load(); });

  function install() {
    if (!window.App?.VIEWS) return false;
    window.App.VIEWS.changes = load;
    return true;
  }
  window.PBEWhatChanged = { load, paint, ui };
  if (!install()) document.addEventListener('DOMContentLoaded', install, { once: true });
})();
