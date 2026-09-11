/* nfl-replay — PBE Replay's POST-GAME ENRICHED layer, owned by Cloudflare.
 *
 *   GET  /api/replay/enrich?event=&season=&week=&type=&away=&home=
 *   GET  /api/replay/health
 *   POST /api/replay/ingest?season=2026      (Bearer REPLAY_ADMIN_TOKEN)
 *
 * INGEST ONCE, READ MANY. A cron checks the nflverse release asset
 * (play_by_play_<season>.csv.gz) every three hours. When its Last-Modified
 * changes, a Workflow instance — id derived from season + Last-Modified, so a
 * second trigger for the same asset is a no-op — streams the file (gunzip ->
 * text -> CSV, one game in memory at a time), writes one normalized object per
 * game to R2 and then the season index. A user request reads one small R2
 * object; nobody downloads or parses a season file per request.
 *
 * TRANSITIONAL READ. Only while no season index exists yet (the pipeline has
 * never completed for that season) does the read path fall back to a bounded
 * direct read of the release file, capped at 8 MB gzipped. Over the cap it
 * answers POST_GAME_ENRICHMENT_UNAVAILABLE. The cap is not to be raised: the
 * pipeline is the fix.
 *
 * Nothing here is live data. A game absent from the ingested file is
 * NOT_YET_PUBLISHED, never an empty success. Attribution (nflverse, CC-BY-4.0)
 * travels in every object and every response.
 */
import { WorkflowEntrypoint } from 'cloudflare:workers';
import { VERSION, json, currentSeason, probeAsset, streamIngest, trigger, enrich, health, PIPELINE_MAX_GZ } from './pipeline.js';

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': 'content-type' };

export class ReplayIngest extends WorkflowEntrypoint {
  async run(event, step) {
    const season = Number(event.payload?.season);
    const asset = await step.do('probe asset', { retries: { limit: 3, delay: '20 seconds', backoff: 'exponential' } }, () => probeAsset(fetch, season));
    if (asset.size && asset.size > PIPELINE_MAX_GZ) return { aborted: 'asset_too_large', asset };
    const result = await step.do('stream to R2', { retries: { limit: 3, delay: '1 minute', backoff: 'exponential' }, timeout: '15 minutes' }, () => streamIngest(this.env, season, asset));
    /* A step's return value must be serializable; R2's put result is not. */
    await step.do('record run', async () => {
      await this.env.REPLAY_R2.put(`replay/${season}/last-run.json`, JSON.stringify({ ...result, instance: event.instanceId || null, asset }));
      return { recorded: true };
    });
    return result;
  }
}

function authorized(req, env) {
  const token = String(req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const want = String(env.REPLAY_ADMIN_TOKEN || '');
  if (!want || token.length !== want.length) return false;
  let d = 0; for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ token.charCodeAt(i);
  return d === 0;
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    try {
      if (url.pathname === '/api/replay/ingest') {
        if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
        if (!authorized(req, env)) return json({ error: 'unauthorized' }, 401);
        const season = Number(url.searchParams.get('season')) || currentSeason();
        return json(await trigger(env, season, { force: url.searchParams.get('force') === '1' }));
      }
      if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      if (url.pathname === '/api/replay/enrich') return await enrich(env, url);
      if (url.pathname === '/api/replay/health' || url.pathname === '/health') return await health(env, url);
      return json({ error: 'not_found', path: url.pathname, service: 'nfl-replay' }, 404);
    } catch (e) {
      return json({ available: false, error: 'internal', detail: String(e?.message || e), runtime: VERSION }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(trigger(env, currentSeason(new Date(event.scheduledTime || Date.now()))).then(r => console.log('[nfl-replay] trigger', JSON.stringify(r))).catch(e => console.log('[nfl-replay] trigger failed', String(e?.message || e))));
  }
};
