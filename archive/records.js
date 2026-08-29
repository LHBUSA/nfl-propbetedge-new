/* ═══════════════════════════════════════════════
   DATA/RECORDS.JS — NFL All-Time Records
   PropBetEdge NFL
═══════════════════════════════════════════════ */
const NFL_RECORDS = {

  PASSING: [
    { stat:'Career Passing Yards',     record:'89,214',   holder:'Tom Brady',           team:'NE/TB',    year:'2000-2022', note:'Surpassed Brees\' 80,358 in 2023' },
    { stat:'Career Passing TDs',       record:'649',      holder:'Tom Brady',            team:'NE/TB',    year:'2000-2022', note:'Set the new gold standard' },
    { stat:'Single Season Pass Yards', record:'5,477',    holder:'Peyton Manning',       team:'DEN',      year:'2013',      note:'Set while also setting TD record' },
    { stat:'Single Season Pass TDs',   record:'55',       holder:'Peyton Manning',       team:'DEN',      year:'2013',      note:'Broke own record of 49' },
    { stat:'Career Completions',       record:'7,263',    holder:'Tom Brady',            team:'NE/TB',    year:'2000-2022', note:'Far ahead of any other QB' },
    { stat:'Career Passer Rating',     record:'98.7',     holder:'Aaron Rodgers',        team:'GB',       year:'2005-present', note:'Minimum 1,500 attempts' },
    { stat:'Consecutive Games TD Pass',record:'51',       holder:'Drew Brees',           team:'NO',       year:'2009-2012', note:'Broke Johnny Unitas\' 47-game streak' },
    { stat:'Most 300-yd Games Career', record:'163',      holder:'Tom Brady',            team:'NE/TB',    year:'2000-2022', note:'' },
  ],

  RUSHING: [
    { stat:'Career Rushing Yards',     record:'18,355',   holder:'Emmitt Smith',         team:'DAL/ARI',  year:'1990-2004', note:'Broke Payton\'s record in 2002' },
    { stat:'Single Season Rush Yards', record:'2,105',    holder:'Eric Dickerson',       team:'LAR',      year:'1984',      note:'Stood for 40+ years. Broken by only scant attempts' },
    { stat:'Career Rushing TDs',       record:'175',      holder:'Emmitt Smith',         team:'DAL/ARI',  year:'1990-2004', note:'Also career total TDs leader at 164 rush alone' },
    { stat:'100-Rush Yard Game Streak',record:'14',       holder:'Barry Sanders',        team:'DET',      year:'1997',      note:'1997 stretch of dominance' },
    { stat:'Career Rush Attempts',     record:'4,409',    holder:'Emmitt Smith',         team:'DAL/ARI',  year:'1990-2004', note:'' },
    { stat:'Avg Yards Per Carry Career',record:'5.22',   holder:'Jim Brown',             team:'CLE',      year:'1957-1965', note:'Min 750 attempts. Never eclipsed in 60+ years' },
  ],

  RECEIVING: [
    { stat:'Career Receptions',        record:'1,549',    holder:'Jerry Rice',           team:'SF/OAK',   year:'1985-2004', note:'Also holds receiving yards and TDs all-time' },
    { stat:'Career Receiving Yards',   record:'22,895',   holder:'Jerry Rice',           team:'SF/OAK',   year:'1985-2004', note:'2nd place is 3,000+ yards behind' },
    { stat:'Career Receiving TDs',     record:'197',      holder:'Jerry Rice',           team:'SF/OAK',   year:'1985-2004', note:'Untouchable. Next closest is 100+ behind' },
    { stat:'Single Season Rec Yards',  record:'1,964',    holder:'Calvin Johnson',       team:'DET',      year:'2012',      note:'Megatron on a 4-12 team. Superhuman' },
    { stat:'Single Season Receptions', record:'149',      holder:'Michael Thomas',       team:'NO',       year:'2019',      note:'Set the new reception mark with Drew Brees' },
    { stat:'Most 100-Rec Yard Games',  record:'76',       holder:'Jerry Rice',           team:'SF/OAK',   year:'1985-2004', note:'' },
    { stat:'Most Rec TDs Single Season',record:'23',      holder:'Randy Moss',           team:'NE',       year:'2007',      note:'Perfect season. Brady-Moss were unstoppable' },
  ],

  DEFENSE: [
    { stat:'Career Sacks',             record:'200',      holder:'Bruce Smith',          team:'BUF/WAS',  year:'1985-2003', note:'Sacks became official stat 1982; Smith played before that too' },
    { stat:'Single Season Sacks',      record:'22.5',     holder:'Michael Strahan',      team:'NYG',      year:'2001',      note:'Controversial Favre kneel at end, but record stands' },
    { stat:'Career Interceptions',     record:'81',       holder:'Paul Krause',          team:'WAS/MIN',  year:'1964-1979', note:'All-time record. 81 INTs in 16 seasons' },
    { stat:'INT Yards Career',         record:'643',      holder:'Ed Reed',              team:'BAL',      year:'2002-2013', note:'The best ball hawk of his era' },
    { stat:'Defensive TDs Career',     record:'12',       holder:'Charles Woodson',      team:'OAK/GB/OAK',year:'1998-2015',note:'Cornerback who played like a WR in the end zone' },
    { stat:'Forced Fumbles Career',    record:'50+',      holder:'Dwight Freeney',       team:'IND+',     year:'2002-2017', note:'Spin move master' },
  ],

  SCORING: [
    { stat:'Career Points Scored',     record:'2,544',    holder:'Morten Andersen',      team:'NO/ATL+',  year:'1982-2007', note:'The Great Dane. Scored more than most offenses per season' },
    { stat:'Career FG Made',           record:'599',      holder:'Adam Vinatieri',       team:'NE/IND',   year:'1996-2019', note:'Mr. Clutch. Made game-winning SB kicks multiple times' },
    { stat:'Longest FG',               record:'66 yds',   holder:'Justin Tucker',        team:'BAL',      year:'2021',      note:'60-yarder in SB conditions. Most accurate kicker ever' },
    { stat:'FG Accuracy Career',       record:'90.5%',    holder:'Justin Tucker',        team:'BAL',      year:'2012-pres',note:'Minimum 100 attempts' },
    { stat:'Single Season TDs',        record:'28',       holder:'LaDainian Tomlinson',  team:'SD',       year:'2006',      note:'23 rush, 3 rec, 2 passing. Historic season' },
    { stat:'Career Total TDs',         record:'208',      holder:'Jerry Rice',           team:'SF/OAK',   year:'1985-2004', note:'197 rec + 10 rush + 1 ret' },
    { stat:'Points in Single Game',    record:'6 TDs',    holder:'Multiple players',     team:'Various',  year:'Various',   note:'Sid Luckman first in 1943. Gale Sayers most famous in 1965' },
  ],

  SPECIAL_TEAMS: [
    { stat:'Career Punt Return TDs',   record:'20',       holder:'Devin Hester',         team:'CHI+',     year:'2006-2016', note:'All-time return TDs record. Greatest returner ever' },
    { stat:'Career KO Return TDs',     record:'8',        holder:'Josh Cribbs',          team:'CLE+',     year:'2005-2014', note:'Also tied by Leon Washington and Cordarrelle Patterson' },
    { stat:'Longest Punt',             record:'98 yds',   holder:'Steve O\'Neal',        team:'NYJ',      year:'1969',      note:'Bounced in end zone and rolled. Will never be broken' },
    { stat:'Career Punting Avg',       record:'46.5',     holder:'Shane Lechler',        team:'OAK/HOU',  year:'2000-2017', note:'Minimum 250 punts' },
  ],

  COACHING: [
    { stat:'Career HC Wins',           record:'328',      holder:'Don Shula',            team:'BAL/MIA',  year:'1963-1995', note:'Bill Belichick will likely break this. Shula at 328' },
    { stat:'Most SB Wins as HC',       record:'4',        holder:'Chuck Noll',           team:'PIT',      year:'1969-1991', note:'Also matched by Bill Belichick (NE)' },
    { stat:'Most SB Appearances as HC',record:'10',       holder:'Bill Belichick',       team:'NE',       year:'2000-2023', note:'Including 6 wins. Dynasty architect' },
    { stat:'Most Consecutive Wins',    record:'21',       holder:'New England Patriots', team:'NE',       year:'2003-2004', note:'Brady-Belichick dynasty peak stretch' },
    { stat:'Longest Win Streak Home',  record:'31',       holder:'Kansas City Chiefs',   team:'KC',       year:'2016-2022', note:'Arrowhead fortress era' },
  ],

  TEAM_RECORDS: [
    { stat:'Most SB Wins',             record:'7',        holder:'New England Patriots / Kansas City Chiefs', team:'NE (6) / KC (4)', year:'Various', note:'Brady NE: 6. Mahomes KC building toward record' },
    { stat:'Most SB Appearances',      record:'11',       holder:'New England Patriots', team:'NE',       year:'1985-2018', note:'Dynasty unmatched in American sports' },
    { stat:'Most Consecutive Playoff Appearances',record:'10+',holder:'Los Angeles Chargers',team:'BAL',year:'2008-2015',note:'Ravens 8 straight 2008-2015' },
    { stat:'Points in Single Season',  record:'606',      holder:'New England Patriots', team:'NE',       year:'2007',      note:'16-0 regular season. Historic offense with Brady/Moss' },
    { stat:'Wins in Single Season',    record:'16-0',     holder:'New England Patriots', team:'NE',       year:'2007',      note:'Perfect regular season ended by Giants in SB XLII' },
    { stat:'Best Single Season Record',record:'15-2',     holder:'Kansas City Chiefs / Detroit Lions',team:'KC/DET',year:'2024',note:'Multiple teams have matched; ties broken by SB results' },
  ],
};

