/* ═══════════════════════════════════════════════
   DATA/SEASONS.JS — NFL Season Encyclopedia
   2000–2025 · 26 complete seasons
   Champion · MVP · Awards · Storylines · Stats
   PropBetEdge NFL
═══════════════════════════════════════════════ */

var NFL_SEASONS = [
  {
    year:2000, sbNum:'XXXV', sbWinner:'Baltimore Ravens', sbLoser:'New York Giants',
    sbScore:'34-7', sbMVP:'Ray Lewis, LB', sbVenue:'Raymond James Stadium, Tampa',
    leagueMVP:'Marshall Faulk, RB, STL',
    opoy:'Marshall Faulk, RB, STL', dpoy:'Ray Lewis, LB, BAL',
    coach:'Dick Vermeil, STL', rookie:'Mike Anderson, RB, DEN',
    champion:'BAL', runnerUp:'NYG',
    passLeader:{ player:'Peyton Manning', team:'IND', yards:4413, tds:33 },
    rushLeader:{ player:'Edgerrin James', team:'IND', yards:1709, tds:13 },
    recLeader: { player:'Torry Holt', team:'STL', yards:1635, tds:6 },
    storyline:"Ray Lewis wins Defensive POY and SB MVP after one of the most dominant seasons in NFL defensive history. The Ravens allow only 165 points — the fewest since the 1977 Falcons. Marshall Faulk has an unprecedented season with 2,189 yards from scrimmage.",
    notes:"Greatest Show on Turf peaks with Faulk's record-setting season. Baltimore defense historic."
  },
  {
    year:2001, sbNum:'XXXVI', sbWinner:'New England Patriots', sbLoser:'St. Louis Rams',
    sbScore:'20-17', sbMVP:'Tom Brady, QB', sbVenue:'Louisiana Superdome, New Orleans',
    leagueMVP:'Kurt Warner, QB, STL',
    opoy:'Marshall Faulk, RB, STL', dpoy:'Michael Strahan, DE, NYG',
    coach:'Dick Jauron, CHI', rookie:'Deuce McAllister, RB, NO',
    champion:'NE', runnerUp:'STL',
    passLeader:{ player:'Kurt Warner', team:'STL', yards:4830, tds:36 },
    rushLeader:{ player:'Priest Holmes', team:'KC', yards:1555, tds:8 },
    recLeader: { player:'David Boston', team:'ARI', yards:1598, tds:8 },
    storyline:"The 9/11 season. Tom Brady, a 6th-round pick, replaces injured Drew Bledsoe and leads the Patriots to an improbable Super Bowl victory over the Greatest Show on Turf. Adam Vinatieri hits the walk-off field goal. A dynasty is born.",
    notes:"Brady era begins. The greatest upset in Super Bowl history at the time. Rams were 14-point favorites."
  },
  {
    year:2002, sbNum:'XXXVII', sbWinner:'Tampa Bay Buccaneers', sbLoser:'Oakland Raiders',
    sbScore:'48-21', sbMVP:'Dexter Jackson, S', sbVenue:'Qualcomm Stadium, San Diego',
    leagueMVP:'Rich Gannon, QB, OAK',
    opoy:'Priest Holmes, RB, KC', dpoy:'Derrick Brooks, LB, TB',
    coach:'Andy Reid, PHI', rookie:'Clinton Portis, RB, DEN',
    champion:'TB', runnerUp:'OAK',
    passLeader:{ player:'Rich Gannon', team:'OAK', yards:4689, tds:26 },
    rushLeader:{ player:'Ricky Williams', team:'MIA', yards:1853, tds:16 },
    recLeader: { player:'Marvin Harrison', team:'IND', yards:1722, tds:11 },
    storyline:"Jon Gruden, traded to Tampa Bay, beats his former team Oakland in the Super Bowl 48-21 — the most lopsided SB in history at the time. Dexter Jackson intercepts Rich Gannon twice. The Raiders' historic offense is neutralized by the Tampa 2 defense.",
    notes:"Gruden beats his old team. Oakland's offense shredded. TB defense historic."
  },
  {
    year:2003, sbNum:'XXXVIII', sbWinner:'New England Patriots', sbLoser:'Carolina Panthers',
    sbScore:'32-29', sbMVP:'Tom Brady, QB', sbVenue:'Reliant Stadium, Houston',
    leagueMVP:"Peyton Manning/Steve McNair (co-MVP)",
    opoy:'Jamal Lewis, RB, BAL', dpoy:'Ray Lewis, LB, BAL',
    coach:'Bill Belichick, NE', rookie:'Anquan Boldin, WR, ARI',
    champion:'NE', runnerUp:'CAR',
    passLeader:{ player:'Peyton Manning', team:'IND', yards:4267, tds:29 },
    rushLeader:{ player:'Jamal Lewis', team:'BAL', yards:2066, tds:14 },
    recLeader: { player:'Torry Holt', team:'STL', yards:1696, tds:12 },
    storyline:"Brady 2. Adam Vinatieri does it again with a walk-off 41-yard FG. Jamal Lewis rushes for 2,066 yards — second in NFL history at the time. First co-MVPs since 1997.",
    notes:"Jamal Lewis's 2,066 yards second all-time. Brady-Vinatieri clutch combination strikes again."
  },
  {
    year:2004, sbNum:'XXXIX', sbWinner:'New England Patriots', sbLoser:'Philadelphia Eagles',
    sbScore:'24-21', sbMVP:'Deion Branch, WR', sbVenue:'ALLTEL Stadium, Jacksonville',
    leagueMVP:'Peyton Manning, QB, IND',
    opoy:'Peyton Manning, QB, IND', dpoy:'Ed Reed, S, BAL',
    coach:'Marty Schottenheimer, SD', rookie:'Ben Roethlisberger, QB, PIT',
    champion:'NE', runnerUp:'PHI',
    passLeader:{ player:'Peyton Manning', team:'IND', yards:4557, tds:49 },
    rushLeader:{ player:'Curtis Martin', team:'NYJ', yards:1697, tds:12 },
    recLeader: { player:'Muhsin Muhammad', team:'CAR', yards:1405, tds:16 },
    storyline:"Manning sets the all-time TD record with 49. Brady wins his 3rd Super Bowl in 4 years, completing the dynasty. Deion Branch catches 11 passes for 133 yards as MVP. The Patriots dynasty is fully established.",
    notes:"Manning's 49 TDs breaks Dan Marino's 20-year-old record. Brady dynasty complete. Big Ben rookie year: 13-0."
  },
  {
    year:2005, sbNum:'XL', sbWinner:'Pittsburgh Steelers', sbLoser:'Seattle Seahawks',
    sbScore:'21-10', sbMVP:'Hines Ward, WR', sbVenue:'Ford Field, Detroit',
    leagueMVP:'Shaun Alexander, RB, SEA',
    opoy:'Shaun Alexander, RB, SEA', dpoy:'Brian Urlacher, LB, CHI',
    coach:'Lovie Smith, CHI', rookie:'Carnell Williams, RB, TB',
    champion:'PIT', runnerUp:'SEA',
    passLeader:{ player:'Carson Palmer', team:'CIN', yards:3836, tds:32 },
    rushLeader:{ player:'Shaun Alexander', team:'SEA', yards:1880, tds:27 },
    recLeader: { player:'Steve Smith', team:'CAR', yards:1563, tds:12 },
    storyline:"The Bus, Jerome Bettis, wins a Super Bowl in his hometown of Detroit in his final game. The Steelers become the first 6-seed to win the Super Bowl, going through three road games. Hines Ward wins MVP despite controversial officiating.",
    notes:"Jerome Bettis retires as champion in hometown. First 6-seed SB winner. Big Ben youngest QB to win Super Bowl at 23."
  },
  {
    year:2006, sbNum:'XLI', sbWinner:'Indianapolis Colts', sbLoser:'Chicago Bears',
    sbScore:'29-17', sbMVP:'Peyton Manning, QB', sbVenue:'Dolphin Stadium, Miami',
    leagueMVP:'LaDainian Tomlinson, RB, SD',
    opoy:'LaDainian Tomlinson, RB, SD', dpoy:'Jason Taylor, DE, MIA',
    coach:'Sean Payton, NO', rookie:'Vince Young, QB, TEN',
    champion:'IND', runnerUp:'CHI',
    passLeader:{ player:'Peyton Manning', team:'IND', yards:4397, tds:31 },
    rushLeader:{ player:'LaDainian Tomlinson', team:'SD', yards:1815, tds:28 },
    recLeader: { player:'Chad Johnson', team:'CIN', yards:1369, tds:7 },
    storyline:"LaDainian Tomlinson shatters the single-season TD record with 28 (28 rush + 3 rec + 2 pass). Manning finally gets his ring, overcoming his playoff demons. Tony Dungy becomes the first Black head coach to win the Super Bowl.",
    notes:"Tomlinson's 28 TDs obliterates Alexander's record. Manning's vindication. Dungy historic."
  },
  {
    year:2007, sbNum:'XLII', sbWinner:'New York Giants', sbLoser:'New England Patriots',
    sbScore:'17-14', sbMVP:'Eli Manning, QB', sbVenue:'University of Phoenix Stadium',
    leagueMVP:'Tom Brady, QB, NE',
    opoy:'Tom Brady, QB, NE', dpoy:'Bob Sanders, S, IND',
    coach:'Bill Belichick, NE', rookie:'Adrian Peterson, RB, MIN',
    champion:'NYG', runnerUp:'NE',
    passLeader:{ player:'Tom Brady', team:'NE', yards:4806, tds:50 },
    rushLeader:{ player:'LaDainian Tomlinson', team:'SD', yards:1474, tds:15 },
    recLeader: { player:'Randy Moss', team:'NE', yards:1493, tds:23 },
    storyline:"The greatest upset in Super Bowl history. New England goes 16-0, Brady throws 50 TDs, Moss catches 23 TDs — both records. Then Eli Manning escapes the sack with the Helmet Catch to David Tyree, hits Plaxico Burress for the TD. 18-0 undone.",
    notes:"Brady's 50 TDs and Moss's 23 rec TDs set records. The Helmet Catch. Brady's perfect season undone. AP's 296-yard game earlier in season."
  },
  {
    year:2008, sbNum:'XLIII', sbWinner:'Pittsburgh Steelers', sbLoser:'Arizona Cardinals',
    sbScore:'27-23', sbMVP:'Santonio Holmes, WR', sbVenue:'Raymond James Stadium, Tampa',
    leagueMVP:'Peyton Manning, QB, IND',
    opoy:'Drew Brees, QB, NO', dpoy:'James Harrison, LB, PIT',
    coach:'Mike Smith, ATL', rookie:'Matt Ryan, QB, ATL',
    champion:'PIT', runnerUp:'ARI',
    passLeader:{ player:'Drew Brees', team:'NO', yards:5069, tds:34 },
    rushLeader:{ player:'Adrian Peterson', team:'MIN', yards:1760, tds:10 },
    recLeader: { player:'Andre Johnson', team:'HOU', yards:1575, tds:8 },
    storyline:"Santonio Holmes makes the toe-tap catch in the back of the end zone with 35 seconds left to give Pittsburgh their record 6th Super Bowl title. James Harrison's 100-yard INT return for a TD in the first half is the longest play in Super Bowl history. Kurt Warner shines in his final Super Bowl.",
    notes:"Harrison's 100-yd INT return record. Holmes' toe-tap for the ages. Steelers' 6th title — most in NFL history at the time."
  },
  {
    year:2009, sbNum:'XLIV', sbWinner:'New Orleans Saints', sbLoser:'Indianapolis Colts',
    sbScore:'31-17', sbMVP:'Drew Brees, QB', sbVenue:'Sun Life Stadium, Miami',
    leagueMVP:'Peyton Manning, QB, IND',
    opoy:'Chris Johnson, RB, TEN', dpoy:'Charles Woodson, CB, GB',
    coach:'Rex Ryan, NYJ', rookie:'Percy Harvin, WR, MIN',
    champion:'NO', runnerUp:'IND',
    passLeader:{ player:'Peyton Manning', team:'IND', yards:4500, tds:33 },
    rushLeader:{ player:'Chris Johnson', team:'TEN', yards:2006, tds:16 },
    recLeader: { player:'Wes Welker', team:'NE', yards:1348, tds:4 },
    storyline:"Who Dat nation. The Saints, 4 years after Hurricane Katrina, win their first Super Bowl on an onside kick to open the second half. Brees is 32/39 for 288 yards. The Colts' undefeated run is deliberately stopped by Caldwell. Chris Johnson rushes for 2,006 yards.",
    notes:"Onside kick in the second half. New Orleans' Katrina redemption narrative. CJ2K's 2006 yards."
  },
  {
    year:2010, sbNum:'XLV', sbWinner:'Green Bay Packers', sbLoser:'Pittsburgh Steelers',
    sbScore:'31-25', sbMVP:'Aaron Rodgers, QB', sbVenue:"Cowboys Stadium, Arlington",
    leagueMVP:'Tom Brady, QB, NE',
    opoy:'Tom Brady, QB, NE', dpoy:'Troy Polamalu, S, PIT',
    coach:'Bill Belichick, NE', rookie:'Sam Bradford, QB, STL',
    champion:'GB', runnerUp:'PIT',
    passLeader:{ player:'Tom Brady', team:'NE', yards:3900, tds:36 },
    rushLeader:{ player:'Arian Foster', team:'HOU', yards:1616, tds:16 },
    recLeader: { player:'Brandon Lloyd', team:'DEN', yards:1448, tds:11 },
    storyline:"Aaron Rodgers wins his first Super Bowl, completing 24/39 for 304 yards and 3 TDs. Rodgers' journey from being drafted with a pick at 24 to Super Bowl champion. Troy Polamalu wins Defensive POY in arguably the greatest safety season ever.",
    notes:"Rodgers' redemption from being drafted behind Brady in the 2005 draft. Polamalu unanimous DPOY."
  },
  {
    year:2011, sbNum:'XLVI', sbWinner:'New York Giants', sbLoser:'New England Patriots',
    sbScore:'21-17', sbMVP:'Eli Manning, QB', sbVenue:'Lucas Oil Stadium, Indianapolis',
    leagueMVP:'Aaron Rodgers, QB, GB',
    opoy:'Drew Brees, QB, NO', dpoy:'Terrell Suggs, LB, BAL',
    coach:'Jim Harbaugh, SF', rookie:'Cam Newton, QB, CAR',
    champion:'NYG', runnerUp:'NE',
    passLeader:{ player:'Drew Brees', team:'NO', yards:5476, tds:46 },
    rushLeader:{ player:'Maurice Jones-Drew', team:'JAX', yards:1606, tds:8 },
    recLeader: { player:'Calvin Johnson', team:'DET', yards:1681, tds:16 },
    storyline:"Eli Manning does it again to Brady and the Patriots. Ahmad Bradshaw accidentally scores a touchdown as the Giants try to run out the clock. Drew Brees shatters the single-season passing yards record with 5,476. Cam Newton sets rookie QB records across the board.",
    notes:"Brees' 5,476 yards destroys Marino's record. Newton's historic rookie year (4,051 yds). Bradshaw's accidental TD."
  },
  {
    year:2012, sbNum:'XLVII', sbWinner:'Baltimore Ravens', sbLoser:'San Francisco 49ers',
    sbScore:'34-31', sbMVP:'Joe Flacco, QB', sbVenue:"Mercedes-Benz Superdome, New Orleans",
    leagueMVP:'Adrian Peterson, RB, MIN',
    opoy:'Adrian Peterson, RB, MIN', dpoy:'J.J. Watt, DE, HOU',
    coach:'Bruce Arians, IND', rookie:'Andrew Luck, QB, IND',
    champion:'BAL', runnerUp:'SF',
    passLeader:{ player:'Peyton Manning', team:'DEN', yards:4659, tds:37 },
    rushLeader:{ player:'Adrian Peterson', team:'MIN', yards:2097, tds:12 },
    recLeader: { player:'Calvin Johnson', team:'DET', yards:1964, tds:5 },
    storyline:"Joe Flacco goes 11-0 in postseason games and wins Super Bowl MVP. The Harbaugh Bowl: brothers John and Jim face each other. The power outage at halftime. AP rushes for 2,097 yards — missing Eric Dickerson's all-time record by 8 yards while coming back from ACL surgery. Calvin Johnson's 1,964 receiving yards shatters the single-season record.",
    notes:"Megatron's 1,964 yards. AP's comeback from ACL. The blackout. Flacco's postseason perfection."
  },
  {
    year:2013, sbNum:'XLVIII', sbWinner:'Seattle Seahawks', sbLoser:'Denver Broncos',
    sbScore:'43-8', sbMVP:'Malcolm Smith, LB', sbVenue:'MetLife Stadium, East Rutherford',
    leagueMVP:'Peyton Manning, QB, DEN',
    opoy:'Peyton Manning, QB, DEN', dpoy:'Luke Kuechly, LB, CAR',
    coach:'Ron Rivera, CAR', rookie:'Eddie Lacy, RB, GB',
    champion:'SEA', runnerUp:'DEN',
    passLeader:{ player:'Peyton Manning', team:'DEN', yards:5477, tds:55 },
    rushLeader:{ player:'LeSean McCoy', team:'PHI', yards:1607, tds:9 },
    recLeader: { player:'Josh Gordon', team:'CLE', yards:1646, tds:9 },
    storyline:"Manning throws 55 TD passes — a record that stood for years. Denver scores 606 points — an NFL record. Then they walk into MetLife Stadium and lose 43-8. The Legion of Boom suffocates the greatest offense ever assembled. Safety on the first play sets the tone.",
    notes:"Manning's 55 TDs + Denver's 606 points — both records. Then the 43-8 blowout. LOB historically dominant."
  },
  {
    year:2014, sbNum:'XLIX', sbWinner:'New England Patriots', sbLoser:'Seattle Seahawks',
    sbScore:'28-24', sbMVP:'Tom Brady, QB', sbVenue:'University of Phoenix Stadium',
    leagueMVP:'Aaron Rodgers, QB, GB',
    opoy:'DeMarco Murray, RB, DAL', dpoy:'J.J. Watt, DE, HOU',
    coach:'Bruce Arians, ARI', rookie:'Odell Beckham Jr, WR, NYG',
    champion:'NE', runnerUp:'SEA',
    passLeader:{ player:'Tony Romo', team:'DAL', yards:3705, tds:34 },
    rushLeader:{ player:'DeMarco Murray', team:'DAL', yards:1845, tds:13 },
    recLeader: { player:'Antonio Brown', team:'PIT', yards:1698, tds:13 },
    storyline:"Malcolm Butler's goal-line interception on 2nd and goal from the 1-yard line with 26 seconds left. The most controversial call in Super Bowl history — why didn't they give it to Lynch? Brady wins his 4th ring. OBJ's one-handed catch becomes the play of the year.",
    notes:"Butler's INT — the most debated play in SB history. OBJ's one-handed catch. Brady 4."
  },
  {
    year:2015, sbNum:'50', sbWinner:'Denver Broncos', sbLoser:'Carolina Panthers',
    sbScore:'24-10', sbMVP:'Von Miller, LB', sbVenue:"Levi's Stadium, Santa Clara",
    leagueMVP:'Cam Newton, QB, CAR',
    opoy:'Cam Newton, QB, CAR', dpoy:'J.J. Watt, DE, HOU',
    coach:'Ron Rivera, CAR', rookie:'Todd Gurley, RB, STL',
    champion:'DEN', runnerUp:'CAR',
    passLeader:{ player:'Carson Palmer', team:'ARI', yards:4671, tds:35 },
    rushLeader:{ player:'Adrian Peterson', team:'MIN', yards:1485, tds:11 },
    recLeader: { player:'Antonio Brown', team:'PIT', yards:1834, tds:10 },
    storyline:"Peyton Manning wins his second Super Bowl in his final game, becoming the first QB to win a SB with two different franchises. Von Miller rips the ball out of Cam Newton's hands twice in the fourth quarter. Manning retires 10 days later. The Roman numeral is dropped for just '50'.",
    notes:"Peyton's swan song. Von Miller dominates. Newton's fumbles sealed it. Manning retires as champion."
  },
  {
    year:2016, sbNum:'LI', sbWinner:'New England Patriots', sbLoser:'Atlanta Falcons',
    sbScore:'34-28 OT', sbMVP:'Tom Brady, QB', sbVenue:'NRG Stadium, Houston',
    leagueMVP:'Matt Ryan, QB, ATL',
    opoy:'Matt Ryan, QB, ATL', dpoy:'Khalil Mack, LB, OAK',
    coach:'Bill Belichick, NE', rookie:'Ezekiel Elliott, RB, DAL',
    champion:'NE', runnerUp:'ATL',
    passLeader:{ player:'Matt Ryan', team:'ATL', yards:4944, tds:38 },
    rushLeader:{ player:'Ezekiel Elliott', team:'DAL', yards:1631, tds:15 },
    recLeader: { player:'T.Y. Hilton', team:'IND', yards:1448, tds:6 },
    storyline:"The greatest comeback in Super Bowl history. New England trails 28-3 in the third quarter. Brady leads the comeback. James White rushes for the game-winning TD in overtime — the first OT in Super Bowl history. Brady's 5th ring. Ryan wins league MVP but loses where it matters.",
    notes:"28-3. The comeback. First SB OT. Brady 5. Ryan's Matty Ice melt in the second half."
  },
  {
    year:2017, sbNum:'LII', sbWinner:'Philadelphia Eagles', sbLoser:'New England Patriots',
    sbScore:'41-33', sbMVP:'Nick Foles, QB', sbVenue:'U.S. Bank Stadium, Minneapolis',
    leagueMVP:'Tom Brady, QB, NE',
    opoy:'Todd Gurley, RB, LAR', dpoy:'Aaron Donald, DT, LAR',
    coach:'Sean McVay, LAR', rookie:'Kareem Hunt, RB, KC',
    champion:'PHI', runnerUp:'NE',
    passLeader:{ player:'Tom Brady', team:'NE', yards:4577, tds:32 },
    rushLeader:{ player:'Kareem Hunt', team:'KC', yards:1327, tds:11 },
    recLeader: { player:'DeAndre Hopkins', team:'HOU', yards:1378, tds:13 },
    storyline:"The Philly Special. Nick Foles catches a touchdown pass — from himself — on 4th and goal before the half. Eagles win their first Super Bowl, beating Brady and the Patriots. Foles is the backup who became a legend. Carson Wentz had the MVP-caliber year before his ACL injury.",
    notes:"The Philly Special. Foles catches a TD. Eagles' first SB. Brady threw for 505 yards — and lost."
  },
  {
    year:2018, sbNum:'LIII', sbWinner:'New England Patriots', sbLoser:'Los Angeles Rams',
    sbScore:'13-3', sbMVP:'Julian Edelman, WR', sbVenue:'Mercedes-Benz Stadium, Atlanta',
    leagueMVP:'Patrick Mahomes, QB, KC',
    opoy:'Patrick Mahomes, QB, KC', dpoy:'Stephon Gilmore, CB, NE',
    coach:'Matt Nagy, CHI', rookie:'Saquon Barkley, RB, NYG',
    champion:'NE', runnerUp:'LAR',
    passLeader:{ player:'Patrick Mahomes', team:'KC', yards:5097, tds:50 },
    rushLeader:{ player:'Ezekiel Elliott', team:'DAL', yards:1434, tds:6 },
    recLeader: { player:'Tyreek Hill', team:'KC', yards:1479, tds:12 },
    storyline:"The lowest-scoring Super Bowl ever — 13-3. Brady wins an unprecedented 6th Super Bowl. McVay's vaunted offense is completely neutralized by Belichick's defensive scheme. Mahomes throws 50 TDs in his first full season as starter, winning MVP at 23.",
    notes:"Lowest-scoring SB ever. Brady's 6th — more than any franchise. Mahomes' 50-TD rookie starter year."
  },
  {
    year:2019, sbNum:'LIV', sbWinner:'Kansas City Chiefs', sbLoser:'San Francisco 49ers',
    sbScore:'31-20', sbMVP:'Patrick Mahomes, QB', sbVenue:'Hard Rock Stadium, Miami',
    leagueMVP:'Lamar Jackson, QB, BAL',
    opoy:'Lamar Jackson, QB, BAL', dpoy:'Stephon Gilmore, CB, NE',
    coach:'John Harbaugh, BAL', rookie:'Nick Bosa, DE, SF',
    champion:'KC', runnerUp:'SF',
    passLeader:{ player:'Jameis Winston', team:'TB', yards:5109, tds:33 },
    rushLeader:{ player:'Derrick Henry', team:'TEN', yards:1540, tds:16 },
    recLeader: { player:'Michael Thomas', team:'NO', yards:1725, tds:9 },
    storyline:"Mahomes leads a 21-point fourth quarter comeback. KC's dynasty begins. Lamar Jackson wins unanimous MVP — the first since 2009 — with 36 TDs and 1,206 rushing yards. The Chiefs end a 50-year Super Bowl drought. Michael Thomas sets the single-season reception record with 149.",
    notes:"Mahomes' first ring. KC's 50-year drought ends. Lamar's unanimous MVP. Thomas' 149 catches."
  },
  {
    year:2020, sbNum:'LV', sbWinner:'Tampa Bay Buccaneers', sbLoser:'Kansas City Chiefs',
    sbScore:'31-9', sbMVP:'Tom Brady, QB', sbVenue:'Raymond James Stadium, Tampa',
    leagueMVP:'Aaron Rodgers, QB, GB',
    opoy:'Davante Adams, WR, GB', dpoy:'Aaron Donald, DT, LAR',
    coach:'Kevin Stefanski, CLE', rookie:'Justin Herbert, QB, LAC',
    champion:'TB', runnerUp:'KC',
    passLeader:{ player:'Deshaun Watson', team:'HOU', yards:4823, tds:33 },
    rushLeader:{ player:'Derrick Henry', team:'TEN', yards:2027, tds:17 },
    recLeader: { player:'Stefon Diggs', team:'BUF', yards:1535, tds:8 },
    storyline:"Brady, 43, leaves New England after 20 years, signs with Tampa Bay, and wins a Super Bowl in his first year — making him the only player to win a Super Bowl in a different team's home stadium. Rodgers goes 13-3 and wins MVP but loses the NFC Championship to the Bucs.",
    notes:"Brady's 7th ring with his 3rd team. Home stadium SB first ever. Rodgers' MVP-but-no-SB season. Henry's 2,027."
  },
  {
    year:2021, sbNum:'LVI', sbWinner:'Los Angeles Rams', sbLoser:'Cincinnati Bengals',
    sbScore:'23-20', sbMVP:'Cooper Kupp, WR', sbVenue:'SoFi Stadium, Inglewood',
    leagueMVP:'Aaron Rodgers, QB, GB',
    opoy:'Cooper Kupp, WR, LAR', dpoy:'T.J. Watt, LB, PIT',
    coach:'Mike Vrabel, TEN', rookie:'Ja\'Marr Chase, WR, CIN',
    champion:'LAR', runnerUp:'CIN',
    passLeader:{ player:'Tom Brady', team:'TB', yards:5316, tds:43 },
    rushLeader:{ player:'Jonathan Taylor', team:'IND', yards:1811, tds:18 },
    recLeader: { player:'Cooper Kupp', team:'LAR', yards:1947, tds:16 },
    storyline:"Cooper Kupp wins the receiving triple crown (catches, yards, TDs) and then catches the game-winning TD in the Super Bowl on their home field. The Bengals, led by Joe Burrow and Ja'Marr Chase reuniting from LSU, go on a Cinderella run to the Super Bowl in just Burrow's second season.",
    notes:"Kupp's triple crown + SB MVP. Bengals' 33-year SB drought ends (almost). Burrow-Chase LSU reunion."
  },
  {
    year:2022, sbNum:'LVII', sbWinner:'Kansas City Chiefs', sbLoser:'Philadelphia Eagles',
    sbScore:'38-35', sbMVP:'Patrick Mahomes, QB', sbVenue:'State Farm Stadium, Glendale',
    leagueMVP:'Patrick Mahomes, QB, KC',
    opoy:'Patrick Mahomes, QB, KC', dpoy:'Nick Bosa, DE, SF',
    coach:'Doug Pederson, JAX', rookie:'Sauce Gardner, CB, NYJ',
    champion:'KC', runnerUp:'PHI',
    passLeader:{ player:'Patrick Mahomes', team:'KC', yards:5250, tds:41 },
    rushLeader:{ player:'Derrick Henry', team:'TEN', yards:1538, tds:13 },
    recLeader: { player:'Stefon Diggs', team:'BUF', yards:1429, tds:11 },
    storyline:"Mahomes wins MVP with his ankle in a boot after a high ankle sprain. The Chiefs rally. Jalen Hurts and the Eagles put up 35 points but it's not enough. A controversial holding call late seals KC's win. Mahomes completes the Mahomes-era dynasty narrative.",
    notes:"Mahomes' MVP with high ankle sprain. Eagles' first SB since 2018 (a loss). Controversial late holding call."
  },
  {
    year:2023, sbNum:'LVIII', sbWinner:'Kansas City Chiefs', sbLoser:'San Francisco 49ers',
    sbScore:'25-22 OT', sbMVP:'Patrick Mahomes, QB', sbVenue:'Allegiant Stadium, Las Vegas',
    leagueMVP:'Lamar Jackson, QB, BAL',
    opoy:'Christian McCaffrey, RB, SF', dpoy:'Myles Garrett, DE, CLE',
    coach:'Dan Campbell, DET', rookie:'CJ Stroud, QB, HOU',
    champion:'KC', runnerUp:'SF',
    passLeader:{ player:'Dak Prescott', team:'DAL', yards:4516, tds:36 },
    rushLeader:{ player:'Christian McCaffrey', team:'SF', yards:1459, tds:21 },
    recLeader: { player:'Tyreek Hill', team:'MIA', yards:1799, tds:13 },
    storyline:"First Super Bowl in Las Vegas. OT thriller. Mahomes wins his 3rd ring, becoming the first player to win 3 SBs with the same team since Brady with the Patriots. Lamar wins his second unanimous MVP. Patrick wins SB MVP in OT after a Mecole Hardman TD.",
    notes:"First SB in Vegas. Mahomes 3rd ring, first player with 3 on same team since Brady. Lamar's 2nd unanimous MVP."
  },
  {
    year:2024, sbNum:'LIX', sbWinner:'Philadelphia Eagles', sbLoser:'Kansas City Chiefs',
    sbScore:'40-22', sbMVP:'Jalen Hurts, QB', sbVenue:'Caesars Superdome, New Orleans',
    leagueMVP:'Josh Allen, QB, BUF',
    opoy:'Saquon Barkley, RB, PHI', dpoy:'Micah Parsons, LB, DAL',
    coach:'Kevin O\'Connell, MIN', rookie:'Jayden Daniels, QB, WAS',
    champion:'PHI', runnerUp:'KC',
    passLeader:{ player:'Lamar Jackson', team:'BAL', yards:4172, tds:41 },
    rushLeader:{ player:'Saquon Barkley', team:'PHI', yards:2005, tds:13 },
    recLeader: { player:"Ja'Marr Chase", team:'CIN', yards:1708, tds:17 },
    storyline:"The Eagles end Kansas City's dynasty bid in dominant fashion, 40-22. Jalen Hurts wins Super Bowl MVP. Saquon Barkley, in his first year as an Eagle after leaving the Giants, rushes for 2,005 yards — the 9th player ever to reach 2,000. Lamar Jackson wins his 3rd MVP.",
    notes:"Eagles end Chiefs' 3-peat bid. Barkley's 2,005-yard season. Hurts SB MVP. Jayden Daniels Rookie of Year."
  },

  {
    year:2025, sbNum:'LX', sbWinner:'Seattle Seahawks', sbLoser:'New England Patriots',
    sbScore:'29-13', sbMVP:'Kenneth Walker III, RB', sbVenue:"Levi's Stadium, Santa Clara",
    leagueMVP:'Matthew Stafford, QB, LAR',
    opoy:'Jaxon Smith-Njigba, WR, SEA', dpoy:'Myles Garrett, DE, CLE',
    coach:'Mike Macdonald, SEA', rookie:'Tetairoa McMillan, WR, CAR',
    champion:'SEA', runnerUp:'NE',
    passLeader:{ player:'Sam Darnold', team:'SEA', yards:3840, tds:28 },
    rushLeader:{ player:'Kenneth Walker III', team:'SEA', yards:1760, tds:14 },
    recLeader: { player:'Jaxon Smith-Njigba', team:'SEA', yards:1487, tds:11 },
    storyline:"Mike Macdonald's Dark Side defense dominates the NFL, holding opponents to the fewest yards per game in the league. Sam Darnold's career resurrection story is complete as he leads Seattle to a dominant 14-3 regular season. Kenneth Walker III rushes for 135 yards in the Super Bowl against Drake Maye and the Patriots to earn MVP honors. Seattle's second Lombardi Trophy arrives 12 years after Legion of Boom.",
    notes:"Seahawks 14-3. Dark Side defense. Darnold redemption arc. Walker III SB MVP. New England's 12th SB appearance."
  },
];

// Derived lookup
var SEASON_BY_YEAR = {};
NFL_SEASONS.forEach(function(s) { SEASON_BY_YEAR[s.year] = s; });

// All-time MVP list
var MVP_HISTORY = NFL_SEASONS.filter(function(s) { return s.leagueMVP !== 'TBD'; }).map(function(s) {
  var parts = s.leagueMVP.split(', ');
  return { year:s.year, player:parts[0]||s.leagueMVP, pos:parts[1]||'', team:(parts[2]||'').split('/')[0] };
});
