/**
 * Core batch-execution logic — create job, poll, download, record — shared by
 * the CLI (run.mts) and the web UI's Generate button (webapp/server.mts) so
 * the two front-ends can never drift on what "running a job" actually means.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createTryonJob, DevApiError, getJob, type DevApiConfig } from './api-client.mts';
import { createLimiter } from './concurrency.mts';
import { ensureRun, getRunRows, insertJobResult } from './db.mts';
import type { TryonJobSpec } from './scan-input.mts';

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export interface JobResult {
  gender: string;
  personName: string;
  categorySlug: string;
  garmentName: string;
  jobId?: string;
  status: 'COMPLETED' | 'FAILED' | 'ERROR';
  errorCode?: string;
  error?: string;
  outputFile?: string;
  finishedAt: string;
}

export function keyOf(j: Pick<TryonJobSpec, 'gender' | 'personName' | 'categorySlug' | 'garmentName'>): string {
  return `${j.gender}/${j.personName}/${j.categorySlug}/${j.garmentName}`;
}

function mimeFor(file: string): string {
  return MIME_BY_EXT[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PollOptions {
  intervalMs: number;
  timeoutMs: number;
}

export async function pollJob(
  cfg: DevApiConfig,
  jobId: string,
  opts: PollOptions,
): Promise<{ status: 'COMPLETED' | 'FAILED'; imageUrl?: string; error?: string }> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const job = await getJob(cfg, jobId);
    if (job.status === 'COMPLETED') return { status: 'COMPLETED', imageUrl: job.imageUrl };
    if (job.status === 'FAILED') return { status: 'FAILED', error: job.error };
    await sleep(opts.intervalMs);
  }
  return { status: 'FAILED', error: 'TIMEOUT_WAITING_FOR_RESULT' };
}

export async function runOneJob(
  cfg: DevApiConfig,
  job: TryonJobSpec,
  resultsDir: string,
  poll: PollOptions,
): Promise<JobResult> {
  const base = {
    gender: job.gender,
    personName: job.personName,
    categorySlug: job.categorySlug,
    garmentName: job.garmentName,
    finishedAt: new Date().toISOString(),
  };

  const person = { buf: readFileSync(job.personFile), filename: path.basename(job.personFile), mime: mimeFor(job.personFile) };
  const garment = { buf: readFileSync(job.garmentFile), filename: path.basename(job.garmentFile), mime: mimeFor(job.garmentFile) };

  const created = await createTryonJob(cfg, job.categorySlug, person, garment);
  const outcome = await pollJob(cfg, created.jobId, poll);

  if (outcome.status === 'FAILED') {
    return { ...base, jobId: created.jobId, status: 'FAILED', error: outcome.error };
  }

  const imgRes = await fetch(outcome.imageUrl!);
  if (!imgRes.ok) {
    return { ...base, jobId: created.jobId, status: 'ERROR', error: `failed to download result: HTTP ${imgRes.status}` };
  }
  const bytes = Buffer.from(await imgRes.arrayBuffer());

  const outDir = path.join(resultsDir, job.gender, job.personName, job.categorySlug);
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${job.garmentName}.jpg`);
  writeFileSync(outFile, bytes);

  return { ...base, jobId: created.jobId, status: 'COMPLETED', outputFile: outFile };
}

export function writeSummaryCsv(runDir: string, runId: string) {
  const rows = getRunRows(runId);
  const header = 'gender,personName,categorySlug,garmentName,status,jobId,outputFile,error';
  const csvEscape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const body = rows.map((r) =>
    [r.gender, r.personName, r.categorySlug, r.garmentName, r.status, r.jobId ?? '', r.outputFile ?? '', r.error ?? '']
      .map(csvEscape)
      .join(','),
  );
  writeFileSync(path.join(runDir, 'summary.csv'), [header, ...body].join('\n') + '\n');
}

export interface RunBatchOptions {
  concurrency: number;
  poll: PollOptions;
  onEvent?: (evt: { type: 'job'; result: JobResult } | { type: 'credits-exhausted' }) => void;
}

/** Resolves once every job has either finished or been skipped after credits ran out. */
export async function runBatch(
  cfg: DevApiConfig,
  jobs: TryonJobSpec[],
  runId: string,
  runDir: string,
  opts: RunBatchOptions,
): Promise<{ completed: number; failed: number }> {
  const resultsDir = path.join(runDir, 'results');
  mkdirSync(resultsDir, { recursive: true });
  ensureRun(runId); // no-op if the caller already registered it (with a startedBy); guards the job_results FK otherwise

  let creditsExhausted = false;
  let completed = 0;
  let failed = 0;
  const limit = createLimiter(opts.concurrency);

  await Promise.all(
    jobs.map((job) =>
      limit(async () => {
        if (creditsExhausted) return;
        const result = await runOneJob(cfg, job, resultsDir, opts.poll).catch(
          (err): JobResult => ({
            gender: job.gender,
            personName: job.personName,
            categorySlug: job.categorySlug,
            garmentName: job.garmentName,
            status: 'ERROR',
            errorCode: err instanceof DevApiError ? err.code : undefined,
            error: err instanceof Error ? err.message : String(err),
            finishedAt: new Date().toISOString(),
          }),
        );

        if (result.errorCode === 'INSUFFICIENT_CREDITS') {
          creditsExhausted = true;
          opts.onEvent?.({ type: 'credits-exhausted' });
        }

        insertJobResult(runId, result);
        if (result.status === 'COMPLETED') completed++;
        else failed++;
        opts.onEvent?.({ type: 'job', result });
      }),
    ),
  );

  writeSummaryCsv(runDir, runId);
  return { completed, failed };
}
