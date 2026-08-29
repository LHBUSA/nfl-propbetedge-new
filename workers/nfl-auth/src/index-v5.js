const SERVICE='propbetedge-nfl-auth';
const VERSION='v5.0';
const APP_ORIGIN_DEFAULT='https://nfl.propbetedge.ai';
const SUPABASE_URL_DEFAULT='https://tkmlnhmylqnttmnsnief.supabase.co';
const FROM_EMAIL='PropBetEdge Picks <picks@propbetedge.ai>';
const COOKIE_NAME='pbe_nfl_session';
const COOKIE_DOMAIN='.propbetedge.ai';
const MAGIC_TTL=15*60;
const SESSION_TTL=30*24*60*60;

export default{async fetch(req,env){
  const url=new URL(req.url),origin=req.headers.get('Origin')||'',app=String(env.APP_ORIGIN||APP_ORIGIN_DEFAULT).replace(/\/$/,'');
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors(origin,app)});
  if(url.pathname==='/health')return out({ok:Boolean(env.RESEND_API_KEY&&env.SUPABASE_SERVICE_ROLE_KEY),service:SERVICE,version:VERSION,auth_issuer:'propbetedge',session:'signed_worker_cookie',entitlement_store:'supabase_nfl_subscriptions',email_transport:'resend',sender:FROM_EMAIL,fallback:false,requirements:{RESEND_API_KEY:Boolean(env.RESEND_API_KEY),SUPABASE_SERVICE_ROLE_KEY:Boolean(env.SUPABASE_SERVICE_ROLE_KEY)}},200,origin,app);
  if((url.pathname==='/v1/auth/request'||url.pathname==='/v1/auth/email')&&req.method==='POST')return requestLink(req,env,origin,app);
  if(url.pathname==='/v1/auth/verify'&&req.method==='GET')return verifyLink(req,env,app);
  if(url.pathname==='/v1/auth/session'&&req.method==='GET')return sessionState(req,env,origin,app);
  if(url.pathname==='/v1/auth/logout'&&req.method==='POST')return out({ok:true},200,origin,app,{'set-cookie':clearCookie()});
  return out({error:'not_found',service:SERVICE,version:VERSION},404,origin,app);
}};

async function requestLink(req,env,origin,app){
  if(origin&&origin!==app)return out({error:'origin_not_allowed'},403,origin,app);
  if(!env.RESEND_API_KEY||!env.SUPABASE_SERVICE_ROLE_KEY)return out({error:'service_unavailable'},503,origin,app);
  let body;try{body=await req.json()}catch{return out({error:'invalid_json'},400,origin,app)}
  const email=normEmail(body?.email);if(!email)return out({error:'Enter a valid email address.'},400,origin,app);
  const purpose=body?.purpose==='purchase'?'purchase':'signin';
  try{
    const now=Math.floor(Date.now()/1000),token=await sign({email,type:'magic',purpose,iat:now,exp:now+MAGIC_TTL,jti:crypto.randomUUID()},env.SUPABASE_SERVICE_ROLE_KEY);
    const link=`${app}/api/auth-verify?token=${encodeURIComponent(token)}`;
    const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:FROM_EMAIL,to:[email],subject:purpose==='purchase'?'PropBetEdge NFL Pro — your access is ready':'PropBetEdge NFL — secure sign-in',html:mailHtml(link,purpose),text:mailText(link,purpose),tags:[{name:'product',value:'nfl'},{name:'message',value:purpose==='purchase'?'purchase-access':'secure-signin'}]})});
    if(!r.ok){const detail=await r.text().catch(()=>'');console.error('[nfl-auth] resend',r.status,detail.slice(0,240));return out({error:'Could not send the sign-in email.',stage:'resend'},502,origin,app)}
    return out({ok:true,provider:'resend',auth_issuer:'propbetedge',purpose,message:purpose==='purchase'?'NFL Pro access email sent.':'Check your inbox. Your secure PropBetEdge NFL sign-in link is on the way.'},200,origin,app);
  }catch(e){console.error('[nfl-auth] request',e?.message||e);return out({error:'Could not send the sign-in email.',stage:'worker'},502,origin,app)}
}

