/* PropBetEdge NFL — PBEcast Arcade Replay mode
 * =============================================================================
 * PROTOTYPE BRANCH ONLY. Additive to PBEcast v6. It does not replace, rewrite
 * or reach into the trusted field-state view: that view stays exactly as it is
 * and remains the default. This module adds a second field mode beside it.
 *
 *   FIELD    the existing compact field-state view (default)
 *   ARCADE   an original pixel reconstruction of each published play
 *
 * The preference is remembered on the device. Nothing about PBEcast's polling,
 * data, audio or layout changes when the mode is FIELD.
 *
 * MOUNTING. PBEcast v6 re-patches [data-cast6-action] on every poll, so a canvas
 * placed inside it would be destroyed every five seconds. The arcade container
 * is therefore mounted as a SIBLING of that slot and simply shows or hides the
 * existing .cast6-field, which survives the patch untouched.
 *
 * TRUTH. Every animation ends on the published field state. Routes, lanes,
 * blocking, defender movement, formation and all 22 positions are reconstructed
 * and the surface says so once, quietly. Player names are read from the play
 * text and may appear in the caption, but they never determine geometry or
 * possession -- see the load-bearing test in prototype/arcade.
 * ========================================================================== */
(() => {
  'use strict';

  const KEY = 'pbe_pbecast_field_mode_v1';
  const MAX_QUEUE = 4;
  const local = {
    mode: 'field', ready: false, mod: null, replay: null,
    queue: [], draining: false, lastPlayId: null, replayId: null, timer: null
  };

  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const state = () => window.PBEcastV6?.state || {};
  const onCast = () => window.App?.current === 'pbecast' && Boolean(document.querySelector('.pbecast6'));

  function saved() {
    try { const v = localStorage.getItem(KEY); return v === 'arcade' ? 'arcade' : 'field'; } catch { return 'field'; }
  }
  function persist(mode) { try { localStorage.setItem(KEY, mode); } catch {} }

  /* ---- data -------------------------------------------------------------- */
  function driveOf(playId) {
    const d = state().detail;
    for (const dr of (d?.drives || [])) {
      if ((dr.plays || []).some(p => p.id === playId)) return dr;
    }
    return d?.current_drive || null;
  }
  function playById(id) {
    const d = state().detail;
    return (d?.plays || []).find(p => p.id === id) || null;
  }
  function normalize(play) {
    if (!play || !local.mod) return null;
    const d = state().detail;
    return local.mod.normalizePlayForArcade(play, {
      drive: driveOf(play.id),
      homeTeam: d?.game?.teams?.home || null,
      awayTeam: d?.game?.teams?.away || null
    });
  }

  /* ---- caption -----------------------------------------------------------
   * Names enhance the caption when the text yielded them; the caption degrades
   * to the play class and the yardage when it did not, and the animation is
   * identical either way.
   */
  function caption(a) {
    if (!a) return '';
    const last = n => String(n || '').split(/\s+/).slice(-1)[0];
    const yards = Number.isFinite(a.yardsGained) ? `${a.yardsGained >= 0 ? '+' : ''}${a.yardsGained} YD` : '';
    let who = '';
    if ((a.kind === 'pass_complete' || a.kind === 'passing_touchdown') && a.passer && a.receiver) who = `${last(a.passer)} → ${last(a.receiver)}`;
    else if ((a.kind === 'rush' || a.kind === 'rushing_touchdown') && a.rusher) who = last(a.rusher);
    else if (a.kind === 'sack' && a.passer) who = `${last(a.passer)} SACKED`;
    else if (a.kind === 'interception' && a.interceptor) who = `INT ${last(a.interceptor)}`;
    else if ((a.kind === 'field_goal_good' || a.kind === 'field_goal_missed') && a.kicker) who = last(a.kicker);
    const kindLabel = String(a.typeText || a.kind).toUpperCase();
    const parts = [who || kindLabel, a.scoring ? 'TOUCHDOWN' : '', yards].filter(Boolean);
    if (a.kind === 'field_goal_good') return `${who || 'FIELD GOAL'} · ${a.kickDistanceYards ?? '—'} YD FG · GOOD`;
    if (a.kind === 'pass_incomplete') return `${who || 'PASS'} · INCOMPLETE`;
    return parts.join(' · ');
  }

  /* ---- shell -------------------------------------------------------------- */
  function shell() {
    return `<div class="cast-arc" data-cast-arc>
      <div class="cast-arc-bar">
        <div class="cast-arc-modes" role="group" aria-label="Field view mode">
          <button type="button" data-arc-mode="field">Field</button>
          <button type="button" data-arc-mode="arcade">Arcade</button>
        </div>
        <span class="cast-arc-note">Reconstructed from live play-by-play</span>
      </div>
      <div class="cast-arc-stage" hidden>
        <div class="cast-arc-replaybar" hidden>
          <span>Replay · earlier play</span>
          <button type="button" data-arc-live>Return to live</button>
        </div>
        <canvas class="cast-arc-canvas" width="240" height="108"
                aria-label="Reconstructed arcade replay of the current play"></canvas>
        <div class="cast-arc-foot">
          <span class="cast-arc-caption" data-arc-caption></span>
          <span class="cast-arc-controls">
            <button type="button" data-arc-replay>Replay</button>
            <button type="button" data-arc-skip>Skip to live</button>
          </span>
        </div>
      </div>
    </div>`;
  }

  function mount() {
    const root = document.querySelector('.pbecast6');
    if (!root) return null;
    let box = root.querySelector('[data-cast-arc]');
    if (box) return box;
    const anchor = root.querySelector('[data-cast6-action]');
    if (!anchor) return null;
    anchor.insertAdjacentHTML('beforebegin', shell());
    box = root.querySelector('[data-cast-arc]');
    wire(box);
    return box;
  }

  function wire(box) {
    box.querySelectorAll('[data-arc-mode]').forEach(b =>
      b.addEventListener('click', () => setMode(b.dataset.arcMode)));
    box.querySelector('[data-arc-replay]')?.addEventListener('click', () => {
      const id = local.replayId || local.lastPlayId;
      const a = normalize(playById(id));
      if (a) { render(a); local.replay?.load(a); local.replay?.start(); }
    });
    box.querySelector('[data-arc-skip]')?.addEventListener('click', skipToLive);
    box.querySelector('[data-arc-live]')?.addEventListener('click', skipToLive);
  }

  /* ---- mode -------------------------------------------------------------- */
  function applyMode() {
    const box = document.querySelector('[data-cast-arc]');
    if (!box) return;
    const arcade = local.mode === 'arcade';
    box.querySelectorAll('[data-arc-mode]').forEach(b =>
      b.classList.toggle('active', b.dataset.arcMode === local.mode));
    box.querySelector('.cast-arc-stage').hidden = !arcade;
    box.querySelector('.cast-arc-note').hidden = !arcade;
    /* the trusted field-state view is hidden, never removed or altered */
    const field = document.querySelector('.pbecast6 .cast6-field');
    if (field) field.style.display = arcade ? 'none' : '';
    document.querySelector('.pbecast6')?.classList.toggle('cast-arc-on', arcade);
  }

  async function setMode(mode) {
    local.mode = mode === 'arcade' ? 'arcade' : 'field';
    persist(local.mode);
    applyMode();
    if (local.mode === 'arcade') {
      await ensureRenderer();
      skipToLive();
    } else {
      local.replay?.pause();
    }
  }

  async function ensureRenderer() {
    if (local.replay) return true;
    if (!local.mod) {
      try {
        const [n, r] = await Promise.all([
          import('./prototype/arcade/arcade-normalize.js'),
          import('./prototype/arcade/arcade-renderer.js')
        ]);
        local.mod = n; local.renderer = r;
      } catch (error) { console.warn('[pbecast-arcade] renderer unavailable', error?.message || error); return false; }
    }
    const canvas = document.querySelector('[data-cast-arc] .cast-arc-canvas');
    if (!canvas) return false;
    local.replay = new local.renderer.ArcadeReplay(canvas, {
      compact: matchMedia('(max-width:640px)').matches,
      onEnd: () => { local.draining = false; drain(); }
    });
    return true;
  }

  /* ---- render + queue ---------------------------------------------------- */
  function render(a) {
    const box = document.querySelector('[data-cast-arc]');
    if (!box || !a) return;
    box.querySelector('[data-arc-caption]').textContent = caption(a);
  }

  function setReplayBar(on) {
    const bar = document.querySelector('[data-cast-arc] .cast-arc-replaybar');
    if (bar) bar.hidden = !on;
    document.querySelector('[data-cast-arc]')?.classList.toggle('is-replay', Boolean(on));
  }

  function enqueue(ids) {
    ids.forEach(id => { if (!local.queue.includes(id)) local.queue.push(id); });
    /* never let the reconstruction make PBEcast materially stale */
    if (local.queue.length > MAX_QUEUE) {
      local.queue.length = 0;
      skipToLive();
      return;
    }
    drain();
  }

  function drain() {
    if (local.draining || !local.queue.length || local.mode !== 'arcade') return;
    const id = local.queue.shift();
    const a = normalize(playById(id));
    if (!a) { drain(); return; }
    local.draining = true;
    local.replayId = null;
    setReplayBar(false);
    render(a);
    local.replay.load(a);
    local.replay.start();
  }

  function skipToLive() {
    local.queue.length = 0;
    local.draining = false;
    local.replayId = null;
    setReplayBar(false);
    const d = state().detail;
    const live = d?.current_play || d?.game?.situation?.last_play || (d?.plays || []).at(-1) || null;
    const a = normalize(live);
    if (!a || !local.replay) return;
    render(a);
    local.replay.load(a);
    local.replay.toEnd();          // land on the real current state, no animation
  }

  function replayHistorical(id) {
    if (local.mode !== 'arcade') return;
    const a = normalize(playById(id));
    if (!a || !local.replay) return;
    local.queue.length = 0;
    local.draining = false;
    local.replayId = id;
    setReplayBar(true);
    render(a);
    local.replay.load(a);
    local.replay.start();
  }

  /* ---- game-log rows become replayable ----------------------------------- */
  function wireLog() {
    const root = document.querySelector('.pbecast6');
    if (!root) return;
    root.querySelectorAll('.cast6-play[data-play-id]:not([data-arc-wired])').forEach(row => {
      row.dataset.arcWired = '1';
      row.addEventListener('click', e => {
        if (local.mode !== 'arcade') return;
        if (e.target.closest('a,button')) return;
        replayHistorical(row.dataset.playId);
      });
    });
  }

  /* ---- new published play ------------------------------------------------ */
  function onData() {
    if (!onCast()) return;
    mount();
    applyMode();
    wireLog();
    if (local.mode !== 'arcade' || !local.replay) return;
    const d = state().detail;
    const plays = d?.plays || [];
    const latest = (d?.current_play?.id) || plays.at(-1)?.id || null;
    if (!latest) return;
    if (local.lastPlayId === null) { local.lastPlayId = latest; skipToLive(); return; }
    if (latest === local.lastPlayId) return;
    /* everything published since the last id we showed, in order */
    const from = plays.findIndex(p => p.id === local.lastPlayId);
    const fresh = from >= 0 ? plays.slice(from + 1).map(p => p.id) : [latest];
    local.lastPlayId = latest;
    if (local.replayId) return;                 // a historical replay is on screen
    enqueue(fresh);
  }

  /* ---- install ----------------------------------------------------------- */
  function install() {
    if (local.ready || !window.PBEcastV6) return false;
    local.ready = true;
    local.mode = saved();
    const native = window.PBEcastV6.refresh;
    window.PBEcastV6.refresh = async function (...args) {
      const out = await native.apply(this, args);
      try { onData(); } catch (error) { console.warn('[pbecast-arcade]', error?.message || error); }
      return out;
    };
    const nativeLoad = window.PBEcastV6.load;
    window.PBEcastV6.load = async function (...args) {
      const out = await nativeLoad.apply(this, args);
      try {
        local.lastPlayId = null;
        mount(); applyMode(); wireLog();
        if (local.mode === 'arcade') { await ensureRenderer(); onData(); }
      } catch (error) { console.warn('[pbecast-arcade]', error?.message || error); }
      return out;
    };
    window.PBEcastArcade = {
      setMode, skipToLive, replayHistorical, local,
      /* QA / demo affordance. No UI reaches it and nothing in the normal flow
         calls it. It exists because there is no live NFL game to point PBEcast
         at outside the season, and a completed game is not in the current
         slate that chooseActive() picks from -- so a full published drive can
         only be demonstrated by loading that event directly. */
      async __demoGame(eventId) {
        /* focus() is PBEcast's own game switch: it sets activeId, fetches
           ?event=<id> -- which works for any published event, not just one in
           today's slate -- and re-patches the surface. The poll it schedules is
           then cleared, because the next refresh would call chooseActive() and
           replace the demo game with one from the current slate. */
        await window.PBEcastV6.focus(String(eventId));
        /* focus() resolves once its own fetch settles, but PBEcast may still be
           mid-patch; wait for the plays to actually be on state before the
           caller starts stepping through them. */
        for (let i = 0; i < 40 && !(state().detail?.plays || []).length; i++) {
          await new Promise(r => setTimeout(r, 150));
        }
        try { clearTimeout(state().poll); } catch {}
        local.lastPlayId = null;
        mount(); applyMode(); wireLog();
        await ensureRenderer();
        const d = state().detail;
        return { plays: (d?.plays || []).length, drives: (d?.drives || []).length };
      },
      /* step to a specific published play as if it had just arrived live */
      async __demoPlay(playId) {
        if (local.mode !== 'arcade') await setMode('arcade');
        await ensureRenderer();
        local.queue.length = 0; local.draining = false; local.replayId = null;
        setReplayBar(false);
        const a = normalize(playById(playId));
        if (!a) return null;
        local.lastPlayId = playId;
        render(a);
        local.replay.load(a);
        local.replay.start();
        return a;
      }
    };
    return true;
  }

  function boot() {
    if (install()) { if (onCast()) { mount(); applyMode(); wireLog(); if (local.mode === 'arcade') ensureRenderer().then(onData); } return; }
    if (!local.timer) local.timer = setInterval(() => { if (install()) { clearInterval(local.timer); local.timer = null; boot(); } }, 400);
  }

  window.addEventListener('pbe:upgrades-ready', boot);
  window.addEventListener('pbe:route-changed', () => setTimeout(boot, 60));
  document.addEventListener('DOMContentLoaded', boot, { once: true });
  if (document.readyState !== 'loading') boot();
})();
