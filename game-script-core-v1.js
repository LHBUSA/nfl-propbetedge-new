/* PBE GAME SCRIPT LAB — calculation core (pure; browser global + Node import).
 *
 * Explores how different game assumptions change a team's offensive
 * opportunities. DESCRIPTIVE ARITHMETIC, NOT A MODEL: every rate comes from
 * the team's own current-season play-by-play (pbe-opportunity/v1, the same
 * contract as Opportunity Radar), split by the pre-snap game state the play
 * was run in. Moving a slider re-weights those observed rates; it does not
 * say how a game will unfold. No win probability, no score distribution, no
 * touchdowns, no confidence, no simulation count.
 *
 * THE UNIVERSE (the contract's own):
 *   plays     = dropbacks + designed runs  (no-plays, two-point tries,
 *               kneels, spikes, aborted snaps and special teams excluded)
 *   dropbacks = attempts + sacks + scrambles + other dropbacks
 *   attempts  = targets + untargeted attempts (no intended receiver)
 *   designed runs = attributed carries + runs without a credited carrier
 * Scrambles stay the quarterback's: they are never allocated as carries, and
 * a dropback is never allocated as a target unless it was an attempt with a
 * receiver in the observed rates.
 *
 * PLAYERS get a share only where the same source window has a real sample of
 * targets / carries; otherwise the team scenario still works and the player
 * allocation says why it is unavailable. Everything allocated adds back to
 * the team total; what is not allocated is shown, not dropped.
 */
