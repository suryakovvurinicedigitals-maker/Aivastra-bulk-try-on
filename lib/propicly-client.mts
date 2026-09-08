/**
 * Thin client for the propicly dev API's RedChief multi-view endpoints (see
 * docs/superpowers/plans/2026-09-08-redchief-tab-spec.md for the full
 * contract). Deliberately separate from lib/api-client.mts: that file talks
 * to the OLD aivastra host under DEV_API_BASE_URL/DEV_API_KEY for the
 * existing bulk try-on flow, which must keep working unchanged. This file
 * talks to the NEW propicly host under PROPICLY_API_BASE_URL/PROPICLY_API_KEY
 * for the RedChief tab only — two separate merchant accounts/keys, never
 * merged into one config.
 */

export interface PropiclyApiConfig {
  baseUrl: string;
  apiKey: string;
}

/** Mirrors the `{ error: { code, message } }` shape every dev route throws. */
export class PropiclyApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'PropiclyApiError';
    this.status = status;
    this.code = code;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Same retry shape as lib/api-client.mts's request(): dev routes are limited
// to 60 req/min per key, and 502/503/504 are what a brief backend restart or
// gateway blip looks like from here — worth riding out rather than failing
// the tester's request outright.
const MAX_RETRIES = 6;
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

async function request(cfg: PropiclyApiConfig, path: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${cfg.apiKey}`, ...(init.headers ?? {}) },
  });
  if (RETRYABLE_STATUSES.has(res.status) && attempt < MAX_RETRIES) {
    const retryAfterHeader = Number(res.headers.get('retry-after'));
    const waitSeconds = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader : 2 ** attempt;
    await sleep(waitSeconds * 1000);
    return request(cfg, path, init, attempt + 1);
  }
  return res;
}

async function parseOrThrow(res: Response): Promise<any> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = body?.error?.code ?? String(res.status);
    const message = body?.error?.message ?? res.statusText;
    throw new PropiclyApiError(res.status, code, message);
  }
  return body;
}

export interface RedchiefWorkflow {
  inputCount: number;
  viewLabels: string[];
}

export interface RedchiefConfig {
  creditCost: number;
  workflows: RedchiefWorkflow[];
}

export async function getRedchiefConfig(cfg: PropiclyApiConfig): Promise<RedchiefConfig> {
  return parseOrThrow(await request(cfg, '/v1/dev/redchief/config'));
}

/**
 * Creates a RedChief job from 1-6 view images, sent as JSON/base64 (each a
 * `data:image/...;base64,...` URI or raw base64 string) rather than
 * multipart — this tool's web server has no incoming multipart parser by
 * design (see webapp/server.mts's header comment on why /api/upload uses raw
 * bodies instead), so the browser base64-encodes each file and this function
 * forwards that same JSON straight through. The propicly API documents this
 * as a fully-equivalent alternative to multipart, not a workaround.
 */
export async function createRedchiefJob(cfg: PropiclyApiConfig, views: string[]): Promise<{ jobId: string; status: string }> {
  return parseOrThrow(
    await request(cfg, '/v1/dev/redchief', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ views }),
    }),
  );
}

export interface DevJob {
  jobId: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  imageUrl?: string;
  imageUrls?: string[];
  error?: string;
}

export async function getJob(cfg: PropiclyApiConfig, jobId: string): Promise<DevJob> {
  return parseOrThrow(await request(cfg, `/v1/dev/jobs/${jobId}`));
}

export interface JobListItem {
  jobId: string;
  kind: 'redchief' | 'tryon' | 'saree_mannequin';
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  creditsCharged: number;
  createdAt: string;
}

export interface JobList {
  page: number;
  pageSize: number;
  total: number;
  jobs: JobListItem[];
}

export async function listJobs(cfg: PropiclyApiConfig, page: number, pageSize: number): Promise<JobList> {
  return parseOrThrow(await request(cfg, `/v1/dev/jobs?page=${page}&pageSize=${pageSize}`));
}

export async function cancelJob(cfg: PropiclyApiConfig, jobId: string): Promise<{ ok: true; creditsRefunded: number }> {
  return parseOrThrow(await request(cfg, `/v1/dev/jobs/${jobId}/cancel`, { method: 'POST' }));
}