// Milestones timeline
const NFL_MILESTONES = [
  { year:1892, event:'First professional football game — $500 paid to William "Pudge" Heffelfinger' },
  { year:1920, event:'NFL founded as American Professional Football Association (APFA) with 14 teams' },
  { year:1922, event:'League renamed the National Football League (NFL)' },
  { year:1932, event:'First NFL Championship game played indoors at Chicago Stadium' },
  { year:1939, event:'First NFL game televised — Brooklyn Dodgers vs. Philadelphia Eagles' },
  { year:1958, event:'"The Greatest Game Ever Played" — Colts vs Giants OT title game establishes NFL on national stage' },
  { year:1960, event:'AFL founded — begins 10-year war with NFL that ends in merger' },
  { year:1967, event:'First Super Bowl (called AFL-NFL Championship) — Green Bay 35, Kansas City 10' },
  { year:1970, event:'AFL-NFL merger complete — 26 teams now in unified NFL' },
  { year:1972, event:'Miami Dolphins complete only undefeated season: 17-0' },
  { year:1978, event:'Pass protection rules liberalized — offense explodes. Modern NFL begins' },
  { year:1982, event:'Sack becomes official statistic for first time' },
  { year:1987, event:'First widespread use of replay review — controversial from day one' },
  { year:1994, event:'Two-point conversion rule added in NFL' },
  { year:2002, event:'Houston Texans join as 32nd team — league reaches current size' },
  { year:2006, event:'NFL Network launches year-round coverage' },
  { year:2011, event:'New CBA signed after lockout — restructures player compensation permanently' },
  { year:2017, event:'Oakland Raiders approved to move to Las Vegas' },
  { year:2020, event:'Los Angeles Rams and Chargers open SoFi Stadium — largest stadium in NFL' },
  { year:2021, event:'17-game regular season added — first change since 1978' },
  { year:2022, event:'First international regular season games with full home team designation' },
  { year:2023, event:'NFL announces $113B in media rights deals through 2033' },
  { year:2024, event:'NFL reaches $20B revenue milestone — most valuable sports league on earth' },
];
