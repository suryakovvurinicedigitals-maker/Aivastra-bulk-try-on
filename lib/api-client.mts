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

// ---------------------------------------------------------------------------
// Catalog surface (apps/api/src/modules/dev/catalog.routes.ts) — for the
// Catalog Batch tab. Still the SAME aivastra host and DEV_API_KEY as
// everything else in this file (unlike lib/propicly-client.mts, which is a
// genuinely separate host/merchant account) — these three routes require a
// 'full'-scoped key, same as /v1/dev/tryon above, so no new config is needed
// as long as the existing key already creates try-on jobs successfully.
// Shapes hand-kept in sync with packages/types/src/dev.ts, same as the rest
// of this file.

export type CatalogGender = 'men' | 'women' | 'boys' | 'girls';

export interface CatalogAsset {
  slug: string;
  label: string;
  thumbnailUrl: string;
}

/** A pose asset additionally says whether it supports a separately-selected lower garment / shoe — some poses (e.g. a close-up) don't show feet or legs at all. */
export interface CatalogPose extends CatalogAsset {
  hasLower: boolean;
  hasShoes: boolean;
}

export interface CatalogOptions {
  garmentTypes: { slug: string; label: string }[];
  faces: CatalogAsset[];
  backgrounds: CatalogAsset[];
  poses: CatalogPose[];
  lowerItems: CatalogAsset[];
  shoeItems: CatalogAsset[];
}

/**
 * Lists the admin-curated assets selectable for a catalog generate call,
 * scoped to `gender` and optionally narrowed further by `garmentType` (some
 * poses/lower/shoe items aren't valid for every garment type — passing it
 * here is what keeps the picker showing only slugs that will actually
 * resolve on generateCatalog below, per the route's own doc comment).
 */
export async function getCatalogOptions(cfg: DevApiConfig, gender: CatalogGender, garmentType?: string): Promise<CatalogOptions> {
  const params = new URLSearchParams({ gender });
  if (garmentType) params.set('garmentType', garmentType);
  return parseOrThrow(await request(cfg, `/v1/dev/catalog/options?${params}`));
}

export interface CatalogLook {
  pose: string;
  background: string;
}

export interface CatalogGenerateBody {
  /** base64 or a `data:image/...;base64,...` URI — sent as JSON here (this tool has no incoming multipart parser), which the route documents as fully equivalent to a multipart upload. */
  garment: string;
  gender: CatalogGender;
  face: string;
  /** 1-12 pose+background pairs; each generate call becomes exactly this many job_results rows, each its own credit charge. */
  looks: CatalogLook[];
  garmentType?: string;
  lower?: string;
  shoe?: string;
  aspectRatio: '1:1' | '2:3' | '3:4' | '4:5';
  resolution: 'HD' | '2K' | '4K';
}

export interface CatalogGenerateResult {
  catalogueId: string;
  jobs: { jobId: string; pose: string; background: string }[];
}

