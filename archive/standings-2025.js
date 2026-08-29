/* PropBetEdge NFL — verified 2025 regular-season standings
 * Source of record: NFL.com 2025 REG division/conference standings, checked 2026-08-29.
 * x/y/z seeding translated into playoff/division/seed fields below.
 */
var StandingsView = {
  source: {
    provider: 'NFL.com',
    season: 2025,
    seasonType: 'REG',
    verifiedAt: '2026-08-29',
    semantics: 'VERIFIED_FINAL'
  },
  STANDINGS: {
    AFC: {
      East: [
        {abbr:'NE',name:'New England Patriots',w:14,l:3,t:0,pct:.824,pf:490,pa:320,streak:'W3',seed:2,playoff:true,division:true,note:'AFC East champion · No. 2 seed'},
        {abbr:'BUF',name:'Buffalo Bills',w:12,l:5,t:0,pct:.706,pf:481,pa:365,streak:'W1',seed:6,playoff:true,division:false,note:'Wild card · No. 6 seed'},
        {abbr:'MIA',name:'Miami Dolphins',w:7,l:10,t:0,pct:.412,pf:347,pa:424,streak:'L1',seed:0,playoff:false,division:false,note:'2025 regular-season final'},
        {abbr:'NYJ',name:'New York Jets',w:3,l:14,t:0,pct:.176,pf:300,pa:503,streak:'L5',seed:0,playoff:false,division:false,note:'2025 regular-season final'}
      ],
      North: [
        {abbr:'PIT',name:'Pittsburgh Steelers',w:10,l:7,t:0,pct:.588,pf:397,pa:387,streak:'W1',seed:4,playoff:true,division:true,note:'AFC North champion · No. 4 seed'},
        {abbr:'BAL',name:'Baltimore Ravens',w:8,l:9,t:0,pct:.471,pf:424,pa:398,streak:'L1',seed:0,playoff:false,division:false,note:'2025 regular-season final'},
        {abbr:'CIN',name:'Cincinnati Bengals',w:6,l:11,t:0,pct:.353,pf:414,pa:492,streak:'L1',seed:0,playoff:false,division:false,note:'2025 regular-season final'},
        {abbr:'CLE',name:'Cleveland Browns',w:5,l:12,t:0,pct:.294,pf:279,pa:379,streak:'W2',seed:0,playoff:false,division:false,note:'2025 regular-season final'}
      ],
      South: [
        {abbr:'JAX',name:'Jacksonville Jaguars',w:13,l:4,t:0,pct:.765,pf:474,pa:336,streak:'W8',seed:3,playoff:true,division:true,note:'AFC South champion · No. 3 seed'},
        {abbr:'HOU',name:'Houston Texans',w:12,l:5,t:0,pct:.706,pf:404,pa:295,streak:'W9',seed:5,playoff:true,division:false,note:'Wild card · No. 5 seed'},
        {abbr:'IND',name:'Indianapolis Colts',w:8,l:9,t:0,pct:.471,pf:466,pa:412,streak:'L7',seed:0,playoff:false,division:false,note:'2025 regular-season final'},
        {abbr:'TEN',name:'Tennessee Titans',w:3,l:14,t:0,pct:.176,pf:284,pa:478,streak:'L2',seed:0,playoff:false,division:false,note:'2025 regular-season final'}
      ],
      West: [
        {abbr:'DEN',name:'Denver Broncos',w:14,l:3,t:0,pct:.824,pf:401,pa:311,streak:'W2',seed:1,playoff:true,division:true,note:'AFC West champion · No. 1 seed'},
        {abbr:'LAC',name:'Los Angeles Chargers',w:11,l:6,t:0,pct:.647,pf:368,pa:340,streak:'L2',seed:7,playoff:true,division:false,note:'Wild card · No. 7 seed'},
        {abbr:'KC',name:'Kansas City Chiefs',w:6,l:11,t:0,pct:.353,pf:362,pa:328,streak:'L6',seed:0,playoff:false,division:false,note:'2025 regular-season final'},
        {abbr:'LV',name:'Las Vegas Raiders',w:3,l:14,t:0,pct:.176,pf:241,pa:432,streak:'W1',seed:0,playoff:false,division:false,note:'2025 regular-season final'}
      ]
    },
    NFC: {
      East: [
        {abbr:'PHI',name:'Philadelphia Eagles',w:11,l:6,t:0,pct:.647,pf:379,pa:325,streak:'L1',seed:3,playoff:true,division:true,note:'NFC East champion · No. 3 seed'},
        {abbr:'DAL',name:'Dallas Cowboys',w:7,l:9,t:1,pct:.441,pf:471,pa:511,streak:'L1',seed:0,playoff:false,division:false,note:'2025 regular-season final'},
        {abbr:'WSH',name:'Washington Commanders',w:5,l:12,t:0,pct:.294,pf:356,pa:451,streak:'W1',seed:0,playoff:false,division:false,note:'2025 regular-season final'},
        {abbr:'NYG',name:'New York Giants',w:4,l:13,t:0,pct:.235,pf:381,pa:439,streak:'W2',seed:0,playoff:false,division:false,note:'2025 regular-season final'}
      ],
      North: [
        {abbr:'CHI',name:'Chicago Bears',w:11,l:6,t:0,pct:.647,pf:441,pa:415,streak:'L2',seed:2,playoff:true,division:true,note:'NFC North champion · No. 2 seed'},
        {abbr:'GB',name:'Green Bay Packers',w:9,l:7,t:1,pct:.559,pf:391,pa:360,streak:'L4',seed:7,playoff:true,division:false,note:'Wild card · No. 7 seed'},
        {abbr:'MIN',name:'Minnesota Vikings',w:9,l:8,t:0,pct:.529,pf:344,pa:333,streak:'W5',seed:0,playoff:false,division:false,note:'2025 regular-season final'},
        {abbr:'DET',name:'Detroit Lions',w:9,l:8,t:0,pct:.529,pf:481,pa:413,streak:'W1',seed:0,playoff:false,division:false,note:'2025 regular-season final'}
      ],
      South: [
        {abbr:'CAR',name:'Carolina Panthers',w:8,l:9,t:0,pct:.471,pf:311,pa:380,streak:'L2',seed:4,playoff:true,division:true,note:'NFC South champion · No. 4 seed'},
        {abbr:'TB',name:'Tampa Bay Buccaneers',w:8,l:9,t:0,pct:.471,pf:380,pa:411,streak:'W1',seed:0,playoff:false,division:false,note:'2025 regular-season final'},
        {abbr:'ATL',name:'Atlanta Falcons',w:8,l:9,t:0,pct:.471,pf:353,pa:401,streak:'W4',seed:0,playoff:false,division:false,note:'2025 regular-season final'},
        {abbr:'NO',name:'New Orleans Saints',w:6,l:11,t:0,pct:.353,pf:306,pa:383,streak:'L1',seed:0,playoff:false,division:false,note:'2025 regular-season final'}
      ],
      West: [
        {abbr:'SEA',name:'Seattle Seahawks',w:14,l:3,t:0,pct:.824,pf:483,pa:292,streak:'W7',seed:1,playoff:true,division:true,note:'NFC West champion · No. 1 seed'},
        {abbr:'LAR',name:'Los Angeles Rams',w:12,l:5,t:0,pct:.706,pf:518,pa:346,streak:'W1',seed:5,playoff:true,division:false,note:'Wild card · No. 5 seed'},
        {abbr:'SF',name:'San Francisco 49ers',w:12,l:5,t:0,pct:.706,pf:437,pa:371,streak:'L1',seed:6,playoff:true,division:false,note:'Wild card · No. 6 seed'},
        {abbr:'ARI',name:'Arizona Cardinals',w:3,l:14,t:0,pct:.176,pf:355,pa:488,streak:'L9',seed:0,playoff:false,division:false,note:'2025 regular-season final'}
      ]
    }
  }
};