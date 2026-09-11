/* Best Line — pure price-shopping core for NFL game markets.
 *
 * Four numbers that must never be confused, each computed (or not) here:
 *
 *   BEST AVAILABLE PRICE  the single most favourable quote a bettor can take
 *                         right now for a side: the best NUMBER first (a
 *                         favourite at -5 beats -5.5), then the best PRICE at
 *                         that number. Always attributed to one sportsbook.
 *   MARKET CONSENSUS      the median line across books, and the vig-free
 *                         probability averaged over books that quote BOTH
 *                         sides at that same line. A description of the
 *                         market — not our opinion.
 *   PBE FAIR VALUE        the PropBetEdge model's own number. Not computed in
 *                         this file and never approximated from consensus.
 *   MODEL EDGE            fair value vs the price on offer. Only exists where a
 *                         published fair value exists.
 *
 * Input is the nfl-odds KV snapshot (/api/odds): a scheduled cross-book
 * capture, never a live quote, and labelled with its capture time downstream.
 */

export const MARKETS = ['spread', 'total', 'moneyline'];
const PROVIDER = { h2h: 'moneyline', spreads: 'spread', totals: 'total' };

const num = v => (v === null || v === undefined || v === '' ? NaN : Number(v));

export function impliedProb(american) {
  const a = num(american);
  if (!Number.isFinite(a) || a === 0) return null;
  return a < 0 ? -a / (-a + 100) : 100 / (a + 100);
}
/* Decimal payout per unit staked. Monotonic in "better for the bettor". */
export function payout(american) {
  const a = num(american);
  if (!Number.isFinite(a) || a === 0) return null;
  return a > 0 ? a / 100 : 100 / -a;
}
export function median(xs) {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/* One flat quote per book/market/side. Side identity is the team name for
   spread/moneyline and OVER/UNDER for totals. */
export function flattenEvent(event) {
  const out = [];
  for (const book of Array.isArray(event?.bookmakers) ? event.bookmakers : []) {
    for (const m of Array.isArray(book?.markets) ? book.markets : []) {
      const market = PROVIDER[m?.key];
      if (!market) continue;
      for (const o of Array.isArray(m?.outcomes) ? m.outcomes : []) {
        const price = num(o?.price);
        if (!Number.isFinite(price) || price === 0) continue;
        const line = market === 'moneyline' ? null : num(o?.point);
        if (market !== 'moneyline' && !Number.isFinite(line)) continue;
        const name = String(o?.name || '');
        const side = market === 'total' ? (/^over$/i.test(name) ? 'OVER' : /^under$/i.test(name) ? 'UNDER' : null) : name;
        if (!side) continue;
        out.push({
          market, side, line, price,
          book: String(book?.title || book?.key || 'Sportsbook'),
          book_key: String(book?.key || ''),
          last_update: m?.last_update || book?.last_update || null
        });
      }
    }
  }
  return out;
}

/* Which number is better for the bettor on this side?
     spread: more points is better (+6 > +5.5, -5 > -5.5)
     total OVER: a lower total is better; UNDER: a higher total is better */
function lineScore(market, side, line) {
  if (market === 'spread') return line;
  if (market === 'total') return side === 'OVER' ? -line : line;
  return 0;
}

export function bestQuote(quotes) {
  let best = null;
  for (const q of quotes) {
    const s = lineScore(q.market, q.side, q.line);
    const p = payout(q.price);
    if (p === null) continue;
    if (!best || s > best.s || (s === best.s && p > best.p)) best = { q, s, p };
  }
  return best ? best.q : null;
}

/* Vig-free probability for `side` from one book that quotes both sides at
   the same number; null when the book does not. */
function bookNoVig(quotes, book, side, other, line) {
  const mine = quotes.find(q => q.book === book && q.side === side && (line === null || q.line === line));
  const theirs = quotes.find(q => q.book === book && q.side === other && (line === null || q.line === (q.market === 'spread' ? -line : line)));
  if (!mine || !theirs) return null;
  const a = impliedProb(mine.price), b = impliedProb(theirs.price);
  if (a === null || b === null || a + b <= 0) return null;
  return a / (a + b);
}

export function summarizeMarket(quotes, market, sides) {
  const out = {};
  for (const side of sides) {
    const other = sides.find(s => s !== side);
    const mine = quotes.filter(q => q.market === market && q.side === side);
    if (!mine.length) { out[side] = null; continue; }
    const best = bestQuote(mine);
    const lines = mine.map(q => q.line).filter(Number.isFinite);
    const consensusLine = market === 'moneyline' ? null : median(lines);
    /* Consensus probability: books that quote BOTH sides at the consensus
       number. A book at a different number is describing a different bet. */
    const books = [...new Set(mine.map(q => q.book))];
    const novig = books
      .map(b => bookNoVig(quotes.filter(q => q.market === market), b, side, other, consensusLine))
      .filter(v => v !== null);
    const atConsensus = mine.filter(q => market === 'moneyline' || q.line === consensusLine);
    const bestAtConsensus = atConsensus.length ? bestQuote(atConsensus) : null;
    out[side] = {
      side,
      best: best ? { book: best.book, line: best.line, price: best.price, last_update: best.last_update } : null,
      best_at_consensus: bestAtConsensus ? { book: bestAtConsensus.book, line: bestAtConsensus.line, price: bestAtConsensus.price } : null,
      consensus: {
        line: consensusLine,
        price: Math.round(median(mine.map(q => q.price))),
        no_vig_probability: novig.length ? Number((novig.reduce((a, b) => a + b, 0) / novig.length).toFixed(4)) : null,
        no_vig_books: novig.length
      },
      line_range: lines.length ? { low: Math.min(...lines), high: Math.max(...lines) } : null,
      price_range: { low: Math.min(...mine.map(q => q.price)), high: Math.max(...mine.map(q => q.price)) },
      book_count: books.length,
      quotes: mine
        .map(q => ({ book: q.book, line: q.line, price: q.price, last_update: q.last_update }))
        .sort((a, b) => (lineScore(market, side, b.line ?? 0) - lineScore(market, side, a.line ?? 0)) || (payout(b.price) - payout(a.price))),
      /* Never derived here. See the header. */
      pbe_fair: null,
      model_edge: null
    };
  }
  return out;
}

export function summarizeEvent(event, { now = Date.now() } = {}) {
  const quotes = flattenEvent(event);
  const away = String(event?.away_team || ''), home = String(event?.home_team || '');
  const kickoff = Date.parse(event?.commence_time || '');
  return {
    id: String(event?.id || ''),
    kickoff: Number.isFinite(kickoff) ? new Date(kickoff).toISOString() : null,
    /* The snapshot is pre-game. Once a game kicks off its stored quotes are
       history, not prices anyone can take. */
    started: Number.isFinite(kickoff) && kickoff <= now,
    away, home,
    books: [...new Set(quotes.map(q => q.book))].length,
    markets: {
      spread: summarizeMarket(quotes, 'spread', [away, home]),
      total: summarizeMarket(quotes, 'total', ['OVER', 'UNDER']),
      moneyline: summarizeMarket(quotes, 'moneyline', [away, home])
    }
  };
}

/* How often each book held the best available price across the slate — the
   standalone value of shopping, independent of any model. */
export function bookLeaderboard(events) {
  const tally = new Map();
  for (const e of events) {
    for (const market of MARKETS) {
      for (const s of Object.values(e.markets[market] || {})) {
        if (!s?.best) continue;
        /* ties: every book at the best number AND price shares the credit */
        const top = s.quotes.filter(q => q.line === s.best.line && q.price === s.best.price).map(q => q.book);
        for (const b of new Set(top)) tally.set(b, (tally.get(b) || 0) + 1);
      }
    }
  }
  return [...tally.entries()].map(([book, best_count]) => ({ book, best_count })).sort((a, b) => b.best_count - a.best_count);
}
