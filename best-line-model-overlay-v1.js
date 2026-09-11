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

  function modelHtml(event, market, side) {
    const state = accessState();
    if (state !== 'ready') return stateHtml(state);

    const card = currentCard(event, market);
    if (!card) return {
      fair: '<span class="pbebl-na">No active signal</span><small>No issued PBE value for this market</small>',
      edge: '<span class="pbebl-na">No active signal</span><small>Best Line will not invent one</small>'
    };

    const selected = sideSelected(card, market, side);
    const selectedProb = n(card?.model?.prob);
    const selectedMarketProb = n(card?.market_prob);
    if (!Number.isFinite(selectedProb) || !Number.isFinite(selectedMarketProb)) return stateHtml('unavailable');

    const modelProb = selected ? selectedProb : 1 - selectedProb;
    const marketProb = selected ? selectedMarketProb : 1 - selectedMarketProb;
    const edge = modelProb - marketProb;
    const scope = card?.publication_scope === 'official' ? 'OFFICIAL' : 'VALIDATION';
    const version = esc(card?.model?.version || card?.model_version || '—');
    const issued = when(card?.issue?.at);
    const sideNote = selected ? 'SIGNAL SIDE' : 'PAIRED SIDE';

    let fair = pct(modelProb);
    let detail = `PBE probability · ${sideNote}`;
    const fairLine = n(card?.model?.fair_line);
    if (market === 'spread' && Number.isFinite(fairLine)) {
      const value = selected ? fairLine : -fairLine;
      fair = `${code(side?.side)} ${Math.abs(value) < 0.05 ? 'PK' : signed(value)}`;
      detail = `${pct(modelProb)} model · ${sideNote}`;
    } else if (market === 'moneyline') {
      fair = american(probToAmerican(modelProb));
      detail = `${pct(modelProb)} model · ${sideNote}`;
    } else if (market === 'total') {
      const issueLine = n(card?.issue?.line);
      detail = `${sideNote}${Number.isFinite(issueLine) ? ` · at issued ${issueLine}` : ''}`;
    }

    const meta = `ISSUED MODEL · ${scope} v${version}${issued ? ` · ${esc(issued)}` : ''}`;
    return {
      fair: `<b>${esc(fair)}</b><small>${esc(detail)}</small><small>${meta}</small>`,
      edge: `<b>${esc(pp(edge))}</b><small>vs ${esc(pct(marketProb))} issue market · frozen at issue</small>`
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
    for (const event of arr(data?.events)) {
      const game = document.getElementById(`bl-${CSS.escape(String(event.id || ''))}`);
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
        const sig = `${accessState()}|${event.id}|${market}|${side?.side}|${model.fair}|${model.edge}`;
        setCell(row.querySelector('[data-label="PBE fair"]'), model.fair, `fair|${sig}`);
        setCell(row.querySelector('[data-label="Model edge"]'), model.edge, `edge|${sig}`);
      });
    }

    const terms = document.querySelectorAll('.pbebl-legend [data-term="fair"] p, .pbebl-legend [data-term="edge"] p');
    if (terms[0]) terms[0].textContent = 'NFL Pro shows the model value frozen with the current PBE signal. Never estimated from consensus.';
    if (terms[1]) terms[1].textContent = 'Issue-time PBE probability minus the issue market probability. Current market movement remains separate.';
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
    queue();
    window.PBEBestLineModelOverlay = { apply, currentCard, modelHtml, accessState };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once:true });
  else install();
})();