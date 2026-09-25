/* PBE TOUCHDOWN TARGETS — the route, and the one client store for the
 * touchdown contract.
 *
 * This module is the sole client owner of /api/pbe-touchdown-targets. The
 * dashboard rail, the game-card badge and the Prop Board row badge all render
 * from the store it publishes, so four surfaces cost one read rather than
 * four. Nothing here computes a probability, ranks a player or decides an
 * abstention: every number on screen comes from the server, and a field the
 * server did not send renders as an em dash instead of a guess.
 *
 * It registers exactly one route (`tdtargets`), owns no page-wide mutation
 * observer and starts no timer.
 */
(() => {
  'use strict';

  const API = '/api/pbe-touchdown-targets';
  const ROUTE = 'tdtargets';

  const store = {
    version: 1,
    state: null,        /* public governance + coverage */
    slate: null,        /* Pro: this week's games */
    pro: null,          /* the entitlement the slate was fetched under */
    record: null,       /* graded history */
    error: null,
    loadedAt: null,
    loading: null,
  };

  const filters = { week: 'all', team: 'all', position: 'all', result: 'all', rank: 'primary', model: 'all' };

  /* ------------------------------------------------------------ utilities */

  const esc = value => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const num = value => {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const isPro = () => window.PBEPro?.state?.pro === true;

  /* A missing value is an em dash. It is never 0%, never -110, never "even". */
  const pct = (value, digits = 1) => {
    const n = num(value);
    return n === null ? '—' : `${(n * 100).toFixed(digits)}%`;
  };
  const points = value => {
    const n = num(value);
    return n === null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(1)}pp`;
  };
  const american = value => {
    const n = num(value);
    return n === null ? '—' : `${n > 0 ? '+' : ''}${Math.round(n)}`;
  };
  const units = value => {
    const n = num(value);
    return n === null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(2)}u`;
  };
  const kickoff = value => {
    const t = Date.parse(value || '');
    if (!Number.isFinite(t)) return '—';
    return new Date(t).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };
  const stamp = value => {
    const t = Date.parse(value || '');
    if (!Number.isFinite(t)) return '—';
    return new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };
  const teamLogo = team => {
    const code = String(team || '').trim();
    if (!code) return '';
    try { if (window.PBENFLMediaV2?.teamLogo) return window.PBENFLMediaV2.teamLogo(code); } catch (_) { /* fall through */ }
    return `https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/${code.toLowerCase()}.png`;
  };
  /* Identity-safe: a headshot is requested by ESPN athlete id and never by a
     name search, so a card can never show a different person's face. */
  const headshot = espnId => (/^\d+$/.test(String(espnId || ''))
    ? `https://a.espncdn.com/i/headshots/nfl/players/full/${espnId}.png` : '');
  const monogram = name => String(name || '').trim().split(/\s+/).map(part => part[0] || '').join('').slice(0, 2).toUpperCase();

  function teamImg(team) {
    const src = teamLogo(team);
    return src
      ? `<img src="${esc(src)}" alt="" width="22" height="22" loading="lazy" decoding="async" onerror="this.remove()">`
      : '';
  }
  function faceHtml(player, size = '') {
    const src = headshot(player?.espn_id);
    return `<span class="pbetd-face ${esc(size)}"><span aria-hidden="true">${esc(monogram(player?.name))}</span>${
      src ? `<img src="${esc(src)}" alt="${esc(player?.name || '')}" loading="lazy" decoding="async" onerror="this.remove()">` : ''
    }</span>`;
  }

  /* ------------------------------------------------------------- transport */

  async function json(url) {
    const response = await fetch(url, { cache: 'no-store', headers: { accept: 'application/json' }, credentials: 'same-origin' });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(body?.error || `http_${response.status}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  }

  async function load({ force = false } = {}) {
    if (store.loading) return store.loading;
    if (!force && store.loadedAt && Date.now() - store.loadedAt < 20000 && store.pro === isPro()) return store;
    store.loading = (async () => {
      const pro = isPro();
      store.error = null;
      try {
        store.state = await json(`${API}?view=state`);
      } catch (error) {
        store.error = error;
        store.state = null;
      }
      if (pro) {
        try {
          store.slate = await json(`${API}?view=current`);
        } catch (error) {
          /* A 401/403 here means the entitlement moved under us, not that the
             engine is quiet. It is kept as an error, never as an empty slate. */
          store.slate = null;
          if (error.status !== 401 && error.status !== 403) store.error = error;
        }
      } else {
        store.slate = null;
      }
      store.pro = pro;
      store.loadedAt = Date.now();
      store.loading = null;
      window.dispatchEvent(new CustomEvent('pbe:td-targets-ready', { detail: { pro } }));
      return store;
    })();
    return store.loading;
  }

  async function loadRecord({ force = false } = {}) {
    if (store.record && !force) return store.record;
    store.record = await json(`${API}?view=trackrecord`).catch(error => ({ error: error.message || 'unavailable' }));
    return store.record;
  }

  /* ------------------------------------------------------------- the hero */

  function engineDot(state) {
    const engine = String(state?.engine_state || '').toUpperCase();
    if (engine.includes('DEGRADED')) return 'degraded';
    if (String(state?.publication || '') === 'GATED') return 'gated';
    return '';
  }

  function heroHtml(state, slate) {
    const coverage = state?.coverage || {};
    const counts = slate?.counts || null;
    const engine = slate?.engine_state || (String(state?.engine_health || '').toUpperCase() !== 'HEALTHY'
      ? 'ENGINE DEGRADED — SOURCE UNAVAILABLE' : 'ENGINE READY');
    const record = state?.validation_performance || {};
    const hitRate = num(record.hit_rate);

    const stats = [
      ['Games analyzed', counts ? String(counts.games_analyzed) : String(coverage.games_evaluated ?? '—'), 'final pregame decisions'],
      ['Primary targets', counts ? String(counts.primary_targets) : String(coverage.target_issued ?? '—'), 'one per game, maximum'],
      ['Hit / pending', counts ? `${counts.hit} / ${counts.pending}` : '—', 'graded from the official box score'],
      ['Season primary record', hitRate === null ? '—' : pct(hitRate), `${record.decided ?? 0} graded`],
      ['Games abstained', counts ? String(counts.abstained) : String(coverage.abstained ?? '—'),
        coverage.abstention_rate === null || coverage.abstention_rate === undefined ? 'rate pending' : `${(coverage.abstention_rate * 100).toFixed(1)}% of decidable games`],
    ];

    return `<header class="pbetd-hero">
      <div class="pbetd-eyebrow"><i class="${esc(engineDot(state))}"></i>${esc(engine)}${state?.selector_version ? ` · SELECTOR v${esc(state.selector_version)}` : ''} · ${esc(state?.model_version || '')}</div>
      <h1 class="pbetd-title">PBE Touchdown Targets</h1>
      <p class="pbetd-kicker">Who the model expects to find the end zone. PBE names one primary target for every
      eligible game, locks it before kickoff, and lives with the result.</p>
      <div class="pbetd-strip">
        ${stats.map(([label, value, note]) => `<div class="pbetd-stat"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></div>`).join('')}
      </div>
    </header>`;
  }

  function scopeBanner(state) {
    if (!state) return '';
    if (String(state.engine_health || '').toUpperCase() !== 'HEALTHY') {
      return `<div class="pbetd-banner degraded"><strong>Engine degraded</strong><p>A source the engine depends on is
        not answering, so this slate may be incomplete. This is a source failure, not a slate the model had no opinion on.</p></div>`;
    }
    if (state.publication === 'GATED') {
      return `<div class="pbetd-banner"><strong>Validation scope</strong><p>${esc(state.scope_note || '')}
        ${esc(state.finalized_sample ?? 0)} of ${esc(state.finalized_required ?? 100)} finalized observations across
        ${esc(state.distinct_weeks ?? 0)} of ${esc(state.distinct_weeks_required ?? 4)} weeks.</p></div>`;
    }
    return '';
  }

  /* ------------------------------------------------------------ game cards */

  /* Which Player DNA product covers a position. Declared here because both
     the card and the click handler read it. */
  const DNA_ROUTE = { QB: 'qbdna', RB: 'rbdna', WR: 'wrdna', TE: 'tedna' };

  function envChips(game, target) {
    const environment = target?.environment || game?.environment || null;
    const market = target?.game_market || null;
    const chips = [];
    if (environment?.roof_state) chips.push(environment.weather_applies === false ? 'ROOFED' : String(environment.roof_state).toUpperCase());
    if (num(environment?.temp_f) !== null) chips.push(`${Math.round(environment.temp_f)}°F`);
    if (num(environment?.wind_mph) !== null) chips.push(`WIND ${Math.round(environment.wind_mph)} MPH`);
    if (environment?.condition) chips.push(String(environment.condition).toUpperCase());
    if (num(market?.total) !== null) chips.push(`TOTAL ${market.total}`);
    const spread = market?.spread_points && target?.player?.team ? num(market.spread_points[target.player.team]) : null;
    if (spread !== null) chips.push(`${esc(target.player.team)} ${spread > 0 ? '+' : ''}${spread}`);
    return chips.length
      ? `<div class="pbetd-env">${chips.map(chip => `<span class="pbetd-envchip">${esc(chip)}</span>`).join('')}</div>`
      : '';
  }

  function resultBadge(target) {
    const grade = target?.grade;
    if (!grade) return '<span class="pbetd-result pending">PENDING</span>';
    const result = String(grade.result || '').toLowerCase();
    const label = result === 'win' ? 'HIT' : result === 'loss' ? 'MISS' : result.toUpperCase();
    return `<span class="pbetd-result ${esc(result)}">${esc(label)}${
      result === 'win' && num(grade.offensive_td) ? ` · ${grade.offensive_td} TD` : ''}</span>`;
  }

  function driversHtml(target) {
    const drivers = Array.isArray(target?.drivers) ? target.drivers : [];
    if (!drivers.length) return '';
    return `<div class="pbetd-drivers">${drivers.map(driver => `<span class="pbetd-chip ${
      esc(driver.key === 'market' ? 'market' : driver.direction === 'up' ? 'up' : 'down')
    }" title="${esc(driver.detail || '')}">${esc(driver.label)}</span>`).join('')}</div>`;
  }

  function numbersHtml(target) {
    const market = target?.market || {};
    const edge = num(target?.edge_pp);
    const price = num(market.best_price);
    return `<div class="pbetd-numbers">
      <div class="pbetd-cell hero"><span>PBE TD probability</span><strong>${esc(pct(target?.model?.probability))}</strong></div>
      <div class="pbetd-cell"><span>Market implied</span><strong>${esc(pct(market.probability))}</strong></div>
      <div class="pbetd-cell ${edge === null ? 'muted' : edge > 0 ? 'up' : 'down'}"><span>PBE edge</span><strong>${esc(points(edge))}</strong></div>
      <div class="pbetd-cell ${price === null ? 'muted' : ''}"><span>Best TD price</span><strong>${
        price === null ? '—' : `${esc(american(price))}${market.best_book ? ` <small style="font-size:var(--fs-micro);color:var(--pbe-faint-text)">${esc(market.best_book)}</small>` : ''}`
      }</strong></div>
      <div class="pbetd-cell"><span>Confidence</span><strong>${esc(target?.model?.confidence || '—')}${
        num(market.books) === null ? '' : ` <small style="font-size:var(--fs-micro);color:var(--pbe-faint-text)">${market.books} book${market.books === 1 ? '' : 's'}</small>`
      }</strong></div>
    </div>`;
  }

  function targetBlock(target, rank, game = null) {
    if (!target) return '';
    const player = target.player || {};
    const save = game && /^\d{6,12}$/.test(String(game.espn_id || '')) ? (window.PBEMySunday?.saveButtonHtml?.({
      type: 'td_target', event_id: String(game.espn_id), gsis_id: /^00-\d{7}$/.test(String(player.gsis_id || '')) ? player.gsis_id : undefined,
      espn_id: /^\d{1,12}$/.test(String(player.espn_id || '')) ? String(player.espn_id) : undefined, season: window.PBESeason?.season?.() || null,
      label: `${player.name || 'Player'} · ${rank} TD target`.slice(0, 80), context: { source: 'td_targets', rank }
    }) || '') : '';
    const position = [player.position, player.team].filter(Boolean).join(' · ');
    return `<div class="pbetd-rank ${rank === 'secondary' ? 'secondary' : ''}">${rank === 'secondary' ? 'Secondary TD target' : 'Primary TD target'}</div>
      <div class="pbetd-player">
        ${faceHtml(player)}
        <div class="pbetd-who">
          <p class="pbetd-name">${player.gsis_id && DNA_ROUTE[String(player.position || '').toUpperCase()]
    ? `<a href="javascript:void(0)" data-pbetd-player="${esc(player.gsis_id)}" data-pbetd-position="${esc(player.position || '')}">${esc(player.name)}</a>`
    : esc(player.name)}</p>
          <p class="pbetd-meta">${esc(position)}${player.opponent ? ` ${player.at_home ? 'vs' : '@'} ${esc(player.opponent)}` : ''}</p>
        </div>${save}
      </div>
      ${numbersHtml(target)}
      ${driversHtml(target)}`;
  }

  function cardHtml(game) {
    const primary = game.primary || null;
    const secondary = game.secondary || null;
    const head = `<div class="pbetd-game">
      <span class="pbetd-matchup">${teamImg(game.away_team)}${esc(game.away_team || '—')} <em>@</em> ${teamImg(game.home_team)}${esc(game.home_team || '—')}</span>
      <span class="pbetd-kick">${esc(kickoff(game.kickoff_ts))}${game.week ? `<br>WEEK ${esc(game.week)}` : ''}</span>
    </div>`;

    if (game.outcome !== 'target_issued' || !primary) {
      const degraded = game.outcome === 'degraded';
      const pool = game.evaluated || {};
      const top = num(pool.top_probability);
      const floor = num(pool.floor);
      return `<article class="pbetd-card ${degraded ? 'degraded' : 'abstain'}">
        ${head}
        <div class="pbetd-none">
          <h4>${degraded ? 'No target — source unavailable' : 'No TD target'}</h4>
          <span class="pbetd-reason">${esc(game.reason_label || 'REASON UNAVAILABLE')}</span>
          <p>${esc(game.reason_copy || (degraded
    ? 'A source this decision depends on did not answer, so no target was published for this game.'
    : 'PBE evaluated the eligible scoring pool and did not identify a player probability strong enough to publish.'))}</p>
          ${pool.eligible_pool !== undefined ? `<span class="pbetd-pool">Evaluated ${esc(pool.eligible_pool)} of ${esc(pool.market_selections ?? 0)} priced selections${
    top === null ? '' : ` · best ${pct(top)}`}${floor === null ? '' : ` · threshold ${pct(floor)}`}</span>` : ''}
        </div>
        <div class="pbetd-foot">
          <span class="pbetd-locked">Decided <b>${esc(stamp(pool.decided_at))}</b></span>
          <span class="pbetd-links">${gameLinks(game)}</span>
        </div>
      </article>`;
    }

    return `<article class="pbetd-card">
      ${head}
      ${envChips(game, primary)}
      ${targetBlock(primary, 'primary', game)}
      ${secondary ? targetBlock(secondary, 'secondary', game) : ''}
      <div class="pbetd-foot">
        <span class="pbetd-locked">Locked <b>${esc(stamp(primary.locked?.at))}</b>${
  primary.locked?.before_kickoff === false ? ' · NOT PREGAME' : ''}</span>
        ${resultBadge(primary)}
        <span class="pbetd-links">${gameLinks(game)}</span>
      </div>
    </article>`;
  }

  function gameLinks(game) {
    const links = [];
    if (/^\d+$/.test(String(game.espn_id || ''))) {
      links.push(`<button type="button" class="pbetd-link" data-pbetd-game="${esc(game.espn_id)}" data-pbetd-kickoff="${esc(game.kickoff_ts || '')}">Game center</button>`);
    }
    links.push('<button type="button" class="pbetd-link" data-pbetd-route="propboard">Prop board</button>');
    links.push('<button type="button" class="pbetd-link" data-pbetd-route="bestline">Best line</button>');
    return links.join('');
  }

  /* ------------------------------------------------------- the record table */

  function optionsFor(rows, key, label) {
    const values = [...new Set(rows.map(row => row[key]).filter(value => value !== null && value !== undefined && value !== ''))]
      .sort((a, b) => (typeof a === 'number' ? a - b : String(a).localeCompare(String(b))));
    if (values.length < 2) return '';
    return `<label>${esc(label)}<select data-pbetd-filter="${esc(key)}">
      <option value="all">All</option>
      ${values.map(value => `<option value="${esc(value)}"${String(filters[key]) === String(value) ? ' selected' : ''}>${esc(value)}</option>`).join('')}
    </select></label>`;
  }

  function recordRows(record) {
    return (Array.isArray(record?.targets) ? record.targets : []).map(target => ({
      id: target.id,
      week: target.week,
      season: target.season,
      team: target.player?.team ?? null,
      position: target.player?.position ?? null,
      rank: target.target_rank,
      result: target.grade?.result ?? 'pending',
      model: target.model?.selector_version ?? null,
      target,
    }));
  }

  function applyFilters(rows) {
    const want = (key, value) => filters[key] === 'all' || String(filters[key]) === String(value);
    return rows.filter(row => want('week', row.week) && want('team', row.team) && want('position', row.position)
      && want('result', row.result) && want('rank', row.rank) && want('model', row.model));
  }

  /* One implementation of the record's arithmetic, and it never mixes
     publication scopes or ranks: the caller has already narrowed the rows. */
  function summarize(rows) {
    const graded = rows.filter(row => ['win', 'loss'].includes(row.result));
    const wins = graded.filter(row => row.result === 'win').length;
    const priced = graded.filter(row => num(row.target.grade?.units) !== null);
    const profit = priced.length === graded.length && graded.length
      ? graded.reduce((sum, row) => sum + num(row.target.grade.units), 0) : null;
    const probabilities = graded.map(row => num(row.target.model?.probability)).filter(value => value !== null);
    const briers = graded.map(row => num(row.target.grade?.brier)).filter(value => value !== null);
    return {
      graded: graded.length,
      pending: rows.filter(row => row.result === 'pending').length,
      voided: rows.filter(row => row.result === 'void').length,
      wins,
      losses: graded.length - wins,
      hitRate: graded.length ? wins / graded.length : null,
      profit,
      roi: profit === null || !graded.length ? null : profit / graded.length * 100,
      avgProbability: probabilities.length ? probabilities.reduce((a, b) => a + b, 0) / probabilities.length : null,
      brier: briers.length ? briers.reduce((a, b) => a + b, 0) / briers.length : null,
    };
  }

  function recordHtml(record) {
    if (!record || record.error) {
      return `<section class="pbetd-panel"><div class="pbetd-empty">The touchdown record could not be read${
        record?.error ? ` (${esc(record.error)})` : ''}. This is a source failure, not an empty record.</div></section>`;
    }
    const allRows = recordRows(record);
    const rows = applyFilters(allRows);
    const summary = summarize(rows);
    const coverage = record.coverage || {};

    const hero = [
      ['Record', `${summary.wins}-${summary.losses}`, `${summary.graded} graded`, summary.wins > summary.losses ? 'good' : summary.wins < summary.losses ? 'bad' : ''],
      ['Hit rate', summary.hitRate === null ? '—' : pct(summary.hitRate), 'graded targets only', ''],
      ['Units', units(summary.profit), '1u at the issued price', summary.profit > 0 ? 'good' : summary.profit < 0 ? 'bad' : ''],
      ['ROI', summary.roi === null ? '—' : `${summary.roi > 0 ? '+' : ''}${summary.roi.toFixed(1)}%`, 'per unit risked', summary.roi > 0 ? 'good' : summary.roi < 0 ? 'bad' : ''],
      ['Avg PBE probability', summary.avgProbability === null ? '—' : pct(summary.avgProbability), 'at issuance', ''],
      ['Brier', summary.brier === null ? '—' : summary.brier.toFixed(4), 'lower is better', ''],
      ['Games abstained', String(coverage.abstained ?? '—'),
        coverage.abstention_rate === null || coverage.abstention_rate === undefined ? 'rate pending' : `${(coverage.abstention_rate * 100).toFixed(1)}% of decidable games`, ''],
    ];

    const body = rows.length
      ? rows.map(row => {
        const target = row.target;
        const grade = target.grade;
        const unitsValue = num(grade?.units);
        return `<tr>
          <td>${esc(target.week ?? '—')}</td>
          <td>${esc(target.away_team || '—')} @ ${esc(target.home_team || '—')}</td>
          <td class="player">${esc(target.player?.name || '—')}</td>
          <td>${esc(target.player?.team || '—')}</td>
          <td>${esc(target.player?.position || '—')}</td>
          <td>${esc(String(target.target_rank || '').toUpperCase())}</td>
          <td>${esc(pct(target.model?.probability))}</td>
          <td>${esc(american(target.market?.best_price))}</td>
          <td>${grade?.result === 'win' ? `${esc(grade.offensive_td ?? 1)} TD` : grade ? '0 TD' : '—'}</td>
          <td>${resultBadge(target)}</td>
          <td class="${unitsValue === null ? '' : unitsValue > 0 ? 'pos' : unitsValue < 0 ? 'neg' : ''}">${esc(units(unitsValue))}</td>
          <td>v${esc(target.model?.selector_version ?? '—')}</td>
          <td class="pbetd-hash" title="${esc(target.receipt?.chain_hash || 'no receipt')}">${
  target.receipt?.chain_hash ? `#${esc(target.receipt.seq)} ${esc(String(target.receipt.chain_hash).slice(0, 10))}…` : '—'}</td>
        </tr>`;
      }).join('')
      : `<tr><td colspan="13" class="pbetd-empty">No graded touchdown targets match these filters.</td></tr>`;

    return `<section class="pbetd-panel">
      <div class="pbetd-panel-head">
        <div><span>Verified live track record</span><strong>Touchdown Targets</strong></div>
        <div class="pbetd-filters">
          <label>Rank<select data-pbetd-filter="rank">
            <option value="primary"${filters.rank === 'primary' ? ' selected' : ''}>Primary only</option>
            <option value="secondary"${filters.rank === 'secondary' ? ' selected' : ''}>Secondary only</option>
            <option value="all"${filters.rank === 'all' ? ' selected' : ''}>All published</option>
          </select></label>
          ${optionsFor(allRows, 'week', 'Week')}
          ${optionsFor(allRows, 'team', 'Team')}
          ${optionsFor(allRows, 'position', 'Position')}
          ${optionsFor(allRows, 'result', 'Result')}
          ${optionsFor(allRows, 'model', 'Selector')}
        </div>
      </div>
      <div class="pbetd-strip" style="padding:var(--s-4);border-top:0">
        ${hero.map(([label, value, note, cls]) => `<div class="pbetd-stat ${esc(cls)}"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></div>`).join('')}
      </div>
      <div class="pbetd-scroll"><table class="pbetd-table">
        <thead><tr>
          <th scope="col">Wk</th><th scope="col">Game</th><th scope="col">Target</th><th scope="col">Team</th>
          <th scope="col">Pos</th><th scope="col">Rank</th><th scope="col">PBE prob.</th><th scope="col">Issued odds</th>
          <th scope="col">Final</th><th scope="col">Result</th><th scope="col">Units</th><th scope="col">Selector</th><th scope="col">Receipt</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table></div>
      <div class="pbetd-note">${esc(record.grading?.pbe_target_result || '')}
      ${esc(record.grading?.non_offensive_touchdowns || '')}
      Units use the price frozen at issuance; a target with no executable price contributes none.
      Prediction accuracy and betting return are separate measurements and are reported separately.</div>
    </section>`;
  }

  /* ------------------------------------------------------------ the paywall */

  function lockHtml(state) {
    return `<section class="pbetd-lock">
      <h3>Touchdown Targets is an NFL Pro feature</h3>
      <p>The engine is running and every eligible game is being evaluated. The named target, the PBE probability
      and the model drivers are NFL Pro. The verified record below is public — losses included.</p>
      <div style="display:flex;gap:var(--s-2);flex-wrap:wrap">
        <button type="button" class="pbetd-btn gold" data-pbetd-upgrade="1">Unlock NFL Pro</button>
        <button type="button" class="pbetd-btn" data-pbetd-route="trackrecord">See the record</button>
      </div>
      ${state?.coverage ? `<span class="pbetd-pool">${esc(state.coverage.games_evaluated ?? 0)} games evaluated ·
        ${esc(state.coverage.target_issued ?? 0)} carrying a primary target ·
        ${esc(state.coverage.abstained ?? 0)} abstained</span>` : ''}
    </section>`;
  }

  /* --------------------------------------------------------------- render */

  function page() {
    const state = store.state;
    if (!state) {
      return `<section class="pbetd-wrap"><div class="pbetd-banner degraded"><strong>Engine unreachable</strong>
        <p>The Touchdown Targets contract did not answer. This is a source failure, not an empty slate.</p></div></section>`;
    }
    const slate = store.slate;
    const games = Array.isArray(slate?.games) ? slate.games : [];
    return `<section class="pbetd-wrap">
      ${heroHtml(state, slate)}
      ${scopeBanner(state)}
      ${store.pro
    ? (games.length
      ? `<div class="pbetd-board">${games.map(cardHtml).join('')}</div>`
      : `<section class="pbetd-panel"><div class="pbetd-empty">${esc(slate?.engine_state || 'ENGINE WAITING — UPCOMING SLATE NOT READY')}<br>
             No game in the current window has been evaluated yet. Every game that is evaluated appears here, with a
             target or with the reason the model abstained.</div></section>`)
    : lockHtml(state)}
      ${recordHtml(store.record)}
    </section>`;
  }

  function paint() {
    if (window.App?.current !== ROUTE) return;
    const container = document.getElementById('view-container');
    if (!container) return;
    container.innerHTML = page();
    wire();
  }

  function wire() {
    document.querySelectorAll('[data-pbetd-route]').forEach(button => button.addEventListener('click', () => {
      window.App?.nav(button.dataset.pbetdRoute);
    }));
    document.querySelectorAll('[data-pbetd-upgrade]').forEach(button => button.addEventListener('click', () => {
      window.PBEPro?.open?.('PBE Touchdown Targets');
    }));
    document.querySelectorAll('[data-pbetd-game]').forEach(button => button.addEventListener('click', () => {
      /* The one way into the game center for a chosen game. */
      window.PBEGameHandoff?.open?.(button.dataset.pbetdGame, { kickoff: button.dataset.pbetdKickoff || null, source: 'tdtargets' });
    }));
    document.querySelectorAll('[data-pbetd-player]').forEach(link => link.addEventListener('click', () => {
      openPlayer(link.dataset.pbetdPlayer, link.dataset.pbetdPosition);
    }));
    document.querySelectorAll('[data-pbetd-filter]').forEach(select => select.addEventListener('change', () => {
      filters[select.dataset.pbetdFilter] = select.value;
      paint();
    }));
  }

  /* Player DNA is split by position, so a target opens the product that
     actually covers him. The hand-off is the existing one-shot focus token
     player-dna-shared.js consumes: `{ route, player_id }`, where player_id is
     the GSIS id — the id those products key on. A target without a GSIS id or
     in a position with no DNA product falls back to the Prop Board rather than
     opening a product on the wrong person. */
  function openPlayer(gsisId, position) {
    const route = DNA_ROUTE[String(position || '').toUpperCase()];
    if (!route || !gsisId) { window.App?.nav('propboard'); return; }
    try {
      sessionStorage.setItem('pbe.playerdna.focus', JSON.stringify({
        route, player_id: String(gsisId), event_id: null, source: 'tdtargets',
      }));
    } catch (_) { /* navigation still works without the hand-off */ }
    window.App?.nav(route);
  }

  async function render() {
    const container = document.getElementById('view-container');
    if (container) {
      container.innerHTML = `<section class="pbetd-wrap"><header class="pbetd-hero">
        <div class="pbetd-eyebrow"><i></i>LOADING</div>
        <h1 class="pbetd-title">PBE Touchdown Targets</h1>
        <p class="pbetd-kicker">Who the model expects to find the end zone.</p></header></section>`;
    }
    await load();
    await loadRecord();
    paint();
  }

  /* ------------------------------------------------ the cross-surface store */

  /* What other surfaces ask this module. All of it is read-only and all of it
     comes from the server's own payload. */
  function primaryForGame(idOrGameId) {
    const key = String(idOrGameId || '');
    const games = Array.isArray(store.slate?.games) ? store.slate.games : [];
    const game = games.find(row => String(row.espn_id) === key || String(row.game_id) === key || String(row.event_id) === key);
    return game?.primary || null;
  }
  function evaluationForGame(idOrGameId) {
    const key = String(idOrGameId || '');
    const games = Array.isArray(store.slate?.games) ? store.slate.games : [];
    return games.find(row => String(row.espn_id) === key || String(row.game_id) === key || String(row.event_id) === key) || null;
  }
  /* Prop Board asks by player and event: only a target that actually exists
     for THAT event may badge a row, so a name that appears in two games cannot
     borrow the other game's badge. */
  function rankForPlayer(eventId, playerName) {
    const key = String(playerName || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key) return null;
    const games = Array.isArray(store.slate?.games) ? store.slate.games : [];
    for (const game of games) {
      if (String(game.event_id) !== String(eventId)) continue;
      for (const target of [game.primary, game.secondary]) {
        if (target && String(target.player?.key || '') === key) return target.target_rank;
      }
    }
    return null;
  }
  function badgeHtml(rank) {
    if (rank !== 'primary' && rank !== 'secondary') return '';
    return `<span class="pbetd-badge ${rank === 'secondary' ? 'secondary' : ''}">PBE ${rank === 'secondary' ? 'SECONDARY' : 'PRIMARY'} TARGET</span>`;
  }

  /* Compact rails for the dashboard and a game card. Rendered here so there is
     one implementation of a target's presentation in the product. */
  function railHtml({ limit = 6, heading = 'This week’s TD targets' } = {}) {
    const state = store.state;
    if (!state) return '';
    if (!store.pro) {
      return `<section class="pbetd-rail"><div class="pbetd-rail-head"><span>NFL Pro</span><strong>${esc(heading)}</strong>
        <button type="button" class="pbetd-btn" data-route="${ROUTE}" data-pbetd-route="${ROUTE}">Open</button></div>
        <p style="margin:0;font:400 var(--fs-sm)/1.55 var(--pbe-font-ui);color:var(--pbe-dim)">PBE names one touchdown
        target for every eligible game and locks it before kickoff. The named targets are NFL Pro.</p></section>`;
    }
    const games = (Array.isArray(store.slate?.games) ? store.slate.games : [])
      .filter(game => game.outcome === 'target_issued' && game.primary)
      .sort((a, b) => Date.parse(a.kickoff_ts || 0) - Date.parse(b.kickoff_ts || 0))
      .slice(0, limit);
    if (!games.length) {
      return `<section class="pbetd-rail"><div class="pbetd-rail-head"><span>${esc(store.slate?.engine_state || 'ENGINE WAITING')}</span>
        <strong>${esc(heading)}</strong><button type="button" class="pbetd-btn" data-route="${ROUTE}" data-pbetd-route="${ROUTE}">Open</button></div></section>`;
    }
    return `<section class="pbetd-rail">
      <div class="pbetd-rail-head"><span>${esc(games.length)} locked</span><strong>${esc(heading)}</strong>
      <button type="button" class="pbetd-btn" data-route="${ROUTE}" data-pbetd-route="${ROUTE}">All targets</button></div>
      <div class="pbetd-rail-list">${games.map(game => {
    const target = game.primary;
    return `<button type="button" class="pbetd-rail-row" data-route="${ROUTE}" data-pbetd-route="${ROUTE}">
          ${faceHtml(target.player)}
          <span><b>${esc(target.player?.name || '')}</b><em>${esc(game.away_team || '')} @ ${esc(game.home_team || '')}</em></span>
          <i>${esc(pct(target.model?.probability, 0))}</i>
        </button>`;
  }).join('')}</div>
    </section>`;
  }

  /* --------------------------------------------------------------- the nav */

  function navLink(label, badge) {
    const anchor = document.createElement('a');
    anchor.className = 'nav-item';
    anchor.id = `nav-${ROUTE}`;
    anchor.href = 'javascript:void(0)';
    anchor.innerHTML = `<span class="ni-icon">&#9679;</span> ${label} <span class="nav-badge" style="color:var(--pbe-pro)">${badge}</span>`;
    anchor.addEventListener('click', () => window.App?.nav(ROUTE));
    return anchor;
  }

  function installNav() {
    const group = document.getElementById('intelligence-nav-group');
    const anchorBefore = document.getElementById('nav-trackrecord') || document.getElementById('nav-picks');
    if (group && anchorBefore && !document.getElementById(`nav-${ROUTE}`)) {
      /* The anchor is found by id, so insert relative to ITS parent — it is not
         guaranteed to be a direct child of the group. */
      (anchorBefore.parentNode || group).insertBefore(navLink('Touchdown Targets', 'NEW · PRO'), anchorBefore);
    }
    const primary = document.querySelector('#pbe-sports-shell .pbes-primary');
    const shellAnchor = primary?.querySelector('[data-route="trackrecord"]') || primary?.querySelector('[data-route="picks"]');
    if (primary && shellAnchor && !primary.querySelector(`[data-route="${ROUTE}"]`)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pbes-nav-btn';
      button.dataset.route = ROUTE;
      button.textContent = 'TD Targets';
      button.addEventListener('click', () => (window.PBESportsShell?.go ? window.PBESportsShell.go(ROUTE) : window.App?.nav(ROUTE)));
      /* Shell nav buttons live inside .pbes-nav-group spans, so the anchor is a
         descendant of .pbes-primary, not a child: insert within its own parent.
         (primary.insertBefore threw NotFoundError on every boot before this.) */
      shellAnchor.parentNode.insertBefore(button, shellAnchor);
    }
    syncNav(window.App?.current || 'home');
  }

  function syncNav(route) {
    document.querySelectorAll(`[data-route="${ROUTE}"]`).forEach(element => element.classList.toggle('active', route === ROUTE));
    document.getElementById(`nav-${ROUTE}`)?.classList.toggle('active', route === ROUTE);
  }

  function installView() {
    if (!window.App?.VIEWS) return false;
    window.App.VIEWS[ROUTE] = render;
    return true;
  }

  function init() {
    installView();
    installNav();
    [120, 420, 1100].forEach(delay => setTimeout(() => { installView(); installNav(); }, delay));
  }

  /* The record section, for the Track Record route's TOUCHDOWN TARGETS
     category. It is the same markup this page renders, from the same store, so
     the two surfaces cannot report different numbers. Nothing about it can
     reach the game-pick or player-prop records: it is a separate request
     against a market-filtered endpoint. */
  async function recordSection() {
    await load();
    await loadRecord();
    return recordHtml(store.record);
  }

  window.PBETouchdownTargets = {
    version: 1,
    route: ROUTE,
    store,
    load,
    loadRecord,
    recordSection,
    render,
    railHtml,
    badgeHtml,
    primaryForGame,
    evaluationForGame,
    rankForPlayer,
    wire,
    installNav,
  };

  init();
  document.addEventListener('DOMContentLoaded', init, { once: true });
  window.addEventListener('pbe:upgrades-ready', init);
  window.addEventListener('pbe:route-changed', event => {
    installNav();
    syncNav(event.detail?.route || window.App?.current || '');
  });
  /* Entitlement can resolve after the first paint. Re-read under the new
     entitlement rather than leaving a locked page in front of a Pro member. */
  window.addEventListener('pbe:pro-state', () => {
    if (store.pro === isPro()) return;
    load({ force: true }).then(() => { if (window.App?.current === ROUTE) paint(); });
  });
})();
