import Stripe from 'stripe';

const SITE_URL = 'https://nfl.propbetedge.ai';

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
    const paid=session?.status==='complete'&&(session?.payment_status==='paid'||session?.payment_status==='no_payment_required'||session?.mode==='subscription');
    if(!isNfl||!paid)return res.redirect(302,`${SITE_URL}/?checkout=not_complete`);

    const tier=encodeURIComponent(session?.metadata?.tier||'nfl_pro');
    return res.redirect(302,`${SITE_URL}/?checkout=success&tier=${tier}`);
  }catch(error){
    console.error('[checkout-complete] verification failed',error?.message||error);
    return res.redirect(302,`${SITE_URL}/?checkout=unavailable`);
  }
}
