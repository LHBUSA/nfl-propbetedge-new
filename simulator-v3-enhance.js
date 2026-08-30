/* Line Simulator v3 enhancement
 * Keeps simulator-v2.js as the production-model authority. This layer converts
 * the selected normal-distribution probability into fair odds, EV, de-vigged
 * market context and Kelly math. Manual prices are explicitly user inputs.
 */
(() => {
  'use strict';

  const manual = new Map();
  let timer = null;
  let enhancing = false;

  const esc = value => String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const num = value => { const n = Number(value); return Number.isFinite(n) ? n : NaN; };
  const fmt = (value,d=1) => Number.isFinite(num(value)) ? num(value).toFixed(d).replace(/\.0$/,'') : '—';
  const playerOf = item => item?.player || item?.player_name || 'Player';

  function erf(x){const sign=x<0?-1:1,a=Math.abs(x),t=1/(1+.3275911*a);const y=1-(((((1.061405429*t-1.453152027)*t+1.421413741)*t-.284496736)*t+.254829592)*t*Math.exp(-a*a));return sign*y;}
  const cdf=z=>.5*(1+erf(z/Math.sqrt(2)));
  const overP=(line,fair,sd)=>Number.isFinite(line)&&Number.isFinite(fair)&&Number.isFinite(sd)&&sd>0?Math.max(0,Math.min(1,1-cdf((line-fair)/sd))):NaN;
  const pdf=z=>Math.exp(-.5*z*z)/Math.sqrt(2*Math.PI);

  function rows(){const state=window.PBELineSimulator?.state, raw=state?.model?.models||state?.model?.picks||state?.model?.data||[];return(Array.isArray(raw)?raw:[]).filter(m=>m?.available!==false&&Number.isFinite(num(m.fair_line))&&Number.isFinite(num(m.predictive_sd))&&num(m.predictive_sd)>0);}
  function selected(){const state=window.PBELineSimulator?.state,list=rows();if(!list.length)return null;return list.find(m=>playerOf(m)===state?.selected)||list[0];}
  function selectedLine(row){const state=window.PBELineSimulator?.state;const stored=state?.lineByPlayer?.get(playerOf(row));const market=num(row.market_consensus_line);return Number.isFinite(num(stored))?num(stored):Number.isFinite(market)?market:num(row.fair_line);}

  const sideOf=q=>{const raw=String(q?.direction||q?.outcome||q?.side||q?.name||'').toUpperCase();if(raw==='YES'||raw.includes('OVER'))return'OVER';if(raw==='NO'||raw.includes('UNDER'))return'UNDER';return raw;};
  const bookOf=q=>q?.book||q?.book_title||q?.sportsbook||q?.book_key||'Book';
  const pointOf=q=>num(q?.point??q?.line);
  const priceOf=q=>num(q?.price??q?.american_odds??q?.odds);
  function quotes(row){const all=window.PBELineSimulator?.state?.board?.quotes||[];return all.filter(q=>playerOf(q).toLowerCase()===playerOf(row).toLowerCase()&&(!q.market||q.market==='player_pass_yds'));}
  function exactQuote(row,line,side){const matches=quotes(row).filter(q=>sideOf(q)===side&&Math.abs(pointOf(q)-line)<.01&&Number.isFinite(priceOf(q)));if(!matches.length)return null;return matches.sort((a,b)=>priceOf(b)-priceOf(a))[0];}

  function fairAmerican(p){if(!Number.isFinite(p)||p<=0||p>=1)return'—';const a=p>=.5?-100*p/(1-p):100*(1-p)/p;return`${a>0?'+':''}${Math.round(a)}`;}
  function american(value){const a=num(value);return Number.isFinite(a)?`${a>0?'+':''}${Math.round(a)}`:'—';}
  function rawImplied(value){const a=num(value);if(!Number.isFinite(a)||a===0)return NaN;return a<0?Math.abs(a)/(Math.abs(a)+100):100/(a+100);}
  function decimal(value){const a=num(value);if(!Number.isFinite(a)||a===0)return NaN;return a>0?1+a/100:1+100/Math.abs(a);}
  function ev(p,price){const d=decimal(price);return Number.isFinite(p)&&Number.isFinite(d)?(p*(d-1)-(1-p))*100:NaN;}
  function kelly(p,price){const d=decimal(price);if(!Number.isFinite(p)||!Number.isFinite(d)||d<=1)return NaN;const b=d-1;return Math.max(0,(b*p-(1-p))/b)*100;}

  function priceKey(row,line,side){return`${playerOf(row)}|${line}|${side}`;}
  function priceValue(row,line,side){const key=priceKey(row,line,side);if(manual.has(key))return{value:manual.get(key),source:'manual'};const q=exactQuote(row,line,side);return{value:q?priceOf(q):null,source:q?bookOf(q):'manual input'};}

  function curve(row,line){const fair=num(row.fair_line),sd=num(row.predictive_sd);if(![fair,sd,line].every(Number.isFinite)||sd<=0)return'';const min=Math.max(0,fair-3*sd),max=fair+3*sd,span=max-min,pts=[];for(let i=0;i<=72;i++){const x=min+span*i/72,z=(x-fair)/sd,y=94-(pdf(z)/.39894228)*76;pts.push({x,px:i/72*100,py:y});}const path=pts.map((p,i)=>`${i?'L':'M'} ${p.px.toFixed(2)} ${p.py.toFixed(2)}`).join(' ');const shadePts=pts.filter(p=>p.x>=line);const shade=shadePts.length?`M ${shadePts[0].px.toFixed(2)} 94 ${shadePts.map(p=>`L ${p.px.toFixed(2)} ${p.py.toFixed(2)}`).join(' ')} L 100 94 Z`:'';const xpos=v=>Math.max(0,Math.min(100,(v-min)/span*100));return`<div class="pbesimx-curve"><svg viewBox="0 0 100 100" preserveAspectRatio="none"><path class="shade" d="${shade}"></path><path class="curve" d="${path}"></path><line class="fair" x1="${xpos(fair).toFixed(2)}" x2="${xpos(fair).toFixed(2)}" y1="8" y2="94"></line><line class="selected" x1="${xpos(line).toFixed(2)}" x2="${xpos(line).toFixed(2)}" y1="8" y2="94"></line></svg><div class="pbesimx-axis"><span>${fmt(min,0)}</span><span>Selected ${fmt(line,1)}</span><span>${fmt(max,0)}</span></div></div>`;}

  function percentile(row){const values=rows().map(x=>num(x.predictive_sd)).filter(Number.isFinite).sort((a,b)=>a-b);const sd=num(row.predictive_sd);if(!values.length||!Number.isFinite(sd))return null;return Math.round(values.filter(v=>v<=sd).length/values.length*100);}

  function pricePanel(row,line,side,p){const q=priceValue(row,line,side),price=num(q.value),modelP=side==='OVER'?p:1-p,e=ev(modelP,price),k=kelly(modelP,price);return`<article class="pbesimx-price"><header><span>${side} PRICE</span><b>${esc(q.source)}</b></header><input type="number" step="1" placeholder="e.g. -110" value="${Number.isFinite(price)?esc(Math.round(price)):''}" data-pbesimx-price="${side}"><div class="big ${Number.isFinite(e)&&e>0?'good':''}">${Number.isFinite(e)?`${e>0?'+':''}${e.toFixed(1)}% EV`:'ENTER PRICE'}</div><div class="pbesimx-metrics"><div><span>Model probability</span><strong>${Number.isFinite(modelP)?`${(modelP*100).toFixed(1)}%`:'—'}</strong></div><div><span>Fair odds</span><strong>${fairAmerican(modelP)}</strong></div><div><span>Raw implied</span><strong>${Number.isFinite(rawImplied(price))?`${(rawImplied(price)*100).toFixed(1)}%`:'—'}</strong></div><div><span>Full Kelly</span><strong>${Number.isFinite(k)?`${k.toFixed(1)}%`:'—'}</strong></div><div><span>Quarter Kelly</span><strong class="${Number.isFinite(k)&&k>0?'good':''}">${Number.isFinite(k)?`${(k/4).toFixed(1)}%`:'—'}</strong></div><div><span>Fair edge</span><strong class="${Number.isFinite(e)&&e>0?'good':''}">${Number.isFinite(e)?`${e>0?'+':''}${e.toFixed(1)}%`:'—'}</strong></div></div></article>`;}

  function deVig(row,line){const over=priceValue(row,line,'OVER'),under=priceValue(row,line,'UNDER'),a=rawImplied(over.value),b=rawImplied(under.value);if(!Number.isFinite(a)||!Number.isFinite(b)||a+b<=0)return'<div class="pbesimx-devig">Enter both Over and Under prices at the same selected line to calculate a two-way vig-free market probability.</div>';const overFair=a/(a+b),underFair=b/(a+b),hold=(a+b-1)*100;return`<div class="pbesimx-devig"><strong>VIG-FREE MARKET:</strong> Over ${(overFair*100).toFixed(1)}% · Under ${(underFair*100).toFixed(1)}% · raw two-way hold ${hold.toFixed(1)}%. Model probability remains separate from sportsbook pricing.</div>`;}

  function panel(row,line){const fair=num(row.fair_line),sd=num(row.predictive_sd),p=overP(line,fair,sd),rank=percentile(row),lo68=Math.max(0,fair-sd),hi68=fair+sd,lo95=Math.max(0,fair-1.96*sd),hi95=fair+1.96*sd;return`<section class="pbesimx" id="pbe-simulator-pricing"><section class="pbesimx-panel"><div class="pbesimx-head"><div><span>Dynamic probability curve</span><strong>What the line is buying</strong></div><b>MODEL DERIVED</b></div>${curve(row,line)}<div class="pbesimx-intervals"><div><span>Fair odds · Over</span><strong>${fairAmerican(p)}</strong></div><div><span>68% interval</span><strong>${fmt(lo68,1)} – ${fmt(hi68,1)}</strong></div><div><span>95% interval</span><strong>${fmt(lo95,1)} – ${fmt(hi95,1)}</strong></div></div><div class="pbesimx-note">Predictive SD ${fmt(sd,1)}${rank===null?'':` · ${rank}th percentile of the currently loaded model rows`}. This percentile is current-slate context, not a claim about historical QB volatility.</div></section><section class="pbesimx-panel"><div class="pbesimx-head"><div><span>Price translation</span><strong>Fair odds · EV · Kelly</strong></div><b>SELECTED LINE ${esc(fmt(line,1))}</b></div><div class="pbesimx-prices">${pricePanel(row,line,'OVER',p)}${pricePanel(row,line,'UNDER',p)}</div>${deVig(row,line)}<div class="pbesimx-note">If an exact current quote exists at this line it is prefilled and labeled by book. Otherwise the price field is blank. Manual inputs are local only. Kelly output is mathematical sizing context, not a guaranteed recommendation.</div></section></section>`;}

  function enhanceLadder(row){const fair=num(row.fair_line),sd=num(row.predictive_sd);document.querySelectorAll('.pbe20-scenario').forEach(card=>{const lineEl=card.querySelector('.pbe20-scenario-line'),line=num(lineEl?.textContent);if(!Number.isFinite(line))return;card.querySelector('.pbesimx-ladder')?.remove();const p=overP(line,fair,sd),q=exactQuote(row,line,'OVER'),price=q?priceOf(q):NaN,e=ev(p,price);const div=document.createElement('div');div.className='pbesimx-ladder';div.innerHTML=`<span>Fair <b>${fairAmerican(p)}</b></span>${q?`<span>${esc(bookOf(q))} ${esc(american(price))}</span><span class="${Number.isFinite(e)&&e>0?'ev':''}">${Number.isFinite(e)?`${e>0?'+':''}${e.toFixed(1)}% EV`:'EV —'}</span>`:'<span>No exact live quote</span>'}`;card.appendChild(div);});}

  function wire(row,line,host){host.querySelectorAll('[data-pbesimx-price]').forEach(input=>input.addEventListener('change',()=>{const side=input.dataset.pbesimxPrice,value=num(input.value),key=priceKey(row,line,side);if(Number.isFinite(value))manual.set(key,value);else manual.delete(key);queue();}));}

  function enhance(){if(enhancing||window.App?.current!=='simulator')return;const row=selected(),workspace=document.querySelector('#pbe20-workspace .pbe20-workspace');if(!row||!workspace)return;enhancing=true;try{const line=selectedLine(row);const old=document.getElementById('pbe-simulator-pricing'),wrap=document.createElement('div');wrap.innerHTML=panel(row,line);const next=wrap.firstElementChild;if(old)old.replaceWith(next);else workspace.appendChild(next);wire(row,line,next);enhanceLadder(row);}finally{enhancing=false;}}
  function queue(){clearTimeout(timer);timer=setTimeout(enhance,25);}

  const observer=new MutationObserver(queue);observer.observe(document.documentElement,{childList:true,subtree:true});
  window.addEventListener('pbe:route-changed',queue);window.addEventListener('pbe:pro-state',queue);window.addEventListener('pbe:event-changed',()=>{manual.clear();queue();});window.addEventListener('pbe:upgrades-ready',queue);setTimeout(queue,100);
})();
