/* Venue and kickoff facts for a schedule game, from the same ESPN observation
 * the broadcast is built from (one source read, one identity join).
 *
 *   buildVenue(game, snapshot)    the stadium ESPN lists for this game, plus
 *                                 its roof state
 *   buildKickoff(game, snapshot)  the kickoff instant: ESPN's when it is final
 *                                 and joined exactly, the schedule's otherwise
 *
 * Roof truth is the PBE weather authority's rule (api/_breaking/weather.js
 * roofState), applied to ESPN's per-game venue flags rather than the home
 * club's table row, so a neutral-site game never borrows a home stadium.
 */
import { joinGame, easternInstant } from './broadcast-core.js';
import { roofState } from '../../api/_breaking/weather.js';

export function roofFor(game, venue, neutralSite) {
  if (neutralSite === true) return roofState(game.home_team, null, { neutralSite: true });
  if (!venue) return roofState(game.home_team, null);
  if (venue.indoor === null || venue.indoor === undefined) {
    return { state: 'UNRESOLVED', indoor: null, weather_applies: false, label: 'Roof unknown',
      reason: 'the source did not state whether this venue is indoor' };
  }
  return roofState(game.home_team, { indoor: venue.indoor });
}

export function buildVenue(game, snapshot) {
  const { event: ev, evidence } = joinGame(game, snapshot?.events || {});
  if (!ev || !ev.venue) {
    return { status: 'UNAVAILABLE', name: null, city: null, state: null, country: null, indoor: null,
      neutral_site: null, roof: null, source: null, source_event_id: ev?.event_id || null,
      reason: ev ? 'venue_not_published' : (evidence.conflict === 'not_observed' ? 'game_not_observed_at_source' : 'identity_join_rejected') };
  }
  const { espn_venue_id, ...v } = ev.venue;
  const roof = roofFor(game, ev.venue, ev.neutral_site);
  return {
    status: 'VERIFIED', ...v,
    neutral_site: ev.neutral_site ?? null,
    roof: { state: roof.state, label: roof.label },
    espn_venue_id: espn_venue_id || null,
    source: ev.source, source_event_id: ev.event_id, verified_at: ev.verified_at
  };
}

export function buildKickoff(game, snapshot) {
  const scheduled = easternInstant(game.gameday, game.gametime);
  const { event: ev, evidence } = joinGame(game, snapshot?.events || {});
  if (ev && evidence.confidence === 'exact' && ev.time_valid === true && ev.kickoff) {
    return { utc: ev.kickoff, time_valid: true, source: ev.source, schedule_utc: scheduled,
      agrees_with_schedule: scheduled ? Date.parse(ev.kickoff) === Date.parse(scheduled) : null };
  }
  return { utc: scheduled, time_valid: ev ? ev.time_valid : null, source: 'nflverse_schedule', schedule_utc: scheduled,
    agrees_with_schedule: null };
}
