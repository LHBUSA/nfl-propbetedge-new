const SERVICE='propbetedge-nfl-auth';
const VERSION='v6.1';
const APP_ORIGIN_DEFAULT='https://nfl.propbetedge.ai';
const FROM_EMAIL='PropBetEdge Picks <picks@propbetedge.ai>';
const MAGIC_TTL=15*60;
const SESSION_TTL=30*24*60*60;

export default{async fetch(req,env){
  const url=new URL(req.url),origin=req.headers.get('Origin')||'',app=String(env.APP_ORIGIN||APP_ORIGIN_DEFAULT).replace(/\/$/,'');
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors(origin,app)});
  if(url.pathname==='/health'){
    const signing=signingSecrets(env);
    return out({ok:Boolean(env.RESEND_API_KEY&&signing.primary),service:SERVICE,version:VERSION,auth_issuer:'propbetedge',session:'vercel_first_party_cookie',session_authority:'vercel:/api/auth-session',exchange:'signed_magic_to_session',entitlement_store:'vercel:/api/auth-session',email_transport:'resend',sender:FROM_EMAIL,fallback:false,requirements:{RESEND_API_KEY:Boolean(env.RESEND_API_KEY),SESSION_SIGNING_SECRET:Boolean(signing.primary),SUPABASE_SERVICE_ROLE_KEY:Boolean(env.SUPABASE_SERVICE_ROLE_KEY)},signing:{mode:signing.mode,dedicated_configured:signing.dedicatedConfigured,legacy_verify_fallback:Boolean(signing.fallback)}},200,origin,app);
  }
  if((url.pathname==='/v1/auth/request'||url.pathname==='/v1/auth/email')&&req.method==='POST')return requestLink(req,env,origin,app);
  if(url.pathname==='/v1/auth/exchange'&&req.method==='POST')return exchangeLink(req,env,origin,app);
  if(url.pathname==='/v1/auth/selftest'&&req.method==='GET')return selfTest(env,origin,app);
  return out({error:'not_found',service:SERVICE,version:VERSION},404,origin,app);
}};

async function requestLink(req,env,origin,app){
  if(origin&&origin!==app)return out({error:'origin_not_allowed'},403,origin,app);
  const signing=signingSecrets(env);
  if(!env.RESEND_API_KEY||!signing.primary)return out({error:'service_unavailable'},503,origin,app);
  let body;try{body=await req.json()}catch{return out({error:'invalid_json'},400,origin,app)}
  const email=normEmail(body?.email);if(!email)return out({error:'Enter a valid email address.'},400,origin,app);
  const purpose=body?.purpose==='purchase'?'purchase':'signin';
  try{
    const now=Math.floor(Date.now()/1000),token=await sign({email,type:'magic',purpose,iat:now,exp:now+MAGIC_TTL,jti:crypto.randomUUID()},signing.primary);
    const link=`${app}/api/auth-verify?token=${encodeURIComponent(token)}`;
    const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:FROM_EMAIL,to:[email],subject:purpose==='purchase'?'PropBetEdge NFL Pro — your access is ready':'PropBetEdge NFL — secure sign-in',html:mailHtml(link,purpose),text:mailText(link,purpose)})});
    if(!r.ok){const detail=await r.text().catch(()=>'');console.error('[nfl-auth] resend',r.status,detail.slice(0,360));return out({error:'Could not send the sign-in email.',stage:'resend',provider_status:r.status,provider_message:safeProviderMessage(detail)},502,origin,app)}
    return out({ok:true,provider:'resend',auth_issuer:'propbetedge',purpose,message:purpose==='purchase'?'NFL Pro access email sent.':'Check your inbox. Your secure PropBetEdge NFL sign-in link is on the way.'},200,origin,app);
  }catch(e){console.error('[nfl-auth] request',e?.message||e);return out({error:'Could not send the sign-in email.',stage:'worker'},502,origin,app)}
}

async function exchangeLink(req,env,origin,app){
  if(origin&&origin!==app)return out({error:'origin_not_allowed'},403,origin,app);
  const signing=signingSecrets(env);
  if(!signing.primary)return out({error:'service_unavailable'},503,origin,app);
  let body;try{body=await req.json()}catch{return out({error:'invalid_json'},400,origin,app)}
  const token=String(body?.token||'').trim();
  if(!token||token.length>1200)return out({error:'invalid_token'},400,origin,app);
  try{
    const verified=await verifyWithSecrets(token,signing);
    const p=verified.payload,email=normEmail(p?.email);
    if(p?.type!=='magic'||!email)throw new Error('invalid_magic');
    const now=Math.floor(Date.now()/1000);
    const session=await sign({email,type:'session',iat:now,exp:now+SESSION_TTL,jti:crypto.randomUUID()},signing.primary);
    return out({ok:true,email,session_token:session,expires_in:SESSION_TTL,auth_issuer:'propbetedge'},200,origin,app);
  }catch(e){
    const reason=e?.message||'invalid_magic';
    console.error('[nfl-auth] exchange',reason);
    return out({error:reason},401,origin,app);
  }
}

