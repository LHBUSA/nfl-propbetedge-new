/* ═══════════════════════════════════════════════
   DATA/HOF.JS — NFL Hall of Fame Database
   PropBetEdge NFL — Through 2024 class
═══════════════════════════════════════════════ */
const HOF_MEMBERS = [
  // ── 2024 CLASS ──
  { name:'Steve McMichael',     pos:'DT', teams:'CHI,GB',                   inducted:2024, era:'1980-1994', note:'Monsters of the Midway cornerstone. 4x Pro Bowl' },
  { name:'Dwight Freeney',      pos:'DE', teams:'IND,SD,ARI,ATL,LAR,SEA',  inducted:2024, era:'2002-2017', note:'Spin move inventor. 125.5 career sacks. 7x Pro Bowl' },
  { name:'Patrick Willis',      pos:'LB', teams:'SF',                        inducted:2024, era:'2007-2014', note:'Most dominant ILB of his era. 5x All-Pro' },
  { name:'Devin Hester',        pos:'KR', teams:'CHI,ATL,SEA,BAL',         inducted:2024, era:'2006-2016', note:'Greatest return specialist ever. 20 return TDs — all-time record' },

  // ── 2023 CLASS ──
  { name:'Darrelle Revis',      pos:'CB', teams:'NYJ,TB,NE,KC,CHI',        inducted:2023, era:'2007-2017', note:'Revis Island. Shutdown corner who erased half the field' },
  { name:'Zach Thomas',         pos:'LB', teams:'MIA',                       inducted:2023, era:'1996-2008', note:'Dolphins icon. 5x All-Pro. Overcame size with elite instincts' },
  { name:'Joe Thomas',          pos:'OT', teams:'CLE',                       inducted:2023, era:'2007-2017', note:'10,363 consecutive snaps — never missed a single play' },
  { name:'Ronde Barber',        pos:'CB', teams:'TB',                        inducted:2023, era:'1997-2012', note:'16 seasons with one team. SB champion. 47 INTs' },
  { name:'DeMarcus Ware',       pos:'LB', teams:'DAL,DEN',                  inducted:2023, era:'2005-2016', note:'138.5 career sacks. SB 50 champion. Dallas legend' },

  // ── 2022 CLASS ──
  { name:'LeRoy Butler',        pos:'S',  teams:'GB',                        inducted:2022, era:'1990-2001', note:'Originated the Lambeau Leap. 38 career INTs' },
  { name:'Sam Mills',           pos:'LB', teams:'NO,CAR',                   inducted:2022, era:'1986-1997', note:'"Keep Pounding" personified. Panthers franchise inspiration' },
  { name:'Richard Seymour',     pos:'DT', teams:'NE,OAK',                   inducted:2022, era:'2001-2012', note:'3x SB champion. Unblockable versatile lineman' },
  { name:'Bryant Young',        pos:'DT', teams:'SF',                        inducted:2022, era:'1994-2007', note:'49ers legend. Won SB XXIX. 89.5 sacks for a DT' },
  { name:'Cliff Branch',        pos:'WR', teams:'OAK',                       inducted:2022, era:'1972-1985', note:'3x SB champion. Part of Raiders receiving dynasty' },

  // ── 2021 CLASS ──
  { name:'Drew Pearson',        pos:'WR', teams:'DAL',                       inducted:2021, era:'1973-1983', note:'Original Hail Mary catch. Cowboys WR1 on 3 SB teams' },
  { name:'Calvin Johnson',      pos:'WR', teams:'DET',                       inducted:2021, era:'2007-2015', note:'Megatron. 1,964 receiving yards 2012 — single season record' },
  { name:'Peyton Manning',      pos:'QB', teams:'IND,DEN',                   inducted:2021, era:'1998-2015', note:'5x MVP, 2x SB champion. Redefined QB play and preparation' },
  { name:'Alan Faneca',         pos:'G',  teams:'PIT,NYJ,ARI',              inducted:2021, era:'1998-2010', note:'9x Pro Bowl guard. Steelers offensive cornerstone' },

  // ── 2020 CLASS ──
  { name:'Steve Atwater',       pos:'S',  teams:'DEN,NYJ',                   inducted:2020, era:'1989-1999', note:'8x Pro Bowl. Hit Christian Okoye so hard it became folklore' },
  { name:'Isaac Bruce',         pos:'WR', teams:'LAR,SF',                    inducted:2020, era:'1994-2009', note:'Greatest Show on Turf. 73-yd TD in SB XXXIV' },
  { name:'Troy Polamalu',       pos:'S',  teams:'PIT',                       inducted:2020, era:'2003-2014', note:'2x SB champion. 2010 Defensive POY. Hair measured 45 inches' },
  { name:'Steve Hutchinson',    pos:'G',  teams:'SEA,MIN,TEN',              inducted:2020, era:'2001-2012', note:'7x Pro Bowl. Dominated for 3 different teams' },
  { name:'Bill Cowher',         pos:'HC', teams:'PIT',                       inducted:2020, era:'1992-2006', note:'SB XL champion. 161-99-1 career record. The Chin' },

  // ── 2019 CLASS ──
  { name:'Tony Gonzalez',       pos:'TE', teams:'KC,ATL',                    inducted:2019, era:'1997-2013', note:'Redefined the TE position. 1,325 receptions, 111 TDs. 14x Pro Bowl' },
  { name:'Ed Reed',             pos:'S',  teams:'BAL,HOU,NYJ',              inducted:2019, era:'2002-2013', note:'643 INT return yards — all-time record. Defensive savant' },
  { name:'Ty Law',              pos:'CB', teams:'NE,NYJ,KC,DEN,ARI',        inducted:2019, era:'1995-2009', note:'3x SB champion. Brady protector. 53 career INTs' },

  // ── 2018 CLASS ──
  { name:'Brian Dawkins',       pos:'S',  teams:'PHI,DEN',                   inducted:2018, era:'1996-2011', note:'Wolverine. Most Pro Bowls ever for a safety (9). Eagles icon' },
  { name:'Randy Moss',          pos:'WR', teams:'MIN,OAK,NE,TEN,SF',        inducted:2018, era:'1998-2012', note:'Greatest vertical threat ever. 156 TDs. 23 TDs in 2007' },
  { name:'Sterling Sharpe',     pos:'WR', teams:'GB',                      inducted:2025, era:'1988-1994', note:'3x All-Pro, led NFL in receptions 3 times. Career cut short by neck injury but HOF-worthy production.' },
  { name:'Jared Allen',         pos:'DE', teams:'KC,MIN,CHI,CAR',          inducted:2025, era:'2004-2016', note:'136 career sacks, 6x Pro Bowl. Cowboys hat-wearing pass rusher became one of the most dominant DEs of his era.' },
  { name:'Antonio Gates',       pos:'TE', teams:'SD,LAC',                   inducted:2025, era:'2003-2018', note:'116 career TDs — most ever by a TE at time of retirement. 8x Pro Bowl. Never played college football.' },
  { name:'Eric Allen',          pos:'CB', teams:'PHI,NO,OAK',              inducted:2025, era:'1988-2001', note:'54 career interceptions, 6x Pro Bowl. One of the most complete cornerbacks of his generation.' },
  { name:'Ray Lewis',           pos:'LB', teams:'BAL',                       inducted:2018, era:'1996-2012', note:'2x SB champion, 2x Defensive POY. The face of Baltimore Ravens' },
  { name:'Jerry Kramer',        pos:'G',  teams:'GB',                        inducted:2018, era:'1958-1968', note:'5x NFL champion. Ice Bowl block. 52 years to reach HOF' },

  // ── 2017 CLASS ──
  { name:'LaDainian Tomlinson', pos:'RB', teams:'SD,NYJ',                    inducted:2017, era:'2001-2011', note:'28 TDs in 2006 — single season record. 2x rushing title' },
  { name:'Terrell Davis',       pos:'RB', teams:'DEN',                       inducted:2017, era:'1995-2002', note:'SB XXXII MVP. 2,008 yards in 1998. Career derailed by injury' },
  { name:'Jason Taylor',        pos:'DE', teams:'MIA,WAS,NYJ',              inducted:2017, era:'1997-2011', note:'139.5 sacks. 2x Defensive POY. Did Dancing with the Stars' },
  { name:'Morten Andersen',     pos:'K',  teams:'NO,ATL,NYG,KC,MIN',        inducted:2017, era:'1982-2007', note:'2,544 points — scoring record at retirement. The Great Dane' },

  // ── 2016 CLASS ──
  { name:'Brett Favre',         pos:'QB', teams:'ATL,GB,NYJ,MIN',            inducted:2016, era:'1991-2010', note:'3x MVP, 297 consecutive starts. 508 TD passes' },
  { name:'Kevin Greene',        pos:'LB', teams:'LAR,PIT,SF,CAR',           inducted:2016, era:'1985-1999', note:'160 career sacks — 3rd all-time. Intense competitor' },
  { name:'Tony Dungy',          pos:'HC', teams:'TB,IND',                    inducted:2016, era:'1996-2008', note:'First Black HC to win SB. Built two franchises from scratch' },
  { name:'Orlando Pace',        pos:'OT', teams:'STL,CHI',                   inducted:2016, era:'1997-2009', note:'7x Pro Bowl. Protected Kurt Warner. Franchise pillar' },

  // ── 2015 CLASS ──
  { name:'Junior Seau',         pos:'LB', teams:'SD,MIA,NE',                 inducted:2015, era:'1990-2009', note:'12x Pro Bowl. 1,515 tackles. Passed away 2012 at 43' },
  { name:'Tim Brown',           pos:'WR', teams:'OAK,TB,NE',                 inducted:2015, era:'1988-2004', note:'100 TDs, 1,094 receptions. Silver and Black legend' },
  { name:'Charles Haley',       pos:'DE', teams:'SF,DAL',                    inducted:2015, era:'1986-1999', note:'Only player with 5 SB rings. Most SB wins ever' },
  { name:'Will Shields',        pos:'G',  teams:'KC',                        inducted:2015, era:'1993-2006', note:'12 consecutive Pro Bowls, never missed a game. Gentleman of the line' },

  // ── 2014 CLASS ──
  { name:'Michael Strahan',     pos:'DE', teams:'NYG',                       inducted:2014, era:'1993-2007', note:'22.5 sacks 2001 — single season sack record. 2x SB champion' },
  { name:'Ray Guy',             pos:'P',  teams:'OAK',                       inducted:2014, era:'1973-1986', note:'First punter in HOF. 3x SB champion. Averaged 42.4 yds career' },
  { name:'Aeneas Williams',     pos:'CB', teams:'ARI,STL',                   inducted:2014, era:'1991-2004', note:'55 INT, 9 INTs returned for TDs. 9x Pro Bowl' },
  { name:'Claude Humphrey',     pos:'DE', teams:'ATL,PHI',                   inducted:2014, era:'1968-1981', note:'6x Pro Bowl pass rusher. Should have been in much earlier' },

  // ── 2013 CLASS ──
  { name:'Larry Allen',         pos:'G',  teams:'DAL,SF,NO',                 inducted:2013, era:'1994-2007', note:'Strongest player in NFL history. 11x Pro Bowl. Bench pressed 700 lbs' },
  { name:'Jonathan Ogden',      pos:'OT', teams:'BAL',                       inducted:2013, era:'1996-2007', note:'11x Pro Bowl. Cornerstone of Ravens dynasty. SB XXXV champion' },
  { name:'Warren Sapp',         pos:'DT', teams:'TB,OAK',                    inducted:2013, era:'1995-2007', note:'SB XXXVII champion. 96.5 sacks for a DT. Dominant force' },
  { name:'Bill Parcells',       pos:'HC', teams:'NYG,NE,NYJ,DAL',           inducted:2013, era:'1983-2006', note:'2x SB champion. The Tuna. Rebuilt four franchises' },
  { name:'Cris Carter',         pos:'WR', teams:'PHI,MIN,MIA',              inducted:2013, era:'1987-2002', note:'1,101 receptions, 130 TDs. Greatest hands in NFL history' },

  // ── 2012 CLASS ──
  { name:'Cortez Kennedy',      pos:'DT', teams:'SEA',                       inducted:2012, era:'1990-2000', note:'Defensive POY on a 2-14 team. 14 sacks on 2-win Seahawks in 1992' },
  { name:'Dermontti Dawson',    pos:'C',  teams:'PIT',                       inducted:2012, era:'1988-2000', note:'7x Pro Bowl. Revolutionized center position with athleticism' },
  { name:'Shannon Sharpe',      pos:'TE', teams:'DEN,BAL',                   inducted:2011, era:'1990-2003', note:'3x SB champion. First modern receiving TE. Made opponents angry' },
  { name:'Chris Doleman',       pos:'DE', teams:'MIN,ATL,SF',               inducted:2012, era:'1985-1999', note:'150.5 career sacks. 8x Pro Bowl dominant rusher' },

  // ── LEGENDS ──
  { name:'Tom Brady',           pos:'QB', teams:'NE,TB',                     inducted:2025, era:'2000-2022', note:'7 SB rings, 5 SB MVPs, 649 TD passes. The undisputed GOAT' },
  { name:'Jerry Rice',          pos:'WR', teams:'SF,OAK,SEA',               inducted:2010, era:'1985-2004', note:'Greatest player ever. 1,549 rec, 197 TDs, 3 SB rings' },
  { name:'Joe Montana',         pos:'QB', teams:'SF,KC',                     inducted:2000, era:'1979-1994', note:'4x SB champion, 3x SB MVP. Zero INTs in 4 Super Bowls' },
  { name:'Lawrence Taylor',     pos:'LB', teams:'NYG',                       inducted:1999, era:'1981-1993', note:'Greatest defensive player ever. Redefined the position' },
  { name:'Reggie White',        pos:'DE', teams:'PHI,GB,CAR',               inducted:2006, era:'1985-2000', note:'Minister of Defense. 198 career sacks' },
  { name:'Emmitt Smith',        pos:'RB', teams:'DAL,ARI',                   inducted:2010, era:'1990-2004', note:'All-time rushing yards: 18,355. 3x SB champion' },
  { name:'Barry Sanders',       pos:'RB', teams:'DET',                       inducted:2004, era:'1989-1998', note:'Retired 2nd all-time at 15,269 yds. Best pure runner ever' },
  { name:'Jim Brown',           pos:'RB', teams:'CLE',                       inducted:1971, era:'1957-1965', note:'104.3 yds/game career average. Left at peak. Untouchable' },
  { name:'Walter Payton',       pos:'RB', teams:'CHI',                       inducted:1993, era:'1975-1987', note:'Sweetness. 16,726 yards. SB champion. True legend' },
  { name:'Dan Marino',          pos:'QB', teams:'MIA',                       inducted:2005, era:'1983-1999', note:'5,084 yds & 48 TDs in 1984 — records stood 27 years' },
  { name:'Deion Sanders',       pos:'CB', teams:'ATL,SF,DAL,WAS,BAL',       inducted:2011, era:'1989-2005', note:'Prime Time. 2x SB champion. Only played SB and World Series' },
  { name:'Roger Staubach',      pos:'QB', teams:'DAL',                       inducted:1985, era:'1969-1979', note:'Captain America. 2x SB champion. Heisman winner' },
  { name:'Terry Bradshaw',      pos:'QB', teams:'PIT',                       inducted:1989, era:'1970-1983', note:'4x SB champion and MVP. Steel Curtain leader' },
  { name:'Dick Butkus',         pos:'LB', teams:'CHI',                       inducted:1979, era:'1965-1973', note:'Most feared player ever. Eyes burned through you' },
  { name:'Mean Joe Greene',     pos:'DT', teams:'PIT',                       inducted:1987, era:'1969-1981', note:'Soul of the Steel Curtain. 4x SB champion' },
  { name:'Eric Dickerson',      pos:'RB', teams:'LAR,IND,LAR,ATL',          inducted:1999, era:'1983-1993', note:'2,105 rushing yards 1984 — single season NFL record' },
  { name:'Anthony Munoz',       pos:'OT', teams:'CIN',                       inducted:1998, era:'1980-1992', note:'Greatest OT ever. 11x Pro Bowl. Zero sacks in 185 games' },
  { name:'Steve Young',         pos:'QB', teams:'TB,SF',                     inducted:2005, era:'1985-1999', note:'SB XXIX MVP, 6 TDs. Career 96.8 passer rating — elite' },
  { name:'John Elway',          pos:'QB', teams:'DEN',                       inducted:2004, era:'1983-1998', note:'98 4th-quarter comebacks. 2x SB champion. The Drive' },
  { name:'Peyton Manning',      pos:'QB', teams:'IND,DEN',                   inducted:2021, era:'1998-2015', note:'5x MVP, 2x SB champion. Changed how QB position is prepared for' },
  { name:'Bruce Smith',         pos:'DE', teams:'BUF,WAS',                   inducted:2009, era:'1985-2003', note:'200 career sacks — NFL all-time record' },
  { name:'Ronnie Lott',         pos:'S',  teams:'SF,LAR,NYJ,KC',            inducted:2000, era:'1981-1994', note:'4x SB champion. Cut tip of finger off rather than miss game' },
  { name:'Johnny Unitas',       pos:'QB', teams:'BAL,SD',                    inducted:1979, era:'1956-1973', note:'47 consecutive games with TD pass. Mr. Quarterback' },
  { name:'Mike Singletary',     pos:'LB', teams:'CHI',                       inducted:1998, era:'1981-1992', note:'46 Bears. Eyes you could not look away from. 10x Pro Bowl' },
  { name:'Marcus Allen',        pos:'RB', teams:'OAK,KC',                    inducted:2003, era:'1982-1997', note:'SB XVIII MVP — 74-yd iconic run. 123 rushing TDs' },
  { name:'Jack Lambert',        pos:'LB', teams:'PIT',                       inducted:1990, era:'1974-1984', note:'Soul of Steel Curtain. Terrified QBs. Toothless menace' },
  { name:'Franco Harris',       pos:'RB', teams:'PIT,SEA',                   inducted:1990, era:'1972-1984', note:'Immaculate Reception. 4x SB champion. 12,120 rush yards' },
  { name:'Bart Starr',          pos:'QB', teams:'GB',                        inducted:1977, era:'1956-1971', note:'SB I & II MVP. 5x NFL champion under Lombardi' },
  { name:'Vince Lombardi',      pos:'HC', teams:'GB,WAS',                   inducted:1971, era:'1959-1969', note:'The standard. 5 NFL titles in 7 years. The Trophy bears his name' },
  { name:'Don Shula',           pos:'HC', teams:'BAL,MIA',                   inducted:1997, era:'1963-1995', note:'328 wins — all-time record. Only perfect season (17-0) in 1972' },
  { name:'Chuck Noll',          pos:'HC', teams:'PIT',                       inducted:1993, era:'1969-1991', note:'4x SB champion HC — the only one. Built the Steel Curtain dynasty' },
  { name:'Bill Walsh',          pos:'HC', teams:'SF',                        inducted:1993, era:'1979-1988', note:'West Coast Offense creator. 3x SB champion. Gave us Montana and Rice' },
  { name:'Tom Landry',          pos:'HC', teams:'DAL',                       inducted:1990, era:'1960-1988', note:'The hat and the stoic look. 2x SB champion. 270 career wins' },
];

const HOF_BY_YEAR = HOF_MEMBERS.reduce((acc, m) => {
  if (!acc[m.inducted]) acc[m.inducted] = [];
  acc[m.inducted].push(m);
  return acc;
}, {});

const HOF_BY_POS = HOF_MEMBERS.reduce((acc, m) => {
  if (!acc[m.pos]) acc[m.pos] = [];
  acc[m.pos].push(m);
  return acc;
}, {});
