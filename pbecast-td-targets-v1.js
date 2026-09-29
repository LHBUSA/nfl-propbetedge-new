/* PropBetEdge NFL — PBEcast TOUCHDOWN TARGETS (additive to PBEcast v6)
 *
 * One module inside every PBEcast matchup: the targets PBE locked for THIS game
 * before kickoff, and what happened to each of them.
 *
 * WHAT DECIDES WHAT
 *   the server    who the targets are, whether this reader may see them
 *                 (view=game: NFL Pro / All Access, checked server-side), and
 *                 each target's state. A free reader's response carries counts
 *                 only — no name, face, probability, reason or play — so there
 *                 is nothing hidden in this DOM to reveal.
 *   the Worker    whether a target SCORED. nfl-touchdown-target-hit-alerts is
 *                 the one detector; its UNIQUE (pick_id) / (espn_id, play_id)
 *                 rows are the one record. This file detects nothing, writes
 *                 nothing, and never matches a player by name.
 *   the grader    HIT / MISS / VOID at the final, from the official box score.
 *
 * THE CELEBRATION is a local visual pulse on the card, once per target per
 * session, only for a hit the server marks announceable (a fresh live play) —
 * never for a touchdown that was already on the board when the tab opened
 * more than a few minutes later. It plays no sound and touches no other
 * PBEcast surface.
 *
 * THE PLAY-BY-PLAY MARKER is attached to the real scoring play by its ESPN
 * play id (v6 rows carry data-play-id, Key Moments rows data-km-play). No play
 * is ever created.
 *
 * Mounted by pbecast-command-v1.js between Game Pulse and Key Moments. The
 * only transport is GET /api/pbe-touchdown-targets?view=game&espn_id=<id>,
 * plus the public record once per page.
 */
