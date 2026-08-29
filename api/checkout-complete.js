import Stripe from 'stripe';

const SITE_URL='https://nfl.propbetedge.ai';
const AUTH_WORKER='https://propbetedge-nfl-auth.sales-fd3.workers.dev';

function emailOf(session){
  const email=String(session?.customer_details?.email||session?.customer_email||session?.metadata?.email||'').trim().toLowerCase();
  return /^\S+@\S+\.\S+$/.test(email)&&email.length<=254?email:'';
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  if(req.method!=='GET')return res.status(405).send('Method not allowed');

  const sessionId=typeof req.query?.session_id==='string'?req.query.session_id.trim():'';
  if(!/^cs_[A-Za-z0-9_]+$/.test(sessionId))return res.redirect(302,`${SITE_URL}/?checkout=invalid`);
  if(!process.env.STRIPE_SECRET_KEY)return res.redirect(302,`${SITE_URL}/?checkout=unavailable`);

  try{
    const stripe=new Stripe(process.env.STRIPE_SECRET_KEY,{apiVersion:'2023-10-16'});
    const session=await stripe.checkout.sessions.retrieve(sessionId);
    const isNfl=session?.metadata?.acquired_sport==='nfl'&&session?.metadata?.product==='propbetedge_nfl';
    const paid=session?.status==='complete'&&(session?.payment_status==='paid'||session?.payment_status==='no_payment_required');
    if(!isNfl||!paid)return res.redirect(302,`${SITE_URL}/?checkout=not_complete`);

    const email=emailOf(session);
    let delivery=session?.metadata?.access_email_sent_at?'already_sent':'pending';

    if(email&&!session?.metadata?.access_email_sent_at){
      try{
        const workerBase=String(process.env.NFL_AUTH_WORKER_URL||AUTH_WORKER).trim().replace(/\/$/,'');
        const response=await fetch(`${workerBase}/v1/auth/request`,{
          method:'POST',
          headers:{'content-type':'application/json',accept:'application/json',origin:SITE_URL},
          cache:'no-store',
          body:JSON.stringify({email,purpose:'purchase'})
        });
        const body=await response.json().catch(()=>({}));
        if(!response.ok)throw new Error(body?.error||`access_email_${response.status}`);
        const sentAt=new Date().toISOString();
        await stripe.checkout.sessions.update(sessionId,{metadata:{...session.metadata,access_email_sent_at:sentAt,access_email_provider:'resend'}});
        delivery='sent';
      }catch(error){
        delivery='failed';
        console.error('[checkout-complete] access email failed',error?.message||error);
      }
    }

    const tier=encodeURIComponent(session?.metadata?.tier||'nfl_pro');
    return res.redirect(302,`${SITE_URL}/?checkout=success&tier=${tier}&access_email=${encodeURIComponent(delivery)}`);
  }catch(error){
    console.error('[checkout-complete] verification failed',error?.message||error);
    return res.redirect(302,`${SITE_URL}/?checkout=unavailable`);
  }
}
