/* PropBetEdge NFL — Matchups v3.
 *
 * An opponent-vs-opponent intelligence surface: what each team does well, where
 * the opponent is vulnerable, what changed this week, and what the market
 * currently charges for it.
 *
 * WHAT CHANGED FROM v2, and why
 *
 *   NEWS. v2 matched a story to a team when the story's text contained the
 *   team's CITY. It also trusted the upstream `teams` tag, which on 2026-09-18
 *   filed 27 of 50 stories under ATL because they shared one boilerplate dek
 *   about Atlanta. Carolina @ Atlanta therefore listed Josh Allen, DJ Moore,
 *   Jalen Carter and a Bills-Lions recap as Atlanta news. There is now no team
 *   matcher in this file at all: attribution is PBENewsTrust.storiesForTeam,
 *   the one place in the product that answers that question.
 *
 *   INJURIES. v2 showed "CAR current injury stories" — the count of news rows
 *   whose text looked injury-related. That is a property of a text feed, not of
 *   a team. It is replaced by the structured ESPN designations nfl-intel already
 *   publishes: OUT / DOUBTFUL / QUESTIONABLE with a timestamp.
 *
 *   DEFAULT EVENT. v2 shipped a 32-hex QA fixture as the consumer default, so a
 *   user opening Matchups read a stale game. The event is now resolved from the
 *   current slate, server-side.
 *
 *   2025. v2 led with last season's record, point differential and playoff seed
 *   for a September 2026 game. That is historical baseline, and it now sits at
 *   the bottom, collapsed, labelled.
 *
 *   ONE REQUEST. v2 assembled the page from three unrelated browser calls. This
 *   reads /api/matchup-intel once.
 *
 * MATCHUP ADVANTAGE is efficiency against efficiency. PBE EDGE is model value
 * against a market price. They are different claims from different inputs and
 * they never share a panel.
 */
