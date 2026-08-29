/* PropBetEdge NFL — brand, team/player media and branded magic-link transport v1 */
(() => {
  'use strict';

  const PBE_MARK = 'https://propbetedge.ai/logo/pbe-mark-160.png';
  const PBE_FULL = 'https://propbetedge.ai/logo/pbe-full-400.png';
  const playerCache = new Map();
  let scanTimer = null;

  const TEAM_ABBR = new Map(Object.entries({
    'arizona cardinals':'ARI','atlanta falcons':'ATL','baltimore ravens':'BAL','buffalo bills':'BUF',
    'carolina panthers':'CAR','chicago bears':'CHI','cincinnati bengals':'CIN','cleveland browns':'CLE',
    'dallas cowboys':'DAL','denver broncos':'DEN','detroit lions':'DET','green bay packers':'GB',
    'houston texans':'HOU','indianapolis colts':'IND','jacksonville jaguars':'JAX','kansas city chiefs':'KC',
    'las vegas raiders':'LV','los angeles chargers':'LAC','los angeles rams':'LAR','miami dolphins':'MIA',
    'minnesota vikings':'MIN','new england patriots':'NE','new orleans saints':'NO','new york giants':'NYG',
    'new york jets':'NYJ','philadelphia eagles':'PHI','pittsburgh steelers':'PIT','san francisco 49ers':'SF',
    'seattle seahawks':'SEA','tampa bay buccaneers':'TB','tennessee titans':'TEN','washington commanders':'WSH'
  }));

  const normalize = value => String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  const esc = value => String(value ?? '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');

  function teamLogo(abbr) {
    const clean = String(abbr || '').replace(/[^A-Za-z]/g, '').toLowerCase();
    return clean ? `https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/${clean}.png` : '';
  }

  function resolveAbbr(nameOrAbbr) {
    const raw = String(nameOrAbbr || '').trim();
    if (/^[A-Za-z]{2,4}$/.test(raw)) return raw.toUpperCase();
    const key = normalize(raw);
    if (TEAM_ABBR.has(key)) return TEAM_ABBR.get(key);
    for (const [name, abbr] of TEAM_ABBR.entries()) {
      if (key && (name.includes(key) || key.includes(name))) return abbr;
    }
    return '';
  }

  function brandShell() {
    const link = document.querySelector('.sidebar-logo');
    if (link && !link.querySelector('.pbe-brand-mark')) {
      const oldMark = link.querySelector('svg');
      const img = document.createElement('img');
      img.src = PBE_MARK;
      img.alt = 'PropBetEdge';
      img.className = 'pbe-brand-mark';
      if (oldMark) oldMark.replaceWith(img); else link.prepend(img);
    }

    const mobile = document.querySelector('.mobile-logo');
    if (mobile && mobile.dataset.pbeBranded !== '1') {
      mobile.dataset.pbeBranded = '1';
      mobile.innerHTML = `<img class="pbe-mobile-mark" src="${PBE_MARK}" alt=""><span class="pbe-mobile-nfl">PropBet<em>Edge</em> NFL</span>`;
    }
  }

  function brandPaywall() {
    const modal = document.querySelector('.pbe-pro-modal');
    if (!modal || modal.dataset.pbeBranded === '1') return;
    modal.dataset.pbeBranded = '1';
    const kicker = modal.querySelector('.pbe-pro-kicker');
    if (kicker) {
      kicker.innerHTML = `<img class="pbe-paywall-logo" src="${PBE_FULL}" alt="PropBetEdge"><span class="pbe-paywall-label">NFL Pro</span>`;
    }
  }

  function healScheduleLogos() {
    document.querySelectorAll('.pbe25-team').forEach(row => {
      if (row.dataset.pbeLogoReady === '1') return;
      const name = row.querySelector('.pbe25-team-name')?.textContent?.trim() || '';
      const abbr = resolveAbbr(name);
      const crest = row.querySelector('.pbe25-crest');
      if (!crest || !abbr) return;
      row.dataset.pbeLogoReady = '1';
      const src = teamLogo(abbr);
      crest.innerHTML = `<img class="pbe-official-team-logo" src="${src}" alt="${esc(name || abbr)} logo" loading="lazy">`;
      const img = crest.querySelector('img');
      img?.addEventListener('error', () => {
        crest.innerHTML = `<strong style="color:#fff;font:900 10px 'Barlow Condensed',sans-serif">${esc(abbr)}</strong>`;
      }, { once:true });
    });
  }

  function healScoreboardLogos() {
    document.querySelectorAll('.cast4-team,.home5-team').forEach(team => {
      const abbr = team.querySelector('.cast4-team-abbr,.home5-abbr')?.textContent?.trim() || '';
      const holder = team.querySelector('.cast4-team-logo,.home5-logo');
      if (!holder || !abbr || holder.querySelector('img')) return;
      const src = teamLogo(resolveAbbr(abbr));
      if (!src) return;
      holder.innerHTML = `<img src="${src}" alt="${esc(abbr)} logo" loading="lazy">`;
    });
  }

  async function resolvePlayerImage(name) {
    const key = normalize(name);
    if (!key) return null;
    if (playerCache.has(key)) return playerCache.get(key);
    const promise = fetch(`/api/nfl-media?kind=player&name=${encodeURIComponent(name)}`, { cache:'force-cache' })
      .then(r => r.ok ? r.json() : null)
      .then(data => data?.image || null)
      .catch(() => null);
    playerCache.set(key, promise);
    return promise;
  }

  function enhancePlayerRows() {
    document.querySelectorAll('.pbe3-player-name:not([data-pbe-media])').forEach(async nameEl => {
      const name = nameEl.textContent?.trim() || '';
      if (!name) return;
      nameEl.dataset.pbeMedia = 'loading';
      const src = await resolvePlayerImage(name);
      if (!nameEl.isConnected) return;
      nameEl.dataset.pbeMedia = src ? 'ready' : 'missing';
      nameEl.classList.add('pbe-player-name-enhanced');

      if (!src) {
        const img = document.createElement('img');
        img.className = 'pbe-player-headshot is-fallback';
        img.src = PBE_MARK;
        img.alt = '';
        nameEl.prepend(img);
        return;
      }

      const img = document.createElement('img');
      img.className = 'pbe-player-headshot';
      img.src = src;
      img.alt = `${name} headshot`;
      img.loading = 'lazy';
      img.addEventListener('error', () => {
        img.classList.add('is-fallback');
        img.src = PBE_MARK;
      }, { once:true });
      nameEl.prepend(img);
    });
  }

  function setPaywallMessage(text, type='') {
    const el = document.getElementById('pbe-pro-message');
    if (!el) return;
    el.className = `pbe-pro-message ${type}`.trim();
    el.textContent = text || '';
  }

  async function supabaseFallback(email) {
    const client = window.PBEPro?.state?.client;
    if (!client) throw new Error('Account service is unavailable.');
    const options = {
      shouldCreateUser: true,
      emailRedirectTo: `${location.origin}/?auth=complete`,
    };
    const { error } = await client.auth.signInWithOtp({ email, options });
    if (error) throw error;
    return true;
  }

  async function brandedSignIn(button) {
    const input = document.getElementById('pbe-pro-email');
    const email = String(input?.value || '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setPaywallMessage('Enter a valid email address.','error');
      return;
    }

    button.disabled = true;
    setPaywallMessage('Sending your secure PropBetEdge sign-in link…');
    try {
      const response = await fetch('/api/auth-email', {
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({ email }),
      });
      if (response.ok) {
        setPaywallMessage('Check your inbox. Your PropBetEdge NFL sign-in link is on the way.','success');
        return;
      }

      // Resend is an enhancement, not a single point of failure. Fall back to
      // Supabase's existing OTP transport so no subscriber is locked out.
      await supabaseFallback(email);
      setPaywallMessage('Check your inbox. Your secure NFL sign-in link is on the way.','success');
    } catch (error) {
      try {
        await supabaseFallback(email);
        setPaywallMessage('Check your inbox. Your secure NFL sign-in link is on the way.','success');
      } catch (fallbackError) {
        setPaywallMessage(fallbackError?.message || error?.message || 'Unable to send the sign-in link.','error');
      }
    } finally {
      button.disabled = false;
    }
  }

  function installAuthIntercept() {
    if (document.documentElement.dataset.pbeAuthIntercept === '1') return;
    document.documentElement.dataset.pbeAuthIntercept = '1';
    document.addEventListener('click', event => {
      const button = event.target?.closest?.('#pbe-pro-signin');
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      brandedSignIn(button);
    }, true);
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      brandShell();
      brandPaywall();
      healScheduleLogos();
      healScoreboardLogos();
      enhancePlayerRows();
    }, 40);
  }

  function init() {
    installAuthIntercept();
    scheduleScan();
    new MutationObserver(scheduleScan).observe(document.documentElement, { childList:true, subtree:true });
    document.addEventListener('error', event => {
      const img = event.target;
      if (!(img instanceof HTMLImageElement)) return;
      if (img.classList.contains('pbe-player-headshot') && !img.classList.contains('is-fallback')) {
        img.classList.add('is-fallback');
        img.src = PBE_MARK;
      }
    }, true);
  }

  init();
})();
