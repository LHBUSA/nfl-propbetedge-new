/* PropBetEdge NFL — slate core (pure; no DOM, no fetch).
 *
 * The season contract (nfl-current /api/season) decides WHICH week is the
 * primary slate from game state: live week, else the provider week while it
 * still has games to play, else the week of the next scheduled kickoff, else
 * the last completed week. This module only applies that decision to the
 * scoreboard games the dashboard already holds, and orders them so the
 * dashboard answers "what can I act on next?":
 *
 *   LIVE  ->  UPCOMING  ->  RECENT FINALS
 *
 * A finished game is never the default actionable event while a scheduled
 * one exists. Loaded in the browser as window.PBESlateCore and imported by
 * tests/nfl-slate.test.mjs.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PBESlateCore = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const TYPE = { 1: 'PRE', 2: 'REG', 3: 'POST', 4: 'OFF' };
  const arr = v => (Array.isArray(v) ? v : []);
  const sem = g => String(g?.status?.semantics || '').toUpperCase();
  const kick = g => Date.parse(g?.date || '');
  const ET = { timeZone: 'America/New_York' };

  /* /api/nfl-live game -> the contract's week key (season:type:week). */
  function gameKey(g) {
    const year = g?.season?.year, type = TYPE[Number(g?.season?.type)], week = g?.week;
    return year != null && type && week != null ? `${year}:${type}:${week}` : null;
  }
  const forKey = (games, key) => (key ? arr(games).filter(g => gameKey(g) === key) : []);

  const STATE_WORD = { LIVE: 'LIVE', UPCOMING: 'UPCOMING', IN_PROGRESS: 'IN PROGRESS', FINAL: 'FINAL' };

  /* Which games are the primary slate, and whether the held payload has all
     of them. `complete:false` tells the caller to fetch the week by dates. */
  function pick(contract, games) {
    const slate = contract?.primary_slate || null;
    if (!slate?.key) return { slate: null, key: null, games: [], expected: 0, complete: false };
    const rows = forKey(games, slate.key);
    const expected = Number(slate?.counts_in_window?.games) || 0;
    return { slate, key: slate.key, games: rows, expected, complete: rows.length > 0 && rows.length >= expected };
  }

  function etDayKey(ms) {
    return new Date(ms).toLocaleDateString('en-CA', ET);
  }
  function etDayLabel(ms) {
    return new Date(ms).toLocaleDateString('en-US', { ...ET, weekday: 'long', month: 'short', day: 'numeric' }).toUpperCase().replace(',', ' ·');
  }

  /* Ordered groups for the primary slate plus the folded previous week.
     Each group: { key, label, games, folded, kind }. kind drives how a card
     prints its time: 'day' and 'next' headings already carry the day. */
  function groups({ slate, games, previous, previousGames, previousCount }) {
    const list = arr(games);
    const live = list.filter(g => sem(g) === 'LIVE').sort((a, b) => kick(a) - kick(b));
    const sched = list.filter(g => sem(g) === 'SCHEDULE').sort((a, b) => kick(a) - kick(b));
    const fin = list.filter(g => sem(g) === 'FINAL').sort((a, b) => kick(b) - kick(a));
    const out = [];
    if (live.length) {
      out.push({ key: 'live', kind: 'live', label: 'LIVE NOW', games: live, folded: false });
      const first = sched.length ? kick(sched[0]) : null;
      const next = sched.filter(g => kick(g) - first < 3 * 36e5);
      const later = sched.filter(g => !next.includes(g));
      if (next.length) out.push({ key: 'next', kind: 'next', label: 'NEXT KICKOFFS', games: next, folded: false });
      if (later.length) out.push({ key: 'later', kind: 'later', label: 'LATER THIS WEEK', games: later, folded: true });
    } else if (sched.length) {
      /* Thursday first, Sunday in kickoff order, then Monday: one open group
         per ET day, so the next thing to act on is at the top. */
      const days = new Map();
      for (const g of sched) {
        const k = etDayKey(kick(g));
        if (!days.has(k)) days.set(k, []);
        days.get(k).push(g);
      }
      let i = 0;
      for (const [k, rows] of days) {
        out.push({ key: `day-${k}`, kind: 'day', label: `${i === 0 ? 'NEXT · ' : ''}${etDayLabel(kick(rows[0]))}`, games: rows, folded: false });
        i += 1;
      }
    }
    if (fin.length) {
      /* Finals of the primary week fold away while anything is still to play.
         Only when the whole slate is the final state (no football left to
         schedule) do they lead, and then they say FINAL. */
      const over = slate?.state === 'FINAL' && !live.length && !sched.length;
      out.push({ key: 'final', kind: 'final', label: over ? `${slate?.label || 'SLATE'} · FINAL` : 'FINAL · THIS WEEK', games: fin, folded: !over });
    }
    if (previous?.key) {
      const rows = arr(previousGames).filter(g => sem(g) === 'FINAL').sort((a, b) => kick(b) - kick(a));
      out.push({ key: 'previous', kind: 'previous', label: `RECENT FINALS · ${previous.label || 'PREVIOUS WEEK'}`, games: rows, folded: true, count: rows.length || previousCount || null, pending: !rows.length });
    }
    return out;
  }

  function heading(slate, games) {
    const list = arr(games);
    const live = list.filter(g => sem(g) === 'LIVE').length;
    const sched = list.filter(g => sem(g) === 'SCHEDULE').length;
    if (!slate) return { eyebrow: `THE SLATE · ${list.length} GAMES`, title: live ? `${live} live now` : sched ? 'Next up' : 'This week' };
    const state = live ? 'LIVE' : slate.state;
    return {
      eyebrow: `${slate.label} · ${STATE_WORD[state] || state} · ${list.length} GAMES`,
      title: live ? `${live} live now` : sched ? (state === 'UPCOMING' ? `${titleCase(slate.label)} is next` : 'Next up') : `${titleCase(slate.label)} is final`
    };
  }
  function titleCase(s) { return String(s || '').toLowerCase().replace(/\b([a-z])/g, m => m.toUpperCase()); }

  /* The featured game: live, else the next kickoff, else the latest final. */
  function featured(games) {
    const list = arr(games).slice().sort((a, b) => kick(a) - kick(b));
    return list.find(g => sem(g) === 'LIVE') || list.find(g => sem(g) === 'SCHEDULE') || list.filter(g => sem(g) === 'FINAL').pop() || list[0] || null;
  }

  /* A week key as words, preferring the contract's own label for it. */
  const POST_NAMES = { 1: 'WILD CARD', 2: 'DIVISIONAL ROUND', 3: 'CONFERENCE CHAMPIONSHIPS', 4: 'PRO BOWL', 5: 'SUPER BOWL' };
  function keyLabel(k, contract) {
    for (const s of [contract?.primary_slate, contract?.previous_slate, contract?.latest_completed_slate]) if (s?.key === k && s.label) return s.label;
    const [, type, week] = String(k || '').split(':');
    if (week == null) return 'SCOREBOARD';
    return type === 'POST' ? (POST_NAMES[week] || `POSTSEASON WEEK ${week}`) : type === 'PRE' ? `PRESEASON WEEK ${week}` : `WEEK ${week}`;
  }

  /* The top score rail's pill. The rail may keep showing the provider's board,
     but it only calls that board the CURRENT SLATE when it is the contract's
     primary slate. Finals of an earlier week are RECENT SCORES of that week.
     Without a contract it claims nothing. */
  function railLabel(contract, games) {
    const list = arr(games);
    const live = list.filter(g => sem(g) === 'LIVE').length;
    if (live) return `${live} GAME${live === 1 ? '' : 'S'} LIVE · ${list.length} ON SLATE`;
    if (!list.length) return 'SCOREBOARD';
    const keys = [...new Set(list.map(gameKey).filter(Boolean))];
    const ps = contract?.primary_slate;
    if (!ps?.key || keys.length !== 1) return `${list.length} GAMES · SCOREBOARD`;
    if (keys[0] === ps.key) return `${list.length} GAMES · CURRENT SLATE`;
    if (list.every(g => sem(g) === 'FINAL')) return `RECENT SCORES · ${keyLabel(keys[0], contract)}`;
    return `${list.length} GAMES · ${keyLabel(keys[0], contract)}`;
  }

  /* Presentation context for a week of market events (Best Line). Relative to
     the actionable primary slate, never the provider's week label, which the
     engine keeps for attribution. Falls back to that label only when the
     contract carries no primary slate. */
  function weekContext(week, contract, fallbackWeek) {
    const w = Number.isFinite(Number(week)) && week !== null ? Number(week) : null;
    const ps = contract?.primary_slate;
    const primary = ps && Number.isFinite(Number(ps.week)) ? Number(ps.week)
      : Number.isFinite(Number(contract?.primary_slate_week)) && contract?.primary_slate_week !== null ? Number(contract.primary_slate_week)
        : Number.isFinite(Number(fallbackWeek)) && fallbackWeek !== null ? Number(fallbackWeek) : null;
    if (w === null || primary === null) return '';
    if (w === primary) return ps?.state === 'FINAL' ? 'FINAL SLATE' : 'CURRENT SLATE';
    if (w > primary) return 'LOOKAHEAD';
    return w === contract?.latest_completed_week ? 'PREVIOUS WEEK · FINAL' : 'PREVIOUS WEEK';
  }

  return { TYPE, gameKey, forKey, pick, groups, heading, featured, keyLabel, railLabel, weekContext };
});
