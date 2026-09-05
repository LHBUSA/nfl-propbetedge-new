/* TE DNA engine — the shared receiver engine bound to the TE dataset.
 *
 * Tight ends. Same arithmetic as WR DNA, different emphasis: the TE surface
 * leads with RED ZONE DNA, because that is where a tight end's value concentrates
 * and where the touchdown markets live.
 */
import { makeReceiverEngine } from '../_receiverdna/engine.js';

const E = makeReceiverEngine('te-dna-dataset.json');

export const dataset = E.dataset;
export const SAMPLE = E.SAMPLE;
export const rate = E.rate;
export const ratio = E.ratio;
export const MARKETS = E.MARKETS;
export const TD_MARKET = E.TD_MARKET;
export const baseline = E.baseline;
export const CONDITION_GROUPS = E.CONDITION_GROUPS;
export const CONDITIONS = E.CONDITIONS;
export const splitRows = E.splitRows;
export const conditionProfile = E.conditionProfile;
export const SIGNAL_TIERS = E.SIGNAL_TIERS;
export const dnaSignals = E.dnaSignals;
export const qbConnections = E.qbConnections;
export const propThreshold = E.propThreshold;
export const tdHistory = E.tdHistory;
export const resolvePlayer = E.resolvePlayer;
export const gamesFor = E.gamesFor;
export const dataWindow = E.dataWindow;
export const provenance = E.provenance;
