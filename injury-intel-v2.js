/* PropBetEdge NFL — Injury Editorial authority v4
 * Photo-led PropBetEdge injury coverage plus a source-disciplined availability
 * board. Structured upstream injury fields win; otherwise only explicit article
 * language is surfaced. Missing timelines stay missing rather than inferred.
 */
(() => {
  'use strict';

  let burstToken = 0;

  const esc = value => String(value ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const clean = value => String(value || '').replace(/\s+/g,' ').trim();
  const escapeRx = value => String(value || '').replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

  /* This module reads article prose to state what a named player's injury,
     status and return timeline are. The upstream feed serves one article's
     summary and entity tags on many rows -- 27 of 50 measured on 2026-09-04 --
     and that is exactly how "Patrick Mahomes - ACL" reached the availability
     board from a borrowed Chiefs dek attached to unrelated headlines.

     Every read of prose or entities below therefore goes through the trust
     guard. When a summary was suppressed the only evidence left is the title,
     which is the one field proven to be article-specific; a fact that cannot
     be built from it is simply not asserted. */
  const trustOf = a => a?._trust || null;
  const safeSummary = a => (trustOf(a) ? trustOf(a).summary : (a?.summary || '')) || '';
  const safePlayers = a => (trustOf(a) ? trustOf(a).players : (Array.isArray(a?.players) ? a.players : [])) || [];
  let TEAM_TERMS = null;
  function teamTerms() {
    if (TEAM_TERMS && TEAM_TERMS.length) return TEAM_TERMS;
    const map = (typeof window !== 'undefined' && window.NFL_TEAMS) || {};
    TEAM_TERMS = Object.entries(map).map(([abbr,t]) => {
      const name = String(t?.name || '');
      const terms = [name, t?.city, name.split(/\s+/).slice(-1)[0], abbr]
        .map(v => String(v || '').toLowerCase().replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim())
        .filter(v => v.length > 1);
      return { abbr:String(abbr).toUpperCase(), terms:[...new Set(terms)] };
    });
    return TEAM_TERMS;
  }
  function safeTeams(a) {
    const declared = (Array.isArray(a?.teams) ? a.teams : []).map(x => String(x).toUpperCase());
    if (!declared.length) return [];
    const hay = `${a?.title || ''} ${safeSummary(a)}`.toLowerCase().replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim();
    if (!hay) return [];
    const index = teamTerms();
    if (!index.length) return [];
    return declared.filter(code => {
      const row = index.find(t => t.abbr === code);
      if (!row) return false;
      return row.terms.some(term => term.length <= 3
        ? new RegExp(`(^| )${term}( |$)`).test(hay)
        : hay.includes(term));
    });
  }

  function timeAgo(value) {
    if (!value) return 'time unavailable';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return 'time unavailable';
    const seconds = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  function canonicalUrl(article) {
    const slug = clean(article?.slug).replace(/^\/+|\/+$/g,'');
    if (slug) return `https://propbetedge.ai/news/nfl/${slug}`;
    const raw = clean(article?.url);
    if (!raw) return null;
    try {
      const url = new URL(raw, 'https://propbetedge.ai');
      if (!/(^|\.)propbetedge\.ai$/i.test(url.hostname)) return null;
      if (!/^\/news\/nfl\//i.test(url.pathname)) return null;
      return url.href;
    } catch {
      return null;
    }
  }

  /* Whether a story is an injury story is itself decided on corroborated text.
     A borrowed ACL dek would otherwise pull half a dozen unrelated headlines --
     practice-squad signings, contract talk -- onto an injury page. */
  function injurySignal(article) {
    const title = clean(article?.title);
    const summary = clean(safeSummary(article));
    const text = `${title} ${summary}`;
    const strong = /\b(injur(?:y|ies|ed)|injured reserve|reserve[\/-]pup|pup(?:\s+list)?|nfi|ir(?:\s+list)?|acl|mcl|achilles|hamstring|ankle|knee|shoulder|concussion|surgery|rehab|recovery|sidelined|questionable|doubtful|inactive|out through|out for|will not play|won't play|miss(?:es|ing)?\s+(?:week|game|season)|return(?:s|ed)?\s+to\s+practice)\b/i;
    if (strong.test(text)) return true;
    const topic = clean(article?.topic_kind).toLowerCase();
    return topic === 'injury' && /\b(health|availability|depth|absence|status|return|week|season)\b/i.test(text);
  }

  function uniqueArticles(rows) {
    const seen = new Set();
    return rows.filter(article => {
      const url = canonicalUrl(article);
      if (!url || !injurySignal(article) || seen.has(url)) return false;
      seen.add(url);
      article.__pbeEditorialUrl = url;
      return true;
    }).sort((a,b) => new Date(b.published_at || 0) - new Date(a.published_at || 0));
  }

  function tokens(value) {
    const stop = new Set(['about','after','before','their','there','these','those','with','from','into','over','under','week','season','player','players','team','teams','will','have','has','been','this','that','they','what','where','when','while','without']);
    return new Set(clean(value).toLowerCase().replace(/[^a-z0-9' ]/g,' ').split(/\s+/).filter(word => word.length >= 4 && !stop.has(word)));
  }

  function deckFor(article, summaryCounts) {
    const summary = clean(safeSummary(article));
    if (summary.length < 36) return '';
    if ((summaryCounts.get(summary.toLowerCase()) || 0) > 1) return '';
    const titleTokens = tokens(article?.title);
    const summaryTokens = tokens(summary);
    const overlap = [...titleTokens].filter(token => summaryTokens.has(token)).length;
    if (titleTokens.size >= 3 && overlap === 0) return '';
    return summary.length > 230 ? `${summary.slice(0,227).trim()}…` : summary;
  }

  function summaryCounts(rows) {
    const map = new Map();
    rows.forEach(article => {
      const summary = clean(safeSummary(article)).toLowerCase();
      if (!summary) return;
      map.set(summary, (map.get(summary) || 0) + 1);
    });
    return map;
  }

  function contextChips(article, limit = 4) {
    const values = [];
    safeTeams(article).slice(0,2).forEach(team => values.push(`<span>${esc(team)}</span>`));
    safePlayers(article).slice(0,2).forEach(player => values.push(`<span class="person">${esc(player)}</span>`));
    return values.slice(0,limit).join('');
  }

  /* MEDIA
     Photography supports the injury information; it is not the interface. The
     old lead frame carried min-height:430px and stretched to 803x563 at 1440,
     so the reader met a tunnel-entrance photograph before a single fact.

     Preference order when a frame is filled:
       1. the article's own photograph, cropped to the subject
       2. the corroborated team's crest, on a flat plate
       3. a restrained PropBetEdge mark
     A crest is only used when the team survived corroboration, so the page
     never labels a photo-less story with a franchise it cannot support.

     CROP. Sports photography puts helmets and faces in the upper third, so a
     centred crop of a landscape frame decapitates the subject as often as not.
     onload reads the natural aspect and biases the focal point upward for wide
     sources, which is where the player actually is; portrait sources are left
     near centre because their subject already fills the frame. An asset that
     would have to be stretched past 1.35x its natural width is dropped rather
     than shown soft. */
  const CREST_ALIAS = { WAS:'wsh', WSH:'wsh' };
  function crestUrl(abbr) {
    const key = String(CREST_ALIAS[abbr] || abbr || '').toLowerCase();
    return key ? `https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/${key}.png` : '';
  }
  /* object-fit:cover crops along one axis only, and which axis depends on the
     source aspect RELATIVE TO THE FRAME -- not relative to 1.0. A 1024x718
     photograph in a 176x176 frame is cropped horizontally, so a vertical
     object-position does nothing to it. Comparing against the frame is what
     makes the bias land on the axis actually being cut: a source taller than
     its frame is pulled up towards the head, a source wider than its frame
     keeps its horizontal centre, which is the conservative choice when the
     subject's position is unknown. */
  const FOCUS_SCRIPT = "var box=this.getBoundingClientRect();var f=box.width/box.height,r=this.naturalWidth/this.naturalHeight;this.style.objectPosition=r<f?'50% 26%':'50% 50%';if(this.naturalWidth&&box.width>this.naturalWidth*1.35){this.closest('[data-pbe-media]').classList.add('is-lowres')}";

  function crestFrame(article, className) {
    const team = safeTeams(article)[0];
    const url = team ? crestUrl(team) : '';
    if (!url) return `<div class="${className} is-mark" data-pbe-media><span>PBE</span></div>`;
    return `<div class="${className} is-crest" data-pbe-media><img src="${esc(url)}" alt="${esc(team)} crest" loading="lazy" decoding="async" onerror="this.remove()"><b>${esc(team)}</b></div>`;
  }

  function articleImage(article, className, eager = false) {
    const src = clean(article?.image_url);
    if (!src) return crestFrame(article, className);
    return `<div class="${className}" data-pbe-media><img src="${esc(src)}" alt="${esc(article?.image_alt || article?.title || 'NFL injury coverage')}" ${eager?'fetchpriority="high"':'loading="lazy"'} decoding="async" onload="${esc(FOCUS_SCRIPT)}" onerror="this.closest('[data-pbe-media]').classList.add('is-mark');this.remove()"></div>`;
  }

  function byline(article) {
    const author = clean(article?.author) || 'PropBetEdge Editorial Team';
    return `By ${esc(author)} · ${esc(timeAgo(article?.published_at))}`;
  }

  function playerTerms(player) {
    const full = clean(player);
    const surname = full.split(/\s+/).filter(Boolean).at(-1)?.replace(/[^A-Za-z'.-]/g,'') || '';
    return [full, surname.length >= 4 ? surname : null].filter(Boolean);
  }

  function termPositions(text, term) {
    if (!text || !term) return [];
    const positions = [];
    const rx = new RegExp(`\\b${escapeRx(term)}(?:'s)?\\b`,'ig');
    let match;
    while ((match = rx.exec(text))) {
      positions.push(match.index);
      if (!match[0].length) rx.lastIndex += 1;
    }
    return positions;
  }

  function injuryMarkerPositions(text) {
    const positions = [];
    const rx = /\b(?:injur(?:y|ies|ed)|injured reserve|reserve[\/-]pup|pup|nfi|acl|mcl|achilles|hamstring|ankle|knee|shoulder|concussion|surgery|rehab(?:bing)?|recovery|sidelined|questionable|doubtful|inactive|out through|out for|will not play|won't play|miss(?:es|ing)?|back at practice|return(?:s|ed)? to practice|activated)\b/ig;
    let match;
    while ((match = rx.exec(text))) {
      positions.push(match.index);
      if (!match[0].length) rx.lastIndex += 1;
    }
    return positions;
  }

  function nearestDistance(points, markers) {
    let best = Infinity;
    points.forEach(point => markers.forEach(marker => { best = Math.min(best, Math.abs(point-marker)); }));
    return best;
  }

  function reportedPlayer(article) {
    const title = clean(article?.title);
    const summary = clean(safeSummary(article));
    const combined = `${title}. ${summary}`;
    const players = safePlayers(article).map(clean).filter(Boolean);
    if (!players.length) return null;
    const markers = injuryMarkerPositions(combined);
    const topic = clean(article?.topic_kind).toLowerCase();
    let best = null;

    players.forEach(player => {
      const terms = playerTerms(player);
      const titlePoints = terms.flatMap(term => termPositions(title,term));
      const summaryPoints = terms.flatMap(term => termPositions(summary,term));
      const combinedPoints = terms.flatMap(term => termPositions(combined,term));
      const inTitle = titlePoints.length > 0;
      const inSummary = summaryPoints.length > 0;
      if (!combinedPoints.length) return;
      if (!inTitle && topic !== 'injury' && !article?.availability) return;

      let score = (inTitle ? 4 : 0) + (inSummary ? 2 : 0);
      const distance = nearestDistance(combinedPoints,markers);
      if (distance <= 35) score += 10;
      else if (distance <= 75) score += 6;
      else if (distance <= 130) score += 3;
      else if (distance <= 220) score += 1;
      if (article?.availability) score += 3;
      if (!best || score > best.score || (score === best.score && distance < best.distance)) best = { player, score, distance, inTitle, inSummary };
    });

    if (best) return best.player;
    if (article?.availability && players.length === 1) return players[0];
    return null;
  }

  function contextForPlayer(article, player) {
    if (article?.availability) return `${clean(article?.title)} ${clean(safeSummary(article))}`;
    const title = clean(article?.title);
    const summary = clean(safeSummary(article));
    const terms = playerTerms(player);
    const pieces = [];
    const titleMention = terms.some(term => termPositions(title,term).length);
    if (titleMention) pieces.push(title);

    const summaryPoints = terms.flatMap(term => termPositions(summary,term));
    summaryPoints.forEach(point => pieces.push(summary.slice(Math.max(0,point-180),Math.min(summary.length,point+240))));

    if (titleMention && !summaryPoints.length) {
      const otherPlayerMention = safePlayers(article).map(clean).filter(Boolean).some(other => {
        if (other.toLowerCase() === clean(player).toLowerCase()) return false;
        return playerTerms(other).some(term => termPositions(summary,term).length);
      });
      if (!otherPlayerMention) pieces.push(summary);
    }

    return clean([...new Set(pieces.filter(Boolean))].join(' '));
  }

  function reportedInjury(article, text) {
    const structured = clean(article?.availability?.injury);
    if (structured) return structured;
    const patterns = [
      [/\b(?:torn\s+)?acl(?:\s+tear)?\b/i,'ACL'],
      [/\b(?:torn\s+)?mcl(?:\s+tear)?\b/i,'MCL'],
      [/\bachilles(?:\s+tear)?\b/i,'Achilles'],
      [/\bhamstring(?:\s+(?:strain|injury|issue))?\b/i,'Hamstring'],
      [/\bpectoral(?:\s+(?:strain|tear|injury))?\b|\bpec\s+(?:strain|tear|injury)\b/i,'Pectoral'],
      [/\bcervical(?:\s+issue)?\b|\bneck(?:\s+(?:injury|issue))?\b/i,'Neck'],
      [/\bconcussion\b/i,'Concussion'],
      [/\bankle(?:\s+(?:injury|sprain|issue))?\b/i,'Ankle'],
      [/\bknee(?:\s+(?:injury|sprain|issue))?\b/i,'Knee'],
      [/\bshoulder(?:\s+(?:injury|issue))?\b/i,'Shoulder'],
      [/\bfoot(?:\s+(?:injury|issue))?\b/i,'Foot'],
      [/\bcalf(?:\s+(?:injury|strain|issue))?\b/i,'Calf'],
      [/\b(?:quadriceps|quad)(?:\s+(?:injury|strain|issue))?\b/i,'Quadriceps'],
      [/\bgroin(?:\s+(?:injury|strain|issue))?\b/i,'Groin'],
      [/\bback(?:\s+(?:injury|issue))?\b/i,'Back'],
      [/\bwrist(?:\s+(?:injury|issue))?\b/i,'Wrist'],
      [/\bhand(?:\s+(?:injury|issue))?\b/i,'Hand'],
      [/\belbow(?:\s+(?:injury|issue))?\b/i,'Elbow'],
      [/\bhip(?:\s+(?:injury|issue))?\b/i,'Hip'],
      [/\bribs?(?:\s+(?:injury|issue))?\b/i,'Rib'],
      [/\billness\b/i,'Illness']
    ];
    for (const [pattern,label] of patterns) if (pattern.test(text)) return label;
    return 'Not specified';
  }

  function reportedStatus(article, text) {
    const structured = clean(article?.availability?.status);
    if (structured) return structured;
    if (/\bseason[- ]ending\b|\bout for (?:the )?(?:season|year)\b|\blost for (?:the )?year\b/i.test(text)) return 'Out — season';
    if (/\breserve[\/-]pup\b|\breserve pup\b/i.test(text)) return 'Reserve/PUP';
    if (/\bactivated from (?:the )?pup\b|\bactivation from (?:the )?pup\b|\bback from (?:the )?pup\b/i.test(text)) return 'Activated';
    if (/\bpup(?:\s+list)?\b/i.test(text)) return 'PUP';
    if (/\binjured reserve\b|\bon (?:the )?ir\b|\bto (?:the )?ir\b|\bIR list\b/i.test(text)) return 'Injured Reserve';
    if (/\bNFI\b|non-football injury/i.test(text)) return 'NFI';
    if (/\breturn(?:s|ed)? to practice\b|\bback at practice\b/i.test(text)) return 'Returned to practice';
    if (/\binactive\b/i.test(text)) return 'Inactive';
    if (/\bdoubtful\b/i.test(text)) return 'Doubtful';
    if (/\bquestionable\b/i.test(text)) return 'Questionable';
    if (/\bout through\b|\bout for\b|\bsidelined\b|\bwill not play\b|\bwon't play\b|\bmiss(?:es|ing)?\s+(?:week|game|season)/i.test(text)) return 'Out';
    if (/\brehab(?:bing)?\b|\brecovery\b/i.test(text)) return 'Rehabbing';
    return 'Injury reported';
  }

  function reportedTimeline(article, text) {
    const structured = clean(article?.availability?.expected_return);
    if (structured) return structured;
    const number = '(?:one|two|three|four|five|six|seven|eight|nine|ten|\\d+)';
    const patterns = [
      new RegExp(`\\bout through week\\s+\\d+\\b`,'i'),
      new RegExp(`\\b(?:out|sidelined)\\s+(?:until|through)\\s+week\\s+\\d+\\b`,'i'),
      new RegExp(`\\b(?:expected|targeted|projected)?\\s*(?:to\\s+)?return(?:ing)?\\s+(?:in|by|for)\\s+week\\s+\\d+\\b`,'i'),
      new RegExp(`\\bat least\\s+${number}\\s+(?:games?|weeks?|months?)\\b`,'i'),
      new RegExp(`\\b(?:out|sidelined)\\s+(?:for\\s+)?(?:at least\\s+)?${number}\\s+(?:games?|weeks?|months?)\\b`,'i'),
      new RegExp(`\\b${number}[- ]week absence\\b`,'i'),
      new RegExp(`\\bmiss(?:es|ing)?\\s+(?:at least\\s+)?${number}\\s+(?:games?|weeks?)\\b`,'i'),
      new RegExp(`\\bmiss(?:es|ing)?\\s+week\\s+\\d+\\b`,'i'),
      /\buntil week\s+\d+\b/i,
      /\bseason[- ]ending\b/i,
      /\bout for (?:the )?(?:season|year)\b/i,
      /\blost for (?:the )?year\b/i
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[0]) return match[0].replace(/^./,letter=>letter.toUpperCase());
    }
    return 'Timeline not reported';
  }

  function factForArticle(article) {
    const player = reportedPlayer(article);
    if (!player) return null;
    const text = contextForPlayer(article,player);
    if (!text && !article?.availability) return null;
    const injury = reportedInjury(article,text);
    const status = reportedStatus(article,text);
    const timeline = reportedTimeline(article,text);
    const explicit = Boolean(article?.availability) || injury !== 'Not specified' || status !== 'Injury reported' || timeline !== 'Timeline not reported';
    if (!explicit) return null;
    const score = (article?.availability?3:0) + (injury!=='Not specified'?1:0) + (status!=='Injury reported'?2:0) + (timeline!=='Timeline not reported'?4:0);
    return {
      player,
      team:safeTeams(article)[0] || '',
      injury,
      status,
      timeline,
      score,
      published_at:article?.published_at || null,
      url:article.__pbeEditorialUrl || canonicalUrl(article),
      title:clean(article?.title)
    };
  }

  function availabilityFacts(rows, limit = 12) {
    const best = new Map();
    rows.forEach(article => {
      const fact = factForArticle(article);
      if (!fact) return;
      const key = fact.player.toLowerCase();
      const current = best.get(key);
      if (!current || fact.score > current.score || (fact.score === current.score && new Date(fact.published_at||0) > new Date(current.published_at||0))) best.set(key,fact);
    });
    return [...best.values()]
      .sort((a,b) => b.score-a.score || new Date(b.published_at||0)-new Date(a.published_at||0))
      .slice(0,limit);
  }

  function statusClass(status) {
    const value=clean(status).toLowerCase();
    if (/season|reserve|injured reserve|inactive|\bout\b/.test(value)) return 'is-out';
    if (/questionable|doubtful|rehab/.test(value)) return 'is-watch';
    if (/return|activat/.test(value)) return 'is-returning';
    return 'is-reported';
  }

  function availabilityRow(fact) {
    const timelineUnknown = fact.timeline === 'Timeline not reported';
    return `<a class="pbe13-availability-row" href="${esc(fact.url)}" target="_blank" rel="noopener">
      <div class="pbe13-availability-player"><strong>${esc(fact.player)}</strong>${fact.team?`<span>${esc(fact.team)}</span>`:''}</div>
      <div class="pbe13-availability-cell"><span class="label">INJURY</span><strong>${esc(fact.injury)}</strong></div>
      <div class="pbe13-availability-cell"><span class="label">STATUS</span><strong class="pbe13-avail-status ${statusClass(fact.status)}">${esc(fact.status)}</strong></div>
      <div class="pbe13-availability-cell timeline ${timelineUnknown?'is-unknown':''}"><span class="label">REPORTED TIMELINE</span><strong>${esc(fact.timeline)}</strong><small>${esc(timeAgo(fact.published_at))} · PBE coverage ↗</small></div>
    </a>`;
  }

  function availabilityBoard(rows) {
    const facts = availabilityFacts(rows);
    if (!facts.length) return '';
    const withTimeline = facts.filter(fact=>fact.timeline!=='Timeline not reported').length;
    return `<section class="pbe13-availability-board" aria-label="Reported NFL player injury availability">
      <div class="pbe13-availability-head">
        <div><span>PLAYER AVAILABILITY</span><h2>Who's out & how long</h2><p>Player-level injury context pulled from current PropBetEdge reporting. Return windows appear only when the coverage explicitly reports one.</p></div>
        <div class="pbe13-availability-coverage"><strong>${withTimeline}</strong><span>reported timelines</span></div>
      </div>
      <div class="pbe13-availability-list">${facts.map(availabilityRow).join('')}</div>
      <div class="pbe13-availability-foot">No return estimate means the current PropBetEdge coverage does not state one. PUP/IR labels are shown as reported; no minimum absence is inferred from the designation alone.</div>
    </section>`;
  }

  /* The feature leads with the facts, not with the headline. Who, which team,
     what the injury is, what status the reporting states and what timeline it
     states -- then the story that says so. An unreported field is labelled as
     unreported; nothing is inferred to fill the row. */
  function factCells(fact) {
    const cells = [
      ['Injury', fact.injury, fact.injury === 'Not specified'],
      ['Status', fact.status, false],
      ['Reported timeline', fact.timeline, fact.timeline === 'Timeline not reported']
    ];
    return `<div class="pbe13-feature-facts">${cells.map(([label,value,unknown]) =>
      `<div class="pbe13-feature-fact${unknown?' is-unreported':''}"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`
    ).join('')}</div>`;
  }

  function researchPath(fact) {
    if (!fact?.player) return '';
    const last = fact.player.split(/\s+/).slice(-1)[0];
    return `<button type="button" class="pbe13-feature-path" data-injury-player="${esc(fact.player)}">${esc(last)} research<i>&rarr;</i></button>`;
  }

  function leadStory(article, counts) {
    if (!article) return `<div class="pbe13-editorial-empty"><strong>No current injury features</strong><span>The PropBetEdge newsroom is live, but no canonical NFL injury article currently matches the editorial filter.</span></div>`;
    const deck = deckFor(article, counts);
    const fact = factForArticle(article);
    const team = fact?.team || safeTeams(article)[0] || '';
    return `<article class="pbe13-feature">
      <a class="pbe13-feature-medialink" href="${esc(article.__pbeEditorialUrl)}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true">
        ${articleImage(article,'pbe13-feature-media',true)}
      </a>
      <div class="pbe13-feature-body">
        <div class="pbe13-feature-rail"><span class="pbe13-feature-eyebrow">Featured injury</span><span class="pbe13-feature-time">${esc(timeAgo(article?.published_at))}</span></div>
        ${fact ? `<div class="pbe13-feature-id"><h2>${esc(fact.player)}</h2>${team?`<span class="pbe13-feature-team">${esc(team)}</span>`:''}</div>
        ${factCells(fact)}` : `<div class="pbe13-feature-id"><h2>${esc(article.title)}</h2></div>`}
        <a class="pbe13-feature-story" href="${esc(article.__pbeEditorialUrl)}" target="_blank" rel="noopener">${esc(article.title)}</a>
        ${deck?`<p class="pbe13-feature-deck">${esc(deck)}</p>`:''}
        <div class="pbe13-feature-foot">
          <span class="pbe13-editorial-meta">${byline(article)}</span>
          ${researchPath(fact)}
        </div>
      </div>
    </article>`;
  }

  /* Coverage rows, not a photo grid. Only a story that carries its own
     corroborated deck earns a thumbnail; the rest are a headline, a team and a
     time, which is all that is true of them. That is also what stops the page
     reserving a 16:9 well for an image it does not have. */
  function storyCard(article, counts, withMedia) {
    const deck = deckFor(article, counts);
    const team = safeTeams(article)[0] || '';
    const fact = factForArticle(article);
    const media = withMedia && clean(article?.image_url);
    return `<a class="pbe13-coverage-row${media?' has-media':''}" href="${esc(article.__pbeEditorialUrl)}" target="_blank" rel="noopener">
      ${media?articleImage(article,'pbe13-coverage-media'):''}
      <div class="pbe13-coverage-body">
        <div class="pbe13-coverage-kicker">${team?`<span class="pbe13-coverage-team">${esc(team)}</span>`:''}<span>${esc(timeAgo(article?.published_at))}</span></div>
        <h3>${esc(article.title)}</h3>
        ${deck?`<p>${esc(deck)}</p>`:''}
        ${fact&&fact.timeline!=='Timeline not reported'?`<div class="pbe13-card-timeline"><span>${esc(fact.status)}</span><strong>${esc(fact.timeline)}</strong></div>`:''}
        <div class="pbe13-editorial-chips">${contextChips(article,3)}</div>
      </div>
    </a>`;
  }

  /* PAGE ORDER
     The old top was a 240px marketing headline ("Injuries change everything."),
     a disclaimer strip and an 803x563 photograph -- roughly 900px before the
     first injury fact, so nothing useful was in the opening viewport at any
     width. The order is now identity, the featured player's actual status, and
     then the availability board, which is the strongest component on the page
     and now begins in the second screen rather than the fourth. Editorial
     coverage sits underneath the structured information, where it belongs. */
  function shell(state, rows) {
    const counts = summaryCounts(rows);
    const lead = rows[0] || null;
    const rest = rows.slice(1);
    const facts = availabilityFacts(rows);
    const withTimeline = facts.filter(f => f.timeline !== 'Timeline not reported').length;
    const nowLine = state?.error
      ? 'Coverage temporarily unavailable'
      : `${rows.length} current injury stories · ${facts.length} players with reported status · ${withTimeline} reported timelines`;
    return `<header class="pbe13-masthead">
      <div class="pbe13-mast-id">
        <span class="pbe13-eyebrow">NFL &middot; Availability + verified status</span>
        <h1 class="pbe13-wordmark">Injury Intelligence</h1>
      </div>
      <div class="pbe13-mast-now"><span class="pbe13-now-line">${esc(nowLine)}</span></div>
    </header>
    <p class="pbe13-truth">Reporting and analysis from PropBetEdge articles &mdash; not the official NFL practice or game injury report. No status or return window is shown beyond what the underlying reporting states.</p>
    ${state?.error?`<div class="pbe13-editorial-empty"><strong>Injury coverage unavailable</strong><span>${esc(state.error)}</span></div>`:leadStory(lead,counts)}
    ${!state?.error?`${availabilityBoard(rows)}<section class="pbe13-coverage">
      <div class="pbe13-section-head"><h2>Latest injury coverage</h2><a href="https://propbetedge.ai/news/nfl" target="_blank" rel="noopener">All NFL news &#8599;</a></div>
      ${rest.length?`<div class="pbe13-coverage-list">${rest.map((article,i)=>storyCard(article,counts,i<4)).join('')}</div>`:`<div class="pbe13-editorial-empty compact"><span>No additional injury stories are currently available.</span></div>`}
    </section>`:''}`;
  }

  function wirePaths(root) {
    root.querySelectorAll('[data-injury-player]').forEach(btn => btn.addEventListener('click', () => {
      const name = btn.dataset.injuryPlayer;
      if (window.PBEPlayerResearch?.show) window.PBEPlayerResearch.show(name);
      else window.App?.nav('usage');
    }));
  }

  function enhance() {
    if (window.App?.current !== 'injuries') return false;
    const state = window.PBENewsroomV2?.state;
    const root = document.querySelector('.pbe13-news');
    if (!state || !root || state.loading) return false;
    const rows = uniqueArticles(Array.isArray(state.articles) ? state.articles : []);
    const signature = `${state.error||''}|${state.fetchedAt||''}|${rows.map(article=>article.id||article.__pbeEditorialUrl).join('|')}`;
    if (root.dataset.pbeInjuryEditorialSignature === signature && root.classList.contains('pbe13-injury-editorial')) return true;
    root.classList.add('pbe13-injury-v2','pbe13-injury-editorial');
    root.dataset.pbeInjuryEditorialSignature = signature;
    root.innerHTML = shell(state, rows);
    wirePaths(root);
    return true;
  }

  function burst() {
    const token = ++burstToken;
    [0,70,180,420,900,1600,2600].forEach(delay => setTimeout(() => {
      if (token === burstToken) enhance();
    }, delay));
  }

  window.addEventListener('pbe:route-changed', burst);
  window.addEventListener('pbe:upgrades-ready', burst);
  document.addEventListener('DOMContentLoaded', burst, { once: true });
  if (document.readyState !== 'loading') burst();

  window.PBEInjuryIntelV2 = { enhance, burst, canonicalUrl, injurySignal, factForArticle, availabilityFacts };
})();
