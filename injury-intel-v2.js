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

  function injurySignal(article) {
    const title = clean(article?.title);
    const summary = clean(article?.summary);
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
    const summary = clean(article?.summary);
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
      const summary = clean(article?.summary).toLowerCase();
      if (!summary) return;
      map.set(summary, (map.get(summary) || 0) + 1);
    });
    return map;
  }

  function contextChips(article, limit = 4) {
    const values = [];
    (article?.teams || []).slice(0,2).forEach(team => values.push(`<span>${esc(team)}</span>`));
    (article?.players || []).slice(0,2).forEach(player => values.push(`<span class="person">${esc(player)}</span>`));
    return values.slice(0,limit).join('');
  }

  function articleImage(article, className, eager = false) {
    const src = clean(article?.image_url);
    if (!src) return `<div class="${className} is-placeholder"><span>PROPBETEDGE</span></div>`;
    return `<div class="${className}"><img src="${esc(src)}" alt="${esc(article?.image_alt || article?.title || 'NFL injury coverage')}" ${eager?'fetchpriority="high"':'loading="lazy"'} decoding="async"></div>`;
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
    const summary = clean(article?.summary);
    const combined = `${title}. ${summary}`;
    const players = (article?.players || []).map(clean).filter(Boolean);
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
    if (article?.availability) return `${clean(article?.title)} ${clean(article?.summary)}`;
    const title = clean(article?.title);
    const summary = clean(article?.summary);
    const terms = playerTerms(player);
    const pieces = [];
    const titleMention = terms.some(term => termPositions(title,term).length);
    if (titleMention) pieces.push(title);

    const summaryPoints = terms.flatMap(term => termPositions(summary,term));
    summaryPoints.forEach(point => pieces.push(summary.slice(Math.max(0,point-180),Math.min(summary.length,point+240))));

    if (titleMention && !summaryPoints.length) {
      const otherPlayerMention = (article?.players || []).map(clean).filter(Boolean).some(other => {
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
      team:clean(article?.teams?.[0]) || 'NFL',
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
      <div class="pbe13-availability-player"><strong>${esc(fact.player)}</strong><span>${esc(fact.team)}</span></div>
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

  function featuredAvailability(article) {
    const fact = factForArticle(article);
    if (!fact) return '';
    return `<div class="pbe13-featured-availability">
      <div><span>PLAYER</span><strong>${esc(fact.player)}</strong></div>
      <div><span>INJURY / STATUS</span><strong>${esc(fact.injury)} · ${esc(fact.status)}</strong></div>
      <div><span>REPORTED TIMELINE</span><strong>${esc(fact.timeline)}</strong></div>
    </div>`;
  }

  function leadStory(article, counts) {
    if (!article) return `<div class="pbe13-editorial-empty"><strong>No current injury features</strong><span>The PropBetEdge newsroom is live, but no canonical NFL injury article currently matches the editorial filter.</span></div>`;
    const deck = deckFor(article, counts);
    return `<article class="pbe13-editorial-lead">
      <a class="pbe13-editorial-lead-link" href="${esc(article.__pbeEditorialUrl)}" target="_blank" rel="noopener" aria-label="Read ${esc(article.title)} on PropBetEdge">
        ${articleImage(article,'pbe13-editorial-lead-media',true)}
      </a>
      <div class="pbe13-editorial-lead-body">
        <div class="pbe13-editorial-eyebrow">FEATURED INJURY STORY</div>
        <h2>${esc(article.title)}</h2>
        ${deck?`<p>${esc(deck)}</p>`:''}
        ${featuredAvailability(article)}
        <div class="pbe13-editorial-meta">${byline(article)}</div>
        <div class="pbe13-editorial-chips">${contextChips(article)}</div>
        <a class="pbe13-editorial-cta" href="${esc(article.__pbeEditorialUrl)}" target="_blank" rel="noopener">Read the full story on PropBetEdge <span>↗</span></a>
      </div>
    </article>`;
  }

  function storyCard(article, counts) {
    const deck = deckFor(article, counts);
    const team = clean(article?.teams?.[0]);
    const fact = factForArticle(article);
    return `<a class="pbe13-editorial-card" href="${esc(article.__pbeEditorialUrl)}" target="_blank" rel="noopener">
      ${articleImage(article,'pbe13-editorial-card-media')}
      <div class="pbe13-editorial-card-body">
        <div class="pbe13-editorial-card-kicker"><span>${team?esc(team):'NFL'}</span><span>${esc(timeAgo(article?.published_at))}</span></div>
        <h3>${esc(article.title)}</h3>
        ${deck?`<p>${esc(deck)}</p>`:''}
        ${fact&&fact.timeline!=='Timeline not reported'?`<div class="pbe13-card-timeline"><span>${esc(fact.status)}</span><strong>${esc(fact.timeline)}</strong></div>`:''}
        <div class="pbe13-editorial-meta">${byline(article)}</div>
        <div class="pbe13-editorial-chips">${contextChips(article,3)}</div>
      </div>
    </a>`;
  }

  function shell(state, rows) {
    const counts = summaryCounts(rows);
    const lead = rows[0] || null;
    const rest = rows.slice(1);
    const deskLine = state?.error ? 'Coverage temporarily unavailable' : 'Reporting · analysis · availability';
    return `<header class="pbe13-hero pbe13-editorial-hero">
      <div>
        <div class="pbe13-kicker">PROPBETEDGE EDITORIAL · NFL INJURIES</div>
        <h1 class="pbe13-title">Injuries change everything.</h1>
        <div class="pbe13-copy">The injury stories that matter — what happened, who it changes, how long they're expected out, and what to watch next. Full NFL injury coverage from PropBetEdge Editorial.</div>
      </div>
      <aside class="pbe13-statusbox"><b>NFL INJURY DESK</b><span>${esc(deskLine)}</span></aside>
    </header>
    <div class="pbe13-editorial-note"><strong>Editorial coverage:</strong> reporting and analysis from PropBetEdge articles. This is not the official NFL practice/game injury report, and no status or return window is inferred beyond what the underlying reporting supports.</div>
    ${state?.error?`<div class="pbe13-editorial-empty"><strong>Injury coverage unavailable</strong><span>${esc(state.error)}</span></div>`:leadStory(lead,counts)}
    ${!state?.error?`${availabilityBoard(rows)}<div class="pbe13-feed pbe13-editorial-feed" style="grid-template-columns:1fr"><section class="pbe13-editorial-latest">
      <div class="pbe13-editorial-section-head"><div><span>PROPBETEDGE EDITORIAL</span><h2>Latest injury coverage</h2></div><a href="https://propbetedge.ai/news/nfl" target="_blank" rel="noopener">All NFL news ↗</a></div>
      ${rest.length?`<div class="pbe13-editorial-grid">${rest.map(article=>storyCard(article,counts)).join('')}</div>`:`<div class="pbe13-editorial-empty compact"><span>No additional injury stories are currently available.</span></div>`}
    </section></div>`:''}`;
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
