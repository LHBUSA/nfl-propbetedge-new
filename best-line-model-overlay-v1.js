/* PropBetEdge NFL — Best Line Pro model overlay v1
 *
 * Best Line owns market truth. PBE Card owns the already entitlement-gated
 * decision model. This additive layer joins the two in the rendered table; it
 * never fetches model data itself and never derives PBE values from consensus.
 *
 * Values shown here are FROZEN AT SIGNAL ISSUE. They are not a newly computed
 * current valuation. A dedicated current fair-value snapshot can replace this
 * overlay later without changing immutable Picks economics.
 */
(() => {
  'use strict';

  const TEAM_CODES = {
    'arizona cardinals':'ARI','atlanta falcons':'ATL','baltimore ravens':'BAL','buffalo bills':'BUF',
    'carolina panthers':'CAR','chicago bears':'CHI','cincinnati bengals':'CIN','cleveland browns':'CLE',
    'dallas cowboys':'DAL','denver broncos':'DEN','detroit lions':'DET','green bay packers':'GB',
    'houston texans':'HOU','indianapolis colts':'IND','jacksonville jaguars':'JAX','kansas city chiefs':'KC',
    'las vegas raiders':'LV','los angeles chargers':'LAC','los angeles rams':'LAR','miami dolphins':'MIA',
    'minnesota vikings':'MIN','new england patriots':'NE','new orleans saints':'NO','new york giants':'NYG',
    'new york jets':'NYJ','philadelphia eagles':'PHI','pittsburgh steelers':'PIT','san francisco 49ers':'SF',
    'seattle seahawks':'SEA','tampa bay buccaneers':'TB','tennessee titans':'TEN','washington commanders':'WSH'
  };
  const ALIAS = { LA:'LAR', WAS:'WSH', JAC:'JAX' };
  let ensurePending = false;
  let queued = false;

  const arr = v => Array.isArray(v) ? v : [];
  const n = v => (v === null || v === undefined || v === '' ? NaN : Number(v));
  const esc = v => String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const pct = v => Number.isFinite(n(v)) ? `${(n(v) * 100).toFixed(1)}%` : '—';
  const pp = v => Number.isFinite(n(v)) ? `${n(v) > 0 ? '+' : ''}${(n(v) * 100).toFixed(1)}pp` : '—';
  const signed = v => Number.isFinite(n(v)) ? `${n(v) > 0 ? '+' : ''}${Math.round(n(v) * 10) / 10}` : '—';
  const american = v => Number.isFinite(n(v)) ? `${n(v) > 0 ? '+' : ''}${Math.round(n(v))}` : '—';
  const when = v => {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-US', { timeZone:'America/New_York', hour:'numeric', minute:'2-digit' }) + ' ET';
  };

  function code(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const named = TEAM_CODES[raw.toLowerCase()];
    if (named) return named;
    const upper = raw.toUpperCase();
    if (/^[A-Z]{2,3}$/.test(upper)) return ALIAS[upper] || upper;
    const last = raw.split(/\s+/).slice(-1)[0]?.toLowerCase();
    const namedByLast = Object.entries(TEAM_CODES).find(([name]) => name.endsWith(` ${last}`));
    return namedByLast?.[1] || upper;
  }

  /* Transforms of the STORED v2 latent state. These are byte-equal to
   * pick-math.mjs (normalCdf, americanToImpliedProb) and are pinned to it by
   * test. They introduce no model: the latent margin comes from the engine's
   * own evaluation, and only the NUMBER it is evaluated against changes. */
  function normalCdf(x) {
    const z = Number(x);
    if (!Number.isFinite(z)) return NaN;
    const sign = z < 0 ? -1 : 1;
    const a = Math.abs(z) / Math.sqrt(2);
    const t = 1 / (1 + 0.3275911 * a);
    const erf = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-a * a);
    return 0.5 * (1 + sign * erf);
  }

  /* Break-even: the probability the listed price demands. Vig included, because
   * this is what the bettor must actually beat at that number. */
  function breakEven(price) {
    const p = n(price);
    if (!Number.isFinite(p) || p === 0) return NaN;
    return p > 0 ? 100 / (p + 100) : Math.abs(p) / (Math.abs(p) + 100);
  }

  /* Model cover probability at an arbitrary spread number, from the stored
   * latent margin. spreadCoverProbability() is normalCdf((margin + line)/sigma). */
  function coverAt(margin, line, sigma) {
    const m = n(margin), l = n(line), sd = n(sigma);
    if (!Number.isFinite(m) || !Number.isFinite(l) || !Number.isFinite(sd) || sd <= 0) return NaN;
    return normalCdf((m + l) / sd);
  }

  function probToAmerican(prob) {
    const p = n(prob);
    if (!Number.isFinite(p) || p <= 0 || p >= 1) return NaN;
    return p >= 0.5 ? -100 * p / (1 - p) : 100 * (1 - p) / p;
  }

  function mounted() {
    return window.App?.current === 'bestline' && Boolean(document.querySelector('.pbebl'));
  }

  function accessState() {
    const pro = window.PBEPro?.state || {};
    if (pro.loading) return 'loading';
    if (pro.pro !== true) return 'locked';
    const store = window.PBECard?.store;
    if (store?.busy) return 'loading';
    if (store?.mode === 'pro' && store?.data) return 'ready';
    if (store?.error || [401,403,503].includes(Number(store?.status))) return 'unavailable';
    return 'loading';
  }

  function ensureProStore() {
    if (!mounted() || window.PBEPro?.state?.pro !== true || ensurePending) return;
    const store = window.PBECard?.store;
    if (store?.mode === 'pro' && store?.data && !store?.error) return;
    if (typeof window.PBECard?.ensure !== 'function') return;
    ensurePending = true;
    Promise.resolve(window.PBECard.ensure(true)).finally(() => {
      ensurePending = false;
      queue();
    });
  }

  function currentCard(event, market) {
    const away = code(event?.away), home = code(event?.home);
    if (!away || !home) return null;
    return arr(window.PBECard?.cards?.()).find(card =>
      String(card?.market || '') === market
      && code(card?.matchup?.away) === away
      && code(card?.matchup?.home) === home
    ) || null;
  }

  function sideSelected(card, market, side) {
    if (market === 'total') {
      return String(card?.selection?.over_under || '').toUpperCase() === String(side?.side || '').toUpperCase();
    }
    return code(card?.selection?.team) === code(side?.side);
  }

  function stateHtml(state) {
    if (state === 'locked') return {
      fair: '<b>NFL PRO</b><small>Model layer locked</small>',
      edge: '<b>NFL PRO</b><small>Unlock decision intelligence</small>'
    };
    if (state === 'unavailable') return {
      fair: '<span class="pbebl-na">Unavailable</span><small>Verified model read unavailable</small>',
      edge: '<span class="pbebl-na">Unavailable</span><small>No model value is guessed</small>'
    };
    return {
      fair: '<span class="pbebl-na">Checking model…</span>',
      edge: '<span class="pbebl-na">Checking model…</span>'
    };
  }

  /* ---- evaluations: the model layer Best Line actually renders -------------
   * Sourced from PBECard.store.data.model_evaluations, which the Pro backend
   * fetched from the orchestrator's own evaluate() snapshot. A market does NOT
   * need an issued pick to show fair value; it needs a successful ELIGIBLE
   * evaluation. Nothing here derives a model number from consensus. */

  function evaluations() {
    return window.PBECard?.store?.data?.model_evaluations || null;
  }

  function evalGame(event) {
    const ev = evaluations();
    if (!ev?.available) return null;
    const away = code(event?.away), home = code(event?.home);
    if (!away || !home) return null;
    return arr(ev.games).find(g => code(g.away) === away && code(g.home) === home) || null;
  }

  function evalSide(event, market, side) {
    const g = evalGame(event);
    if (!g) return null;
    const want = code(side?.side);
    return arr(g.markets).find(m => {
      if (String(m.market) !== market) return false;
      if (market === 'total') {
        return String(m.over_under || '').toUpperCase() === String(side?.side || '').toUpperCase();
      }
      return code(m.team) === want || code(m.side) === want;
    }) || null;
  }

  /* Freshness: the evaluation instant, and whether the market has moved since. */
  function staleNote(ev, m) {
    const evalAt = ev?.evaluated_at || m?.evaluated_at || null;
    const evalTape = m?.tape_captured_at || ev?.tape_captured_at || null;
    const shownTape = window.PBECommandCenter?.store?.bestline?.data?.captured_at || null;
    const moved = evalTape && shownTape && Date.parse(shownTape) > Date.parse(evalTape);
    return {
      at: evalAt ? when(evalAt) : '',
      moved: Boolean(moved),
      label: moved ? 'market moved since evaluation' : 'evaluated at this tape',
    };
  }

  function statusHtml(m) {
    if (m.integrity_status === 'MODEL_DISABLED') return {
      fair: '<b>MODEL DISABLED</b><small>Dedicated total model required</small>',
      edge: '<b>NOT MODELED</b><small>No total model is published</small>'
    };
    if (m.integrity_status === 'ANOMALY_REVIEW') return {
      fair: '<b>QUARANTINED</b><small>Under review · no value published</small>',
      edge: `<b>REVIEW</b><small>${esc(m.integrity_reason || 'decision integrity')}</small>`
    };
    if (m.integrity_status === 'INPUT_UNAVAILABLE') return {
      fair: '<b>UNAVAILABLE</b><small>Model input missing · nothing estimated</small>',
      edge: '<b>UNAVAILABLE</b><small>No value is guessed</small>'
    };
    return null;
  }

  /* Totals: a dedicated, market-calibrated validation model. One expected total
   * drives both sides, so Over and Under are complements of one distribution.
   * Labelled so nobody reads it as a trained proprietary forecast. */
  function totalHtml(m, side, ev) {
    const expected = n(m.expected_total);
    const prob = n(m.model_prob);
    if (!Number.isFinite(expected) || !Number.isFinite(prob)) return {
      fair: '<b>UNAVAILABLE</b><small>No consensus total to anchor to</small>',
      edge: '<b>UNAVAILABLE</b><small>No value is guessed</small>'
    };
    const bestLine = n(side?.best?.line);
    const bestPrice = n(side?.best?.price);
    const bestBook = side?.best?.book || '';
    const ou = String(m.over_under || side?.side || '').toUpperCase() === 'UNDER' ? 'Under' : 'Over';
    const sigma = n(m.total_sigma);

    /* Probability AT the best executable number, from the same expected total. */
    let probAtBest = prob;
    if (Number.isFinite(bestLine) && Number.isFinite(sigma) && sigma > 0) {
      const over = 1 - normalCdf((bestLine - expected) / sigma);
      probAtBest = ou === 'Under' ? 1 - over : over;
    }
    const be = breakEven(bestPrice);
    const edgeAtBest = Number.isFinite(be) ? probAtBest - be : NaN;
    const fresh = staleNote(ev, m);
    const at = Number.isFinite(bestLine)
      ? `${pct(probAtBest)} ${ou} at ${bestLine}${Number.isFinite(bestPrice) ? ` ${american(bestPrice)}` : ''}`
      : `${pct(probAtBest)} ${ou}`;

    return {
      fair: `<b>${esc(String(expected))}</b><small>${esc(at)}</small><small>${esc(`PBE TOTAL · MARKET-CALIBRATED VALIDATION${fresh.at ? ` · ${fresh.at}` : ''}`)}</small>`,
      edge: `<b>${esc(Number.isFinite(edgeAtBest) ? pp(edgeAtBest) : '—')}</b><small>EDGE AT BEST · ${esc(Number.isFinite(be) ? `vs ${pct(be)} break-even at ${american(bestPrice)}${bestBook ? ` · ${bestBook}` : ''}` : 'no executable price')}</small><small>Market-anchored, zero structural residual</small>`
    };
  }

  function modelHtml(event, market, side) {
    const state = accessState();
    if (state !== 'ready') return stateHtml(state);

    const ev = evaluations();
    const m = evalSide(event, market, side);

    if (m) {
      if (m.integrity_status === 'MARKET_CALIBRATED') return totalHtml(m, side, ev);
      const status = statusHtml(m);
      if (status) return status;

      if (m.integrity_status === 'ELIGIBLE') {
        const modelProb = n(m.model_prob);
        if (!Number.isFinite(modelProb)) return stateHtml('unavailable');
        const fresh = staleNote(ev, m);
        const version = esc(ev?.model_version ?? '—');
        const scope = ev?.trained === true ? 'OFFICIAL' : 'VALIDATION';
        const sigma = n(ev?.spread_sigma);

        /* THE EXECUTABLE NUMBER. This is Best Line: the question a row answers
         * is "what is the PBE edge at the best price actually on offer here",
         * not "how does the model compare to a consensus nobody can bet". */
        const bestLine = n(side?.best?.line);
        const bestPrice = n(side?.best?.price);
        const bestBook = side?.best?.book || '';

        /* Model probability AT the best number. For a spread that means
         * re-stating the stored latent margin against that exact line; for a
         * moneyline the model's win probability is already number-independent. */
        let probAtBest = modelProb;
        let atLabel = '';
        if (market === 'spread') {
          const margin = n(m.latent_margin);
          const c = coverAt(margin, bestLine, sigma);
          if (Number.isFinite(c)) {
            probAtBest = c;
            atLabel = `cover at ${signed(bestLine)}${Number.isFinite(bestPrice) ? ` ${american(bestPrice)}` : ''}`;
          } else {
            /* No latent state to re-state safely: fall back to the evaluated
             * number and say so rather than implying the best line was used. */
            atLabel = `cover at ${signed(n(m.market_line))} (evaluated line)`;
          }
        } else if (market === 'moneyline') {
          atLabel = `win probability${Number.isFinite(bestPrice) ? ` · at ${american(bestPrice)}` : ''}`;
        }

        /* PBE FAIR stays pure model truth: the model's own fair number. */
        let fair = pct(modelProb);
        const fairLine = n(m.model_line);
        if (market === 'spread' && Number.isFinite(fairLine)) {
          fair = `${code(side?.side)} ${Math.abs(fairLine) < 0.05 ? 'PK' : signed(fairLine)}`;
        } else if (market === 'moneyline') {
          fair = american(probToAmerican(modelProb));
        }
        const detail = `${pct(probAtBest)} ${atLabel}`;

        /* PRIMARY: edge against the executable price. SECONDARY: consensus,
         * kept as a market benchmark and clearly named as one. */
        const be = breakEven(bestPrice);
        const edgeAtBest = Number.isFinite(be) ? probAtBest - be : NaN;
        const consensusEdge = n(m.edge_pct);

        const edgeMain = Number.isFinite(edgeAtBest) ? pp(edgeAtBest) : '—';
        const beNote = Number.isFinite(be)
          ? `vs ${pct(be)} break-even at ${american(bestPrice)}${bestBook ? ` · ${esc(bestBook)}` : ''}`
          : 'no executable price on this row';
        const consensusNote = Number.isFinite(consensusEdge)
          ? `Consensus edge: ${pp(consensusEdge)}`
          : '';

        return {
          fair: `<b>${esc(fair)}</b><small>${esc(detail)}</small><small>${esc(`PBE MODEL · ${scope} v${version}${fresh.at ? ` · ${fresh.at}` : ''}${fresh.moved ? ' · market moved since evaluation' : ''}`)}</small>`,
          edge: `<b>${esc(edgeMain)}</b><small>EDGE AT BEST · ${esc(beNote)}</small>${consensusNote ? `<small>${esc(consensusNote)}</small>` : ''}`
        };
      }
    }

    /* No evaluation for this market yet (engine has not run against this tape). */
    if (ev && ev.available === false) return stateHtml('unavailable');
    return {
      fair: '<span class="pbebl-na">Not evaluated</span><small>No current model evaluation for this market</small>',
      edge: '<span class="pbebl-na">Not evaluated</span>'
    };
  }

  function setCell(cell, html, sig) {
    if (!cell || cell.dataset.pbeModelSig === sig) return;
    cell.dataset.pbeModelSig = sig;
    cell.innerHTML = html;
  }

  function apply() {
    queued = false;
    if (!mounted()) return;
    ensureProStore();

    const data = window.PBECommandCenter?.store?.bestline?.data;
    const state = accessState();
    for (const event of arr(data?.events)) {
      /* getElementById takes a RAW id. CSS.escape is for selectors and escapes a
       * leading digit (95c0... -> \39 5c0...), so every event id starting with a
       * digit silently failed to match and its cells were never written. */
      const game = document.getElementById(`bl-${String(event.id || '')}`);
      if (!game) continue;
      const rows = [...game.querySelectorAll('.pbebl-table > tbody > .pbebl-row')];
      const ordered = [
        ['spread', event?.markets?.spread],
        ['total', event?.markets?.total],
        ['moneyline', event?.markets?.moneyline]
      ].flatMap(([market, sides]) => Object.values(sides || {}).filter(Boolean).map(side => [market, side]));

      ordered.forEach(([market, side], i) => {
        const row = rows[i];
        if (!row) return;
        const model = modelHtml(event, market, side);
        const sig = `${state}|${event.id}|${market}|${side?.side}|${model.fair}|${model.edge}`;
        setCell(row.querySelector('[data-label="PBE fair"]'), model.fair, `fair|${sig}`);
        setCell(row.querySelector('[data-label="Model edge"]'), model.edge, `edge|${sig}`);
      });
    }

    const terms = document.querySelectorAll('.pbebl-legend [data-term="fair"] p, .pbebl-legend [data-term="edge"] p');
    if (terms[0]) terms[0].textContent = 'NFL Pro shows the PBE model value from the current engine evaluation. Never estimated from consensus.';
    if (terms[1]) terms[1].textContent = 'PBE model probability minus the vig-free market probability at evaluation. Totals are not modelled.';
  }

  function queue() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(apply);
  }

  function install() {
    const host = document.getElementById('view-container');
    if (host) {
      new MutationObserver(queue).observe(host, { childList:true, subtree:true });
    }
    window.addEventListener('pbe:card-ready', queue);
    window.addEventListener('pbe:pro-state', queue);
    window.addEventListener('pbe:route-changed', queue);
    window.addEventListener('pbe:upgrades-ready', queue);
    window.addEventListener('hashchange', queue);
    /* The rows, the entitlement and the evaluations resolve independently, and
     * an event can land before the table exists. A short bounded settle keeps a
     * cell from being left as whatever the table first rendered. */
    let settles = 0;
    const settle = setInterval(() => {
      settles += 1;
      queue();
      if (settles >= 20) clearInterval(settle);
    }, 500);
    queue();
    window.PBEBestLineModelOverlay = { apply, currentCard, modelHtml, accessState };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once:true });
  else install();
})();