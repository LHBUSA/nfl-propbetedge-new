/* NFL magic links are issued ONLY to an email that may open NFL Pro right now
   (a current NFL entitlement or a configured owner), and exchanged for a
   session ONLY after the same check passes again. Identity is not entitlement:
   an MLB/NBA/NHL/UFC subscription, a known customer or an existing session
   grants nothing here. The check is the one Vercel uses
   (api/_nfl-entitlement-ledger.js -> api/_nfl-entitlement.js). */
import { resolveNflAccess, parseOwnerEmails } from '../../../api/_nfl-entitlement-ledger.js';
import { normalizeEmail } from '../../../api/_nfl-entitlement.js';

const SERVICE='propbetedge-nfl-auth';
const VERSION='v7.0';
/* One answer for every accepted request, entitled or not, so the response
   never reveals whether an email owns NFL Pro. The decision and any email run
   after the response (ctx.waitUntil), so timing reveals nothing either. */
export const GENERIC_REQUEST_MESSAGE='If this email has NFL Pro access, a secure link will arrive shortly.';
/* A purchase return can reach us a moment before the Stripe webhook writes
   the ledger row; purchase requests re-check briefly before giving up. */
const PURCHASE_RECHECK_DELAYS_MS=[2000,4000,8000];
const APP_ORIGIN_DEFAULT='https://nfl.propbetedge.ai';
const FROM_EMAIL='PropBetEdge Picks <picks@propbetedge.ai>';
const MAGIC_TTL=15*60;
const SESSION_TTL=30*24*60*60;

export default{async fetch(req,env,ctx){
  const url=new URL(req.url),origin=req.headers.get('Origin')||'',app=String(env.APP_ORIGIN||APP_ORIGIN_DEFAULT).replace(/\/$/,'');
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors(origin,app)});
  if(url.pathname==='/health'){
    const signing=signingSecrets(env);
    return out({ok:Boolean(env.RESEND_API_KEY&&signing.primary),service:SERVICE,version:VERSION,auth_issuer:'propbetedge',session:'vercel_first_party_cookie',session_authority:'vercel:/api/auth-session',exchange:'signed_magic_to_session',entitlement_store:'supabase:nfl_subscriptions',entitlement_gate:{request:true,exchange:true,owner_configured:parseOwnerEmails(env.NFL_OWNER_EMAILS).length>0},email_transport:'resend',sender:FROM_EMAIL,fallback:false,requirements:{RESEND_API_KEY:Boolean(env.RESEND_API_KEY),SESSION_SIGNING_SECRET:Boolean(signing.primary),SUPABASE_SERVICE_ROLE_KEY:Boolean(env.SUPABASE_SERVICE_ROLE_KEY)},signing:{mode:signing.mode,dedicated_configured:signing.dedicatedConfigured,legacy_verify_fallback:Boolean(signing.fallback)}},200,origin,app);
  }
  if((url.pathname==='/v1/auth/request'||url.pathname==='/v1/auth/email')&&req.method==='POST')return requestLink(req,env,origin,app,ctx);
  if(url.pathname==='/v1/auth/exchange'&&req.method==='POST')return exchangeLink(req,env,origin,app);
  if(url.pathname==='/v1/auth/selftest'&&req.method==='GET')return selfTest(env,origin,app);
  return out({error:'not_found',service:SERVICE,version:VERSION},404,origin,app);
}};

async function requestLink(req,env,origin,app,ctx){
  if(origin&&origin!==app)return out({error:'origin_not_allowed'},403,origin,app);
  const signing=signingSecrets(env);
  if(!env.RESEND_API_KEY||!signing.primary||!String(env.SUPABASE_SERVICE_ROLE_KEY||'').trim())return out({error:'service_unavailable'},503,origin,app);
  let body;try{body=await req.json()}catch{return out({error:'invalid_json'},400,origin,app)}
  const email=normalizeEmail(body?.email);if(!email)return out({error:'Enter a valid email address.'},400,origin,app);
  const purpose=body?.purpose==='purchase'?'purchase':'signin';
  const work=issueLinkIfEntitled(env,app,signing,email,purpose).catch(e=>console.error('[nfl-auth] request stage=worker_exception',e?.message||e));
  if(ctx?.waitUntil)ctx.waitUntil(work);else await work;
  return out({ok:true,provider:'resend',auth_issuer:'propbetedge',purpose,message:GENERIC_REQUEST_MESSAGE},200,origin,app);
}

/* The gate. Nothing is signed and nothing is sent unless resolveNflAccess
   allows this exact email at this moment. A ledger that cannot answer is a
   denial. Returns the decision for tests; the HTTP answer never carries it. */
