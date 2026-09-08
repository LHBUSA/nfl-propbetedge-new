/* DEPLOY TARGET GUARD
 *
 *   node scripts/verify-deploy-target.mjs
 *
 * Refuses to let a CLI deploy leave this directory unless it is aimed at the
 * one project this repo belongs to, and unless the repo carries no directive
 * that could move a production domain by itself.
 *
 * On 2026-09-07 a `vercel deploy` run here with no .vercel link created a brand
 * new project from the directory name and deployed to it. vercel.json carried
 *
 *     "alias": ["nfl.propbetedge.ai"]
 *
 * so that first build in the stray project took the production domain, and a
 * later CLI deploy into the real project was recorded as a promote to
 * production. The served commit happened to be correct, and the stray project
 * had no environment variables at all, so anything reading SUPABASE_SERVICE_ROLE_KEY,
 * RESEND_API_KEY or NFL_SESSION_SIGNING_SECRET would have been degraded for as
 * long as it held the domain. Nothing in the repo objected.
 *
 * Three refusals, each naming the fix:
 *   1. UNLINKED    — no .vercel/project.json, so the CLI would invent a project
 *   2. MISMATCHED  — linked to some other project or team
 *   3. SELF-ALIASING — vercel.json declares alias/domains, so a deploy can move
 *                      a production hostname on its own
 *
 * Production domains belong to the project's Vercel settings and to the git
 * integration, never to a file a CLI deploy can act on.
 *
 * Exit 0 = safe to deploy from here. Exit 1 = refused.
 */
import { readFileSync, existsSync } from 'node:fs';

/* --config-only checks just the repo-visible rule (3). CI has no .vercel link
   -- it is gitignored -- so asking CI about the link would refuse every run;
   what CI can and must defend is that the alias directive never comes back. */
const CONFIG_ONLY = process.argv.includes('--config-only');

/* The one project this repository deploys to. */
const EXPECTED = {
  orgId: 'team_fNvGcQj9hijhsrIMDZbv0DJQ',
  orgSlug: 'justins-projects-ad4f4bb7',
  projectId: 'prj_iZubyt3i0ievyHSwnC8GSOF5VzaN',
  projectName: 'nfl-propbetedge-new',
};
/* Keys in vercel.json that can move a hostname without anyone asking. */
const SELF_ALIASING_KEYS = ['alias', 'domains'];

let failures = 0;
const fail = (code, detail, fix) => {
  failures++;
  console.error(`  REFUSED  ${code}\n           ${detail}\n           fix: ${fix}`);
};
const pass = (label, detail = '') => console.log(`  ok       ${label}${detail ? `  ${detail}` : ''}`);

console.log(`DEPLOY TARGET GUARD${CONFIG_ONLY ? ' (config only)' : ''}`);

/* 1 + 2 — the link ------------------------------------------------------- */
if (CONFIG_ONLY) {
  console.log('  skip     link check (--config-only)');
} else if (!existsSync('.vercel/project.json')) {
  fail('UNLINKED', 'no .vercel/project.json, so `vercel deploy` would create a new project named after this directory.',
    `vercel link --scope ${EXPECTED.orgSlug} --project ${EXPECTED.projectName}`);
} else {
  let link = null;
  try { link = JSON.parse(readFileSync('.vercel/project.json', 'utf8')); } catch (error) {
    fail('UNLINKED', `.vercel/project.json is not readable JSON (${error.message}).`, 'delete it and re-run vercel link');
  }
  if (link) {
    if (link.orgId !== EXPECTED.orgId) {
      fail('MISMATCHED', `linked to team ${link.orgId || '(none)'}, expected ${EXPECTED.orgId}.`,
        `vercel link --scope ${EXPECTED.orgSlug} --project ${EXPECTED.projectName}`);
    } else pass('team', EXPECTED.orgSlug);

    if (link.projectId !== EXPECTED.projectId) {
      fail('MISMATCHED', `linked to project ${link.projectName || link.projectId || '(none)'}, expected ${EXPECTED.projectName} (${EXPECTED.projectId}).`,
        `vercel link --scope ${EXPECTED.orgSlug} --project ${EXPECTED.projectName}`);
    } else pass('project', `${EXPECTED.projectName} ${EXPECTED.projectId}`);
  }
}

/* 3 — the repo must not be able to move a hostname by itself -------------- */
let config = null;
try { config = JSON.parse(readFileSync('vercel.json', 'utf8')); } catch (error) {
  fail('UNREADABLE', `vercel.json is not readable JSON (${error.message}).`, 'fix the JSON');
}
if (config) {
  const declared = SELF_ALIASING_KEYS.filter((key) => config[key] !== undefined);
  if (declared.length) {
    fail('SELF-ALIASING', `vercel.json declares ${declared.map((k) => `"${k}"`).join(' and ')}; a CLI deploy would assign that hostname to whatever it just built, in whatever project it landed in.`,
      `remove ${declared.join(' and ')} from vercel.json and manage domains in the project's Vercel settings`);
  } else pass('vercel.json declares no alias or domains');
}

if (failures) {
  console.error(`\n${failures} refusal(s) — not safe to deploy from this directory.`);
  process.exit(1);
}
console.log('\nCLEAN — this directory deploys only to ' + EXPECTED.orgSlug + '/' + EXPECTED.projectName + '.');