async function verifyLink(req,env,app){
  const token=new URL(req.url).searchParams.get('token')||'';
  try{
    const p=await verify(token,env.SUPABASE_SERVICE_ROLE_KEY);
    if(p?.type!=='magic'||!normEmail(p?.email))throw new Error('invalid_magic');
    const now=Math.floor(Date.now()/1000),session=await sign({email:normEmail(p.email),type:'session',iat:now,exp:now+SESSION_TTL,jti:crypto.randomUUID()},env.SUPABASE_SERVICE_ROLE_KEY);
    return new Response(null,{status:302,headers:{location:`${app}/?auth=complete`,'set-cookie':sessionCookie(session),'cache-control':'no-store','x-content-type-options':'nosniff'}});
  }catch(e){console.error('[nfl-auth] verify',e?.message||e);return errorPage('This secure link is invalid or expired. Request a new one.',app)}
}

async function sessionState(req,env,origin,app){
  const token=readCookie(req,COOKIE_NAME);if(!token)return out({valid:false,pro:false,user:null,subscription:null},200,origin,app);
  try{
    const p=await verify(token,env.SUPABASE_SERVICE_ROLE_KEY);if(p?.type!=='session')throw new Error('invalid_session');
    const email=normEmail(p.email);if(!email)throw new Error('invalid_email');
    const sub=await entitlement(env,email);
    return out({valid:true,pro:Boolean(sub),user:{email},subscription:sub},200,origin,app);
  }catch(e){console.error('[nfl-auth] session',e?.message||e);return out({valid:false,pro:false,user:null,subscription:null},200,origin,app,{'set-cookie':clearCookie()})}
}

async function entitlement(env,email){
  const base=String(env.SUPABASE_URL||SUPABASE_URL_DEFAULT).replace(/\/$/,'');
  const q=`customer_email=ilike.${encodeURIComponent(email)}&select=status,current_period_end,cancel_at_period_end,stripe_price_id,created_at&order=created_at.desc&limit=10`;
  const r=await fetch(`${base}/rest/v1/nfl_subscriptions?${q}`,{headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,Accept:'application/json'},cache:'no-store'});
  if(!r.ok)throw new Error(`entitlement_${r.status}`);
  const rows=await r.json(),now=Date.now();
  const row=(Array.isArray(rows)?rows:[]).find(x=>['active','trialing'].includes(String(x?.status||'').toLowerCase())&&(!x?.current_period_end||Date.parse(x.current_period_end)>now));
  return row?{status:row.status,current_period_end:row.current_period_end||null,cancel_at_period_end:Boolean(row.cancel_at_period_end),stripe_price_id:row.stripe_price_id||null}:null;
}

