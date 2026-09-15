/* PropBetEdge NFL — Stripe Checkout return.
 *
 * Verifies the Checkout Session with Stripe, then asks the auth Worker's
 * server-to-server purchase-delivery route (never the public, deliberately
 * uninformative /v1/auth/request) to send the purchase access link. The Worker
 * re-checks NFL entitlement and answers with the TRUE delivery result.
 *
 * access_email_sent_at is written to the session ONLY when that result is
 * `sent` or `already_sent`. Anything else leaves the session unstamped, so the
 * next visit to this return URL (or the webhook) retries, and the buyer is told
 * they can request their secure access link.
 */
const SITE_URL='https://nfl.propbetedge.ai';
const AUTH_WORKER='https://propbetedge-nfl-auth.sales-fd3.workers.dev';
export const INTERNAL_DELIVERY_PATH='/internal/v1/purchase-delivery';
/* The Worker's late-webhook re-check is ~4.5s; past this the buyer is
   redirected and delivery is reported as not yet confirmed. */
export const DELIVERY_TIMEOUT_MS=12000;
const CONFIRMED=new Set(['sent','already_sent']);
const PENDING=new Set(['not_entitled','in_progress']);

function emailOf(session){
  const email=String(session?.customer_details?.email||session?.customer_email||session?.metadata?.email||'').trim().toLowerCase();
  return /^\S+@\S+\.\S+$/.test(email)&&email.length<=254?email:'';
}

/* The same key the billing Worker uses, so the Worker's delivery record
   dedupes the checkout return and the webhook against each other. */
export function deliveryKeyOf(session,sessionId){
  const sub=typeof session?.subscription==='string'?session.subscription:session?.subscription?.id;
  return /^sub_[A-Za-z0-9]+$/.test(String(sub||''))?`subscription:${sub}`:`checkout:${sessionId}`;
}

/** Ask the auth Worker to deliver; returns the Worker's result string or an
 *  internal_* failure. Never throws. */
export async function requestPurchaseDelivery({email,deliveryKey,token,workerBase=AUTH_WORKER,fetchImpl=fetch,timeoutMs=DELIVERY_TIMEOUT_MS}){
  const secret=String(token||'').trim();
  if(!secret)return 'internal_unconfigured';
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const response=await fetchImpl(`${String(workerBase).trim().replace(/\/$/,'')}${INTERNAL_DELIVERY_PATH}`,{
      method:'POST',
      headers:{'content-type':'application/json',accept:'application/json',authorization:`Bearer ${secret}`},
      cache:'no-store',
      signal:controller.signal,
      body:JSON.stringify({email,delivery_key:deliveryKey})
    });
    const body=await response.json().catch(()=>({}));
    const result=String(body?.result||'');
    return result||`internal_${response.status}`;
  }catch(error){
    return error?.name==='AbortError'?'internal_timeout':'internal_network';
  }finally{
    clearTimeout(timer);
  }
}

/** Verify one Checkout Session and deliver its access link at most once.
 *  `deliver({email,deliveryKey})` resolves to a delivery result string. */
export async function completeCheckout({sessionId,stripe,deliver}){
  const session=await stripe.checkout.sessions.retrieve(sessionId);
  const isNfl=session?.metadata?.acquired_sport==='nfl'&&session?.metadata?.product==='propbetedge_nfl';
  const paid=session?.status==='complete'&&(session?.payment_status==='paid'||session?.payment_status==='no_payment_required');
  if(!isNfl||!paid)return{location:`${SITE_URL}/?checkout=not_complete`,access:null,result:null};

  const tier=encodeURIComponent(session?.metadata?.tier||'nfl_pro');
  const done=access=>`${SITE_URL}/?checkout=success&tier=${tier}&access_email=${access}`;
  if(session?.metadata?.access_email_sent_at)return{location:done('already_sent'),access:'already_sent',result:'already_stamped'};

  const email=emailOf(session);
  if(!email)return{location:done('pending'),access:'pending',result:'no_email'};

  const result=await deliver({email,deliveryKey:deliveryKeyOf(session,sessionId)});
  if(!CONFIRMED.has(result)){
    const access=PENDING.has(result)?'pending':'failed';
    console.error('[checkout-complete] access email not confirmed result=%s access_email=%s',result,access);
    return{location:done(access),access,result};
  }
  try{
    await stripe.checkout.sessions.update(sessionId,{metadata:{...session.metadata,access_email_sent_at:new Date().toISOString(),access_email_provider:'resend'}});
  }catch(error){
    /* Delivery is recorded by the Worker; the next return stamps it without
       a second email. */
    console.error('[checkout-complete] sent but stamp failed',error?.message||error);
  }
  return{location:done('sent'),access:'sent',result};
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  if(req.method!=='GET')return res.status(405).send('Method not allowed');

  const sessionId=typeof req.query?.session_id==='string'?req.query.session_id.trim():'';
  if(!/^cs_[A-Za-z0-9_]+$/.test(sessionId))return res.redirect(302,`${SITE_URL}/?checkout=invalid`);
  if(!process.env.STRIPE_SECRET_KEY)return res.redirect(302,`${SITE_URL}/?checkout=unavailable`);

  try{
    /* Loaded here so the delivery core above stays importable without the SDK. */
    const {default:Stripe}=await import('stripe');
    const stripe=new Stripe(process.env.STRIPE_SECRET_KEY,{apiVersion:'2023-10-16'});
    const outcome=await completeCheckout({
      sessionId,
      stripe,
      deliver:({email,deliveryKey})=>requestPurchaseDelivery({
        email,
        deliveryKey,
        token:process.env.NFL_AUTH_INTERNAL_TOKEN,
        workerBase:process.env.NFL_AUTH_WORKER_URL||AUTH_WORKER
      })
    });
    return res.redirect(302,outcome.location);
  }catch(error){
    console.error('[checkout-complete] verification failed',error?.message||error);
    return res.redirect(302,`${SITE_URL}/?checkout=unavailable`);
  }
}