(function (root) {
  'use strict';

  const VERSION = 'game-script/1.0.0';
  const LIMITS = { volume: [40, 90], passRate: [0.25, 0.85] };
  const MIN_STATE_PLAYS = 60;
  const MIN_PLAYER_TARGETS = 25;
  const MIN_PLAYER_CARRIES = 15;
  const STATES = ['baseline', 'leading', 'trailing', 'balanced'];
  const LABEL = 'Scenario estimate — not an official PBE prediction.';

  const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
  const div = (a, b) => (b > 0 ? a / b : 0);
  const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

  function sourceOf(script, state) {
    if (state === 'baseline') return script.totals;
    return script.states?.[state] || null;
  }

  /* Baseline inputs for a team: its observed plays per game and its observed
     dropback rate over every state. */
  function baselineInputs(script) {
    const T = script.totals;
    const games = Math.max(1, script.games || 1);
    return {
      state: 'baseline',
      volume: round(clamp(T.plays / games, LIMITS.volume), 1),
      pass_rate: null
    };
  }

  function normalizeInputs(script, inputs = {}) {
    const base = baselineInputs(script);
    const state = STATES.includes(inputs.state) ? inputs.state : 'baseline';
    const volume = Number.isFinite(Number(inputs.volume)) ? round(clamp(Number(inputs.volume), LIMITS.volume), 1) : base.volume;
    const pr = inputs.pass_rate === null || inputs.pass_rate === undefined || inputs.pass_rate === '' ? null : Number(inputs.pass_rate);
    const pass_rate = pr === null || !Number.isFinite(pr) ? null : round(clamp(pr, LIMITS.passRate), 3);
    return { state, volume, pass_rate };
  }

  function playerRows(script, state, key) {
    return (script.players || []).map(p => {
      const n = state === 'baseline' ? p[key] : p.st?.[state]?.[key] || 0;
      return { gsis: p.gsis_id || p.gsis, espn: p.espn_id || p.espn || null, name: p.pbp_name || p.name || null, n };
    }).filter(p => p.n > 0);
  }

  function allocate(rows, total, sourceTotal) {
    const list = rows.map(r => ({ ...r, share: div(r.n, sourceTotal), value: total * div(r.n, sourceTotal) })).sort((a, b) => b.value - a.value || String(a.gsis).localeCompare(String(b.gsis)));
    return list;
  }

  function compute(script, rawInputs) {
    if (!script || !script.totals) return { available: false, reason: 'NO_TEAM_DATA', version: VERSION };
    const inputs = normalizeInputs(script, rawInputs);
    const src = sourceOf(script, inputs.state);
    const games = script.games || 0;
    if (!src || src.plays < MIN_STATE_PLAYS) {
      return { available: false, reason: 'STATE_SAMPLE_TOO_SMALL', detail: `${src?.plays || 0} ${inputs.state} plays this season; at least ${MIN_STATE_PLAYS} are needed to use that state's rates.`, inputs, version: VERSION, label: LABEL };
    }
    const observedRate = div(src.dropbacks, src.plays);
    const passRate = inputs.pass_rate === null ? observedRate : inputs.pass_rate;
    const plays = inputs.volume;
    const dropbacks = plays * passRate;
    const designedRuns = plays - dropbacks;
    const rSack = div(src.sacks, src.dropbacks), rScr = div(src.scrambles, src.dropbacks), rOther = div(src.other_dropbacks || 0, src.dropbacks), rAtt = div(src.attempts, src.dropbacks);
    const attempts = dropbacks * rAtt;
    const targets = attempts * div(src.targets, src.attempts);
    const untargeted = attempts - targets;
    const unattributedRate = div(src.unattributed_runs || 0, src.designed_runs);
    const attributedRuns = designedRuns * (1 - unattributedRate);

    const team = {
      plays, dropbacks, attempts, sacks: dropbacks * rSack, scrambles: dropbacks * rScr, other_dropbacks: dropbacks * rOther,
      designed_runs: designedRuns, targets, untargeted_attempts: untargeted, attributed_runs: attributedRuns, unattributed_runs: designedRuns - attributedRuns,
      pass_rate: passRate
    };

    const tRows = playerRows(script, inputs.state, 't');
    const cRows = playerRows(script, inputs.state, 'c');
    const tSample = tRows.reduce((s, r) => s + r.n, 0);
    const cSample = cRows.reduce((s, r) => s + r.n, 0);
    const players = {
      targets: tSample >= MIN_PLAYER_TARGETS ? { available: true, sample: tSample, rows: allocate(tRows, targets, tSample) } : { available: false, sample: tSample, reason: `Only ${tSample} targets were recorded in this state; player shares need at least ${MIN_PLAYER_TARGETS}. The team numbers above still apply.` },
      carries: cSample >= MIN_PLAYER_CARRIES ? { available: true, sample: cSample, rows: allocate(cRows, attributedRuns, cSample) } : { available: false, sample: cSample, reason: `Only ${cSample} credited carries were recorded in this state; player shares need at least ${MIN_PLAYER_CARRIES}.` }
    };

    return {
      available: true,
      version: VERSION,
      label: LABEL,
      inputs,
      source: { state: inputs.state, plays: src.plays, dropbacks: src.dropbacks, designed_runs: src.designed_runs, games, observed_pass_rate: observedRate, pass_rate_overridden: inputs.pass_rate !== null },
      team,
      players
    };
  }

  /* Invariants the UI refuses to render without. Returns [] when sound. */
  function validate(result) {
    const v = [];
    if (!result?.available) return v;
    const t = result.team;
    for (const [k, x] of Object.entries(t)) if (!Number.isFinite(x) || x < -1e-9) v.push(`negative_or_nan:${k}`);
    if (t.pass_rate < 0 || t.pass_rate > 1) v.push('pass_rate_out_of_bounds');
    const eq = (a, b) => Math.abs(a - b) < 1e-6;
    if (!eq(t.dropbacks + t.designed_runs, t.plays)) v.push('plays_not_conserved');
    if (!eq(t.attempts + t.sacks + t.scrambles + t.other_dropbacks, t.dropbacks)) v.push('dropbacks_not_conserved');
    if (!eq(t.targets + t.untargeted_attempts, t.attempts)) v.push('attempts_not_conserved');
    if (!eq(t.attributed_runs + t.unattributed_runs, t.designed_runs)) v.push('runs_not_conserved');
    const P = result.players;
    if (P.targets.available && !eq(P.targets.rows.reduce((s, r) => s + r.value, 0), t.targets)) v.push('targets_not_conserved');
    if (P.carries.available && !eq(P.carries.rows.reduce((s, r) => s + r.value, 0), t.attributed_runs)) v.push('carries_not_conserved');
    for (const side of ['targets', 'carries']) if (P[side].available) for (const r of P[side].rows) if (r.value < 0 || r.share < 0 || r.share > 1) v.push(`player_bounds:${side}`);
    return v;
  }

  const api = { VERSION, LIMITS, STATES, MIN_STATE_PLAYS, MIN_PLAYER_TARGETS, MIN_PLAYER_CARRIES, LABEL, baselineInputs, normalizeInputs, compute, validate };
  root.PBEGameScriptCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
