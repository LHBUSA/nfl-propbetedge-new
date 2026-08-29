/* STANDINGS.JS — World Class NFL Standings */
var StandingsView = {
  currentConf: 'all',
  sortKey: 'seed',

  STANDINGS: {
    AFC: {
      East: [
        { abbr:'NE',  name:'New England Patriots',  w:14, l:3,  pct:.824, pf:389, pa:198, streak:'W3', seed:2, playoff:true,  division:true,  note:'Drake Maye led AFC East title & SB LX run' },
        { abbr:'BUF', name:'Buffalo Bills',          w:11, l:6,  pct:.647, pf:412, pa:321, streak:'W1', seed:5, playoff:true,  division:false, note:'Allen strong season, lost AFCCG' },
        { abbr:'MIA', name:'Miami Dolphins',         w:7,  l:10, pct:.412, pf:298, pa:342, streak:'L3', seed:0, playoff:false, division:false, note:'Tua injuries ended season early' },
        { abbr:'NYJ', name:'New York Jets',          w:5,  l:12, pct:.294, pf:241, pa:398, streak:'L2', seed:0, playoff:false, division:false, note:'Ongoing QB uncertainty' },
      ],
      North: [
        { abbr:'BAL', name:'Baltimore Ravens',       w:12, l:5,  pct:.706, pf:398, pa:267, streak:'W2', seed:3, playoff:true,  division:true,  note:'Jackson 32 TDs, lost AFCDG' },
        { abbr:'CLE', name:'Cleveland Browns',       w:9,  l:8,  pct:.529, pf:312, pa:298, streak:'W1', seed:6, playoff:true,  division:false, note:'Garrett 23 sacks, record-breaking season' },
        { abbr:'PIT', name:'Pittsburgh Steelers',    w:8,  l:9,  pct:.471, pf:276, pa:305, streak:'L1', seed:0, playoff:false, division:false, note:'Wilson inconsistent, missed playoffs' },
        { abbr:'CIN', name:'Cincinnati Bengals',     w:7,  l:10, pct:.412, pf:289, pa:334, streak:'L4', seed:0, playoff:false, division:false, note:'Burrow injury mid-season' },
      ],
      South: [
        { abbr:'HOU', name:'Houston Texans',         w:11, l:6,  pct:.647, pf:362, pa:291, streak:'W2', seed:4, playoff:true,  division:true,  note:'Stroud bounced back, div champions' },
        { abbr:'IND', name:'Indianapolis Colts',     w:8,  l:9,  pct:.471, pf:308, pa:319, streak:'W1', seed:0, playoff:false, division:false, note:'Richardson developing' },
        { abbr:'JAX', name:'Jacksonville Jaguars',   w:6,  l:11, pct:.353, pf:278, pa:356, streak:'L2', seed:0, playoff:false, division:false, note:'Lawrence inconsistent' },
        { abbr:'TEN', name:'Tennessee Titans',       w:4,  l:13, pct:.235, pf:218, pa:402, streak:'L5', seed:0, playoff:false, division:false, note:'Full rebuild year' },
      ],
      West: [
        { abbr:'KC',  name:'Kansas City Chiefs',     w:13, l:4,  pct:.765, pf:421, pa:289, streak:'W4', seed:1, playoff:true,  division:true,  note:'AFC #1 seed · lost AFCCG to NE' },
        { abbr:'LAC', name:'Los Angeles Chargers',   w:9,  l:8,  pct:.529, pf:334, pa:312, streak:'L1', seed:7, playoff:true,  division:false, note:'Herbert solid, wild card exit' },
        { abbr:'DEN', name:'Denver Broncos',         w:7,  l:10, pct:.412, pf:289, pa:331, streak:'W1', seed:0, playoff:false, division:false, note:'Wilson new chapter' },
        { abbr:'LV',  name:'Las Vegas Raiders',      w:4,  l:13, pct:.235, pf:231, pa:401, streak:'L7', seed:0, playoff:false, division:false, note:'Full rebuild mode' },
      ],
    },
    NFC: {
      East: [
        { abbr:'PHI', name:'Philadelphia Eagles',    w:13, l:4,  pct:.765, pf:438, pa:287, streak:'W2', seed:2, playoff:true,  division:true,  note:'Defending SB LIX champs · lost NFCDG' },
        { abbr:'DAL', name:'Dallas Cowboys',         w:9,  l:8,  pct:.529, pf:352, pa:331, streak:'L1', seed:6, playoff:true,  division:false, note:'Lamb monster year, wild card exit' },
        { abbr:'NYG', name:'New York Giants',        w:6,  l:11, pct:.353, pf:248, pa:378, streak:'L3', seed:0, playoff:false, division:false, note:'Rebuild continues' },
        { abbr:'WAS', name:'Washington Commanders',  w:8,  l:9,  pct:.471, pf:318, pa:309, streak:'W2', seed:0, playoff:false, division:false, note:'Daniels sophomore slump' },
      ],
      North: [
        { abbr:'DET', name:'Detroit Lions',          w:12, l:5,  pct:.706, pf:421, pa:332, streak:'W3', seed:3, playoff:true,  division:true,  note:'Goff elite, Gibbs breakout year' },
        { abbr:'MIN', name:'Minnesota Vikings',      w:10, l:7,  pct:.588, pf:378, pa:341, streak:'W1', seed:5, playoff:true,  division:false, note:'McCarthy showed promise' },
        { abbr:'GB',  name:'Green Bay Packers',      w:8,  l:9,  pct:.471, pf:312, pa:318, streak:'L2', seed:0, playoff:false, division:false, note:'Young core building' },
        { abbr:'CHI', name:'Chicago Bears',          w:7,  l:10, pct:.412, pf:287, pa:341, streak:'L1', seed:0, playoff:false, division:false, note:'Williams year 2 improvement' },
      ],
      South: [
        { abbr:'TB',  name:'Tampa Bay Buccaneers',   w:10, l:7,  pct:.588, pf:356, pa:318, streak:'W2', seed:4, playoff:true,  division:true,  note:'Mayfield consistent, div title' },
        { abbr:'ATL', name:'Atlanta Falcons',        w:8,  l:9,  pct:.471, pf:312, pa:329, streak:'L1', seed:0, playoff:false, division:false, note:'Penix developing season' },
        { abbr:'NO',  name:'New Orleans Saints',     w:6,  l:11, pct:.353, pf:261, pa:378, streak:'L4', seed:0, playoff:false, division:false, note:'Post-Brees rebuild' },
        { abbr:'CAR', name:'Carolina Panthers',      w:8,  l:9,  pct:.471, pf:318, pa:331, streak:'W3', seed:0, playoff:false, division:false, note:'McMillan ROY, bright future' },
      ],
      West: [
        { abbr:'SEA', name:'Seattle Seahawks',       w:14, l:3,  pct:.824, pf:398, pa:198, streak:'W1', seed:1, playoff:true,  division:true,  note:'🏆 NFC #1 · Super Bowl LX Champions' },
        { abbr:'LAR', name:'Los Angeles Rams',       w:12, l:5,  pct:.706, pf:421, pa:298, streak:'W2', seed:4, playoff:true,  division:false, note:'Stafford MVP · lost NFCDG' },
        { abbr:'SF',  name:'San Francisco 49ers',    w:8,  l:9,  pct:.471, pf:321, pa:318, streak:'L2', seed:0, playoff:false, division:false, note:'Purdy solid, injuries hurt' },
        { abbr:'ARI', name:'Arizona Cardinals',      w:6,  l:11, pct:.353, pf:278, pa:368, streak:'L3', seed:0, playoff:false, division:false, note:'Murray developing' },
      ],
    },
  },

  render: function() {
    var vc = document.getElementById('view-container');
    vc.innerHTML = (
      '<div style="background:linear-gradient(135deg,#0D1117,#141B25);border-bottom:1px solid rgba(65,105,225,.2);padding:1.75rem 2rem 1.5rem;position:relative;overflow:hidden">' +
        '<div style="position:absolute;right:-20px;top:-20px;font-family:\'Barlow Condensed\',sans-serif;font-size:180px;font-weight:900;color:rgba(255,255,255,.03);line-height:1;pointer-events:none">NFL</div>' +
        '<div style="font-size:9px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;color:#93c5fd;margin-bottom:.35rem">2025 Season · Final</div>' +
        '<div style="font-family:\'Barlow Condensed\',sans-serif;font-size:clamp(28px,4vw,44px);font-weight:900;color:#fff;text-transform:uppercase;letter-spacing:-1.5px;line-height:.95">Season Standings</div>' +
        '<div style="font-size:13px;color:rgba(255,255,255,.55);margin-top:.4rem">Final standings · Playoff seeds · Division leaders · 2025 Results</div>' +
      '</div>' +

      '<div style="background:rgba(13,17,23,.98);border-bottom:1px solid rgba(255,255,255,.08);padding:.75rem 2rem;display:flex;align-items:center;gap:8px;backdrop-filter:blur(10px)">' +
        '<div id="std-all" onclick="StandingsView.setConf(\'all\')" style="padding:5px 16px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;border:1px solid rgba(65,105,225,.4);background:rgba(65,105,225,.18);color:#93c5fd">All</div>' +
        '<div id="std-AFC" onclick="StandingsView.setConf(\'AFC\')" style="padding:5px 16px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;border:1px solid rgba(213,10,10,.25);background:transparent;color:rgba(255,255,255,.6)">AFC</div>' +
        '<div id="std-NFC" onclick="StandingsView.setConf(\'NFC\')" style="padding:5px 16px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;border:1px solid rgba(65,105,225,.25);background:transparent;color:rgba(255,255,255,.6)">NFC</div>' +
        '<div style="margin-left:auto;display:flex;align-items:center;gap:10px">' +
          '<div style="display:flex;align-items:center;gap:5px"><div style="width:10px;height:10px;border-radius:2px;background:rgba(255,255,255,.25)"></div><span style="font-size:10px;color:rgba(255,255,255,.7)">Playoff</span></div>' +
          '<div style="display:flex;align-items:center;gap:5px"><div style="width:10px;height:10px;border-radius:2px;background:rgba(232,192,0,.2)"></div><span style="font-size:10px;color:rgba(255,255,255,.55)">Div Leader</span></div>' +
          '<div style="display:flex;align-items:center;gap:5px"><div style="width:10px;height:10px;border-radius:2px;background:rgba(232,24,40,.15)"></div><span style="font-size:10px;color:rgba(255,255,255,.55)">Champion</span></div>' +
        '</div>' +
      '</div>' +

      '<div id="standings-body" style="padding:1.5rem 2rem"></div>' +
      FooterComp.html()
    );
    this.renderStandings();
  },

  setConf: function(conf) {
    this.currentConf = conf;
    ['all','AFC','NFC'].forEach(function(c) {
      var el = document.getElementById('std-'+c);
      if (!el) return;
      var active = c === conf;
      el.style.background  = active ? 'rgba(255,255,255,.12)' : 'transparent';
      el.style.color       = active ? '#fff' : 'rgba(255,255,255,.65)';
      el.style.borderColor = active ? 'rgba(65,105,225,.4)' : (c==='AFC'?'rgba(213,10,10,.25)':'rgba(65,105,225,.25)');
    });
    this.renderStandings();
  },

  renderStandings: function() {
    var self = this;
    var body = document.getElementById('standings-body');
    var html = '';
    var confs = this.currentConf === 'all' ? ['AFC','NFC'] : [this.currentConf];

    confs.forEach(function(conf) {
      var isAFC = conf === 'AFC';
      var confColor = isAFC ? '#f87171' : '#93c5fd';

      html += (
        '<div style="margin-bottom:2.5rem">' +
          '<div style="display:flex;align-items:center;gap:12px;margin-bottom:1.25rem">' +
            '<div style="font-family:\'Barlow Condensed\',sans-serif;font-size:32px;font-weight:900;color:'+confColor+';letter-spacing:-1px">'+conf+'</div>' +
            '<div style="flex:1;height:1px;background:rgba(255,255,255,.1)"></div>' +
          '</div>'
      );

      ['East','North','South','West'].forEach(function(div) {
        var teams = self.STANDINGS[conf][div] || [];
        html += (
          '<div style="margin-bottom:1.5rem">' +
            '<div style="font-size:9px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,.45);margin-bottom:.625rem;padding:0 2px">'+conf+' '+div+'</div>' +
            '<div style="background:#141B25;border:1px solid rgba(255,255,255,.1);border-radius:12px;overflow:hidden">' +
              /* Header */
              '<div style="display:grid;grid-template-columns:32px 48px 1fr 56px 56px 56px 56px 72px 80px;align-items:center;padding:.5rem 1rem;background:rgba(255,255,255,.05);border-bottom:1px solid rgba(255,255,255,.1)">' +
                ['','','Team','W','L','PCT','PF','PA','Streak'].map(function(h,i) {
                  return '<div style="font-size:8px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:rgba(255,255,255,.45);'+(i>=3?'text-align:center':'')+'">'+h+'</div>';
                }).join('') +
              '</div>'
        );

        teams.forEach(function(t, idx) {
          var isChamp = t.abbr === 'SEA';
          var isDivLeader = t.division;
          var isPlayoff = t.playoff;
          var rowBg = isChamp ? 'rgba(232,192,0,.08)' : isDivLeader ? 'rgba(255,255,255,.04)' : isPlayoff ? 'rgba(255,255,255,.025)' : 'transparent';
          var borderLeft = isChamp ? 'border-left:3px solid #E8C000' : isDivLeader ? 'border-left:3px solid rgba(255,255,255,.5)' : isPlayoff ? 'border-left:3px solid rgba(255,255,255,.2)' : 'border-left:3px solid transparent';

          html += (
            '<div style="display:grid;grid-template-columns:32px 48px 1fr 56px 56px 56px 56px 72px 80px;align-items:center;padding:.625rem 1rem;background:'+rowBg+';'+borderLeft+';border-bottom:1px solid rgba(255,255,255,.05);cursor:pointer;transition:background .12s" '+
              'onclick="TeamsView.showTeam(\''+t.abbr+'\')" '+
              'onmouseover="this.style.background=\'rgba(255,255,255,.07)\'" '+
              'onmouseout="this.style.background=\''+rowBg+'\'">' +
              /* Seed */
              '<div style="font-size:11px;font-weight:700;color:'+(t.seed ? '#E8C000' : 'rgba(255,255,255,.3)')+';text-align:center">'+(t.seed || '—')+'</div>' +
              /* Crest */
              '<div>' + teamCrest(t.abbr, 28) + '</div>' +
              /* Name */
              '<div>' +
                '<div style="font-size:14px;font-weight:700;color:#fff;display:flex;align-items:center;gap:6px">' +
                  t.name +
                  (isChamp ? '<span style="font-size:10px;background:rgba(232,192,0,.15);color:#E8C000;padding:1px 6px;border-radius:99px;font-weight:700">🏆 SB LX</span>' : '') +
                  (isDivLeader && !isChamp ? '<span style="font-size:8px;background:rgba(255,255,255,.15);color:#fff;padding:1px 6px;border-radius:99px;font-weight:700">DIV</span>' : '') +
                '</div>' +
                '<div style="font-size:10px;color:rgba(255,255,255,.65);margin-top:1px">'+t.note+'</div>' +
              '</div>' +
              /* Stats */
              [t.w, t.l, t.pct.toFixed(3), t.pf, t.pa].map(function(v, i) {
                return '<div style="font-family:\'DM Mono\',monospace;font-size:12px;font-weight:600;color:'+(i===0?'#4ade80':i===1?'#f87171':'rgba(255,255,255,.85)')+';text-align:center">'+v+'</div>';
              }).join('') +
              /* Streak */
              '<div style="text-align:center">' +
                '<span style="font-size:10px;font-weight:700;background:'+(t.streak.startsWith('W')?'rgba(65,105,225,.15)':'rgba(213,10,10,.15)')+';color:'+(t.streak.startsWith('W')?'#93c5fd':'#f87171')+';padding:2px 8px;border-radius:99px">'+t.streak+'</span>' +
              '</div>' +
            '</div>'
          );
        });

        html += '</div></div>';
      });

      html += '</div>';
    });

    body.innerHTML = html;
  },
};
