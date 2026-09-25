/* PropBetEdge NFL — GAME SCRIPT LAB v1 ("Explore game script" in Matchups)
 *
 * A panel inside Matchup Research, not a route and not a replacement for the
 * Line Simulator or SGP Lab. Matchups asks for it (PBEGameScriptLab.panelHtml)
 * the way the command center asks Touchdown Targets for its rail; if this
 * module is absent the panel simply is not there.
 *
 * Reads the same contract as Opportunity Radar (/api/opportunity, view=script
 * per team: pbe-opportunity/v1 game-state splits) and computes with the pure
 * core (game-script-core-v1.js, window.PBEGameScriptCore). The calculation is
 * descriptive arithmetic over the team's own observed rates; the panel says
 * so, shows the sample and definition beside the controls, and labels every
 * output "Scenario estimate — not an official PBE prediction."
 *
 * Free research, like the rest of Matchups: the inputs are public-derived
 * season splits and nothing premium is computed or shipped here.
 */
(() => {
  'use strict';

  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const track = (name, params = {}) => { try { window.gtag?.('event', name, { pbe_surface: 'nfl', ...params }); } catch (_) {} };
  const NFLVERSE = { LAR: 'LA', WSH: 'WAS' };
  const toNflverse = a => NFLVERSE[String(a || '').toUpperCase()] || String(a || '').toUpperCase();
  const STATE_COPY = {
    baseline: ['Season baseline', 'Every play this season'],
    leading: ['Leading', 'Ahead by 7+ before the snap'],
    trailing: ['Trailing', 'Behind by 7+ before the snap'],
    balanced: ['Balanced', 'Within 6 points before the snap']
  };
  const core = () => window.PBEGameScriptCore;

  const cache = new Map();          // `${season}|${team}` -> { state, body, at }
  const ui = { key: null, season: null, teams: [], team: null, inputs: null };

  async function loadTeam(season, team) {
    const key = `${season}|${team}`;
    const hit = cache.get(key);
    if (hit && (hit.state === 'loading' || Date.now() - hit.at < 300000)) return hit.promise || hit;
    const entry = { state: 'loading', at: Date.now() };
    entry.promise = (async () => {
      try {
        const r = await fetch(`/api/opportunity?season=${season}&view=script&team=${encodeURIComponent(toNflverse(team))}`, { headers: { accept: 'application/json' } });
        const body = await r.json().catch(() => null);
        if (!r.ok || !body) Object.assign(entry, { state: 'UNAVAILABLE' });
        else if (body.state === 'NOT_YET_PUBLISHED') Object.assign(entry, { state: 'NOT_YET_PUBLISHED' });
        else if (body.state === 'READY' && body.available && Number(body.season) === Number(season)) Object.assign(entry, { state: 'READY', body });
        else if (body.state === 'READY') Object.assign(entry, { state: 'NO_GAMES', body });
        else Object.assign(entry, { state: 'UNAVAILABLE' });
      } catch (_) { entry.state = 'UNAVAILABLE'; }
      entry.at = Date.now();
      delete entry.promise;
      return entry;
    })();
    cache.set(key, entry);
    return entry.promise;
  }

  /* ---- markup ---------------------------------------------------------- */

  function panelHtml(p) {
    if (!core()) return '';
    const away = p?.game?.away?.abbr, home = p?.game?.home?.abbr, season = Number(p?.game?.season);
    if (!away || !home || !Number.isInteger(season)) return '';
    const key = `${season}|${away}|${home}`;
    if (ui.key !== key) Object.assign(ui, { key, season, teams: [away, home], team: home, inputs: null });
    queueMicrotask(() => hydrate());
    return `<section class="pbe17m-panel gsl" data-gsl aria-labelledby="gsl-title">
      <div class="pbe17m-head"><strong id="gsl-title">Explore game script</strong><span>SCENARIO LAB · DESCRIPTIVE</span></div>
      <p class="gsl-lede">How would ${esc(away)} or ${esc(home)}'s opportunities change if the game ran differently? Adjust the game state, the offense's volume and its pass/run tendency. Rates come from the team's own ${esc(season)} play-by-play in each game state.</p>
      <div data-gsl-body>${bodyHtml()}</div>
    </section>`;
  }

  function bodyHtml() {
    const entry = cache.get(`${ui.season}|${ui.team}`);
    const teamSwitch = `<div class="gsl-seg" role="group" aria-label="Team">${ui.teams.map(t => `<button type="button" data-gsl-team="${esc(t)}" aria-pressed="${t === ui.team}">${esc(t)} offense</button>`).join('')}</div>`;
    if (!entry || entry.state === 'loading') return `${teamSwitch}<p class="gsl-muted">Loading ${esc(ui.team)}'s game-state splits…</p>`;
    if (entry.state === 'NOT_YET_PUBLISHED') return `${teamSwitch}<p class="gsl-muted">No ${esc(ui.season)} play-by-play has been published yet, so there is nothing to explore. The Line Simulator and SGP Lab are unaffected.</p>`;
    if (entry.state === 'NO_GAMES') return `${teamSwitch}<p class="gsl-muted">${esc(ui.team)} has no completed ${esc(ui.season)} game in the play-by-play yet.</p>`;
    if (entry.state !== 'READY') return `${teamSwitch}<p class="gsl-muted">Game-state splits are temporarily unavailable. Nothing is estimated in their place. <button type="button" class="gsl-link" data-gsl-retry>Retry</button></p>`;
    const script = entry.body.script;
    if (!ui.inputs) ui.inputs = core().baselineInputs(script);
    const inp = core().normalizeInputs(script, ui.inputs);
    const src = inp.state === 'baseline' ? script.totals : script.states[inp.state];
    const observed = src && src.plays ? src.dropbacks / src.plays : null;
    const L = core().LIMITS;
    const states = core().STATES.map(s => {
      const n = s === 'baseline' ? script.totals.plays : script.states[s]?.plays || 0;
      return `<button type="button" data-gsl-state="${s}" aria-pressed="${inp.state === s}"${n < core().MIN_STATE_PLAYS ? ' data-thin="1"' : ''}><b>${esc(STATE_COPY[s][0])}</b><small>${n} plays</small></button>`;
    }).join('');
    const passPct = Math.round((inp.pass_rate ?? observed ?? 0.55) * 100);
    return `${teamSwitch}
      <fieldset class="gsl-controls"><legend class="gsl-sr">Scenario inputs</legend>
        <div class="gsl-field gsl-field-wide"><span class="gsl-k">Game state</span><div class="gsl-states" role="group" aria-label="Game state">${states}</div></div>
        <label class="gsl-field"><span class="gsl-k">Offensive plays per game <output data-gsl-volume-out>${esc(inp.volume)}</output></span><input type="range" min="${L.volume[0]}" max="${L.volume[1]}" step="1" value="${esc(Math.round(inp.volume))}" data-gsl-volume aria-describedby="gsl-vol-help"><small id="gsl-vol-help">Dropbacks plus designed runs. ${esc(ui.team)} averages ${esc((script.totals.plays / Math.max(1, script.games)).toFixed(1))} over ${esc(script.games)} game${script.games === 1 ? '' : 's'}.</small></label>
        <label class="gsl-field"><span class="gsl-k">Dropback rate <output data-gsl-pass-out>${inp.pass_rate === null ? `${passPct}% (observed)` : `${passPct}%`}</output></span><input type="range" min="${Math.round(L.passRate[0] * 100)}" max="${Math.round(L.passRate[1] * 100)}" step="1" value="${passPct}" data-gsl-pass aria-describedby="gsl-pass-help"><small id="gsl-pass-help">Observed in this state: ${observed === null ? '—' : `${(observed * 100).toFixed(1)}%`}. ${inp.pass_rate === null ? '' : '<button type="button" class="gsl-link" data-gsl-observed>Use observed rate</button>'}</small></label>
        <div class="gsl-actions"><button type="button" class="gsl-btn" data-gsl-reset>Reset to baseline</button><span data-gsl-save>${saveHtml(entry.body, inp)}</span></div>
      </fieldset>
      <div data-gsl-results>${resultsHtml(script, inp, entry.body)}</div>
      <details class="gsl-method"><summary>How the scenario is calculated</summary><div>
        <p><b>Game state</b> is the offense's score margin before each snap: leading by 7+, trailing by 7+, or balanced (within 6). Splits are what ${esc(ui.team)} has done in those situations this season — descriptive, not proof that a game script causes a play mix.</p>
        <p><b>The play universe:</b> plays = dropbacks + designed runs. Dropbacks split into pass attempts, sacks, scrambles and other dropbacks at the state's observed rates; attempts split into targets and attempts with no intended receiver. Designed runs exclude scrambles, kneels and two-point tries; runs without a credited carrier stay unallocated. No-plays, spikes, aborted snaps and special teams are excluded.</p>
        <p><b>Players</b> receive the scenario's targets and carries in proportion to their share in the same state, only when that state has at least ${core().MIN_PLAYER_TARGETS} targets / ${core().MIN_PLAYER_CARRIES} credited carries. Everything allocated adds back to the team figure; what is not allocated is listed.</p>
        <p>Calculation ${esc(core().VERSION)} · data ${esc(entry.body.source?.revision || '—')} · ${esc(entry.body.version || '')}. Source: nflverse play-by-play (CC-BY-4.0).</p>
      </div></details>`;
  }

  /* Only a scenario that computed can be saved: an unavailable state is
     explained, never bookmarked. */
  function saveHtml(body, inp) {
    if (!core().compute(body.script, inp).available) return '';
    return window.PBEMySunday?.saveButtonHtml?.({
      type: 'scenario', team: ui.team, season: ui.season,
      label: `${ui.team} script · ${STATE_COPY[inp.state][0]} · ${Math.round(inp.volume)} plays${inp.pass_rate === null ? '' : ` · ${Math.round(inp.pass_rate * 100)}% dropbacks`}`,
      context: { scenario: { state: inp.state, volume: Math.round(inp.volume), pass_rate: inp.pass_rate, data_revision: String(body.source?.revision || body.generated_at || 'unknown').slice(0, 80), calc_version: core().VERSION }, official: false, label: core().LABEL }
    }) || '';
  }

  const f1 = v => (Number.isFinite(v) ? v.toFixed(1) : '—');
  const signed = v => (Math.abs(v) < 0.05 ? '±0.0' : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`);

  function resultsHtml(script, inp) {
    const C = core();
    const base = C.compute(script, C.baselineInputs(script));
    const scen = C.compute(script, inp);
    if (!scen.available) return `<div class="gsl-unavail" role="status"><b>Scenario unavailable.</b> ${esc(scen.detail || scen.reason)}</div>`;
    const bad = [...C.validate(base), ...C.validate(scen)];
    if (bad.length) return `<div class="gsl-unavail" role="status"><b>Scenario withheld.</b> An internal consistency check failed (${esc(bad.join(', '))}); nothing is shown rather than a number that does not add up.</div>`;
    const rows = [
      ['Plays', 'plays', 0], ['Dropbacks', 'dropbacks', 0], ['Pass attempts', 'attempts', 1], ['Targets', 'targets', 2, 'data-gsl-targets'], ['No intended receiver', 'untargeted_attempts', 2],
      ['Sacks', 'sacks', 1], ['QB scrambles', 'scrambles', 1], ['Designed runs', 'designed_runs', 0], ['Credited carries', 'attributed_runs', 1]
    ];
    const table = `<div class="gsl-table" role="table" aria-label="Baseline and scenario, per game">
      <div class="gsl-tr gsl-th" role="row"><span role="columnheader">Per game</span><span role="columnheader" data-gsl-out="baseline">Baseline</span><span role="columnheader" data-gsl-out="scenario">Scenario</span><span role="columnheader">Change</span></div>
      ${rows.map(([label, k, indent, attr]) => `<div class="gsl-tr lvl${indent}" role="row"><span role="rowheader">${esc(label)}</span><span role="cell" data-gsl-out="baseline"><b ${attr || ''}>${f1(base.team[k])}</b></span><span role="cell" data-gsl-out="scenario"><b ${attr || ''}>${f1(scen.team[k])}</b></span><span role="cell" class="${scen.team[k] - base.team[k] > 0.05 ? 'up' : scen.team[k] - base.team[k] < -0.05 ? 'down' : ''}">${signed(scen.team[k] - base.team[k])}</span></div>`).join('')}
    </div>`;
    const players = side => {
      const S = scen.players[side], B = base.players[side];
      const title = side === 'targets' ? 'Targets by player' : 'Carries by player';
      if (!S.available) return `<div class="gsl-players"><h4>${title}</h4><p class="gsl-muted">${esc(S.reason)}</p></div>`;
      const top = S.rows.slice(0, 6);
      const rest = S.rows.slice(6);
      const bv = id => B.available ? (B.rows.find(r => r.gsis === id)?.value || 0) : null;
      const name = r => window.PBEPlayerIndex?.byGsis?.(r.gsis)?.name || r.name || r.gsis;
      const total = side === 'targets' ? scen.team.targets : scen.team.attributed_runs;
      const residual = side === 'targets' ? ['Attempts with no intended receiver', scen.team.untargeted_attempts] : ['Runs without a credited carrier', scen.team.unattributed_runs];
      return `<div class="gsl-players"><h4>${title} <small>${esc(STATE_COPY[inp.state][0].toLowerCase())} shares · ${S.sample} ${side === 'targets' ? 'targets' : 'carries'} observed</small></h4><ul>${top.map(r => `<li><button type="button" class="gsl-player" data-gsl-player="${esc(r.gsis)}">${esc(name(r))}</button><span class="gsl-share">${(r.share * 100).toFixed(1)}%</span><span class="gsl-val">${bv(r.gsis) === null ? '' : `<s>${f1(bv(r.gsis))}</s> → `}<b>${f1(r.value)}</b></span></li>`).join('')}${rest.length ? `<li class="gsl-other"><span>${rest.length} other player${rest.length === 1 ? '' : 's'}</span><span></span><span class="gsl-val"><b>${f1(rest.reduce((s, r) => s + r.value, 0))}</b></span></li>` : ''}<li class="gsl-total"><span>Allocated (adds to team)</span><span></span><span class="gsl-val"><b>${f1(total)}</b></span></li>${residual[1] > 0.05 ? `<li class="gsl-res"><span>${esc(residual[0])} — not allocated</span><span></span><span class="gsl-val">${f1(residual[1])}</span></li>` : ''}</ul></div>`;
    };
    return `<p class="gsl-label" role="note">${esc(C.LABEL)}</p>
      <p class="gsl-sample">${esc(STATE_COPY[inp.state][0])}: ${esc(STATE_COPY[inp.state][1].toLowerCase())} · ${scen.source.plays} ${esc(ui.team)} plays over ${scen.source.games} game${scen.source.games === 1 ? '' : 's'} · dropback rate ${(scen.team.pass_rate * 100).toFixed(1)}%${scen.source.pass_rate_overridden ? ' (set by you)' : ' (observed)'}</p>
      ${table}<div class="gsl-players-grid">${players('targets')}${players('carries')}</div>`;
  }

  /* ---- behaviour ------------------------------------------------------- */

  function body() { return document.querySelector('[data-gsl] [data-gsl-body]'); }
  async function hydrate() {
    if (!document.querySelector('[data-gsl]') || !ui.team) return;
    const key = `${ui.season}|${ui.team}`;
    const had = cache.get(key)?.state;
    if (had !== 'READY') { const b = body(); if (b) b.innerHTML = bodyHtml(); }
    await loadTeam(ui.season, ui.team);
    const b = body();
    if (b && had !== 'READY') b.innerHTML = bodyHtml();
    loadTeam(ui.season, ui.teams.find(t => t !== ui.team));   // warm the other side
    /* Full names come from the Player DNA index (by gsis id); until it lands
       the play-by-play short name is shown. */
    if (window.PBEPlayerIndex && !window.PBEPlayerIndex.ready) window.PBEPlayerIndex.load().then(repaintResults).catch(() => {});
  }
  function repaintResults() {
    const entry = cache.get(`${ui.season}|${ui.team}`);
    const host = document.querySelector('[data-gsl] [data-gsl-results]');
    if (!host || entry?.state !== 'READY') return;
    const inp = core().normalizeInputs(entry.body.script, ui.inputs);
    host.innerHTML = resultsHtml(entry.body.script, inp);
    const save = document.querySelector('[data-gsl] [data-gsl-save]');
    if (save) save.innerHTML = saveHtml(entry.body, inp);
    clearTimeout(repaintResults.t);
    repaintResults.t = setTimeout(() => track('pbe_scenario_run', { pbe_state: inp.state, pbe_pass_override: inp.pass_rate !== null }), 1200);
  }
  function repaintBody() { const b = body(); if (b) b.innerHTML = bodyHtml(); }

  document.addEventListener('click', event => {
    const root = event.target.closest?.('[data-gsl]');
    if (!root) return;
    if (event.target.closest('.pms-save')) { track('pbe_scenario_save', {}); return; }
    const t = event.target.closest('button');
    if (!t) return;
    if (t.dataset.gslTeam) { ui.team = t.dataset.gslTeam; ui.inputs = null; hydrate().then(repaintBody); repaintBody(); return; }
    if (t.dataset.gslState) { ui.inputs = { ...(ui.inputs || {}), state: t.dataset.gslState, pass_rate: null }; repaintBody(); track('pbe_scenario_run', { pbe_state: t.dataset.gslState }); return; }
    if (t.hasAttribute('data-gsl-reset')) { ui.inputs = null; repaintBody(); root.querySelector('[data-gsl-state="baseline"]')?.focus(); return; }
    if (t.hasAttribute('data-gsl-observed')) { ui.inputs = { ...(ui.inputs || {}), pass_rate: null }; repaintBody(); return; }
    if (t.hasAttribute('data-gsl-retry')) { cache.delete(`${ui.season}|${ui.team}`); hydrate(); return; }
    if (t.dataset.gslPlayer) { window.PBEOpportunityRadar?.focusPlayer?.(t.dataset.gslPlayer); }
  });
  document.addEventListener('input', event => {
    const el = event.target;
    if (!el.closest?.('[data-gsl]')) return;
    if (el.matches('[data-gsl-volume]')) { ui.inputs = { ...(ui.inputs || {}), volume: Number(el.value) }; const o = el.closest('label')?.querySelector('[data-gsl-volume-out]'); if (o) o.textContent = el.value; repaintResults(); }
    if (el.matches('[data-gsl-pass]')) { ui.inputs = { ...(ui.inputs || {}), pass_rate: Number(el.value) / 100 }; const o = el.closest('label')?.querySelector('[data-gsl-pass-out]'); if (o) o.textContent = `${el.value}%`; repaintResults(); }
  });
  window.addEventListener('pbe:mysunday-changed', () => { const s = document.querySelector('[data-gsl] [data-gsl-save]'); const e = cache.get(`${ui.season}|${ui.team}`); if (s && e?.state === 'READY') s.innerHTML = saveHtml(e.body, core().normalizeInputs(e.body.script, ui.inputs)); });

  window.PBEGameScriptLab = { version: 1, panelHtml, loadTeam, state: ui };
})();