(() => {
  'use strict';

  const MARK = 'data-pbe-matchups-v3';
  const state = { eventId: null, payload: null, error: null, loading: false, token: 0, showHistory: false };

  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const arr = v => (Array.isArray(v) ? v : []);
  const isPro = () => Boolean(window.PBEPro?.state?.pro);

  /* The event comes from the URL or the selector. There is deliberately no
     fallback constant: with neither, the server resolves the current slate.
     
     Both link shapes are honoured, because app-core's deep-link contract
     accepts both: ?event=<id>#matchups and #matchups?event=<id>. Reading only
     location.search silently ignored the hash form and kept showing whichever
     game the slate resolved to, which looks exactly like a page that ignores
     the selector. */
  function currentEvent() {
    const fromApp = window.App?.params?.event;
    if (fromApp) return String(fromApp);
    const search = new URLSearchParams(location.search).get('event');
    if (search) return search;
    const hash = String(location.hash || '');
    const at = hash.indexOf('?');
    if (at >= 0) {
      const inHash = new URLSearchParams(hash.slice(at + 1)).get('event');
      if (inHash) return inHash;
    }
    return localStorage.getItem('pbe_nfl_event') || '';
  }

  /* ---- numbers ------------------------------------------------------------ */
  const num = (v, digits = 3) => (Number.isFinite(Number(v)) ? Number(v).toFixed(digits) : null);
  const signed = (v, digits = 3) => {
    const n = num(v, digits);
    return n === null ? null : (Number(v) > 0 ? `+${n}` : n);
  };
  /* "31st", not "31th". These are read by people, not parsed. */
  const ordinal = n => {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return null;
    const mod100 = Math.abs(v) % 100;
    if (mod100 >= 11 && mod100 <= 13) return `${v}th`;
    return `${v}${({ 1: 'st', 2: 'nd', 3: 'rd' })[Math.abs(v) % 10] || 'th'}`;
  };
  const pct = v => (v === null || v === undefined || v === '' ? null
    : (Number.isFinite(Number(v)) ? ordinal(v) : null));

  /* A metric is printed only when it has a value. UNAVAILABLE prints the word,
     never a zero, because 0.0 EPA/play is a real and different statement. */
  function metricTile(m, title) {
    if (!m || m.state === 'UNAVAILABLE' || m.value === null) {
      return `<div class="pbe17m-tile is-none"><dt>${esc(title)}</dt><dd>UNAVAILABLE</dd></div>`;
    }
    const p = pct(m.percentile);
    return `<div class="pbe17m-tile${m.limited ? ' is-limited' : ''}">
      <dt>${esc(title)}</dt>
      <dd>${esc(signed(m.value))}</dd>
      ${p !== null ? `<span class="pbe17m-pct">${esc(p)} pct</span>` : ''}
      ${m.plays !== null ? `<small>${esc(m.plays)} plays</small>` : ''}
      ${m.limited ? '<b class="pbe17m-limited">LIMITED SAMPLE</b>' : ''}
    </div>`;
  }

  /* ---- sections ----------------------------------------------------------- */
  function hero(p) {
    const g = p.game || {};
    const m = p.market || {};
    const side = (t, s) => `<div class="pbe17m-side">
      <div class="pbe17m-crest">${window.teamCrest ? window.teamCrest(t?.abbr, 52) : ''}</div>
      <div class="pbe17m-name">${esc(t?.name || t?.abbr || '—')}</div>
      ${s?.rating ? `<span class="pbe17m-ratepill is-${esc(String(s.rating.state).toLowerCase())}">${esc(s.rating.label)}</span>` : ''}
    </div>`;
    const kick = g.kickoff ? new Date(g.kickoff).toLocaleString('en-US',
      { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) : '—';
    return `<header class="pbe17m-hero">
      <div class="pbe17m-vs">
        ${side(g.away, p.teams?.away)}
        <div class="pbe17m-mid"><b>AT</b><span>${esc(kick)}</span>
          ${g.week ? `<small>${esc(g.season)} · WEEK ${esc(g.week)}</small>` : ''}</div>
        ${side(g.home, p.teams?.home)}
      </div>
      ${marketStrip(m)}
    </header>`;
  }

  function marketStrip(m) {
    if (!m || m.state === 'NO_CURRENT_MARKET') {
      return `<div class="pbe17m-market is-none"><b>NO CURRENT MARKET</b>
        <span>No book snapshot is available for this game.</span></div>`;
    }
    const cell = (label, value, sub) => `<div><dt>${esc(label)}</dt>
      <dd>${value === null || value === undefined ? '—' : esc(value)}</dd>
      ${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
    const age = Number.isFinite(Number(m.age_seconds)) ? `${Math.round(Number(m.age_seconds) / 60)}m ago` : null;
    const priced = v => (v === null || v === undefined ? null : (Number(v) > 0 ? `+${v}` : `${v}`));
    return `<div class="pbe17m-market">
      ${cell('SPREAD', m.spread?.home?.line ?? null, m.spread?.home?.price ? priced(m.spread.home.price) : null)}
      ${cell('TOTAL', m.total?.line ?? null, m.total?.price ? priced(m.total.price) : null)}
      ${cell('MONEYLINE', priced(m.moneyline?.home?.price ?? null), null)}
      ${cell('BOOKS', m.books ?? null)}
      <span class="pbe17m-fresh">${esc(age || 'snapshot time unknown')}${m.price_semantics ? ` · ${esc(m.price_semantics.replace(/_/g, ' ').toLowerCase())}` : ''}</span>
    </div>`;
  }

  function formPanel(side, who) {
    if (!side) return '';
    const r = side.rating || {};
    return `<section class="pbe17m-panel">
      <div class="pbe17m-head"><strong>${esc(side.team || who)} · CURRENT FORM</strong>
        <span class="pbe17m-ratepill is-${esc(String(r.state).toLowerCase())}">${esc(r.label || '—')}</span></div>
      ${r.note ? `<p class="pbe17m-note">${esc(r.note)}</p>` : ''}
      <dl class="pbe17m-tiles">
        ${metricTile(side.form?.offence, 'Offense EPA/play')}
        ${metricTile(side.form?.defence, 'Defense EPA/play allowed')}
        ${metricTile(side.form?.proe, 'PROE')}
        ${metricTile(side.form?.pace, 'Plays / game')}
      </dl>
      <p class="pbe17m-sample">${r.games_sample !== null && r.games_sample !== undefined
        ? `${esc(r.season || '')} · ${esc(r.games_sample)} games · ${esc(r.plays_sample ?? '—')} plays`
        : 'Sample unavailable'}${r.as_of_week ? ` · through week ${esc(r.as_of_week)}` : ''}</p>
      ${splitsBlock(side)}
    </section>`;
  }

  /* Each team's own classified profile. Separate from the collision on purpose:
     a pressure point needs both sides to qualify, and on a week where none does
     the reader still has to be able to see what each team is. */
  function profilePanel(p) {
    const block = (abbr, rows) => {
      if (!rows || !rows.length) {
        return `<div class="pbe17m-prof"><h4>${esc(abbr)}</h4>
          <p class="pbe17m-none">No dimension clears the strength or weakness threshold.</p></div>`;
      }
      return `<div class="pbe17m-prof"><h4>${esc(abbr)}</h4>
        <ul>${rows.map(r => `<li class="is-${esc(r.band.toLowerCase())}">
          <b>${esc(r.band)}</b><span>${esc(r.label)}</span>
          <em>${esc(pct(r.percentile) || '—')} pct</em>
          ${r.limited ? '<small class="pbe17m-limited">LIMITED SAMPLE</small>' : ''}
        </li>`).join('')}</ul></div>`;
    };
    const away = p.profile?.away, home = p.profile?.home;
    if (!away && !home) return '';
    return `<section class="pbe17m-panel">
      <div class="pbe17m-head"><strong>STRENGTHS &amp; WEAKNESSES</strong>
        <span>TOP ${esc(100 - (p.thresholds?.strength_percentile ?? 75))}% = STRENGTH · BOTTOM ${esc(p.thresholds?.weakness_percentile ?? 25)}% = WEAKNESS</span></div>
      <div class="pbe17m-profs">
        ${block(p.game?.away?.abbr || 'AWAY', away)}
        ${block(p.game?.home?.abbr || 'HOME', home)}
      </div>
    </section>`;
  }

  /* The Matchup Lab splits, from 2026 play-by-play. A split carries its own
     play sample because it is a different, smaller sample than the team total —
     a rush EPA over 18 carries is not the same claim as one over 180. */
  function splitsBlock(side) {
    const sp = side.splits;
    if (!sp || sp.state !== 'OK') {
      return `<p class="pbe17m-none">Pass / rush / explosive splits are not available for this team${
        sp?.reason ? ` (${esc(sp.reason.replace(/_/g, ' '))})` : ''}.</p>`;
    }
    const row = (label, m) => {
      if (!m || m.state === 'UNAVAILABLE' || m.value === null) {
        return `<tr><th>${esc(label)}</th><td colspan="3" class="pbe17m-na">UNAVAILABLE</td></tr>`;
      }
      const isRate = label.includes('Explosive');
      const shown = isRate ? `${(Number(m.value) * 100).toFixed(1)}%` : signed(m.value);
      return `<tr${m.limited ? ' class="is-limited"' : ''}>
        <th>${esc(label)}</th>
        <td>${esc(shown)}</td>
        <td>${esc(pct(m.percentile) || '—')}</td>
        <td>${esc(m.plays ?? '—')}${m.limited ? ' <b>LTD</b>' : ''}</td>
      </tr>`;
    };
    return `<div class="pbe17m-splits">
      <h5>Matchup lab · ${esc(sp.games ?? '—')} game${sp.games === 1 ? '' : 's'}</h5>
      <table class="pbe17m-table">
        <thead><tr><th>Split</th><th>EPA / rate</th><th>Pct</th><th>Plays</th></tr></thead>
        <tbody>
          ${row('Pass offense', sp.offence?.pass)}
          ${row('Rush offense', sp.offence?.rush)}
          ${row('Explosive gained', sp.offence?.explosive)}
          ${row('Pass defense allowed', sp.defence?.pass)}
          ${row('Rush defense allowed', sp.defence?.rush)}
          ${row('Explosive allowed', sp.defence?.explosive)}
        </tbody>
      </table>
    </div>`;
  }

  /* Who actually does the work. Pro: this is role leverage, not identity. */
  function rolePanel(p) {
    const r = p.role || {};
    if (r.state === 'PRO_REQUIRED') {
      return `<section class="pbe17m-panel is-pro">
        <div class="pbe17m-head"><strong>PLAYERS WHO SHAPE THIS MATCHUP</strong><span>NFL PRO</span></div>
        <p class="pbe17m-note">Snap share, target share, carry share and depth rank for the players who
        touch these matchups are part of NFL Pro.</p>
        <button type="button" class="pbe17m-cta" onclick="window.PBEPro?.open?.('upgrade')">Unlock player role</button>
      </section>`;
    }
    if (r.state !== 'OK') return '';
    const side = (abbr, block) => {
      const rows = arr(block?.players);
      if (!rows.length) return `<div class="pbe17m-roleside"><h4>${esc(abbr)}</h4>
        <p class="pbe17m-none">No usage rows resolved for this team.</p></div>`;
      return `<div class="pbe17m-roleside"><h4>${esc(abbr)}</h4>
        <table class="pbe17m-table">
          <thead><tr><th>Player</th><th>Snap</th><th>Tgt</th><th>Car</th><th>Dep</th></tr></thead>
          <tbody>${rows.map(x => `<tr>
            <td>${esc(x.name || '—')}<small>${esc(x.position || '')}</small></td>
            <td>${x.snap_share === null ? '—' : esc(`${Math.round(x.snap_share * 100)}%`)}</td>
            <td>${esc(x.targets ?? 0)}${x.target_share ? `<small>${Math.round(x.target_share * 100)}%</small>` : ''}</td>
            <td>${esc(x.carries ?? 0)}${x.carry_share ? `<small>${Math.round(x.carry_share * 100)}%</small>` : ''}</td>
            <td>${esc(x.depth_rank ?? '—')}</td>
          </tr>`).join('')}</tbody>
        </table>
        ${rows.some(x => x.week_over_week_state === 'ONE_WEEK_ONLY')
          ? '<p class="pbe17m-none">Week-over-week change needs two played weeks; only one exists so far.</p>' : ''}
      </div>`;
    };
    return `<section class="pbe17m-panel">
      <div class="pbe17m-head"><strong>PLAYERS WHO SHAPE THIS MATCHUP</strong>
        <span>2026 USAGE · JOINED ON ID, NEVER NAME</span></div>
      <div class="pbe17m-roles">${side(p.game?.away?.abbr, p.role.away)}${side(p.game?.home?.abbr, p.role.home)}</div>
    </section>`;
  }

  function redZonePanel(p) {
    const rz = p.red_zone || {};
    if (rz.state === 'PRO_REQUIRED') {
      /* A teaser, not silence. The role panel shows one, and a section that
         simply vanishes for free readers reads as a section that does not
         exist rather than one they have not paid for. */
      return `<section class="pbe17m-panel is-pro">
        <div class="pbe17m-head"><strong>RED ZONE BATTLE</strong><span>NFL PRO</span></div>
        <p class="pbe17m-note">Trips inside the 20, conversion rate, and the carries and targets that
        get them there are part of NFL Pro.</p>
        <button type="button" class="pbe17m-cta" onclick="window.PBEPro?.open?.('upgrade')">Unlock red zone</button>
      </section>`;
    }
    if (rz.state !== 'OK') return '';
    const side = (abbr, z) => {
      if (!z) return `<div class="pbe17m-rz"><h4>${esc(abbr)}</h4><p class="pbe17m-none">No red-zone rows.</p></div>`;
      const cell = (k, v) => `<div><dt>${esc(k)}</dt><dd>${v === null || v === undefined ? '—' : esc(v)}</dd></div>`;
      return `<div class="pbe17m-rz"><h4>${esc(abbr)}</h4>
        <dl class="pbe17m-tiles">
          ${cell('Trips', z.trips)}
          ${cell('TD rate', z.touchdown_rate === null ? null : `${Math.round(z.touchdown_rate * 100)}%`)}
          ${cell('Carries in 20', z.carries_inside_20)}
          ${cell('Targets in 20', z.targets_inside_20)}
          ${cell('Goal-to-go', z.goal_to_go_plays)}
        </dl>
        ${z.limited ? '<b class="pbe17m-limited">LIMITED SAMPLE</b>' : ''}</div>`;
    };
    return `<section class="pbe17m-panel">
      <div class="pbe17m-head"><strong>RED ZONE BATTLE</strong><span>yardline_100 &le; 20</span></div>
      <div class="pbe17m-rzs">${side(p.game?.away?.abbr, rz.away)}${side(p.game?.home?.abbr, rz.home)}</div>
    </section>`;
  }

  function pressurePanel(p) {
    const points = arr(p.pressure_points);
    if (!points.length) {
      return `<section class="pbe17m-panel"><div class="pbe17m-head"><strong>PRESSURE POINTS</strong>
        <span>MATCHUP ADVANTAGE</span></div>
        <p class="pbe17m-none">No strength-versus-weakness collision is supported by the current
        metrics. This is not a prediction that the game is even — it is the absence of a
        classified mismatch in the data we hold.</p></section>`;
    }
    return `<section class="pbe17m-panel">
      <div class="pbe17m-head"><strong>PRESSURE POINTS</strong><span>MATCHUP ADVANTAGE · NOT A PRICE</span></div>
      ${points.map(pt => `<div class="pbe17m-press">
        <b>${esc(pt.offense_team)} ${esc(pt.dimension)} offense → ${esc(pt.defense_team)} ${esc(pt.dimension)} defense</b>
        <p>${esc(pt.statement)}</p>
        ${pt.limited ? '<span class="pbe17m-limited">LIMITED SAMPLE</span>' : ''}
      </div>`).join('')}
    </section>`;
  }

  function availabilityPanel(p) {
    const block = (label, a) => {
      if (!a || a.state === 'UNAVAILABLE') {
        return `<div class="pbe17m-avail"><h4>${esc(label)}</h4>
          <p class="pbe17m-none">No current designation report.</p></div>`;
      }
      if (!a.rows.length) {
        return `<div class="pbe17m-avail"><h4>${esc(label)}</h4>
          <p class="pbe17m-none">No listed designations on the current report.</p></div>`;
      }
      return `<div class="pbe17m-avail"><h4>${esc(label)}</h4>
        <ul>${a.rows.map(r => `<li>
          <b class="is-${esc(String(r.status).toLowerCase())}">${esc(r.status)}</b>
          <span>${esc(r.player)}</span>
          ${r.position ? `<em>${esc(r.position)}</em>` : ''}
          ${r.detail ? `<small>${esc(r.detail)}</small>` : ''}
        </li>`).join('')}</ul>
        ${a.total_rows > a.rows.length ? `<small class="pbe17m-more">${esc(a.total_rows - a.rows.length)} further rows on the full report</small>` : ''}
      </div>`;
    };
    const fresh = p.availability?.freshness;
    return `<section class="pbe17m-panel">
      <div class="pbe17m-head"><strong>AVAILABILITY WATCH</strong>
        <span>${esc(fresh ? `REPORTED ${new Date(fresh).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'REPORTED DESIGNATIONS')}</span></div>
      <div class="pbe17m-avails">
        ${block(p.game?.away?.abbr || 'AWAY', p.availability?.away)}
        ${block(p.game?.home?.abbr || 'HOME', p.availability?.home)}
      </div>
    </section>`;
  }

  function mattersPanel(p) {
    const rows = arr(p.what_matters_most);
    if (!rows.length) return '';
    return `<section class="pbe17m-panel">
      <div class="pbe17m-head"><strong>WHAT MATTERS MOST</strong><span>EVERY LINE TRACES TO A METRIC ABOVE</span></div>
      <ul class="pbe17m-matters">${rows.map(r => `<li>${esc(r.text)}</li>`).join('')}</ul>
    </section>`;
  }

  function modelPanel(p) {
    const m = p.model || {};
    if (m.state === 'PRO_REQUIRED') {
      return `<section class="pbe17m-panel is-pro">
        <div class="pbe17m-head"><strong>PBE MODEL CONTEXT</strong><span>PBE EDGE · MODEL vs MARKET</span></div>
        <p class="pbe17m-note">Fair values and the gap to the current market are part of NFL Pro.
        This is a different question from the matchup advantage above: it prices the market, not the football.</p>
        <button type="button" class="pbe17m-cta" onclick="window.PBEPro?.open?.('upgrade')">Unlock PBE model context</button>
      </section>`;
    }
    if (m.state !== 'OK' || !arr(m.rows).length) {
      return `<section class="pbe17m-panel"><div class="pbe17m-head"><strong>PBE MODEL CONTEXT</strong><span>PBE EDGE</span></div>
        <p class="pbe17m-none">No current model row for this game.</p></section>`;
    }
    return `<section class="pbe17m-panel">
      <div class="pbe17m-head"><strong>PBE MODEL CONTEXT</strong><span>PBE EDGE · MODEL vs MARKET</span></div>
      <table class="pbe17m-table"><thead><tr><th>Market</th><th>PBE fair</th><th>Market</th><th>Gap</th></tr></thead>
      <tbody>${arr(m.rows).slice(0, 8).map(r => `<tr>
        <td>${esc(r.player || r.market || '—')}</td>
        <td>${esc(r.fair_line ?? '—')}</td>
        <td>${esc(r.market_consensus_line ?? '—')}</td>
        <td>${esc(r.fair_line_gap_yards ?? '—')}</td></tr>`).join('')}</tbody></table>
      ${m.model_version ? `<p class="pbe17m-sample">Model ${esc(m.model_version)}</p>` : ''}
    </section>`;
  }

  /* News: no matcher here. The shared trust guard answers the question. */
  function newsPanel(p) {
    const raw = p.news?.raw;
    const items = arr(raw?.articles || raw?.items || raw?.stories);
    if (!items.length || !window.PBENewsTrust) return '';
    window.PBENewsTrust.prepare(items);
    const forTeam = abbr => window.PBENewsTrust.storiesForTeam(items, abbr, { limit: 4 });
    const away = forTeam(p.game?.away?.abbr), home = forTeam(p.game?.home?.abbr);
    if (!away.length && !home.length) return '';
    const list = (label, rows) => (!rows.length ? '' : `<div class="pbe17m-news">
      <h4>${esc(label)}</h4>
      <ul>${rows.map(a => `<li><a href="${esc(a.url || '#')}" target="_blank" rel="noopener">${esc(a.title || '')}</a>
        <small>${esc(a.source || '')}</small></li>`).join('')}</ul></div>`);
    return `<section class="pbe17m-panel">
      <div class="pbe17m-head"><strong>CURRENT NEWS</strong><span>TEAM-ATTRIBUTED ONLY</span></div>
      <div class="pbe17m-newsgrid">${list(p.game?.away?.abbr, away)}${list(p.game?.home?.abbr, home)}</div>
    </section>`;
  }

  function qualityPanel(p) {
    const q = p.data_quality || {};
    const row = (k, v) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`;
    return `<details class="pbe17m-quality"><summary>Data quality &amp; sources</summary>
      <dl>
        ${row('Ratings', q.ratings?.state === 'OK' ? `${q.ratings.teams} teams · through week ${q.ratings.as_of_week ?? '—'}` : `unavailable (${q.ratings?.reason || '—'})`)}
        ${row('Market', q.market?.state === 'OK' ? `captured ${q.market.captured_at || '—'}` : 'no current snapshot')}
        ${row('Availability', q.availability?.state === 'OK' ? `reported ${q.availability.generated_at || '—'}` : `unavailable (${q.availability?.reason || '—'})`)}
        ${row('Event resolution', p.game?.resolution_rule || '—')}
        ${row('Strength threshold', `${p.thresholds?.strength_percentile}th percentile`)}
        ${row('Weakness threshold', `${p.thresholds?.weakness_percentile}th percentile`)}
        ${row('Limited sample', `under ${p.thresholds?.limited_sample_plays} plays`)}
      </dl>
      <h5>Inputs this page does not have</h5>
      <ul>${arr(q.missing_inputs).map(m => `<li><b>${esc(m.input)}</b> — ${esc(m.reason)}</li>`).join('')}</ul>
    </details>`;
  }

  function shell(p) {
    return `<section class="pbe17m" ${MARK}>
      ${hero(p)}
      ${mattersPanel(p)}
      <div class="pbe17m-grid">${formPanel(p.teams?.away, 'AWAY')}${formPanel(p.teams?.home, 'HOME')}</div>
      ${profilePanel(p)}
      ${pressurePanel(p)}
      ${rolePanel(p)}
      ${availabilityPanel(p)}
      ${redZonePanel(p)}
      ${modelPanel(p)}
      ${newsPanel(p)}
      ${qualityPanel(p)}
    </section>`;
  }

  /* ---- data --------------------------------------------------------------- */
  async function load() {
    const token = ++state.token;
    state.loading = true; state.error = null;
    const id = currentEvent();
    try {
      const url = `/api/matchup-intel${id ? `?event_id=${encodeURIComponent(id)}` : ''}`;
      const response = await fetch(url, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
      const body = await response.json();
      if (token !== state.token) return;
      if (!body?.ok) throw new Error(body?.error || `matchup_intel_${response.status}`);
      state.payload = body;
      state.eventId = body.game?.event_id || null;
    } catch (error) {
      if (token !== state.token) return;
      state.error = String(error.message || error);
    } finally {
      if (token === state.token) state.loading = false;
    }
    render();
  }

  function render() {
    const host = document.getElementById('view-container');
    if (!host || window.App?.current !== 'matchups') return '';
    if (state.loading && !state.payload) {
      host.innerHTML = `<section class="pbe17m"><p class="pbe17m-none">Resolving the current slate…</p></section>`;
      return '';
    }
    if (state.error) {
      host.innerHTML = `<section class="pbe17m"><div class="pbe17m-panel">
        <div class="pbe17m-head"><strong>MATCHUP INTELLIGENCE</strong><span>UNAVAILABLE</span></div>
        <p class="pbe17m-none">${esc(state.error)}</p></div></section>`;
      return '';
    }
    if (!state.payload) { load(); return ''; }
    host.innerHTML = shell(state.payload);
    return '';
  }

  /* ---- install ------------------------------------------------------------ */
  function install() {
    if (window.App?.VIEWS) window.App.VIEWS.matchups = render;
    window.addEventListener('pbe:event-changed', () => { state.payload = null; load(); });
    window.addEventListener('hashchange', () => {
      if (window.App?.current !== 'matchups') return;
      const next = currentEvent();
      if (next && next !== state.eventId) { state.payload = null; load(); }
    });
    window.addEventListener('pbe:pro-state', () => { state.payload = null; load(); });
  }

  window.PBEMatchups = { load, render, state };
  install();
  document.addEventListener('DOMContentLoaded', install, { once: true });
})();