export async function generateCatalog(cfg: DevApiConfig, body: CatalogGenerateBody): Promise<CatalogGenerateResult> {
  return parseOrThrow(
    await request(cfg, '/v1/dev/catalog/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export type CatalogJobStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface CatalogueJob {
  jobId: string;
  status: CatalogJobStatus;
  /** present only when status === 'COMPLETED'; a 900s-TTL presigned URL, never plural — one job = one image. */
  imageUrl?: string;
  /** present only when status === 'FAILED'; a plain string code (e.g. "JOB_FAILED"/"JOB_CANCELLED"), not a {code,message} object. */
  error?: string;
}

export interface CatalogueStatus {
  catalogueId: string;
  jobs: CatalogueJob[];
}

/** Status of every job created by one generateCatalog call — no pagination, always the full set (capped at 12 by the looks array). */
export async function getCatalogueStatus(cfg: DevApiConfig, catalogueId: string): Promise<CatalogueStatus> {
  return parseOrThrow(await request(cfg, `/v1/dev/catalogues/${catalogueId}`));
}

// ---------------------------------------------------------------------------
// Dev-API-owned backgrounds (apps/api/src/modules/dev/backgrounds.routes.ts)
// — added to aivastra's dev API specifically so a merchant can test a
// CANDIDATE background image (one that doesn't exist in the admin-curated
// library) in a real generateCatalog call, before deciding whether it's
// worth adding permanently via the admin panel. Same [requireApiKey,
// requireDevScope('full')] auth as every other route in this section — no
// new config needed. Deliberately scoped to background only, not
// face/lower/shoe/pose, which stay admin-curated-only (see the catalog
// picker's own comments in webapp/public/catalog.js for why).
//
// Upload SHAPE is genuinely different from every other image this client
// sends: garment (createTryonJob/generateCatalog) goes in as multipart or a
// base64 data URI directly inside the job-creation call itself. A
// background instead goes through THREE steps: presign (reserve storage,
// get a direct-to-storage upload URL) -> the caller PUTs raw image bytes to
// that URL directly (S3-style, bypassing this API entirely) -> confirm
// (finalize the upload into a selectable background). Don't conflate the
// two upload mechanisms.
// ---------------------------------------------------------------------------

export interface DevBackgroundItem {
  /** A UUID — happens to satisfy PUBLIC_SLUG's regex, so it can be passed straight into looks[].background alongside admin-curated slugs from getCatalogOptions. */
  id: string;
  label: string;
  /** Presigned GET, 3600s TTL — same caveat as CatalogAsset.thumbnailUrl above. */
  thumbnailUrl: string;
}

/** Every background this merchant (this DEV_API_KEY) has uploaded and not deleted. Not gender-scoped — one list regardless of the catalog picker's current gender/garmentType selection. */
export async function listDevBackgrounds(cfg: DevApiConfig): Promise<{ items: DevBackgroundItem[] }> {
  return parseOrThrow(await request(cfg, '/v1/dev/backgrounds'));
}

export interface DevBackgroundPresignResult {
  /** Presigned S3-style PUT URL — PUT raw image bytes here directly; this server/client never round-trips them through the dev API itself. */
  uploadUrl: string;
  /** Pass straight through to confirmDevBackground once the PUT succeeds. */
  r2Key: string;
  /** The eventual background's id — already known before confirm, but not usable in a generate call until confirm succeeds. */
  id: string;
  /** Seconds the uploadUrl stays valid for (300 as of the route's current implementation) — PUT promptly. */
  expiresIn: number;
}

/** Step 1 of 3. contentType must be one of the three formats the route accepts; contentLength is only an outer bound (50MB) — real size enforcement happens server-side at confirm time via a HEAD on the uploaded object. */
export async function presignDevBackground(
  cfg: DevApiConfig,
  contentType: 'image/jpeg' | 'image/png' | 'image/webp',
  contentLength: number,
): Promise<DevBackgroundPresignResult> {
  return parseOrThrow(
    await request(cfg, '/v1/dev/backgrounds/presign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentType, contentLength }),
    }),
  );
}

/** Step 3 of 3 (step 2 is the caller PUTting bytes to presignDevBackground's uploadUrl — not an API call at all, so there's no client function for it here). The server re-sniffs the real image format/size itself; the contentType declared at presign time is never trusted. */
export async function confirmDevBackground(cfg: DevApiConfig, r2Key: string, label?: string): Promise<DevBackgroundItem> {
  return parseOrThrow(
    await request(cfg, '/v1/dev/backgrounds/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ r2Key, label }),
    }),
  );
}

/** Soft-deletes one of THIS merchant's own uploaded backgrounds. "Not yours" / "already deleted" / "never existed" all produce the same 404 upstream — same non-enumerability pattern as the job/catalogue routes, not something this client can distinguish either. */
export async function deleteDevBackground(cfg: DevApiConfig, id: string): Promise<{ deleted: true }> {
  return parseOrThrow(await request(cfg, `/v1/dev/backgrounds/${id}`, { method: 'DELETE' }));
}