export async function issueLinkIfEntitled(env,app,signing,email,purpose,{sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
  const tag=await emailTag(email);
  let access=await checkAccess(env,email);
  if(!access.allowed&&purpose==='purchase'&&access.reason!=='entitlement_unavailable'){
    for(const delay of PURCHASE_RECHECK_DELAYS_MS){await sleep(delay);access=await checkAccess(env,email);if(access.allowed||access.reason==='entitlement_unavailable')break}
  }
  if(!access.allowed){
    console.log(`[nfl-auth] request decision=denied reason=${access.reason} purpose=${purpose} email=${tag} magic_token=none resend=none`);
    return{sent:false,reason:access.reason};
  }
  const now=Math.floor(Date.now()/1000),token=await sign({email,type:'magic',purpose,iat:now,exp:now+MAGIC_TTL,jti:crypto.randomUUID()},signing.primary);
  const link=`${app}/api/auth-verify?token=${encodeURIComponent(token)}`;
  const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:FROM_EMAIL,to:[email],subject:purpose==='purchase'?'PropBetEdge NFL Pro — your access is ready':'PropBetEdge NFL — secure sign-in',html:mailHtml(link,purpose),text:mailText(link,purpose)})});
  const detail=await r.text().catch(()=>'');
  if(!r.ok){console.error(`[nfl-auth] request decision=allowed role=${access.role} email=${tag} resend_status=${r.status} resend_error=${safeProviderMessage(detail)}`);return{sent:false,reason:'resend_failed',role:access.role}}
  let id='';try{id=String(JSON.parse(detail)?.id||'')}catch{}
  console.log(`[nfl-auth] request decision=allowed role=${access.role} purpose=${purpose} email=${tag} resend_status=${r.status} resend_id=${id}`);
  return{sent:true,role:access.role,resend_id:id};
}

async function checkAccess(env,email){
  try{
    const a=await resolveNflAccess(email,{ownerEmails:parseOwnerEmails(env.NFL_OWNER_EMAILS),supabaseUrl:env.SUPABASE_URL,serviceKey:env.SUPABASE_SERVICE_ROLE_KEY});
    return{allowed:a.allowed,role:a.role,reason:a.allowed?a.role:(a.verdict?.reason||'not_entitled')};
  }catch(e){
    console.error(`[nfl-auth] entitlement stage=unavailable error=${e?.message||e}`);
    return{allowed:false,role:null,reason:'entitlement_unavailable'};
  }
}

/* Correlates log lines without writing an address into logs. */
async function emailTag(email){const d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`pbe-nfl-auth-log:${email}`));return b64url(new Uint8Array(d)).slice(0,12)}

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
    /* Single use: the first exchange consumes the link's jti in a Durable
       Object keyed by that jti (strongly consistent); any later exchange of the
       same link is refused. No ledger, no session. */
    const consumed=await consumeMagicLink(env,p);
    if(consumed!=='ok')return out({error:consumed},consumed==='link_ledger_unavailable'?503:401,origin,app);
    /* Second check, after the link is spent: a subscription canceled or
       expired since the email was sent, or a link issued before the request
       gate existed, gets no session. The denied link stays consumed. */
    const access=await checkAccess(env,email);
    const tag=await emailTag(email);
    if(!access.allowed){
      console.log(`[nfl-auth] exchange decision=denied reason=${access.reason} email=${tag} session=none`);
      return access.reason==='entitlement_unavailable'
        ?out({error:'entitlement_unavailable'},503,origin,app)
        :out({error:'not_authorized'},403,origin,app);
    }
    const now=Math.floor(Date.now()/1000);
    const session=await sign({email,type:'session',iat:now,exp:now+SESSION_TTL,jti:crypto.randomUUID()},signing.primary);
    console.log(`[nfl-auth] exchange decision=allowed role=${access.role} email=${tag} session=issued`);
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

async function consumeMagicLink(env,p){
  const jti=String(p?.jti||'');
  if(!/^[0-9a-f-]{36}$/i.test(jti))return 'link_invalid';
  if(!env.MAGIC_LINKS)return 'link_ledger_unavailable';
  try{
    const stub=env.MAGIC_LINKS.get(env.MAGIC_LINKS.idFromName(jti));
    const r=await stub.fetch('https://magic-links/consume',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({exp:Number(p.exp)||0})});
    if(r.status===200)return 'ok';
    if(r.status===409)return 'link_already_used';
    return 'link_ledger_unavailable';
  }catch(e){console.error('[nfl-auth] magic ledger',e?.message||e);return 'link_ledger_unavailable'}
}

/* One instance per magic-link jti. storage.get/put inside one Durable Object
   run to completion without interleaving, so two simultaneous exchanges of the
   same link cannot both succeed. The record deletes itself after expiry. */
export class MagicLinkLedger{
  constructor(state){this.state=state}
  async fetch(req){
    if(req.method!=='POST')return new Response('method_not_allowed',{status:405});
    const used=await this.state.storage.get('used_at');
    if(used)return new Response(JSON.stringify({error:'link_already_used'}),{status:409});
    let exp=0;try{exp=Number((await req.json())?.exp)||0}catch{}
    const now=Date.now();
    await this.state.storage.put('used_at',now);
    await this.state.storage.setAlarm(Math.max(now+60000,(exp*1000)+3600000));
    return new Response(JSON.stringify({ok:true}),{status:200});
  }
  async alarm(){await this.state.storage.deleteAll()}
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
