/**
 * Bulk try-on runner against the public dev API (/v1/dev/*).
 *
 * Takes N person photos and N garment categories and creates one try-on job
 * per (person x garment) pair via POST /v1/dev/tryon. The category slug alone
 * picks the ComfyUI workflow server-side — dev_tryon_categories.workflowTemplateId,
 * set in Admin > Developer API > Categories — so this script never touches
 * workflow selection itself; it only has to send the right slug.
 *
 * Input layout (create under scripts/bulk-tryon/input/ — gitignored, never commit
 * real photos):
 *   input/
 *     people/<gender>/*.jpg                     one file per person
 *     garments/<gender>/<category-slug>/*.jpg   one or more per category
 *
 *   <gender> is any folder name you choose (e.g. "men", "women") — it is never
 *   sent to the API, it only controls which people get matched against which
 *   garments subtree (dev categories have no gender column). <category-slug>
 *   MUST match an active slug from GET /v1/dev/categories or that folder's
 *   jobs are skipped with a warning.
 *
 * Output: scripts/bulk-tryon/output/<run-id>/ (gitignored)
 *   results/<gender>/<person>/<category>/<garment>.jpg   the actual images
 *   summary.csv                                           written once, at the end
 * Job attempts themselves (one row per job, as it finishes — crash-safe, and
 * what --resume reads) live in lib/db.mts's SQLite store, not a file under
 * this folder.
 *
 * Usage (see package.json "bulk-tryon" script):
 *   pnpm bulk-tryon -- --dry-run          validate + show the plan, no API calls
 *   pnpm bulk-tryon -- --limit=3          smoke-test a handful of jobs first
 *   pnpm bulk-tryon -- --yes              skip the interactive confirmation
 *   pnpm bulk-tryon -- --resume=<run-id>  continue an interrupted run
 *
 * Requires scripts/bulk-tryon/.env (copy from .env.example):
 *   DEV_API_KEY       merchant dev API key, minted once via POST /v1/merchant/api-keys — SECRET
 *   DEV_API_BASE_URL  defaults to https://app.aivastra.com (PRODUCTION — every job
 *                      created here spends real merchant credits)
 */

import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { getBalance, getCategories, type DevApiConfig } from './lib/api-client.mts';
import { keyOf, runBatch } from './lib/batch.mts';
import { ensureRun, getCompletedKeysForRun } from './lib/db.mts';
import { scanInput } from './lib/scan-input.mts';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// ---- CLI args + env ----
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string): string | undefined => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

const DRY_RUN = flag('dry-run');
const SKIP_CONFIRM = flag('yes') || flag('y');
const LIMIT = opt('limit') ? Number(opt('limit')) : undefined;
const RESUME_RUN_ID = opt('resume');

const BASE_URL = (process.env.DEV_API_BASE_URL ?? 'https://app.aivastra.com').replace(/\/$/, '');
const API_KEY = process.env.DEV_API_KEY;
const INPUT_DIR = process.env.INPUT_DIR ? path.resolve(process.env.INPUT_DIR) : path.join(SCRIPT_DIR, 'input');
const OUTPUT_DIR = process.env.OUTPUT_DIR ? path.resolve(process.env.OUTPUT_DIR) : path.join(SCRIPT_DIR, 'output');
const CONCURRENCY = Number(opt('concurrency') ?? process.env.CONCURRENCY ?? 2);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 4000);
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS ?? 5 * 60 * 1000);

if (!API_KEY) {
  console.error('DEV_API_KEY is not set. Copy scripts/bulk-tryon/.env.example to scripts/bulk-tryon/.env and fill it in.');
  process.exit(1);
}
const cfg: DevApiConfig = { baseUrl: BASE_URL, apiKey: API_KEY };

async function main() {
  console.log(`Dev API base: ${BASE_URL}${BASE_URL.includes('app.aivastra.com') ? ' (PRODUCTION)' : ''}`);

  const categories = await getCategories(cfg);
  const activeSlugs = new Set(categories.map((c) => c.slug));
  console.log(`Active categories (${activeSlugs.size}): ${[...activeSlugs].join(', ') || '(none)'}`);

  const { jobs: scanned, warnings } = scanInput(INPUT_DIR);
  for (const w of warnings) console.warn(`  ! ${w}`);

  const unknownSlugs = new Set(scanned.filter((j) => !activeSlugs.has(j.categorySlug)).map((j) => j.categorySlug));
  for (const slug of unknownSlugs) {
    console.warn(`  ! garments/*/${slug}/ does not match any active dev category — skipping those jobs`);
  }
  const jobs = scanned.filter((j) => activeSlugs.has(j.categorySlug));

  const runId = RESUME_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(OUTPUT_DIR, runId);
  mkdirSync(runDir, { recursive: true });
  ensureRun(runId, os.userInfo().username);

  const done = getCompletedKeysForRun(runId);
  const pending = jobs.filter((j) => !done.has(keyOf(j)));
  const finalJobs = LIMIT ? pending.slice(0, LIMIT) : pending;

  console.log(
    `\nPlan: ${finalJobs.length} job(s) to run` +
      (LIMIT && pending.length > LIMIT ? ` (--limit=${LIMIT}, ${pending.length - LIMIT} more available)` : '') +
      (done.size ? `, ${done.size} already completed in run ${runId}` : '') +
      '.',
  );
  const byCategory = new Map<string, number>();
  for (const j of finalJobs) byCategory.set(j.categorySlug, (byCategory.get(j.categorySlug) ?? 0) + 1);
  for (const [slug, count] of byCategory) console.log(`  ${slug}: ${count}`);

  if (finalJobs.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  const balance = await getBalance(cfg);
  console.log(`\nBalance: ${balance.credits} credits (~${balance.tryOnsRemaining} try-ons remaining).`);
  if (finalJobs.length > balance.tryOnsRemaining) {
    console.warn(
      `  ! Plan (${finalJobs.length} jobs) exceeds the estimated remaining try-ons (${balance.tryOnsRemaining}) — later jobs will likely fail with INSUFFICIENT_CREDITS.`,
    );
  }

  if (DRY_RUN) {
    console.log('\n--dry-run: no jobs were created, run folder left empty.');
    return;
  }

  if (!SKIP_CONFIRM) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      `\nThis calls ${BASE_URL} and will spend real credits creating ${finalJobs.length} job(s). Continue? (y/N) `,
    );
    rl.close();
    if (answer.trim().toLowerCase() !== 'y') {
      console.log('Aborted — no jobs created.');
      return;
    }
  }

  const { completed, failed } = await runBatch(cfg, finalJobs, runId, runDir, {
    concurrency: CONCURRENCY,
    poll: { intervalMs: POLL_INTERVAL_MS, timeoutMs: POLL_TIMEOUT_MS },
    onEvent: (evt) => {
      if (evt.type === 'credits-exhausted') {
        console.error('  ! Out of credits — no further new jobs will be started (already-started ones still finish).');
        return;
      }
      const { result } = evt;
      console.log(
        `  [${result.status}] ${result.gender}/${result.personName} + ${result.categorySlug}/${result.garmentName}` +
          (result.error ? ` — ${result.error}` : ''),
      );
    },
  });

  console.log(`\nDone: ${completed} completed, ${failed} failed. Run folder: ${runDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
