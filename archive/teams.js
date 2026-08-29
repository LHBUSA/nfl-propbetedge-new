/* ═══════════════════════════════════════════════
   DATA/TEAMS.JS — All 32 NFL teams
   PropBetEdge NFL
═══════════════════════════════════════════════ */
const NFL_TEAMS = {

  // ── AFC EAST ──
  BUF:{ name:'Buffalo Bills',         city:'Buffalo',         abbr:'BUF', conf:'AFC', div:'East', sb:0, sbWins:0, founded:1960, stadium:'Highmark Stadium',       cap:'71,608',  coach:'Sean McDermott',    record2024:'13-4', color:'#00338D' },
  MIA:{ name:'Miami Dolphins',        city:'Miami',           abbr:'MIA', conf:'AFC', div:'East', sb:2, sbWins:0, founded:1966, stadium:'Hard Rock Stadium',       cap:'65,326',  coach:'Mike McDaniel',     record2024:'8-9',  color:'#008E97' },
  NE: { name:'New England Patriots',  city:'New England',     abbr:'NE',  conf:'AFC', div:'East', sb:11,sbWins:6, founded:1960, stadium:'Gillette Stadium',         cap:'65,878',  coach:'Jerod Mayo',        record2024:'4-13', color:'#002244' },
  NYJ:{ name:'New York Jets',         city:'New York',        abbr:'NYJ', conf:'AFC', div:'East', sb:1, sbWins:1, founded:1960, stadium:'MetLife Stadium',          cap:'82,500',  coach:'Jeff Ulbrich',      record2024:'5-12', color:'#125740' },

  // ── AFC NORTH ──
  BAL:{ name:'Baltimore Ravens',      city:'Baltimore',       abbr:'BAL', conf:'AFC', div:'North',sb:3, sbWins:2, founded:1996, stadium:'M&T Bank Stadium',         cap:'71,008',  coach:'John Harbaugh',     record2024:'12-5', color:'#241773' },
  CIN:{ name:'Cincinnati Bengals',    city:'Cincinnati',      abbr:'CIN', conf:'AFC', div:'North',sb:3, sbWins:0, founded:1968, stadium:'Paycor Stadium',            cap:'65,515',  coach:'Zac Taylor',        record2024:'9-8',  color:'#FB4F14' },
  CLE:{ name:'Cleveland Browns',      city:'Cleveland',       abbr:'CLE', conf:'AFC', div:'North',sb:0, sbWins:0, founded:1946, stadium:'Huntington Bank Field',     cap:'67,431',  coach:'Kevin Stefanski',   record2024:'3-14', color:'#311D00' },
  PIT:{ name:'Pittsburgh Steelers',   city:'Pittsburgh',      abbr:'PIT', conf:'AFC', div:'North',sb:8, sbWins:6, founded:1933, stadium:'Acrisure Stadium',          cap:'68,400',  coach:'Mike Tomlin',       record2024:'10-7', color:'#FFB612' },

  // ── AFC SOUTH ──
  HOU:{ name:'Houston Texans',        city:'Houston',         abbr:'HOU', conf:'AFC', div:'South',sb:0, sbWins:0, founded:2002, stadium:'NRG Stadium',              cap:'72,220',  coach:'DeMeco Ryans',      record2024:'10-7', color:'#03202F' },
  IND:{ name:'Indianapolis Colts',    city:'Indianapolis',    abbr:'IND', conf:'AFC', div:'South',sb:4, sbWins:2, founded:1953, stadium:'Lucas Oil Stadium',         cap:'67,000',  coach:'Shane Steichen',    record2024:'8-9',  color:'#002C5F' },
  JAX:{ name:'Jacksonville Jaguars',  city:'Jacksonville',    abbr:'JAX', conf:'AFC', div:'South',sb:0, sbWins:0, founded:1995, stadium:'EverBank Stadium',          cap:'62,438',  coach:'Liam Coen',         record2024:'4-13', color:'#006778' },
  TEN:{ name:'Tennessee Titans',      city:'Tennessee',       abbr:'TEN', conf:'AFC', div:'South',sb:1, sbWins:0, founded:1960, stadium:'Nissan Stadium',            cap:'69,143',  coach:'Brian Callahan',    record2024:'3-14', color:'#0C2340' },

  // ── AFC WEST ──
  DEN:{ name:'Denver Broncos',        city:'Denver',          abbr:'DEN', conf:'AFC', div:'West', sb:8, sbWins:3, founded:1960, stadium:'Empower Field',             cap:'76,125',  coach:'Sean Payton',       record2024:'10-7', color:'#FB4F14' },
  KC: { name:'Kansas City Chiefs',    city:'Kansas City',     abbr:'KC',  conf:'AFC', div:'West', sb:6, sbWins:4, founded:1960, stadium:'Arrowhead Stadium',         cap:'76,416',  coach:'Andy Reid',         record2024:'15-2', color:'#E31837' },
  LAC:{ name:'Los Angeles Chargers',  city:'Los Angeles',     abbr:'LAC', conf:'AFC', div:'West', sb:2, sbWins:0, founded:1960, stadium:'SoFi Stadium',              cap:'70,240',  coach:'Jim Harbaugh',      record2024:'11-6', color:'#0080C6' },
  LV: { name:'Las Vegas Raiders',     city:'Las Vegas',       abbr:'LV',  conf:'AFC', div:'West', sb:5, sbWins:3, founded:1960, stadium:'Allegiant Stadium',         cap:'65,000',  coach:'Pete Carroll',      record2024:'4-13', color:'#A5ACAF' },

  // ── NFC EAST ──
  DAL:{ name:'Dallas Cowboys',        city:'Dallas',          abbr:'DAL', conf:'NFC', div:'East', sb:8, sbWins:5, founded:1960, stadium:'AT&T Stadium',              cap:'100,000', coach:'Brian Schottenheimer',record2024:'7-10',color:'#003594' },
  NYG:{ name:'New York Giants',       city:'New York',        abbr:'NYG', conf:'NFC', div:'East', sb:5, sbWins:4, founded:1925, stadium:'MetLife Stadium',           cap:'82,500',  coach:'Brian Daboll',      record2024:'3-14', color:'#0B2265' },
  PHI:{ name:'Philadelphia Eagles',   city:'Philadelphia',    abbr:'PHI', conf:'NFC', div:'East', sb:4, sbWins:1, founded:1933, stadium:'Lincoln Financial Field',   cap:'69,796',  coach:'Nick Sirianni',     record2024:'14-3', color:'#004C54' },
  WAS:{ name:'Washington Commanders', city:'Washington',      abbr:'WAS', conf:'NFC', div:'East', sb:5, sbWins:3, founded:1932, stadium:'Northwest Stadium',         cap:'61,000',  coach:'Dan Quinn',         record2024:'12-5', color:'#5A1414' },

  // ── NFC NORTH ──
  CHI:{ name:'Chicago Bears',         city:'Chicago',         abbr:'CHI', conf:'NFC', div:'North',sb:2, sbWins:1, founded:1920, stadium:'Soldier Field',             cap:'61,500',  coach:'Ben Johnson',       record2024:'5-12', color:'#0B162A' },
  DET:{ name:'Detroit Lions',         city:'Detroit',         abbr:'DET', conf:'NFC', div:'North',sb:0, sbWins:0, founded:1930, stadium:'Ford Field',                cap:'65,000',  coach:'Dan Campbell',      record2024:'15-2', color:'#0076B6' },
  GB: { name:'Green Bay Packers',     city:'Green Bay',       abbr:'GB',  conf:'NFC', div:'North',sb:5, sbWins:4, founded:1919, stadium:'Lambeau Field',             cap:'81,441',  coach:'Matt LaFleur',      record2024:'11-6', color:'#203731' },
  MIN:{ name:'Minnesota Vikings',     city:'Minnesota',       abbr:'MIN', conf:'NFC', div:'North',sb:4, sbWins:0, founded:1961, stadium:'U.S. Bank Stadium',         cap:'66,655',  coach:'Kevin O\'Connell',  record2024:'14-3', color:'#4F2683' },

  // ── NFC SOUTH ──
  ATL:{ name:'Atlanta Falcons',       city:'Atlanta',         abbr:'ATL', conf:'NFC', div:'South',sb:2, sbWins:0, founded:1966, stadium:'Mercedes-Benz Stadium',     cap:'71,000',  coach:'Raheem Morris',     record2024:'8-9',  color:'#A71930' },
  CAR:{ name:'Carolina Panthers',     city:'Carolina',        abbr:'CAR', conf:'NFC', div:'South',sb:2, sbWins:0, founded:1995, stadium:'Bank of America Stadium',   cap:'74,455',  coach:'Dave Canales',      record2024:'5-12', color:'#0085CA' },
  NO: { name:'New Orleans Saints',    city:'New Orleans',     abbr:'NO',  conf:'NFC', div:'South',sb:1, sbWins:1, founded:1967, stadium:'Caesars Superdome',         cap:'73,208',  coach:'Darren Rizzi',      record2024:'5-12', color:'#D3BC8D' },
  TB: { name:'Tampa Bay Buccaneers',  city:'Tampa Bay',       abbr:'TB',  conf:'NFC', div:'South',sb:3, sbWins:2, founded:1976, stadium:'Raymond James Stadium',     cap:'69,218',  coach:'Todd Bowles',       record2024:'10-7', color:'#D50A0A' },

  // ── NFC WEST ──
  ARI:{ name:'Arizona Cardinals',     city:'Arizona',         abbr:'ARI', conf:'NFC', div:'West', sb:2, sbWins:0, founded:1898, stadium:'State Farm Stadium',        cap:'63,400',  coach:'Jonathan Gannon',   record2024:'8-9',  color:'#97233F' },
  LAR:{ name:'Los Angeles Rams',      city:'Los Angeles',     abbr:'LAR', conf:'NFC', div:'West', sb:5, sbWins:2, founded:1936, stadium:'SoFi Stadium',              cap:'70,240',  coach:'Sean McVay',        record2024:'10-7', color:'#003594' },
  SF: { name:'San Francisco 49ers',   city:'San Francisco',   abbr:'SF',  conf:'NFC', div:'West', sb:7, sbWins:5, founded:1946, stadium:'Levi\'s Stadium',           cap:'68,500',  coach:'Kyle Shanahan',     record2024:'6-11', color:'#AA0000' },
  SEA:{ name:'Seattle Seahawks',      city:'Seattle',         abbr:'SEA', conf:'NFC', div:'West', sb:2, sbWins:1, founded:1976, stadium:'Lumen Field',               cap:'69,000',  coach:'Mike Macdonald',    record2024:'10-7', color:'#002244' },
};

