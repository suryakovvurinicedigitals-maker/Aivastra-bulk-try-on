/**
 * Thin client for the public dev API (apps/api/src/modules/dev/routes.ts).
 * Deliberately just fetch + retry — this script has no workspace dependency
 * on @aivastra/types, so response shapes here are hand-kept in sync with
 * packages/types/src/dev.ts rather than imported.
 */

export interface DevApiConfig {
  baseUrl: string;
  apiKey: string;
}

/** Mirrors the `{ error: { code, message } }` shape every dev route throws (server.ts). */
export class DevApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'DevApiError';
    this.status = status;
    this.code = code;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Dev routes are limited to 60 req/min per key (apps/api/src/modules/dev/routes.ts
// rateLimitConfig) — a run with many jobs will hit this from job-creation +
// polling combined, so 429s are expected, not exceptional.
//
// 502/503/504 are retried the same way — they're what a brief restart, deploy,
// or overload on aivastra's own backend (or whatever gateway/load balancer
// sits in front of it) looks like from here: a fast, contentless bounce, not
// a real rejection. Confirmed 2026-09-07 from a run where ~60 jobs all
// recorded "Bad Gateway" (a 502's res.statusText, since 502 bodies are almost
// never JSON — see parseOrThrow's fallback) in the same ~1s window, and a
// plain re-run of the same jobs succeeded once aivastra's backend was back —
// without a retry here, an unattended overnight run turns a few-second
// upstream blip into a wall of permanent ERROR rows instead of quietly
// riding it out.
const MAX_RETRIES = 6;
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

async function request(cfg: DevApiConfig, path: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${cfg.apiKey}`, ...(init.headers ?? {}) },
  });
  if (RETRYABLE_STATUSES.has(res.status) && attempt < MAX_RETRIES) {
    // 429s usually carry a Retry-After; 502/503/504 almost never do (they're
    // typically a static error page from the gateway, not aivastra's own API
    // responding), so those fall straight through to the same exponential
    // backoff (1, 2, 4, 8, 16, 32s) used whenever the header's absent anyway.
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
    throw new DevApiError(res.status, code, message);
  }
  return body;
}

export async function getCategories(cfg: DevApiConfig): Promise<{ slug: string; name: string }[]> {
  const body = await parseOrThrow(await request(cfg, '/v1/dev/categories'));
  return body.categories;
}

/** Works with either key scope (unlike /v1/dev/me, which needs a full-scope key). */
export async function getBalance(cfg: DevApiConfig): Promise<{ credits: number; tryOnsRemaining: number }> {
  return parseOrThrow(await request(cfg, '/v1/dev/balance'));
}

export interface ImageInput {
  buf: Buffer;
  filename: string;
  mime: string;
}

export async function createTryonJob(
  cfg: DevApiConfig,
  category: string,
  person: ImageInput,
  garment: ImageInput,
): Promise<{ jobId: string; status: string; personKey?: string }> {
  const form = new FormData();
  form.set('category', category);
  form.set('person', new File([person.buf], person.filename, { type: person.mime }));
  form.set('garment', new File([garment.buf], garment.filename, { type: garment.mime }));
  const res = await request(cfg, '/v1/dev/tryon', { method: 'POST', body: form });
  return parseOrThrow(res);
}

export async function getJob(
  cfg: DevApiConfig,
  jobId: string,
): Promise<{ jobId: string; status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED'; imageUrl?: string; error?: string }> {
  const res = await request(cfg, `/v1/dev/jobs/${jobId}`);
  return parseOrThrow(res);
}
