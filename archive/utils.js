/* ═══════════════════════════════════════════════
   COMPONENTS/UTILS.JS
   Shared visual utilities — loaded before all views
   PropBetEdge NFL
═══════════════════════════════════════════════ */

var TEAM_VISUALS = {
  PHI:{ c1:'#004C54', c2:'#A5ACAF', name:'Eagles'     },
  DAL:{ c1:'#003594', c2:'#869397', name:'Cowboys'     },
  KC: { c1:'#E31837', c2:'#FFB81C', name:'Chiefs'      },
  BAL:{ c1:'#241773', c2:'#9E7C0C', name:'Ravens'      },
  BUF:{ c1:'#00338D', c2:'#C60C30', name:'Bills'       },
  DET:{ c1:'#0076B6', c2:'#B0B7BC', name:'Lions'       },
  MIN:{ c1:'#4F2683', c2:'#FFC62F', name:'Vikings'     },
  GB: { c1:'#203731', c2:'#FFB612', name:'Packers'     },
  SF: { c1:'#AA0000', c2:'#B3995D', name:'49ers'       },
  LAR:{ c1:'#003594', c2:'#FFA300', name:'Rams'        },
  MIA:{ c1:'#008E97', c2:'#FC4C02', name:'Dolphins'    },
  NE: { c1:'#002244', c2:'#C60C30', name:'Patriots'    },
  PIT:{ c1:'#101820', c2:'#FFB612', name:'Steelers'    },
  CIN:{ c1:'#FB4F14', c2:'#000000', name:'Bengals'     },
  WAS:{ c1:'#5A1414', c2:'#FFB612', name:'Commanders'  },
  NYG:{ c1:'#0B2265', c2:'#A71930', name:'Giants'      },
  NYJ:{ c1:'#125740', c2:'#FFFFFF', name:'Jets'        },
  CLE:{ c1:'#311D00', c2:'#FF3C00', name:'Browns'      },
  IND:{ c1:'#002C5F', c2:'#A2AAAD', name:'Colts'       },
  HOU:{ c1:'#03202F', c2:'#A71930', name:'Texans'      },
  TEN:{ c1:'#0C2340', c2:'#4B92DB', name:'Titans'      },
  JAX:{ c1:'#006778', c2:'#9F792C', name:'Jaguars'     },
  DEN:{ c1:'#FB4F14', c2:'#002244', name:'Broncos'     },
  LV: { c1:'#A5ACAF', c2:'#000000', name:'Raiders'     },
  LAC:{ c1:'#0080C6', c2:'#FFC20E', name:'Chargers'    },
  SEA:{ c1:'#002244', c2:'#69BE28', name:'Seahawks'    },
  ARI:{ c1:'#97233F', c2:'#FFB612', name:'Cardinals'   },
  ATL:{ c1:'#A71930', c2:'#000000', name:'Falcons'     },
  CAR:{ c1:'#0085CA', c2:'#101820', name:'Panthers'    },
  NO: { c1:'#D3BC8D', c2:'#101820', name:'Saints'      },
  TB: { c1:'#D50A0A', c2:'#FF7900', name:'Buccaneers'  },
  CHI:{ c1:'#0B162A', c2:'#C83803', name:'Bears'       },
  // Historical / relocated
  STL:{ c1:'#003594', c2:'#FFA300', name:'Rams'        },
  OAK:{ c1:'#A5ACAF', c2:'#000000', name:'Raiders'     },
  SD: { c1:'#0080C6', c2:'#FFC20E', name:'Chargers'    },
};

function teamLogoUrl(abbr, scoreboard) {
  var raw = String(abbr || '').replace(/[^A-Za-z]/g, '').toUpperCase();
  if (!raw) return '';
  var slug = raw === 'WAS' ? 'wsh' : raw.toLowerCase();
  return scoreboard === false
    ? 'https://a.espncdn.com/i/teamlogos/nfl/500/' + slug + '.png'
    : 'https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/' + slug + '.png';
}