(() => {
  'use strict';

  const API = '/api/pbe-touchdown-targets';
  const POLL = { LIVE: 30000, FINAL_PENDING: 60000, SCHEDULE: 300000 };
  const FRESH_CELEBRATION_MS = 3 * 60 * 1000;
  const CELEBRATE_MS = 4200;
  const SEEN_KEY = 'pbe.tdcast.celebrated.v1';

  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const arr = v => (Array.isArray(v) ? v : []);
  const num = v => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
  const v6 = () => window.PBEcastV6?.state || {};
  const ET = { timeZone: 'America/New_York' };
  const etTime = v => { const d = new Date(v); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-US', { ...ET, hour: 'numeric', minute: '2-digit' }); };
  const pct = v => (num(v) === null ? null : `${(num(v) * 100).toFixed(1)}%`);

  const store = new Map();       // espn id -> { data, at, error, inflight }
  const lastState = new Map();   // pick id -> state this tab last rendered
  const celebrating = new Map(); // pick id -> expiry ms
  let record = null;
  let recordLoading = false;
  let timer = null;
  let mountedId = null;

  /* ------------------------------------------------------------- transport */

  function semOf(id) {
    const d = v6().detail;
    if (d?.game && String(d.game.id) === String(id)) return String(d.game.status?.semantics || '').toUpperCase();
    const g = arr(v6().scoreboard?.games).find(x => String(x.id) === String(id));
    return String(g?.status?.semantics || '').toUpperCase();
  }

  function celebratedSet() {
    try { return new Set(JSON.parse(sessionStorage.getItem(SEEN_KEY) || '[]')); } catch (_) { return new Set(); }
  }
  function markCelebrated(id) {
    try { const s = celebratedSet(); s.add(id); sessionStorage.setItem(SEEN_KEY, JSON.stringify([...s].slice(-200))); } catch (_) {}
  }

  /* A HIT this tab watched arrive, or a fresh one it opened onto, celebrates
     once per session. Everything else simply renders its permanent state. */
  function noteTransitions(data, firstLoad) {
    const done = celebratedSet();
    for (const t of arr(data?.targets)) {
      const prev = lastState.get(t.pick_id);
      lastState.set(t.pick_id, t.state);
      if (t.state !== 'HIT' || !t.hit?.announce || done.has(t.pick_id)) continue;
      const detected = Date.parse(t.hit.detected_at || '');
      const fresh = Number.isFinite(detected) && Date.now() - detected <= FRESH_CELEBRATION_MS;
      const arrived = !firstLoad && prev && prev !== 'HIT';
      if (arrived || (firstLoad && fresh)) {
        celebrating.set(t.pick_id, Date.now() + CELEBRATE_MS);
        markCelebrated(t.pick_id);
        setTimeout(() => { celebrating.delete(t.pick_id); rerender(); }, CELEBRATE_MS + 50);
      }
    }
  }

  async function load(id, { force = false } = {}) {
    if (!/^\d{6,12}$/.test(String(id || ''))) return;
    const entry = store.get(id) || {};
    if (entry.inflight) return;
    if (!force && entry.at && Date.now() - entry.at < 5000) return;
    entry.inflight = true;
    store.set(id, entry);
    try {
      const response = await fetch(`${API}?view=game&espn_id=${encodeURIComponent(id)}`, {
        credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' },
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body || body.view !== 'game') throw new Error(`td_game_${response.status}`);
      const firstLoad = !entry.data;
      entry.data = body;
      entry.error = null;
      noteTransitions(body, firstLoad);
    } catch (error) {
      entry.error = String(error?.message || error);
    } finally {
      entry.inflight = false;
      entry.at = Date.now();
      rerender();
    }
  }

  function loadRecord() {
    if (record || recordLoading) return;
    recordLoading = true;
    fetch(`${API}?view=trackrecord`, { headers: { accept: 'application/json' } })
      .then(r => (r.ok ? r.json() : null))
      .then(body => { record = body?.records || null; })
      .catch(() => { record = null; })
      .finally(() => { recordLoading = false; rerender(); });
  }

  function cadence(id) {
    const sem = semOf(id);
    const data = store.get(id)?.data;
    if (sem === 'LIVE') return POLL.LIVE;
    if (sem === 'FINAL') return data?.counts?.pending > 0 ? POLL.FINAL_PENDING : null;
    if (sem === 'SCHEDULE') return POLL.SCHEDULE;
    return null;
  }
  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (!mountedId || document.hidden) return;
    const ms = cadence(mountedId);
    if (!ms) return;
    timer = setTimeout(() => {
      if (window.App?.current === 'pbecast' && mountedId) load(mountedId, { force: true });
      schedule();
    }, ms);
  }

  function rerender() { window.PBEcastCommand?.render?.(); }

  /* ------------------------------------------------------------- rendering */

  const STATE_BADGE = {
    PENDING: '<span class="pbetdc-badge is-pending">PENDING</span>',
    HIT: '<span class="pbetdc-badge is-hit">✓ TOUCHDOWN HIT</span>',
    MISS: '<span class="pbetdc-badge is-miss">FINAL — MISS</span>',
    VOID: '<span class="pbetdc-badge is-void">VOID</span>',
  };

  function hitLine(hit) {
    if (!hit) return '';
    const kind = hit.touchdown_type === 'receiving' ? 'receiving touchdown' : hit.touchdown_type === 'rushing' ? 'rushing touchdown' : 'touchdown';
    const yards = num(hit.yards);
    const what = yards === null ? kind[0].toUpperCase() + kind.slice(1) : `${yards}-yard ${kind}`;
    const when = [hit.period ? `Q${hit.period}` : null, hit.clock].filter(Boolean).join(' · ');
    return { what, when };
  }

  function face(player) {
    const initials = String(player?.name || '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
    const src = /^https:\/\/a\.espncdn\.com\//.test(String(player?.headshot_url || '')) ? player.headshot_url : '';
    return `<span class="pbetdc-face" aria-hidden="true"><i>${esc(initials)}</i>${src ? `<img src="${esc(src)}" alt="" width="64" height="64" loading="lazy" decoding="async" onerror="this.remove()">` : ''}</span>`;
  }

  function cardHtml(t, game) {
    const state = t.state || 'PENDING';
    const p = t.player || {}, m = t.model || {};
    const matchup = [p.position, p.team && p.opponent ? `${p.team} vs ${p.opponent}` : p.team].filter(Boolean).join(' · ');
    const h = state === 'HIT' ? hitLine(t.hit) : null;
    const nums = [
      ['TD PROBABILITY', pct(m.probability)],
      ['MARKET', pct(m.market_probability)],
      ['EDGE', num(m.edge_pp) === null ? null : `${m.edge_pp > 0 ? '+' : ''}${Number(m.edge_pp).toFixed(1)} pp`],
      ['CONFIDENCE', m.confidence ? String(m.confidence) : null],
    ].filter(([, v]) => v);
    const reasons = arr(t.reasons).filter(r => r.detail).slice(0, 3);
    const celebrate = (celebrating.get(t.pick_id) || 0) > Date.now();
    return `<article class="pbetdc-card is-${state.toLowerCase()}${celebrate ? ' is-celebrate' : ''}" data-pbetdc-pick="${esc(t.pick_id)}">
      <header class="pbetdc-card-head">
        <span class="pbetdc-rank">${state === 'MISS' || state === 'VOID' ? '' : '🎯 '}TARGET #${esc(t.rank)}<small>${t.target_rank === 'primary' ? 'PRIMARY' : 'SECONDARY'}</small></span>
        ${STATE_BADGE[state] || STATE_BADGE.PENDING}
      </header>
      <div class="pbetdc-who">${face(p)}<div><b>${esc(p.name || 'Target')}</b><small>${esc(matchup)}</small></div></div>
      ${h ? `<div class="pbetdc-hit" role="status"><span>🎯 TOUCHDOWN TARGET HIT</span><b>${esc(h.what)}</b>${h.when ? `<em>${esc(h.when)}</em>` : ''}</div>` : ''}
      ${state === 'HIT' && !h ? '<div class="pbetdc-hit" role="status"><span>🎯 TOUCHDOWN TARGET HIT</span><b>Settled from the official final box score</b></div>' : ''}
      ${nums.length ? `<dl class="pbetdc-nums">${nums.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}
      ${reasons.length ? `<ul class="pbetdc-why">${reasons.map(r => `<li class="is-${esc(r.direction || 'up')}"><b>${esc(r.label)}</b><span>${esc(r.detail)}</span></li>`).join('')}</ul>` : ''}
      <footer class="pbetdc-foot"><span>${esc(t.scope_label || 'TRACKING TARGET')}</span><span>Named ${esc(etTime(t.locked?.issued_at))} ET · ${game?.locked ? 'locked at kickoff' : 'locks at kickoff'}</span></footer>
    </article>`;
  }

  function recordLine() {
    const scope = record?.official?.all?.graded ? 'official' : 'tracking';
    const r = record?.[scope]?.all;
    if (!r || !(r.graded || r.voids)) return '';
    const rate = r.hit_rate === null || r.hit_rate === undefined ? '—' : `${(r.hit_rate * 100).toFixed(1)}%`;
    return `<p class="pbetdc-record"><b>${scope === 'official' ? 'OFFICIAL' : 'TRACKING'} RECORD</b><span>${esc(r.wins)} HIT · ${esc(r.losses)} MISS · ${esc(r.voids)} VOID · ${esc(rate)} hit rate</span><button type="button" data-pbetdc-route="trackrecord">Full record →</button></p>`;
  }

  function countsLine(c) {
    if (!c || !c.targets) return '';
    const parts = [c.hit ? `${c.hit} HIT` : null, c.miss ? `${c.miss} MISS` : null, c.void ? `${c.void} VOID` : null, c.pending ? `${c.pending} PENDING` : null].filter(Boolean);
    return parts.length ? `<span class="pbetdc-tally">${esc(parts.join(' · '))}</span>` : '';
  }

  function headerHtml(data, locked) {
    const n = num(data?.counts?.targets) || 0;
    return `<header class="pbetdc-head"><div><span class="pbetdc-eye">🎯 TOUCHDOWN TARGETS</span><em class="pbetdc-pro">PRO</em>${data?.game?.locked ? '<em class="pbetdc-lock">LOCKED AT KICKOFF</em>' : ''}</div>
      <h2>${n ? `PBE identified ${n} touchdown target${n === 1 ? '' : 's'} for this matchup.` : locked ? 'PBE Touchdown Targets' : 'PBE Touchdown Targets'}</h2>${countsLine(data?.counts)}</header>`;
  }

  function emptyCopy(data) {
    const outcome = data?.evaluation?.outcome;
    if (!data?.evaluated || outcome === 'not_evaluated') return 'PBE has not evaluated this game yet. Targets are named inside the pregame window and locked at kickoff.';
    if (outcome === 'abstained') return 'PBE evaluated this matchup and abstained: no player cleared the publication threshold. An abstention is recorded, never hidden.';
    if (outcome === 'degraded') return 'A source this game depends on was unavailable, so PBE did not name a target. That is recorded as a degraded source, not a pick.';
    return 'No target is on record for this game.';
  }

  function lockedHtml(data) {
    const n = num(data?.counts?.targets) || 0;
    const ghosts = Array.from({ length: Math.min(n, 5) }, (_, i) => `<div class="pbetdc-ghost" aria-hidden="true"><span>TARGET #${i + 1}</span><i></i><i></i></div>`).join('');
    return `<section class="pbetdc is-locked" aria-label="Touchdown Targets — Pro">
      ${headerHtml(data, true)}
      ${n ? `<div class="pbetdc-ghosts">${ghosts}</div>` : `<p class="pbetdc-empty">${esc(emptyCopy(data))}</p>`}
      <div class="pbetdc-cta"><button type="button" class="pbetdc-unlock" data-pbetdc-upgrade="1">🔒 Unlock with All Access Pro</button>
      <p>Named before kickoff, locked at kickoff, graded from the official box score. Each target's live HIT shows here.</p></div>
      ${recordLine()}
    </section>`;
  }

  function proHtml(data) {
    const targets = arr(data?.targets);
    return `<section class="pbetdc is-pro${targets.some(t => t.state === 'HIT') ? ' has-hit' : ''}" aria-label="Touchdown Targets">
      ${headerHtml(data, false)}
      ${targets.length ? `<div class="pbetdc-grid">${targets.map(t => cardHtml(t, data.game)).join('')}</div>` : `<p class="pbetdc-empty">${esc(emptyCopy(data))}</p>`}
      <p class="pbetdc-note">LIVE HIT = a rushing or receiving touchdown credited to the target on the live feed. The result settles from the official final box score. Passing and return touchdowns do not count.</p>
      ${recordLine()}
    </section>`;
  }

  function html(id) {
    const entry = store.get(String(id || ''));
    if (!entry?.data) {
      if (entry?.error) return `<section class="pbetdc is-error" aria-label="Touchdown Targets"><header class="pbetdc-head"><div><span class="pbetdc-eye">🎯 TOUCHDOWN TARGETS</span><em class="pbetdc-pro">PRO</em></div></header><p class="pbetdc-empty">Touchdown Targets are unavailable right now. Nothing is shown in their place; this retries.</p></section>`;
      return `<section class="pbetdc is-loading" aria-label="Touchdown Targets" aria-busy="true"><header class="pbetdc-head"><div><span class="pbetdc-eye">🎯 TOUCHDOWN TARGETS</span><em class="pbetdc-pro">PRO</em></div></header><div class="pbetdc-skel"></div></section>`;
    }
    return entry.data.access === 'pro' ? proHtml(entry.data) : lockedHtml(entry.data);
  }

  /* Called by the command layer on every render. Writes only on change. */
  function mount(host, state) {
    if (!host) return;
    const id = String(state?.activeId || '');
    if (!id) { if (host.innerHTML) { host.innerHTML = ''; host.dataset.sig = ''; } return; }
    if (mountedId !== id) { mountedId = id; load(id, { force: true }); }
    loadRecord();
    const next = html(id);
    if (host.dataset.sig !== next) { host.innerHTML = next; host.dataset.sig = next; }
    if (!timer) schedule();
  }

  /* ----------------------------------------------------- play-by-play marker */

  function hitsForActive() {
    const data = store.get(String(mountedId || ''))?.data;
    if (data?.access !== 'pro') return [];
    return arr(data.targets).filter(t => t.state === 'HIT' && t.hit?.play_id);
  }
  function markerHtml(t) {
    const h = hitLine(t.hit);
    return `<span>🎯 PBE TOUCHDOWN TARGET HIT — ${esc(t.player?.name || '')}</span><small>${esc([h.what, h.when].filter(Boolean).join(' · '))}</small>`;
  }
  function decorate(root) {
    const scope = root || document.querySelector('.pbecast6');
    if (!scope) return;
    const hits = hitsForActive();
    const wanted = new Set(hits.map(t => String(t.hit.play_id)));
    scope.querySelectorAll('[data-pbetdc-marker]').forEach(el => { if (!wanted.has(el.dataset.pbetdcMarker)) el.remove(); });
    for (const t of hits) {
      const id = String(t.hit.play_id);
      const sel = CSS.escape(id);
      scope.querySelectorAll(`[data-play-id="${sel}"], [data-km-play="${sel}"]`).forEach(row => {
        const prev = row.previousElementSibling;
        if (prev && prev.dataset?.pbetdcMarker === id) return;
        const tag = row.tagName === 'LI' ? 'li' : 'div';
        const el = document.createElement(tag);
        el.className = 'pbetdc-pbp';
        el.dataset.pbetdcMarker = id;
        el.setAttribute('role', 'note');
        el.innerHTML = markerHtml(t);
        row.before(el);
        row.classList.add('is-td-target-hit');
      });
    }
  }

  /* ------------------------------------------------------------------ events */

  document.addEventListener('click', e => {
    if (e.target.closest?.('[data-pbetdc-upgrade]')) { window.PBEPro?.open?.('PBE Touchdown Targets'); return; }
    const route = e.target.closest?.('[data-pbetdc-route]');
    if (route) window.App?.nav?.(route.dataset.pbetdcRoute);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearTimeout(timer); timer = null; return; }
    if (mountedId && window.App?.current === 'pbecast') { load(mountedId, { force: true }); schedule(); }
  });
  /* The one live detector's announcement for THIS game: read now instead of
     waiting for the next cadence tick. */
  window.addEventListener('pbe:td-target-hit', e => {
    const game = String(e?.detail?.espn_id || '');
    if (game && game === String(mountedId || '')) load(game, { force: true });
  });
  window.addEventListener('pbe:route-changed', () => {
    if (window.App?.current !== 'pbecast') { clearTimeout(timer); timer = null; mountedId = null; }
  });

  window.PBEcastTDTargets = { mount, html, decorate, load, store, hitLine, _state: { lastState, celebrating } };
})();