// Helper: get teams by conference and division
const NFL_DIVISIONS = {
  AFC:{ East:['BUF','MIA','NE','NYJ'], North:['BAL','CIN','CLE','PIT'], South:['HOU','IND','JAX','TEN'], West:['DEN','KC','LAC','LV'] },
  NFC:{ East:['DAL','NYG','PHI','WAS'], North:['CHI','DET','GB','MIN'], South:['ATL','CAR','NO','TB'],  West:['ARI','LAR','SF','SEA'] },
};

// 2024 Playoff results (known through my knowledge cutoff)
const NFL_2024_PLAYOFFS = {
  superBowl:{ game:'Super Bowl LIX', date:'Feb 9, 2025', location:'Caesars Superdome, New Orleans', winner:'PHI', loser:'KC', score:'40-22', mvp:'Jalen Hurts', note:'Eagles win first SB since 2018' },
  nfcChamp:{ winner:'PHI', loser:'WAS', score:'55-23' },
  afcChamp:{ winner:'KC', loser:'BUF', score:'32-29' },
};

// 2025 season notable players (pre-season knowledge)
const NFL_STAR_PLAYERS = [
  { name:'Patrick Mahomes', pos:'QB', team:'KC',  note:'4x Super Bowl champion, 3x MVP' },
  { name:'Josh Allen',      pos:'QB', team:'BUF', note:'League MVP candidate every season' },
  { name:'Lamar Jackson',   pos:'QB', team:'BAL', note:'2x NFL MVP, electric dual-threat' },
  { name:'Jalen Hurts',     pos:'QB', team:'PHI', note:'Super Bowl LIX MVP, dual-threat star' },
  { name:'CeeDee Lamb',     pos:'WR', team:'DAL', note:'Elite WR1, 1,000+ yards machine' },
  { name:'Tyreek Hill',     pos:'WR', team:'MIA', note:'Fastest player in NFL history' },
  { name:'Justin Jefferson', pos:'WR',team:'MIN', note:'Most yards in first 4 seasons, NFL history' },
  { name:'Christian McCaffrey',pos:'RB',team:'SF',note:'All-purpose weapon, dual-threat elite' },
  { name:'Micah Parsons',   pos:'LB', team:'DAL', note:'Defensive Player of Year candidate' },
  { name:'Myles Garrett',   pos:'DE', team:'CLE', note:'Elite pass rusher, defensive force' },
  { name:'Nico Collins',    pos:'WR', team:'HOU', note:'Breakout star, elite route runner' },
  { name:'Sam LaPorta',     pos:'TE', team:'DET', note:'Emerging elite TE' },
];