/**
 * Build a real NFL team crest image for any team. Synthetic shields and
 * abbreviation marks are intentionally not used as fallbacks.
 * @param {string} abbr - team abbreviation
 * @param {number} size - pixel size (default 48)
 * @returns {string} HTML string
 */
function teamCrest(abbr, size) {
  size = Math.max(18, Math.min(96, Number(size) || 48));
  var tv = TEAM_VISUALS[abbr] || { name:abbr };
  var primary = teamLogoUrl(abbr, true);
  var alternate = teamLogoUrl(abbr, false);
  if (!primary) return '';
  return '<img class="team-crest pbe-official-team-logo" src="' + primary + '" data-alt-src="' + alternate + '" data-team-abbr="' + String(abbr || '') + '" alt="' + String(tv.name || abbr || 'NFL') + ' logo" width="' + size + '" height="' + size + '" loading="lazy" decoding="async">';
}

/**
 * Build a player jersey card visual
 * @param {string} player - player full name
 * @param {string} pos    - position
 * @param {string} team   - team abbreviation
 * @param {string} num    - jersey number
 * @returns {string} HTML string
 */
function playerCard(player, pos, team, num) {
  var tv = TEAM_VISUALS[team] || { c1:'#166534', c2:'#22c55e' };
  return '<div style="display:flex;align-items:center;gap:8px">' +
    '<svg width="36" height="44" viewBox="0 0 36 44">' +
      '<path d="M8 6 L4 14 L10 16 L10 40 L26 40 L26 16 L32 14 L28 6 L22 8 C20 5 16 5 14 8 Z" fill="' + tv.c1 + '"/>' +
      '<path d="M8 6 L4 14 L10 16 L10 40 L26 40 L26 16 L32 14 L28 6 L22 8 C20 5 16 5 14 8 Z" fill="none" stroke="' + tv.c2 + '" stroke-width="1.5"/>' +
      '<text x="18" y="30" text-anchor="middle" fill="' + tv.c2 + '" font-size="11" font-weight="900" font-family="Barlow Condensed,sans-serif">' + (num || '') + '</text>' +
    '</svg>' +
    '<div>' +
      '<div style="font-family:var(--font-display);font-size:14px;font-weight:800;color:#fff;text-transform:uppercase;line-height:1">' + player.split(' ').pop() + '</div>' +
      '<div style="font-size:9px;color:rgba(255,255,255,.55);margin-top:1px">' + pos + ' · ' + team + '</div>' +
    '</div>' +
  '</div>';
}

/**
 * Jersey SVG card for picks engine and player displays
 */
function jerseyCard(num, team, pos) {
  var tv = TEAM_VISUALS[team] || { c1:'#166534', c2:'#22c55e' };
  var uid = (num||'') + (team||'') + String((window.__pbeArchiveUid = (window.__pbeArchiveUid || 0) + 1));
  return '<svg width="44" height="54" viewBox="0 0 44 54" fill="none">' +
    '<defs><linearGradient id="jg' + uid + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="' + tv.c1 + '"/>' +
      '<stop offset="100%" stop-color="' + tv.c1 + '" stop-opacity=".7"/>' +
    '</linearGradient></defs>' +
    '<path d="M10 10 L3 22 L12 26 L12 50 L32 50 L32 26 L41 22 L34 10 L28 13 C25 9 19 9 16 13 Z" fill="url(#jg' + uid + ')"/>' +
    '<path d="M10 10 L3 22 L12 26 L12 50 L32 50 L32 26 L41 22 L34 10 L28 13 C25 9 19 9 16 13 Z" fill="none" stroke="' + tv.c2 + '" stroke-width="1.5" opacity=".5"/>' +
    '<line x1="12" y1="27" x2="32" y2="27" stroke="' + tv.c2 + '" stroke-width="2" opacity=".25"/>' +
    '<text x="22" y="43" text-anchor="middle" fill="' + tv.c2 + '" font-size="16" font-weight="900" font-family="Barlow Condensed,sans-serif" letter-spacing="-0.5">' + (num || pos || '') + '</text>' +
  '</svg>';
}