async function selfTest(env,origin,app){
  const signing=signingSecrets(env);
  if(!signing.primary)return out({ok:false,error:'service_unavailable'},503,origin,app);
  const now=Math.floor(Date.now()/1000);
  const probe=await sign({type:'probe',iat:now,exp:now+120,jti:crypto.randomUUID()},signing.primary);
  return out({ok:true,service:SERVICE,version:VERSION,namespace:'pbe-nfl-auth-v5',probe_token:probe,expires_in:120,signing_mode:signing.mode},200,origin,app);
}

function signingSecrets(env){
  const dedicated=String(env.NFL_SESSION_SIGNING_SECRET||'').trim();
  const legacy=String(env.SUPABASE_SERVICE_ROLE_KEY||'').trim();
  return{primary:dedicated||legacy,fallback:dedicated&&legacy&&dedicated!==legacy?legacy:'',mode:dedicated?'dedicated':'legacy_service_role',dedicatedConfigured:Boolean(dedicated)};
}
async function verifyWithSecrets(token,secrets){
  const candidates=[secrets?.primary,secrets?.fallback].filter(Boolean);let reason='token_invalid';
  for(let i=0;i<candidates.length;i+=1){try{return{payload:await verify(token,candidates[i]),matched:i===0?'primary':'fallback'}}catch(e){reason=e?.message||reason}}
  throw new Error(reason);
}
function safeProviderMessage(detail){try{const body=JSON.parse(detail);return String(body?.message||body?.error||'').slice(0,220)}catch{return String(detail||'').slice(0,220)}}
function normEmail(v){const e=String(v||'').trim().toLowerCase();return /^\S+@\S+\.\S+$/.test(e)&&e.length<=254?e:''}
function b64url(bytes){let s='';for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}
function enc(v){return b64url(new TextEncoder().encode(JSON.stringify(v)))}
function dec(v){let s=v.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';const bin=atob(s),bytes=Uint8Array.from(bin,c=>c.charCodeAt(0));return JSON.parse(new TextDecoder().decode(bytes))}
async function hmacKey(secret){return crypto.subtle.importKey('raw',new TextEncoder().encode(`pbe-nfl-auth-v5:${secret}`),{name:'HMAC',hash:'SHA-256'},false,['sign','verify'])}
async function sign(payload,secret){const h=enc({alg:'HS256',typ:'JWT'}),p=enc(payload),data=`${h}.${p}`,sig=await crypto.subtle.sign('HMAC',await hmacKey(secret),new TextEncoder().encode(data));return `${data}.${b64url(new Uint8Array(sig))}`}
async function verify(token,secret){const parts=String(token||'').split('.');if(parts.length!==3)throw new Error('token_shape');const data=`${parts[0]}.${parts[1]}`;let sig=parts[2].replace(/-/g,'+').replace(/_/g,'/');while(sig.length%4)sig+='=';const raw=Uint8Array.from(atob(sig),c=>c.charCodeAt(0));const ok=await crypto.subtle.verify('HMAC',await hmacKey(secret),raw,new TextEncoder().encode(data));if(!ok)throw new Error('token_signature');const p=dec(parts[1]);if(!p?.exp||Math.floor(Date.now()/1000)>=Number(p.exp))throw new Error('token_expired');return p}
function cors(origin,app){return{'access-control-allow-origin':!origin||origin===app?app:'null','access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'content-type','access-control-allow-credentials':'true','access-control-max-age':'86400',vary:'Origin'}}
function out(body,status,origin,app,extra={}){return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...cors(origin,app),...extra}})}
function mailHtml(link,purpose){const title=purpose==='purchase'?'Your NFL Pro access is ready.':'Your secure NFL sign-in is ready.';const copy=purpose==='purchase'?'Stripe has confirmed your NFL Pro purchase. Use this secure link to open PropBetEdge NFL with the same email used at checkout.':'Use this secure link to open your PropBetEdge NFL account.';return`<!doctype html><html><body style="margin:0;background:#080b10;color:#f7f3ea;font-family:Arial"><table width="100%" cellpadding="0" cellspacing="0" style="padding:36px 16px;background:#080b10"><tr><td align="center"><table width="100%" style="max-width:620px;background:#11161d;border:1px solid #3a301c;border-radius:18px;padding:32px"><tr><td><div style="color:#d8b75b;font-size:11px;font-weight:800;letter-spacing:2px">PROPBETEDGE NFL · SECURE ACCESS</div><h1 style="font-size:36px;line-height:1.05;margin:12px 0;color:#fff">${title}</h1><p style="color:#b7bec7;font-size:15px;line-height:1.65">${copy}</p><a href="${link}" style="display:inline-block;margin-top:10px;padding:15px 22px;border-radius:9px;background:#d8b75b;color:#161008;text-decoration:none;font-weight:900">OPEN PROPBETEDGE NFL</a><p style="margin-top:24px;color:#737b86;font-size:11px;line-height:1.6">This link expires in 15 minutes. If you did not request or purchase NFL Pro, ignore this message.</p></td></tr></table></td></tr></table></body></html>`}
function mailText(link,purpose){return`${purpose==='purchase'?'Your PropBetEdge NFL Pro purchase is confirmed.':'Your PropBetEdge NFL sign-in link is ready.'}\n\nOpen NFL:\n${link}\n\nThis secure link expires in 15 minutes.`}