function normEmail(v){const e=String(v||'').trim().toLowerCase();return /^\S+@\S+\.\S+$/.test(e)&&e.length<=254?e:''}
function b64url(bytes){let s='';for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}
function enc(v){return b64url(new TextEncoder().encode(JSON.stringify(v)))}
function dec(v){let s=v.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';const bin=atob(s),bytes=Uint8Array.from(bin,c=>c.charCodeAt(0));return JSON.parse(new TextDecoder().decode(bytes))}
async function hmacKey(secret){return crypto.subtle.importKey('raw',new TextEncoder().encode(`pbe-nfl-auth-v5:${secret}`),{name:'HMAC',hash:'SHA-256'},false,['sign','verify'])}
async function sign(payload,secret){const h=enc({alg:'HS256',typ:'JWT'}),p=enc(payload),data=`${h}.${p}`,sig=await crypto.subtle.sign('HMAC',await hmacKey(secret),new TextEncoder().encode(data));return `${data}.${b64url(new Uint8Array(sig))}`}
async function verify(token,secret){const parts=String(token||'').split('.');if(parts.length!==3)throw new Error('token_shape');const data=`${parts[0]}.${parts[1]}`;let sig=parts[2].replace(/-/g,'+').replace(/_/g,'/');while(sig.length%4)sig+='=';const raw=Uint8Array.from(atob(sig),c=>c.charCodeAt(0));const ok=await crypto.subtle.verify('HMAC',await hmacKey(secret),raw,new TextEncoder().encode(data));if(!ok)throw new Error('token_signature');const p=dec(parts[1]);if(!p?.exp||Math.floor(Date.now()/1000)>=Number(p.exp))throw new Error('token_expired');return p}
function readCookie(req,name){for(const part of (req.headers.get('Cookie')||'').split(';')){const[k,...v]=part.trim().split('=');if(k===name)return v.join('=')}return''}
function sessionCookie(token){return`${COOKIE_NAME}=${token}; Domain=${COOKIE_DOMAIN}; Path=/; Max-Age=${SESSION_TTL}; HttpOnly; Secure; SameSite=Lax`}
function clearCookie(){return`${COOKIE_NAME}=; Domain=${COOKIE_DOMAIN}; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`}
function cors(origin,app){return{'access-control-allow-origin':!origin||origin===app?app:'null','access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'content-type','access-control-allow-credentials':'true','access-control-max-age':'86400',vary:'Origin'}}
function out(body,status,origin,app,extra={}){return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...cors(origin,app),...extra}})}
function errorPage(msg,app){return new Response(`<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#090b0f;color:#f7f3ea;font-family:Arial"><main style="max-width:460px;padding:32px;border:1px solid #40351e;border-radius:18px;background:#15130f"><h1>Secure sign-in problem</h1><p style="color:#aaa398;line-height:1.6">${esc(msg)}</p><a href="${app}" style="display:inline-block;padding:13px 18px;background:#d8b75b;color:#161008;border-radius:9px;text-decoration:none;font-weight:800">Back to PropBetEdge NFL</a></main></body></html>`,{status:400,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}})}
function mailHtml(link,purpose){const title=purpose==='purchase'?'Your NFL Pro access is ready.':'Your secure NFL sign-in is ready.';const copy=purpose==='purchase'?'Stripe has confirmed your NFL Pro purchase. Use this secure link to open PropBetEdge NFL with the same email used at checkout.':'Use this secure link to open your PropBetEdge NFL account.';return`<!doctype html><html><body style="margin:0;background:#080b10;color:#f7f3ea;font-family:Arial"><table width="100%" cellpadding="0" cellspacing="0" style="padding:36px 16px;background:#080b10"><tr><td align="center"><table width="100%" style="max-width:620px;background:#11161d;border:1px solid #3a301c;border-radius:18px;padding:32px"><tr><td><div style="color:#d8b75b;font-size:11px;font-weight:800;letter-spacing:2px">PROPBETEDGE NFL · SECURE ACCESS</div><h1 style="font-size:36px;line-height:1.05;margin:12px 0;color:#fff">${title}</h1><p style="color:#b7bec7;font-size:15px;line-height:1.65">${copy}</p><a href="${link}" style="display:inline-block;margin-top:10px;padding:15px 22px;border-radius:9px;background:#d8b75b;color:#161008;text-decoration:none;font-weight:900">OPEN PROPBETEDGE NFL</a><p style="margin-top:24px;color:#737b86;font-size:11px;line-height:1.6">This link expires in 15 minutes. If you did not request or purchase NFL Pro, ignore this message.</p></td></tr></table></td></tr></table></body></html>`}
function mailText(link,purpose){return`${purpose==='purchase'?'Your PropBetEdge NFL Pro purchase is confirmed.':'Your PropBetEdge NFL sign-in link is ready.'}\n\nOpen NFL:\n${link}\n\nThis secure link expires in 15 minutes.`}
function esc(v){return String(v||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
