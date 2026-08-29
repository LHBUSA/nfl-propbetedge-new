/* PropBetEdge NFL — Stats v2 */
(() => {
  'use strict';

  const state={tab:'passing',search:''};
  const esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

  function source(){ return window.StatsView?.STATS || {}; }
  function sourceMeta(){ return window.StatsView?.source || {}; }
  function crest(abbr,size=28){ try{ if(typeof teamCrest==='function')return teamCrest(abbr,size);}catch(_){} return `<strong style="color:#fff;font:900 11px 'Barlow Condensed',sans-serif">${esc(abbr)}</strong>`; }

  function category(){ return source()[state.tab] || Object.values(source())[0] || null; }
  function filteredRows(){
    const data=category(); if(!data)return[];
    const q=state.search.trim().toLowerCase();
    return data.rows.filter(row=>!q || row.some(cell=>String(cell).toLowerCase().includes(q)));
  }

  function leadColumnIndex(data){
    const headers=data?.headers||[];
    const preferred=['YDS','SACKS','PTS','TD','FGM'];
    for(const name of preferred){ const i=headers.indexOf(name); if(i>=3)return i; }
    return Math.min(headers.length-1,3);
  }

  function podiumHtml(data){
    const idx=leadColumnIndex(data);
    return `<div class="pbe6-podium">${data.rows.slice(0,3).map((row,i)=>`<article class="pbe6-podium-card"><span class="pbe6-rank">${i+1}</span><div class="pbe6-podium-top"><div>${crest(row[2],34)}</div><div><div class="pbe6-name">${esc(row[1])}</div><div class="pbe6-team">${esc(row[2])} · Rank ${esc(row[0])}</div></div></div><div class="pbe6-lead-stat">${esc(row[idx]??'—')}</div><div class="pbe6-lead-label">${esc(data.headers[idx]||'Leader metric')}</div></article>`).join('')}</div>`;
  }

  function tableHtml(data){
    const rows=filteredRows();
    const meta=sourceMeta();
    if(!rows.length)return '<div class="pbe6-empty">No leaderboard rows match the current search.</div>';
    return `<div class="pbe6-table-scroll"><table class="pbe6-table"><thead><tr>${data.headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr data-player="${esc(row[1])}">${row.map((cell,i)=>`<td class="${i===0?'rank':i===1?'player':i>=3?'mono':''}">${i===2?`<div style="display:flex;align-items:center;gap:7px">${crest(cell,22)}<span>${esc(cell)}</span></div>`:esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div><div class="pbe6-foot">Verified ${esc(meta.provider||'NFL.com')} 2025 regular-season final leaders · checked ${esc(meta.verifiedAt||'2026-08-29')} · historical/reference data, not live 2026 statistics.</div>`;
  }

  function render(){
    const vc=document.getElementById('view-container'); if(!vc)return;
    const data=category();
    if(!data){vc.innerHTML='<section class="pbe6-stats"><div class="pbe6-empty">Stats archive unavailable.</div></section>';return;}
    const tabs=Object.keys(source());
    const meta=sourceMeta();
    vc.innerHTML=`<section class="pbe6-stats"><header class="pbe6-hero"><div class="pbe6-kicker">2025 NFL REGULAR SEASON · VERIFIED FINAL</div><h1 class="pbe6-title">Statistical leaders.<br><em>Built for research.</em></h1><div class="pbe6-copy">Verified 2025 regular-season passing, rushing, receiving, sacks and field-goal leaderboards. Source: ${esc(meta.provider||'NFL.com')} · verified ${esc(meta.verifiedAt||'2026-08-29')}. This archive is explicitly historical and never presented as live 2026 output.</div><span class="pbe6-archive-note">VERIFIED · 2025 FINAL</span></header><nav class="pbe6-tabs">${tabs.map(key=>`<button class="pbe6-tab ${state.tab===key?'active':''}" data-tab="${key}">${esc((source()[key]?.title||key).replace(' Leaders','').replace(' — Sacks','').replace(' — Field Goals Made',''))}</button>`).join('')}</nav><div class="pbe6-tools"><input id="pbe6-search" class="pbe6-input" type="search" placeholder="Search player, team or stat…" value="${esc(state.search)}"><div class="pbe6-count">${filteredRows().length} rows shown</div></div>${podiumHtml(data)}<section class="pbe6-table-wrap" id="pbe6-table-wrap">${tableHtml(data)}</section></section>`;
    wire();
  }

  function rerenderTable(){
    const data=category();
    const host=document.getElementById('pbe6-table-wrap'); if(host&&data)host.innerHTML=tableHtml(data);
    const count=document.querySelector('.pbe6-count'); if(count)count.textContent=`${filteredRows().length} rows shown`;
    wireRows();
  }

  function wire(){
    document.querySelectorAll('.pbe6-tab').forEach(btn=>btn.addEventListener('click',()=>{state.tab=btn.dataset.tab||'passing';state.search='';render();}));
    document.getElementById('pbe6-search')?.addEventListener('input',e=>{state.search=e.currentTarget.value||'';rerenderTable();});
    wireRows();
  }
  function wireRows(){
    document.querySelectorAll('.pbe6-table tbody tr[data-player]').forEach(row=>row.addEventListener('click',()=>{try{if(window.PlayerModal)PlayerModal.show(row.dataset.player);}catch(_){}}));
  }
  function install(){if(!window.App?.VIEWS)return false;App.VIEWS.stats=render;return true;}
  window.PBEStatsV2={render,state};install();document.addEventListener('DOMContentLoaded',install,{once:true});
})();