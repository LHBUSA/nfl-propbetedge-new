/* STATS.JS — World Class NFL Stats Leaders */
var StatsView = {
  currentTab: 'passing',

  STATS: {
    passing: {
      icon: '🎯', title: 'Passing Leaders',
      headers: ['#','Player','Team','ATT','CMP','YDS','TD','INT','RTG'],
      rows: [
        ['1','Matthew Stafford','LAR','491','332','4,707','46','8', '109.2'],
        ['2','Drake Maye',      'NE', '498','338','4,380','33','10','104.8'],
        ['3','Lamar Jackson',   'BAL','422','278','3,740','32','8', '105.1'],
        ['4','Jalen Hurts',     'PHI','466','298','3,920','28','8', '99.4'],
        ['5','Josh Allen',      'BUF','454','298','3,864','31','10','98.8'],
        ['6','Jared Goff',      'DET','501','334','4,002','29','11','97.3'],
        ['7','Sam Darnold',     'SEA','442','295','3,840','28','9', '101.2'],
        ['8','Patrick Mahomes', 'KC', '498','322','3,928','28','11','92.4'],
        ['9','Baker Mayfield',  'TB', '471','309','3,890','26','9', '96.8'],
        ['10','Kyler Murray',   'ARI','418','271','3,620','24','10','96.2'],
      ],
      highlight: 0, highlightNote: '2025 NFL MVP — Led league in TDs (46) and won AP MVP over Drake Maye',
    },
    rushing: {
      icon: '💨', title: 'Rushing Leaders',
      headers: ['#','Player','Team','ATT','YDS','AVG','TD','FUM'],
      rows: [
        ['1','Kenneth Walker III','SEA','298','1,760','5.9','14','2'],
        ['2','Saquon Barkley',   'PHI','312','1,544','4.9','11','1'],
        ['3','Derrick Henry',    'BAL','288','1,412','4.9','12','2'],
        ['4','Josh Jacobs',      'GB', '260','1,329','5.1','9', '1'],
        ['5','Kyren Williams',   'LAR','241','1,281','5.3','10','1'],
        ['6','James Cook',       'BUF','228','1,198','5.3','8', '0'],
        ['7','Jahmyr Gibbs',     'DET','224','1,176','5.2','11','1'],
        ['8','Lamar Jackson',    'BAL','148','918', '6.2','8', '2'],
        ['9','De\'Von Achane',   'MIA','198','987', '4.9','9', '1'],
        ['10','Bijan Robinson',  'ATL','226','1,012','4.5','7', '2'],
      ],
      highlight: 0, highlightNote: 'SB LX MVP — 135 yards on 27 carries in Super Bowl win over New England',
    },
    receiving: {
      icon: '🙌', title: 'Receiving Leaders',
      headers: ['#','Player','Team','REC','TGT','YDS','AVG','TD','YAC'],
      rows: [
        ['1','Jaxon Smith-Njigba','SEA','104','142','1,487','14.3','11','6.2'],
        ['2','CeeDee Lamb',       'DAL','118','163','1,456','12.3','12','5.8'],
        ['3','Davante Adams',     'LAR','112','148','1,389','12.4','11','4.9'],
        ['4','Puka Nacua',        'LAR','98', '131','1,342','13.7','9', '5.4'],
        ['5','Ja\'Marr Chase',    'CIN','102','138','1,298','12.7','10','5.1'],
        ['6','Amon-Ra St. Brown', 'DET','108','139','1,245','11.5','8', '5.8'],
        ['7','A.J. Brown',        'PHI','94', '124','1,198','12.7','9', '4.8'],
        ['8','Stefon Diggs',      'WAS','88', '118','1,112','12.6','8', '5.2'],
        ['9','Justin Jefferson',  'MIN','90', '126','1,089','12.1','7', '4.9'],
        ['10','Rashee Rice',      'KC', '86', '114','1,056','12.3','9', '5.1'],
      ],
      highlight: 0, highlightNote: '2025 Offensive Player of the Year — Led NFL in receiving yards',
    },
    defense: {
      icon: '🛡️', title: 'Defensive Leaders — Sacks',
      headers: ['#','Player','Team','POS','SACKS','TFL','QB HITS','FF','SOLO'],
      rows: [
        ['1','Myles Garrett',    'CLE','DE', '23.0','33','39','4','43'],
        ['2','Micah Parsons',    'DAL','LB', '17.5','22','28','3','54'],
        ['3','Trey Hendrickson', 'CIN','DE', '16.0','20','31','3','38'],
        ['4','Maxx Crosby',      'LV', 'DE', '14.5','18','26','2','41'],
        ['5','Brian Burns',      'NYG','DE', '13.5','17','22','2','36'],
        ['6','Chris Jones',      'KC', 'DT', '13.0','16','29','1','32'],
        ['7','Uchenna Nwosu',    'SEA','LB', '12.5','18','21','3','48'],
        ['8','Rashan Gary',      'GB', 'OLB','12.0','15','20','2','34'],
        ['9','Khalil Mack',      'LAC','DE', '11.5','14','19','3','31'],
        ['10','Josh Uche',       'NE', 'LB', '11.0','14','18','2','29'],
      ],
      highlight: 0, highlightNote: '2025 Defensive POY — 23 sacks breaks Michael Strahan\'s record set in 2001',
    },
    kicking: {
      icon: '🦵', title: 'Kicking Leaders',
      headers: ['#','Player','Team','FGM','FGA','PCT','LNG','XPM','PTS'],
      rows: [
        ['1','Justin Tucker',    'BAL','38','41','92.7','61','42','156'],
        ['2','Evan McPherson',   'CIN','35','38','92.1','58','40','145'],
        ['3','Tyler Bass',       'BUF','33','36','91.7','56','41','140'],
        ['4','Harrison Butker',  'KC', '32','35','91.4','57','43','139'],
        ['5','Jake Elliott',     'PHI','31','34','91.2','54','42','135'],
        ['6','Jason Myers',      'SEA','30','33','90.9','55','44','134'],
        ['7','Brandon Aubrey',   'DAL','31','34','91.2','53','40','133'],
        ['8','Chris Boswell',    'PIT','29','32','90.6','54','41','128'],
        ['9','Ka\'imi Fairbairn','HOU','28','31','90.3','52','42','126'],
        ['10','Dustin Hopkins',  'LAC','28','32','87.5','55','40','124'],
      ],
      highlight: -1, highlightNote: '',
    },
  },

  render: function() {
    var self = this;
    var vc = document.getElementById('view-container');

    var tabs = Object.keys(this.STATS).map(function(key) {
      var s = self.STATS[key];
      var active = key === self.currentTab;
      return '<div onclick="StatsView.setTab(\''+key+'\')" style="display:flex;align-items:center;gap:6px;padding:.875rem 1.25rem;font-size:13px;font-weight:600;color:'+(active?'#93c5fd':'rgba(255,255,255,.55)')+';cursor:pointer;border-bottom:2px solid '+(active?'#4169E1':'transparent')+';white-space:nowrap;transition:all .15s">'+s.icon+' '+s.title.split(' ')[0]+'</div>';
    }).join('');

    vc.innerHTML = (
      '<div style="background:linear-gradient(135deg,#0D1117,#141B25);border-bottom:1px solid rgba(65,105,225,.2);padding:1.75rem 2rem 1.5rem;position:relative;overflow:hidden">' +
        '<div style="position:absolute;right:-20px;top:-20px;font-family:\'Barlow Condensed\',sans-serif;font-size:180px;font-weight:900;color:rgba(255,255,255,.03);line-height:1;pointer-events:none">STATS</div>' +
        '<div style="font-size:9px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;color:#93c5fd;margin-bottom:.35rem">2025 NFL Season · Final</div>' +
        '<div style="font-family:\'Barlow Condensed\',sans-serif;font-size:clamp(28px,4vw,44px);font-weight:900;color:#fff;text-transform:uppercase;letter-spacing:-1.5px;line-height:.95">Statistical Leaders</div>' +
        '<div style="font-size:13px;color:rgba(255,255,255,.55);margin-top:.4rem">Full-season leaders · Passing · Rushing · Receiving · Defense · Kicking</div>' +
      '</div>' +
      '<div style="background:rgba(8,14,30,.9);border-bottom:1px solid rgba(255,255,255,.08);display:flex;overflow-x:auto;backdrop-filter:blur(10px);padding:0 .5rem">' + tabs + '</div>' +
      '<div id="stats-body" style="padding:1.5rem 2rem"></div>' +
      FooterComp.html()
    );

    this.renderTable();
  },

  setTab: function(tab) {
    this.currentTab = tab;
    // Update tab styles
    var tabs = document.querySelectorAll('[onclick*="StatsView.setTab"]');
    var self = this;
    tabs.forEach(function(t, i) {
      var key = Object.keys(self.STATS)[i];
      var active = key === tab;
      t.style.color = active ? '#93c5fd' : 'rgba(255,255,255,.55)';
      t.style.borderBottomColor = active ? '#4169E1' : 'transparent';
    });
    this.renderTable();
  },

  renderTable: function() {
    var body = document.getElementById('stats-body');
    if (!body) return;
    var data = this.STATS[this.currentTab];

    var highlight = data.highlight >= 0 ? (
      '<div style="background:linear-gradient(135deg,rgba(65,105,225,.1),rgba(255,255,255,.04));border:1px solid rgba(65,105,225,.25);border-left:3px solid #93c5fd;border-radius:10px;padding:1rem 1.25rem;margin-bottom:1.5rem;display:flex;align-items:center;gap:12px">' +
        teamCrest(this.STATS[this.currentTab].rows[0][2], 32) +
        '<div>' +
          '<div style="font-family:\'Barlow Condensed\',sans-serif;font-size:18px;font-weight:900;color:#fff">'+data.rows[0][1]+' <span style="color:#93c5fd">'+data.rows[0][2]+'</span></div>' +
          '<div style="font-size:12px;color:rgba(255,255,255,.65);margin-top:2px">'+data.highlightNote+'</div>' +
        '</div>' +
      '</div>'
    ) : '';

    var table = (
      '<div style="background:#141B25;border:1px solid rgba(255,255,255,.1);border-radius:14px;overflow:hidden">' +
        /* Header */
        '<div style="display:grid;grid-template-columns:36px 48px 1fr'+data.headers.slice(3).map(function(){return ' 72px';}).join('')+';padding:.625rem 1rem;background:rgba(255,255,255,.05);border-bottom:1px solid rgba(255,255,255,.08)">' +
          data.headers.map(function(h, i) {
            return '<div style="font-size:8px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:rgba(255,255,255,.5);'+(i>2?'text-align:center':'')+'">'+h+'</div>';
          }).join('') +
        '</div>' +
        /* Rows */
        data.rows.map(function(row, idx) {
          var isTop = idx === 0;
          var rowBg = isTop ? 'rgba(232,192,0,.04)' : idx < 3 ? 'rgba(65,105,225,.04)' : 'transparent';
          return (
            '<div style="display:grid;grid-template-columns:36px 48px 1fr'+row.slice(3).map(function(){return ' 72px';}).join('')+';align-items:center;padding:.625rem 1rem;background:'+rowBg+';border-bottom:1px solid rgba(255,255,255,.04);cursor:pointer;transition:background .12s" '+
              'onclick="PlayerModal.show(\''+row[1]+'\')" '+
              'onmouseover="this.style.background=\'rgba(65,105,225,.1)\'" '+
              'onmouseout="this.style.background=\''+rowBg+'\'">' +
              /* Rank */
              '<div style="font-family:\'DM Mono\',monospace;font-size:12px;font-weight:700;color:'+(isTop?'#E8C000':idx<3?'#93c5fd':'rgba(255,255,255,.4)')+';text-align:center">'+row[0]+'</div>' +
              /* Crest */
              '<div>'+teamCrest(row[2], 28)+'</div>' +
              /* Name + Team */
              '<div>' +
                '<div style="font-size:13px;font-weight:700;color:#fff;display:flex;align-items:center;gap:6px">' +
                  row[1] +
                  (isTop ? '<span style="font-size:8px;background:rgba(232,192,0,.15);color:#E8C000;padding:1px 6px;border-radius:99px;font-weight:700">#1</span>' : '') +
                '</div>' +
                '<div style="font-size:10px;color:rgba(255,255,255,.5)">'+row[2]+'</div>' +
              '</div>' +
              /* Stats */
              row.slice(3).map(function(v, i) {
                var isYds = i === 2; // YDS column
                var isTD  = i === 3; // TD column
                return '<div style="font-family:\'DM Mono\',monospace;font-size:12px;font-weight:'+(isYds||isTD?'700':'500')+';color:'+(isYds?'#93c5fd':isTD?'#E8C000':'rgba(255,255,255,.75)')+';text-align:center">'+v+'</div>';
              }).join('') +
            '</div>'
          );
        }).join('') +
      '</div>'
    );

    body.innerHTML = highlight + table;
  },
};
