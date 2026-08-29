/* PropBetEdge NFL — page upgrade loader
 * Keeps the stable shell unchanged while page-specific redesigns are rolled out one at a time.
 */
(() => {
  'use strict';

  const VERSION = '20260828k1';
  const upgrades = [
    { css:'./teams-v2.css', js:'./teams-v2.js' },
    { css:'./stats-v2.css', js:'./stats-v2.js' },
    { css:'./standings-v2.css', js:'./standings-v2.js' },
    { css:'./season-archive-v2.css', js:'./season-archive-v2.js' },
    { css:'./hof-v2.css', js:'./hof-v2.js' },
    { css:'./records-v2.css', js:'./records-v2.js' }
  ];

  function addCss(href) {
    if (document.querySelector(`link[data-pbe-upgrade="${href}"]`)) return;
    const link=document.createElement('link');
    link.rel='stylesheet';
    link.href=`${href}?v=${VERSION}`;
    link.dataset.pbeUpgrade=href;
    document.head.appendChild(link);
  }

  function addScript(src) {
    return new Promise(resolve => {
      if (document.querySelector(`script[data-pbe-upgrade="${src}"]`)) return resolve();
      const script=document.createElement('script');
      script.src=`${src}?v=${VERSION}`;
      script.async=false;
      script.dataset.pbeUpgrade=src;
      script.onload=()=>resolve();
      script.onerror=()=>resolve();
      document.body.appendChild(script);
    });
  }

  async function load() {
    upgrades.forEach(item=>addCss(item.css));
    for (const item of upgrades) await addScript(item.js);
  }

  load();
})();
