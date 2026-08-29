/* PropBetEdge NFL — verified 2025 regular-season leaders
 * Source of record: NFL.com 2025 REG player-stat tables, checked 2026-08-29.
 * This file is data-only. Do not hand-edit values without re-verifying the source.
 */
var StatsView = {
  source: {
    provider: 'NFL.com',
    season: 2025,
    seasonType: 'REG',
    verifiedAt: '2026-08-29',
    semantics: 'VERIFIED_FINAL'
  },
  STATS: {
    passing: {
      icon: '🎯', title: 'Passing Leaders',
      headers: ['#','Player','Team','ATT','CMP','YDS','TD','INT','RTG'],
      rows: [
        ['1','Matthew Stafford','LAR','597','388','4,707','46','8','109.2'],
        ['2','Jared Goff','DET','578','393','4,564','34','8','105.5'],
        ['3','Dak Prescott','DAL','600','404','4,552','30','10','99.5'],
        ['4','Drake Maye','NE','492','354','4,394','31','8','113.5'],
        ['5','Sam Darnold','SEA','477','323','4,048','25','14','99.1'],
        ['6','Trevor Lawrence','JAX','560','341','4,007','29','12','91.0'],
        ['7','Caleb Williams','CHI','568','330','3,942','27','7','90.1'],
        ['8','Bo Nix','DEN','612','388','3,931','25','11','87.8'],
        ['9','Justin Herbert','LAC','512','340','3,727','26','13','94.1'],
        ['10','Baker Mayfield','TB','543','343','3,693','26','11','90.6']
      ],
      highlight: 0,
      highlightNote: 'Verified NFL.com 2025 regular-season passing-yards leader.'
    },
    rushing: {
      icon: '💨', title: 'Rushing Leaders',
      headers: ['#','Player','Team','ATT','YDS','AVG','TD','FUM'],
      rows: [
        ['1','James Cook','BUF','309','1,621','5.2','12','6'],
        ['2','Derrick Henry','BAL','307','1,595','5.2','16','4'],
        ['3','Jonathan Taylor','IND','323','1,585','4.9','18','1'],
        ['4','Bijan Robinson','ATL','287','1,478','5.2','7','3'],
        ['5','De\'Von Achane','MIA','238','1,350','5.7','8','1'],
        ['6','Kyren Williams','LAR','259','1,252','4.8','10','2'],
        ['7','Jahmyr Gibbs','DET','243','1,223','5.0','13','2'],
        ['8','Christian McCaffrey','SF','311','1,202','3.9','10','1'],
        ['9','Javonte Williams','DAL','252','1,201','4.8','11','1'],
        ['10','Saquon Barkley','PHI','280','1,140','4.1','7','0']
      ],
      highlight: 0,
      highlightNote: 'Verified NFL.com 2025 regular-season rushing-yards leader.'
    },
    receiving: {
      icon: '🙌', title: 'Receiving Leaders',
      headers: ['#','Player','Team','REC','TGT','YDS','AVG','TD','YAC'],
      rows: [
        ['1','Jaxon Smith-Njigba','SEA','119','163','1,793','15.1','10','528'],
        ['2','Puka Nacua','LAR','129','166','1,715','13.3','10','666'],
        ['3','George Pickens','DAL','93','137','1,429','15.4','9','479'],
        ['4','Ja\'Marr Chase','CIN','125','185','1,412','11.3','8','640'],
        ['5','Amon-Ra St. Brown','DET','117','172','1,401','12.0','11','570'],
        ['6','Trey McBride','ARI','126','169','1,239','9.8','11','583'],
        ['7','Zay Flowers','BAL','86','118','1,211','14.1','5','458'],
        ['8','Chris Olave','NO','100','156','1,163','11.6','9','289'],
        ['9','Nico Collins','HOU','71','120','1,117','15.7','6','324'],
        ['10','Jameson Williams','DET','65','102','1,117','17.2','7','441']
      ],
      highlight: 0,
      highlightNote: 'Verified NFL.com 2025 regular-season receiving-yards leader.'
    },
    defense: {
      icon: '🛡️', title: 'Defensive Leaders — Sacks',
      headers: ['#','Player','Team','TOT','ASST','SOLO','SACKS'],
      rows: [
        ['1','Myles Garrett','CLE','60','17','40','23.0'],
        ['2','Brian Burns','NYG','67','28','39','16.5'],
        ['3','Danielle Hunter','HOU','54','26','28','15.0'],
        ['4','Aidan Hutchinson','DET','54','18','35','14.5'],
        ['5','Nik Bonitto','DEN','46','15','30','14.0'],
        ['6','Tuli Tuipulotu','LAC','49','14','32','13.0'],
        ['7','Micah Parsons','GB','41','22','17','12.5'],
        ['8','Will Anderson Jr.','HOU','54','19','31','12.0'],
        ['9','Josh Sweat','ARI','30','10','19','12.0'],
        ['10','Byron Young','2TM','82','37','44','12.0']
      ],
      highlight: 0,
      highlightNote: 'Verified NFL.com 2025 regular-season sacks leader.'
    },
    kicking: {
      icon: '🦵', title: 'Kicking Leaders — Field Goals Made',
      headers: ['#','Player','Team','FGM','FGA','PCT','LNG'],
      rows: [
        ['1','Ka\'imi Fairbairn','HOU','44','48','91.7','57'],
        ['2','Jason Myers','SEA','41','48','85.4','57'],
        ['3','Cameron Dicker','LAC','38','41','92.7','59'],
        ['4','Brandon Aubrey','DAL','36','42','85.7','64'],
        ['5','Harrison Butker','KC','33','38','86.8','59'],
        ['6','Will Reichard','MIN','33','35','94.3','62'],
        ['7','Chase McLaughlin','TB','32','38','84.2','65'],
        ['8','Cam Little','JAX','30','34','88.2','68'],
        ['9','Tyler Loop','BAL','30','34','88.2','52'],
        ['10','Blake Grupe','2TM','29','37','78.4','60']
      ],
      highlight: 0,
      highlightNote: 'Verified NFL.com 2025 regular-season field-goals-made leader.'
    }
  }
};