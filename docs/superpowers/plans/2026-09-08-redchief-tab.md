# RedChief Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new "RedChief" tab to this bulk-tryon control panel that lets a tester upload 1-6 product-photo "views" of one item and get back 4 AI-generated images from the propicly RedChief multi-view pipeline, via a new, fully-isolated API integration.

**Architecture:** A new `lib/propicly-client.mts` (mirrors `lib/api-client.mts`'s style) talks to the propicly dev API under its own `PROPICLY_API_BASE_URL`/`PROPICLY_API_KEY` env vars. `webapp/server.mts` grows five new `/api/redchief/*` proxy routes that add the bearer key server-side (never shipped to the browser) and otherwise pass requests/responses through close to verbatim. The browser side adds a new nav tab + view section to `webapp/public/index.html`, all new logic in a new `webapp/public/redchief.js` (loaded alongside the existing `app.js`, same plain-global-script convention, no bundler), and a small CSS addition to `webapp/public/style.css` reusing existing component classes.

**Tech Stack:** Node ≥23.4 (works today on 22.23 with an experimental-SQLite warning — unrelated to this feature), TypeScript via `tsx`, zero runtime npm dependencies (built-in `fetch`/`FormData` not even needed here — see JSON/base64 decision in the spec), plain `node:http` server, vanilla JS/HTML/CSS on the client (no framework, no build step).

**Spec:** `docs/superpowers/plans/2026-09-08-redchief-tab-spec.md` — the plan below argues from that spec; read it first, it has the exact field names, error codes, and endpoint paths. Do not invent alternatives to anything in it.

## Global Constraints

- Never modify `DEV_API_BASE_URL`, `DEV_API_KEY`, `lib/api-client.mts`, or the existing bulk try-on flow's behavior — the RedChief integration is fully separate, own env vars, own lib module, own routes.
- Locked env var names: `PROPICLY_API_BASE_URL` (default `https://app.propicly.com`), `PROPICLY_API_KEY` (placeholder `sk_live_...` in `.env.example`, real value supplied by the user after implementation — never ask for it, never hardcode it).
- Zero new npm dependencies. Use Node's built-in `fetch`/`FormData`/`Blob` where needed (mirroring `lib/api-client.mts`); the RedChief job-creation call itself uses JSON/base64, not multipart (see spec's "Why JSON/base64" section) so no multipart parsing is needed anywhere in this repo.
- All new server files/imports use explicit `.mts` extensions, matching every existing import in this repo (e.g. `from '../lib/api-client.mts'`).
- This repo has no test suite (`package.json` has no `test` script, confirmed in `CLAUDE.md`) and `lib/api-client.mts` — the closest sibling to the new client — has none either. Do not introduce a new test-framework convention unilaterally for this one file. Verification is manual: `pnpm exec tsc --noEmit` for type-correctness, plus real (but zero-cost/low-cost) calls against the live propicly host — a bad/missing key returns `401` with no auth and no credits charged, which is safe to hit freely during development; the one paid job (5 credits) happens only in the final task, after the user supplies a real key.
- Follow the existing `webapp/server.mts` convention exactly: one big `if (method && pathname)` dispatch chain in `http.createServer`'s callback, a shared `json()` response helper, no router library, no new files split out of `server.mts` (the repo's own convention keeps all routes in this one file — do not restructure it).
- Follow the existing client convention exactly: `webapp/public/app.js` is a plain classic script (no `type="module"`, no bundler); new client code goes in a new sibling file, `webapp/public/redchief.js`, loaded via its own `<script>` tag after `app.js`. The only edit to `app.js` itself is one line in `setView()` calling into `redchief.js`'s entry point.
- Match existing visual style: reuse `.panel`, `.dropzone`, `.status`/`.status.err`, `.btn-primary`/`.btn-secondary`/`.btn-danger`, `.link-btn`, `.results-table`/`.results-table-wrap`, `.run-banner`, `.hint` classes from `webapp/public/style.css` rather than inventing new component styles; only add the handful of new rules needed for the upload-slot grid and the 2x2 result grid.

---

## File Structure

- **Create:** `lib/propicly-client.mts` — thin fetch client for the propicly dev API's RedChief + generic job endpoints (config, create, get, list, cancel), with its own error class/retry logic, fully independent of `lib/api-client.mts`.
- **Modify:** `.env.example` — add `PROPICLY_API_BASE_URL` (commented default) and `PROPICLY_API_KEY` (placeholder) documentation block.
- **Modify:** `webapp/server.mts` — new imports, new `PROPICLY_BASE_URL`/`PROPICLY_API_KEY`/`propiclyCfg` config consts, a `propiclyErrorResponse()` helper, five new `/api/redchief/*` routes, one new startup log line.
- **Modify:** `webapp/public/index.html` — new nav link, new `<section class="view" data-view="redchief">` markup, new `<script src="/redchief.js">` tag.
- **Modify:** `webapp/public/app.js` — one line in `setView()` to call `window.enterRedchiefView?.()`.
- **Create:** `webapp/public/redchief.js` — all RedChief tab client logic: config load, workflow/slot rendering, client-side validation, job creation, backoff poll loop, result grid rendering (with expiry re-fetch), FAILED display, cancel (from both the in-flight job panel and the recent-jobs table), recent-jobs table.
- **Modify:** `webapp/public/style.css` — new rules for `.redchief-slots`/`.redchief-slot`/`.redchief-dropzone`/`.redchief-slot-preview`/`.redchief-result-grid`/`.redchief-result-cell`.

---

### Task 1: `lib/propicly-client.mts` + env scaffolding

**Files:**
- Create: `lib/propicly-client.mts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `PropiclyApiConfig { baseUrl: string; apiKey: string }`, `PropiclyApiError extends Error { status: number; code: string }`, `RedchiefWorkflow { inputCount: number; viewLabels: string[] }`, `RedchiefConfig { creditCost: number; workflows: RedchiefWorkflow[] }`, `DevJob { jobId: string; status: 'QUEUED'|'RUNNING'|'COMPLETED'|'FAILED'; imageUrl?: string; imageUrls?: string[]; error?: string }`, `JobListItem { jobId: string; kind: 'redchief'|'tryon'|'saree_mannequin'; status: 'QUEUED'|'RUNNING'|'COMPLETED'|'FAILED'; creditsCharged: number; createdAt: string }`, `JobList { page: number; pageSize: number; total: number; jobs: JobListItem[] }`, and functions `getRedchiefConfig(cfg)`, `createRedchiefJob(cfg, views: string[])`, `getJob(cfg, jobId: string)`, `listJobs(cfg, page: number, pageSize: number)`, `cancelJob(cfg, jobId: string)` — all consumed by Task 2.

- [ ] **Step 1: Write `lib/propicly-client.mts`**

```ts
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
```

- [ ] **Step 2: Add the RedChief env block to `.env.example`**

Append after the existing `SUPERADMIN_USERNAME`/`SUPERADMIN_PASSWORD` block:

```
# --- RedChief tab (propicly API) — separate merchant account/env from the
# DEV_API_KEY above, which still targets the old aivastra host for the
# existing bulk try-on flow. Never reuse one for the other. ---

# Base URL for the propicly dev API (RedChief tab only). Defaults to
# https://app.propicly.com in code if unset — only set this to override,
# e.g. http://localhost:4010 for local backend dev.
# PROPICLY_API_BASE_URL=https://app.propicly.com

# Merchant API key for the RedChief endpoints. Mint via the propicly merchant
# portal's Developers page (/developers). SECRET — never commit. Leave this
# as a placeholder until you have a real sk_live_... value; the RedChief tab
# stays disabled (with a clear message) until it's set.
PROPICLY_API_KEY=sk_live_...
```

- [ ] **Step 3: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Zero-cost live verification against the real host**

Create a throwaway script (not committed) to confirm the request/error-parsing logic works end-to-end against the real live server — an invalid key is safe to test with: it returns `401` before any auth/credits logic runs.

```bash
cat > /tmp/redchief-check.mts <<'EOF'
import { getRedchiefConfig, PropiclyApiError } from '/ABSOLUTE/PATH/TO/REPO/lib/propicly-client.mts';

try {
  await getRedchiefConfig({ baseUrl: 'https://app.propicly.com', apiKey: 'sk_live_deliberately_invalid' });
  console.log('UNEXPECTED: call succeeded with an invalid key');
} catch (err) {
  if (err instanceof PropiclyApiError) {
    console.log(`OK: status=${err.status} code=${err.code} message=${err.message}`);
  } else {
    throw err;
  }
}
EOF
pnpm exec tsx /tmp/redchief-check.mts
```

Expected output: `OK: status=401 code=UNAUTHORIZED message=...` (or a very similar 401 body — the exact message text isn't load-bearing, the status/code are). If this instead times out or throws a network error, stop and check connectivity/the base URL before continuing — don't proceed on an unverified client.

Delete the throwaway script afterward — it's not part of the repo.

- [ ] **Step 5: Commit**

```bash
git add lib/propicly-client.mts .env.example
git commit -m "feat: add propicly RedChief API client"
```

---

### Task 2: `webapp/server.mts` proxy routes

**Files:**
- Modify: `webapp/server.mts:24-27` (imports), `webapp/server.mts:53` (config consts, after `POLL_TIMEOUT_MS`), `webapp/server.mts:271` (after the `json()` helper), `webapp/server.mts:1057` (new routes, right before the `serveStatic(res, url.pathname);` fallback), `webapp/server.mts:1070` (startup log)

**Interfaces:**
- Consumes: everything exported from `lib/propicly-client.mts` (Task 1).
- Produces: `GET /api/redchief/config`, `POST /api/redchief`, `GET /api/redchief/jobs`, `GET /api/redchief/jobs/:id`, `POST /api/redchief/jobs/:id/cancel` — all session-authenticated the same way every other `/api/*` route already is (no new auth code needed, the existing `url.pathname.startsWith('/api/')` gate at line 535 already covers these). Consumed by `webapp/public/redchief.js` (Tasks 4-6).

- [ ] **Step 1: Add the import**

In `webapp/server.mts`, right after the existing `scan-input.mts` import:

```ts
import { scanInput, type TryonJobSpec } from '../lib/scan-input.mts';
import {
  PropiclyApiError,
  cancelJob as cancelPropiclyJob,
  createRedchiefJob,
  getJob as getPropiclyJob,
  getRedchiefConfig,
  listJobs as listPropiclyJobs,
  type PropiclyApiConfig,
} from '../lib/propicly-client.mts';
```

- [ ] **Step 2: Add the config consts**

Right after the existing `const POLL_TIMEOUT_MS = ...` line:

```ts
// RedChief tab (propicly API) — a separate merchant account/host from the
// aivastra BASE_URL/API_KEY above. Never reuse those here: the two flows are
// deliberately isolated so one tab's key/env changes can't affect the other.
const PROPICLY_BASE_URL = (process.env.PROPICLY_API_BASE_URL ?? 'https://app.propicly.com').replace(/\/$/, '');
const PROPICLY_API_KEY = process.env.PROPICLY_API_KEY;
const propiclyCfg: PropiclyApiConfig | undefined = PROPICLY_API_KEY ? { baseUrl: PROPICLY_BASE_URL, apiKey: PROPICLY_API_KEY } : undefined;
```

- [ ] **Step 3: Add the error-forwarding helper**

Right after the existing `json()` function:

```ts
/** Forwards a PropiclyApiError's real status/code/message; anything else becomes a 502 so a network blip to the propicly host never looks like this server's own bug. */
function propiclyErrorResponse(res: http.ServerResponse, err: unknown) {
  if (err instanceof PropiclyApiError) {
    json(res, err.status, { error: { code: err.code, message: err.message } });
    return;
  }
  json(res, 502, { error: { code: 'PROXY_ERROR', message: err instanceof Error ? err.message : String(err) } });
}
```

- [ ] **Step 4: Add the five routes**

Right before `serveStatic(res, url.pathname);` (the final line before the catch-all in the request handler):

```ts
    // ---- RedChief (propicly API) — separate tab, separate merchant account ----
    // Discovery probe, like /api/balance above: never throws past a 200, so
    // the tab can show a clear "not configured"/"unreachable" state instead
    // of a broken page when PROPICLY_API_KEY is unset or the host is down.
    if (req.method === 'GET' && url.pathname === '/api/redchief/config') {
      if (!propiclyCfg) {
        json(res, 200, { available: false, error: 'PROPICLY_API_KEY is not set on the server.' });
        return;
      }
      try {
        const config = await getRedchiefConfig(propiclyCfg);
        json(res, 200, { available: true, ...config });
      } catch (err) {
        json(res, 200, { available: false, error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/redchief') {
      if (!propiclyCfg) {
        json(res, 400, { error: { code: 'CONFIG_MISSING', message: 'PROPICLY_API_KEY is not set on the server.' } });
        return;
      }
      let body: Buffer;
      try {
        // 6 views * 10MB * ~1.33 base64 inflation, capped comfortably under
        // the upstream API's own 170MB limit for this endpoint.
        body = await readBodyCapped(req, 90 * 1024 * 1024);
      } catch {
        json(res, 413, { error: { code: 'VALIDATION', message: 'request body too large' } });
        return;
      }
      let parsed: any;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        json(res, 400, { error: { code: 'VALIDATION', message: 'invalid JSON body' } });
        return;
      }
      const views = parsed?.views;
      if (!Array.isArray(views) || views.length < 1 || views.length > 6 || !views.every((v: unknown) => typeof v === 'string' && v.length > 0)) {
        json(res, 400, { error: { code: 'VALIDATION', message: 'views must be an array of 1-6 base64/data-URI image strings' } });
        return;
      }
      try {
        const result = await createRedchiefJob(propiclyCfg, views);
        json(res, 202, result);
      } catch (err) {
        propiclyErrorResponse(res, err);
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/redchief/jobs') {
      if (!propiclyCfg) {
        json(res, 400, { error: { code: 'CONFIG_MISSING', message: 'PROPICLY_API_KEY is not set on the server.' } });
        return;
      }
      const page = Number(url.searchParams.get('page') ?? 1);
      const pageSize = Number(url.searchParams.get('pageSize') ?? 25);
      try {
        const list = await listPropiclyJobs(propiclyCfg, page, pageSize);
        json(res, 200, list);
      } catch (err) {
        propiclyErrorResponse(res, err);
      }
      return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/redchief/jobs/') && url.pathname.endsWith('/cancel')) {
      if (!propiclyCfg) {
        json(res, 400, { error: { code: 'CONFIG_MISSING', message: 'PROPICLY_API_KEY is not set on the server.' } });
        return;
      }
      const jobId = decodeURIComponent(url.pathname.slice('/api/redchief/jobs/'.length, -'/cancel'.length));
      if (!/^[\w-]{1,80}$/.test(jobId)) {
        json(res, 400, { error: { code: 'VALIDATION', message: 'invalid job id' } });
        return;
      }
      try {
        const result = await cancelPropiclyJob(propiclyCfg, jobId);
        json(res, 200, result);
      } catch (err) {
        propiclyErrorResponse(res, err);
      }
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/redchief/jobs/')) {
      if (!propiclyCfg) {
        json(res, 400, { error: { code: 'CONFIG_MISSING', message: 'PROPICLY_API_KEY is not set on the server.' } });
        return;
      }
      const jobId = decodeURIComponent(url.pathname.slice('/api/redchief/jobs/'.length));
      if (!/^[\w-]{1,80}$/.test(jobId)) {
        json(res, 400, { error: { code: 'VALIDATION', message: 'invalid job id' } });
        return;
      }
      try {
        const job = await getPropiclyJob(propiclyCfg, jobId);
        json(res, 200, job);
      } catch (err) {
        propiclyErrorResponse(res, err);
      }
      return;
    }

    serveStatic(res, url.pathname);
```

- [ ] **Step 5: Add the startup log line**

Right after the existing `if (!cfg) console.log(...)` line in the `server.listen` callback:

```ts
  if (!propiclyCfg) console.log('  (PROPICLY_API_KEY not set — RedChief tab disabled)');
```

- [ ] **Step 6: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Manual verification — no key set**

```bash
pnpm web &
sleep 2
# log in and keep the session cookie
curl -s -c /tmp/rc-cookies.txt -X POST http://localhost:5959/api/auth/login \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"Digitals@2025"}'
curl -s -b /tmp/rc-cookies.txt http://localhost:5959/api/redchief/config
curl -s -b /tmp/rc-cookies.txt http://localhost:5959/api/redchief/jobs
kill %1
```
Expected: `/api/redchief/config` → `{"available":false,"error":"PROPICLY_API_KEY is not set on the server."}`; `/api/redchief/jobs` → 400 with `{"error":{"code":"CONFIG_MISSING",...}}`.

- [ ] **Step 8: Manual verification — bogus key set (real live 401, zero cost)**

Temporarily add `PROPICLY_API_KEY=sk_live_deliberately_invalid` to `.env` (leave `PROPICLY_API_BASE_URL` unset so it defaults to the real `https://app.propicly.com`), restart the server, repeat the `/api/redchief/config` curl from Step 7.
Expected: `{"available":false,"error":"..."}` where the error text reflects a real 401/unauthorized response from the live host (proves the proxy is actually reaching `https://app.propicly.com`, not just a local stub). Also `curl -s -b /tmp/rc-cookies.txt -X POST http://localhost:5959/api/redchief -H 'Content-Type: application/json' -d '{"views":["data:image/png;base64,iVBORw0KGgo="]}'` should return `401` with `{"error":{"code":"UNAUTHORIZED",...}}` forwarded through `propiclyErrorResponse`.
Leave the bogus key in `.env` for now — it's needed for Tasks 4-6's error-path verification too — but never commit `.env` (it's gitignored).

- [ ] **Step 9: Commit**

```bash
git add webapp/server.mts
git commit -m "feat: proxy RedChief endpoints through the web server"
```

---

### Task 3: HTML scaffold + nav entry

**Files:**
- Modify: `webapp/public/index.html:22-23` (nav link), `webapp/public/index.html:261-262` (new view section, after the Users view), `webapp/public/index.html:292` (script tag)
- Create: `webapp/public/redchief.js` (stub only — Task 4 fills in the real logic)

**Interfaces:**
- Produces: DOM element ids consumed by `redchief.js` in Tasks 4-6: `redchief-config-loading`, `redchief-config-error`, `redchief-config-body`, `redchief-credit-cost`, `redchief-workflow-select`, `redchief-upload-panel`, `redchief-slots`, `redchief-upload-status`, `redchief-generate-btn`, `redchief-job-panel`, `redchief-job-banner`, `redchief-result-grid`, `redchief-jobs-tbody`, `redchief-jobs-refresh-btn`. A global function `window.enterRedchiefView` (stubbed here, implemented in Task 4).

- [ ] **Step 1: Add the nav link**

In `webapp/public/index.html`, between the existing Results and Users nav links:

```html
        <a href="#results" class="nav-link" data-view="results"><span class="nav-icon">📁</span>Results</a>
        <a href="#redchief" class="nav-link" data-view="redchief"><span class="nav-icon">📦</span>RedChief</a>
        <a href="#users" class="nav-link" data-view="users" id="nav-users-link" hidden><span class="nav-icon">👥</span>Users</a>
```

- [ ] **Step 2: Add the view section**

Right after the closing `</section>` of the Users view (`data-view="users"`), before the `</div>` that closes `.content`:

```html
      <!-- ============ REDCHIEF VIEW ============ -->
      <section class="view" data-view="redchief" hidden>
        <header class="view-header">
          <h1>RedChief</h1>
          <p class="subtitle">Upload every view of one product and generate 4 AI images from the RedChief multi-view pipeline.</p>
        </header>

        <section class="panel" id="redchief-config-panel">
          <div id="redchief-config-loading">Loading RedChief configuration…</div>
          <div class="status err" id="redchief-config-error" hidden></div>
          <div id="redchief-config-body" hidden>
            <div class="plan-head">
              <div>
                <h2>📦 Choose a workflow</h2>
                <p class="hint">Costs <strong id="redchief-credit-cost">–</strong> credits per job, however many views you submit.</p>
              </div>
              <label>Views
                <select id="redchief-workflow-select"></select>
              </label>
            </div>
          </div>
        </section>

        <section class="panel" id="redchief-upload-panel" hidden>
          <h2>🖼️ Upload views</h2>
          <p class="hint">One photo per slot, in order — each slot is matched to a specific view of the item.</p>
          <div class="redchief-slots" id="redchief-slots"></div>
          <div class="status" id="redchief-upload-status"></div>
          <button id="redchief-generate-btn" class="btn-primary" disabled>Generate</button>
        </section>

        <section class="panel" id="redchief-job-panel" hidden>
          <h2>⏳ Current job</h2>
          <div class="run-banner" id="redchief-job-banner"></div>
          <div class="redchief-result-grid" id="redchief-result-grid" hidden></div>
        </section>

        <section class="panel">
          <div class="plan-head">
            <h2>🗂️ Recent RedChief jobs</h2>
            <button type="button" class="btn-secondary btn-small" id="redchief-jobs-refresh-btn">Refresh</button>
          </div>
          <div class="results-table-wrap">
            <table class="results-table">
              <thead>
                <tr>
                  <th>Job ID</th>
                  <th>Status</th>
                  <th>Credits</th>
                  <th>Created</th>
                  <th></th>
                </tr>
              </thead>
              <tbody id="redchief-jobs-tbody">
                <tr><td colspan="5" class="empty">Loading…</td></tr>
              </tbody>
            </table>
          </div>
        </section>
      </section>
```

- [ ] **Step 3: Add the script tag**

```html
  <script src="/app.js"></script>
  <script src="/redchief.js"></script>
</body>
```

- [ ] **Step 4: Create the `redchief.js` stub**

```js
// Stub — Task 4 replaces this with the real RedChief tab logic.
window.enterRedchiefView = function enterRedchiefView() {
  console.log('[redchief] tab entered (stub)');
};
```

- [ ] **Step 5: Add the router hook in `app.js`**

In `webapp/public/app.js`'s `setView()`, right after the existing `if (target === 'users') loadUsers();` line:

```js
  if (target === 'redchief') window.enterRedchiefView?.();
```

- [ ] **Step 6: Browser verification**

Start the server (`pnpm web`), log in, click the new "RedChief" nav link (or navigate to `#redchief`). Confirm: the tab becomes active/highlighted, the RedChief view section shows (config-loading text visible), the browser console shows `[redchief] tab entered (stub)`, and no console errors. Confirm switching to Upload/Results/Users and back still works unchanged.

- [ ] **Step 7: Commit**

```bash
git add webapp/public/index.html webapp/public/app.js webapp/public/redchief.js
git commit -m "feat: scaffold RedChief tab (nav, view markup, stub script)"
```

---

### Task 4: Config load, workflow selection, upload slots, job creation

**Files:**
- Modify: `webapp/public/redchief.js` (replace the Task 3 stub entirely)

**Interfaces:**
- Consumes: `GET /api/redchief/config`, `POST /api/redchief` (Task 2). DOM ids from Task 3.
- Produces: `redchiefWorkflows`, `redchiefCreditCost`, `redchiefSlotFiles` module-level state and a `startRedchiefJob(jobId)` function — consumed by Task 5 (poll loop) and Task 6 (recent-jobs "View result" action).

- [ ] **Step 1: Write the config-load and slot-rendering logic**

```js
// ---------- RedChief tab ----------
const redchiefConfigLoadingEl = document.getElementById('redchief-config-loading');
const redchiefConfigErrorEl = document.getElementById('redchief-config-error');
const redchiefConfigBodyEl = document.getElementById('redchief-config-body');
const redchiefCreditCostEl = document.getElementById('redchief-credit-cost');
const redchiefWorkflowSelectEl = document.getElementById('redchief-workflow-select');
const redchiefUploadPanelEl = document.getElementById('redchief-upload-panel');
const redchiefSlotsEl = document.getElementById('redchief-slots');
const redchiefUploadStatusEl = document.getElementById('redchief-upload-status');
const redchiefGenerateBtn = document.getElementById('redchief-generate-btn');
const redchiefJobPanelEl = document.getElementById('redchief-job-panel');
const redchiefJobBannerEl = document.getElementById('redchief-job-banner');
const redchiefResultGridEl = document.getElementById('redchief-result-grid');

let redchiefWorkflows = [];
let redchiefCreditCost = 0;
let redchiefSlotFiles = [];
let redchiefLoaded = false;

const REDCHIEF_MAX_MB = 10;
const REDCHIEF_ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

window.enterRedchiefView = async function enterRedchiefView() {
  if (!redchiefLoaded) await loadRedchiefConfig();
  loadRedchiefJobs();
};

async function loadRedchiefConfig() {
  redchiefConfigLoadingEl.hidden = false;
  redchiefConfigErrorEl.hidden = true;
  redchiefConfigBodyEl.hidden = true;
  redchiefUploadPanelEl.hidden = true;
  try {
    const res = await fetch('/api/redchief/config');
    const body = await res.json();
    if (!res.ok || body.available === false) {
      throw new Error(body.error || 'RedChief config unavailable.');
    }
    if (!Array.isArray(body.workflows) || body.workflows.length === 0) {
      throw new Error('No active RedChief workflow is configured. Ask an admin to activate one.');
    }
    redchiefWorkflows = body.workflows;
    redchiefCreditCost = body.creditCost;
    redchiefLoaded = true;
    renderRedchiefWorkflowOptions();
    redchiefConfigLoadingEl.hidden = true;
    redchiefConfigBodyEl.hidden = false;
  } catch (err) {
    redchiefConfigLoadingEl.hidden = true;
    redchiefConfigErrorEl.hidden = false;
    redchiefConfigErrorEl.textContent = err instanceof Error ? err.message : String(err);
  }
}

function renderRedchiefWorkflowOptions() {
  redchiefCreditCostEl.textContent = String(redchiefCreditCost);
  redchiefWorkflowSelectEl.innerHTML = redchiefWorkflows
    .map((w, i) => `<option value="${i}">${w.inputCount} views (${w.viewLabels.join(', ')})</option>`)
    .join('');
  redchiefWorkflowSelectEl.value = '0';
  renderRedchiefSlots();
}

redchiefWorkflowSelectEl.addEventListener('change', renderRedchiefSlots);

function renderRedchiefSlots() {
  const workflow = redchiefWorkflows[Number(redchiefWorkflowSelectEl.value)];
  if (!workflow) return;
  redchiefSlotFiles = new Array(workflow.inputCount).fill(null);
  redchiefSlotsEl.innerHTML = workflow.viewLabels
    .map(
      (label, i) => `
    <div class="redchief-slot" data-slot="${i}">
      <div class="redchief-slot-label">${label}</div>
      <div class="dropzone redchief-dropzone" data-slot="${i}" tabindex="0">
        <input type="file" class="redchief-slot-input" data-slot="${i}" accept="image/*" hidden />
        <span class="icon">⬆</span>
        <span>Click or drag a photo</span>
      </div>
      <img class="redchief-slot-preview" data-slot="${i}" hidden />
      <button type="button" class="link-btn danger redchief-slot-clear" data-slot="${i}" hidden>Clear</button>
    </div>`,
    )
    .join('');
  redchiefUploadPanelEl.hidden = false;
  redchiefUploadStatusEl.textContent = '';
  wireRedchiefSlotEvents();
  updateRedchiefGenerateEnabled();
}

function wireRedchiefSlotEvents() {
  for (const dz of redchiefSlotsEl.querySelectorAll('.redchief-dropzone')) {
    const slot = Number(dz.dataset.slot);
    const input = redchiefSlotsEl.querySelector(`.redchief-slot-input[data-slot="${slot}"]`);
    dz.addEventListener('click', () => input.click());
    dz.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') input.click();
    });
    dz.addEventListener('dragover', (e) => e.preventDefault());
    dz.addEventListener('drop', (e) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file) setRedchiefSlotFile(slot, file);
    });
    input.addEventListener('change', () => {
      const file = input.files[0];
      if (file) setRedchiefSlotFile(slot, file);
      input.value = '';
    });
  }
  for (const btn of redchiefSlotsEl.querySelectorAll('.redchief-slot-clear')) {
    btn.addEventListener('click', () => clearRedchiefSlot(Number(btn.dataset.slot)));
  }
}

function setRedchiefSlotFile(slot, file) {
  if (!REDCHIEF_ACCEPTED_TYPES.has(file.type)) {
    redchiefUploadStatusEl.textContent = `${file.name}: only JPEG, PNG, or WebP images are accepted.`;
    return;
  }
  redchiefUploadStatusEl.textContent =
    file.size > REDCHIEF_MAX_MB * 1024 * 1024 ? `${file.name}: over ${REDCHIEF_MAX_MB}MB — the server may reject this, but you can still try.` : '';
  redchiefSlotFiles[slot] = file;
  const preview = redchiefSlotsEl.querySelector(`.redchief-slot-preview[data-slot="${slot}"]`);
  const clearBtn = redchiefSlotsEl.querySelector(`.redchief-slot-clear[data-slot="${slot}"]`);
  preview.src = URL.createObjectURL(file);
  preview.hidden = false;
  clearBtn.hidden = false;
  updateRedchiefGenerateEnabled();
}

function clearRedchiefSlot(slot) {
  redchiefSlotFiles[slot] = null;
  const preview = redchiefSlotsEl.querySelector(`.redchief-slot-preview[data-slot="${slot}"]`);
  const clearBtn = redchiefSlotsEl.querySelector(`.redchief-slot-clear[data-slot="${slot}"]`);
  preview.hidden = true;
  preview.src = '';
  clearBtn.hidden = true;
  updateRedchiefGenerateEnabled();
}

function updateRedchiefGenerateEnabled() {
  redchiefGenerateBtn.disabled = redchiefSlotFiles.length === 0 || redchiefSlotFiles.some((f) => f === null);
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

redchiefGenerateBtn.addEventListener('click', async () => {
  redchiefGenerateBtn.disabled = true;
  redchiefUploadStatusEl.textContent = 'Encoding images…';
  try {
    const views = await Promise.all(redchiefSlotFiles.map(fileToDataUrl));
    redchiefUploadStatusEl.textContent = 'Submitting job…';
    const res = await fetch('/api/redchief', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ views }),
    });
    const body = await res.json();
    if (!res.ok) {
      throw new Error(`${body.error?.code ?? res.status}: ${body.error?.message ?? 'request failed'}`);
    }
    redchiefUploadStatusEl.textContent = '';
    startRedchiefJob(body.jobId);
  } catch (err) {
    redchiefUploadStatusEl.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    updateRedchiefGenerateEnabled();
  }
});

// startRedchiefJob is completed in Task 5 (poll loop + result rendering).
// Defined here as a forward reference so Task 4's Generate handler compiles
// and runs standalone before Task 5 lands.
function startRedchiefJob(jobId) {
  redchiefJobPanelEl.hidden = false;
  redchiefResultGridEl.hidden = true;
  redchiefResultGridEl.innerHTML = '';
  redchiefJobBannerEl.hidden = false;
  redchiefJobBannerEl.textContent = `Job ${jobId}: QUEUED (polling not wired up yet — Task 5)`;
}
```

- [ ] **Step 2: Verify the error path (real live call, zero cost)**

With the bogus `PROPICLY_API_KEY=sk_live_deliberately_invalid` still in `.env` from Task 2, restart `pnpm web`, open the RedChief tab in a browser. Expected: the config panel shows the red error text (the real 401 message from `https://app.propicly.com`), the upload panel stays hidden, no uncaught exceptions in the console. This exercises the full chain (browser → `/api/redchief/config` → live propicly host → error rendering) for real, at zero cost.

Note: full slot-rendering/Generate-button verification needs a *valid* key (workflows only come back non-empty with real auth) — that happens in Task 8's end-to-end pass once the user supplies one. Don't block on it here; the error-path check above is sufficient proof this task's code is wired correctly.

- [ ] **Step 3: Commit**

```bash
git add webapp/public/redchief.js
git commit -m "feat: RedChief config load, upload slots, and job creation"
```

---

### Task 5: Poll loop, result grid, FAILED display, in-flight cancel

**Files:**
- Modify: `webapp/public/redchief.js` (replace Task 4's placeholder `startRedchiefJob`, add polling/result/cancel functions)

**Interfaces:**
- Consumes: `GET /api/redchief/jobs/:id`, `POST /api/redchief/jobs/:id/cancel` (Task 2). `redchiefJobPanelEl`/`redchiefJobBannerEl`/`redchiefResultGridEl` (Task 3/4).
- Produces: `startRedchiefJob(jobId)` (final version — replaces Task 4's placeholder, also used by Task 6's "View result"), `pollRedchiefJob(jobId, attempt, delayMs)`, `cancelRedchiefJob(jobId)`.

- [ ] **Step 1: Replace the placeholder `startRedchiefJob` and add polling/result/cancel logic**

Remove the placeholder `startRedchiefJob` function from Task 4 and replace it with:

```js
let redchiefPollTimer = null;
const redchiefRetriedJobs = new Set(); // one auto-retry per job on an expired image URL, never a retry loop

function startRedchiefJob(jobId) {
  redchiefJobPanelEl.hidden = false;
  redchiefResultGridEl.hidden = true;
  redchiefResultGridEl.innerHTML = '';
  redchiefJobBannerEl.hidden = false;
  redchiefJobBannerEl.textContent = 'Loading job status…';
  clearTimeout(redchiefPollTimer);
  pollRedchiefJob(jobId);
}

function renderRedchiefJobBanner(job) {
  const cancelBtn =
    job.status === 'QUEUED' ? `<button type="button" class="btn-secondary btn-small" id="redchief-cancel-btn">Cancel</button>` : '';
  redchiefJobBannerEl.hidden = false;
  redchiefJobBannerEl.innerHTML = `<span>Job <code>${job.jobId}</code>: <strong>${job.status}</strong></span>${cancelBtn}`;
  document.getElementById('redchief-cancel-btn')?.addEventListener('click', () => cancelRedchiefJob(job.jobId));
}

async function pollRedchiefJob(jobId, attempt = 0, delayMs = 2000) {
  const maxAttempts = 20;
  const maxDelayMs = 20000;

  let job;
  try {
    const res = await fetch(`/api/redchief/jobs/${jobId}`);
    job = await res.json();
    if (!res.ok) throw new Error(`${job.error?.code ?? res.status}: ${job.error?.message ?? 'poll failed'}`);
  } catch (err) {
    redchiefJobBannerEl.innerHTML = `<span>Job <code>${jobId}</code>: <strong>error polling status</strong> — ${
      err instanceof Error ? err.message : String(err)
    }</span>`;
    return;
  }

  if (job.status === 'COMPLETED') {
    renderRedchiefJobBanner(job);
    renderRedchiefResult(job);
    loadRedchiefJobs();
    return;
  }
  if (job.status === 'FAILED') {
    redchiefJobBannerEl.hidden = false;
    redchiefJobBannerEl.innerHTML = `<span>Job <code>${job.jobId}</code>: <strong>FAILED</strong> — ${job.error ?? 'unknown error'}</span>`;
    loadRedchiefJobs();
    return;
  }

  renderRedchiefJobBanner(job);
  if (attempt >= maxAttempts) {
    redchiefJobBannerEl.innerHTML += ' <span class="hint">Still processing — check back later or refresh the jobs table below.</span>';
    return;
  }
  redchiefPollTimer = setTimeout(() => pollRedchiefJob(jobId, attempt + 1, Math.min(delayMs * 1.5, maxDelayMs)), delayMs);
}

function renderRedchiefResult(job) {
  const urls = job.imageUrls ?? (job.imageUrl ? [job.imageUrl] : []);
  redchiefResultGridEl.hidden = false;
  redchiefResultGridEl.innerHTML = urls
    .map(
      (url, i) => `
    <div class="redchief-result-cell">
      <img src="${url}" alt="Result ${i + 1}" data-job="${job.jobId}" />
      <a href="${url}" target="_blank" rel="noopener" class="link-btn">Open</a>
    </div>`,
    )
    .join('');
  for (const img of redchiefResultGridEl.querySelectorAll('img')) {
    img.addEventListener('error', () => refreshExpiredRedchiefResult(img.dataset.job));
  }
}

async function refreshExpiredRedchiefResult(jobId) {
  if (redchiefRetriedJobs.has(jobId)) return;
  redchiefRetriedJobs.add(jobId);
  try {
    const res = await fetch(`/api/redchief/jobs/${jobId}`);
    const job = await res.json();
    if (res.ok && job.status === 'COMPLETED') renderRedchiefResult(job);
  } catch {
    // best-effort — leave the broken thumbnail if this also fails
  }
}

async function cancelRedchiefJob(jobId) {
  try {
    const res = await fetch(`/api/redchief/jobs/${jobId}/cancel`, { method: 'POST' });
    const body = await res.json();
    if (!res.ok) throw new Error(`${body.error?.code ?? res.status}: ${body.error?.message ?? 'cancel failed'}`);
    clearTimeout(redchiefPollTimer);
    redchiefJobBannerEl.innerHTML = `<span>Job <code>${jobId}</code>: <strong>CANCELLED</strong> — ${body.creditsRefunded} credit(s) refunded.</span>`;
    loadRedchiefJobs();
  } catch (err) {
    // A 409 CONFLICT here means it's already RUNNING/COMPLETED/FAILED — show
    // that plainly rather than a generic failure (spec requirement).
    redchiefJobBannerEl.innerHTML += `<div class="status err">${err instanceof Error ? err.message : String(err)}</div>`;
  }
}
```

- [ ] **Step 2: Type/lint sanity pass**

Run: `pnpm exec tsc --noEmit` (this repo has no separate JS lint step; `redchief.js` is plain JS and isn't type-checked, but this confirms the `.mts` files touched so far still compile). Open the browser console on the RedChief tab and confirm no syntax errors on page load (a stray syntax error in `redchief.js` would show as a console error immediately).

- [ ] **Step 3: Commit**

```bash
git add webapp/public/redchief.js
git commit -m "feat: RedChief poll loop, result grid, and cancel"
```

---

### Task 6: Recent RedChief jobs table

**Files:**
- Modify: `webapp/public/redchief.js` (add `loadRedchiefJobs`, wire the refresh button)

**Interfaces:**
- Consumes: `GET /api/redchief/jobs` (Task 2), `startRedchiefJob(jobId)` and `cancelRedchiefJob(jobId)` (Task 5).
- Produces: `loadRedchiefJobs()` — already called from `enterRedchiefView()` (Task 4) and from `pollRedchiefJob`/`cancelRedchiefJob` (Task 5) on every state change, so the table stays current without a manual refresh in the common case.

- [ ] **Step 1: Add the jobs-table logic**

```js
const redchiefJobsTbodyEl = document.getElementById('redchief-jobs-tbody');
const redchiefJobsRefreshBtn = document.getElementById('redchief-jobs-refresh-btn');

async function loadRedchiefJobs() {
  redchiefJobsTbodyEl.innerHTML = '<tr><td colspan="5" class="empty">Loading…</td></tr>';
  try {
    const res = await fetch('/api/redchief/jobs?page=1&pageSize=25');
    const body = await res.json();
    if (!res.ok) throw new Error(`${body.error?.code ?? res.status}: ${body.error?.message ?? 'failed to load jobs'}`);
    const rows = (body.jobs ?? []).filter((j) => j.kind === 'redchief');
    redchiefJobsTbodyEl.innerHTML = rows.length
      ? rows.map(redchiefJobRowHtml).join('')
      : '<tr><td colspan="5" class="empty">No RedChief jobs yet.</td></tr>';
    for (const btn of redchiefJobsTbodyEl.querySelectorAll('.redchief-view-btn')) {
      btn.addEventListener('click', () => startRedchiefJob(btn.dataset.jobid));
    }
    for (const btn of redchiefJobsTbodyEl.querySelectorAll('.redchief-cancel-row-btn')) {
      btn.addEventListener('click', () => cancelRedchiefJob(btn.dataset.jobid).then(loadRedchiefJobs));
    }
  } catch (err) {
    redchiefJobsTbodyEl.innerHTML = `<tr><td colspan="5" class="empty">${err instanceof Error ? err.message : String(err)}</td></tr>`;
  }
}

function redchiefJobRowHtml(j) {
  const cancelBtn =
    j.status === 'QUEUED'
      ? `<button type="button" class="btn-danger btn-small redchief-cancel-row-btn" data-jobid="${j.jobId}">Cancel</button>`
      : '';
  return `
    <tr>
      <td><code>${j.jobId.slice(0, 8)}…</code></td>
      <td>${j.status}</td>
      <td>${j.creditsCharged}</td>
      <td>${new Date(j.createdAt).toLocaleString()}</td>
      <td>
        <button type="button" class="btn-secondary btn-small redchief-view-btn" data-jobid="${j.jobId}">View result</button>
        ${cancelBtn}
      </td>
    </tr>`;
}

redchiefJobsRefreshBtn.addEventListener('click', loadRedchiefJobs);
```

- [ ] **Step 2: Verify the error path (real live call, zero cost)**

With the bogus key still set, open the RedChief tab. The "Recent RedChief jobs" table should show the error message (from the 400 `CONFIG_MISSING` or forwarded upstream error) in its empty-state row, not hang on "Loading…" or throw a console error. Click "Refresh" and confirm it re-runs cleanly.

- [ ] **Step 3: Commit**

```bash
git add webapp/public/redchief.js
git commit -m "feat: RedChief recent-jobs table with view/cancel actions"
```

---

### Task 7: Styling pass

**Files:**
- Modify: `webapp/public/style.css` (append new rules; no existing rules change)

**Interfaces:**
- Consumes: class names referenced by the markup written in Tasks 3-6 (`redchief-slots`, `redchief-slot`, `redchief-slot-label`, `redchief-dropzone`, `redchief-slot-preview`, `redchief-result-grid`, `redchief-result-cell`).

- [ ] **Step 1: Append the new rules**

At the end of `webapp/public/style.css`:

```css
/* ---------- RedChief tab ---------- */
.redchief-slots { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 16px; margin-top: 10px; }
.redchief-slot { display: flex; flex-direction: column; gap: 8px; align-items: center; }
.redchief-slot-label { font-size: 0.82rem; font-weight: 650; color: var(--muted); }
.redchief-dropzone { width: 100%; min-height: 120px; flex-direction: column; }
.redchief-slot-preview { width: 100%; height: 120px; object-fit: cover; border-radius: 10px; border: 1px solid var(--border); }

.redchief-result-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; margin-top: 14px; }
.redchief-result-cell { display: flex; flex-direction: column; gap: 6px; align-items: center; }
.redchief-result-cell img { width: 100%; border-radius: 10px; border: 1px solid var(--border); }
```

- [ ] **Step 2: Browser verification**

With a workflow's slots rendered (even against the bogus-key error state, you can temporarily hand-set `redchiefWorkflows`/call `renderRedchiefWorkflowOptions()` from the browser console to sanity-check layout without a real key), confirm the slot grid wraps sensibly at different window widths and matches the visual weight of the existing Upload tab's dropzones. Confirm no other tab's layout shifted (diff `style.css` — only additions, nothing edited).

- [ ] **Step 3: Commit**

```bash
git add webapp/public/style.css
git commit -m "style: RedChief tab layout"
```

---

### Task 8: End-to-end verification with a real key

**Files:** none (verification-only; revert the bogus test key from `.env` first)

**Interfaces:** none — this task exercises the full stack built in Tasks 1-7.

- [ ] **Step 1: Get the real key in place**

Once the user has dropped their real `sk_live_...` merchant key into `.env` as `PROPICLY_API_KEY` (and set `PROPICLY_API_BASE_URL` only if they need something other than the `https://app.propicly.com` default — e.g. a local backend dev server), restart `pnpm web`.

- [ ] **Step 2: Confirm config loads for real**

Open the RedChief tab. Expected: the config panel shows the real workflow(s) and credit cost from the merchant account (no more error text), the workflow selector is populated, and choosing a workflow renders the right number of correctly-labeled upload slots.

- [ ] **Step 3: One real, low-cost job end-to-end**

Per `CLAUDE.md`'s "don't test by actually running jobs against production unless necessary and low-cost" — this is that necessary, low-cost case (this feature cannot be verified any other way). Upload one photo per slot for the smallest available workflow, click Generate, and confirm:
- The job panel shows QUEUED → RUNNING → COMPLETED (or FAILED, if the account/workflow genuinely can't produce a result — either outcome proves the wiring works).
- On COMPLETED, all 4 images render in the 2x2 grid and each "Open" link works.
- The "Recent RedChief jobs" table shows the new job with the correct `creditsCharged`.

Report back to the user afterward exactly what happened (per `CLAUDE.md`'s "report honestly" rule) — including that this spent real credits.

- [ ] **Step 4: Cancel path**

Start a second job, and — quickly, before it leaves `QUEUED` — click Cancel (either from the in-flight job panel or the recent-jobs row). Expected: `{"ok":true,"creditsRefunded":N}` and the UI reflects CANCELLED with the refunded amount. If the job transitions to RUNNING before Cancel is clicked, expected instead is the plain "too late to cancel, already processing" message from the `409 CONFLICT` path — either outcome is an acceptable proof of the cancel wiring; note which one occurred.

- [ ] **Step 5: Commit**

No code changes in this task, so nothing to commit unless Step 2-4 surfaced a bug — if so, fix it, verify again, and commit that fix with a message describing what was wrong (e.g. `fix: RedChief result grid didn't handle a 3-view workflow's short imageUrls array`).

---

---

## Addendum: Task 9 — Folder upload with automatic view detection

Added after Tasks 1-8 shipped and were merged into review, per a direct user
request: RedChief currently only supports one-file-per-slot manual upload;
the tester should be able to drop/choose a whole folder of one item's photos
and have them auto-assigned to the right slot by filename, the same way the
existing Upload tab already supports whole-folder uploads for people/garments
(see `webapp/public/app.js`'s `wireDropzone`/`wireFolderPicker`/
`filesFromDataTransferItems`/`collectFilesFromEntry`/`isImageFile`/
`filterImageFiles` — all global functions in that classic script, directly
callable from `redchief.js` since both share one page-global scope).

**Design decision (ruled by the controller, confirmed reasonable given no
real example filenames were available to test against): a conservative,
transparent match-or-leave-blank heuristic — never guess a slot assignment
with zero evidence, since a wrong slot silently produces a bad paid job.**
Score each (view label, filename) pair by counting how many of the label's
own significant words (lowercased, non-alphanumeric-split, with generic
words like "view"/"side" stripped) appear as whole tokens in the filename;
greedily assign the highest-scoring pairs first; any slot with no
positive-scoring file stays empty for the tester to fill by hand, and any
leftover unmatched files are simply not used. Report the match count
plainly so the tester knows what still needs manual attention before
Generate is even enabled.

### Task 9: Folder upload with automatic view detection

**Files:**
- Modify: `webapp/public/index.html` (new folder-dropzone markup inside `#redchief-upload-panel`)
- Modify: `webapp/public/redchief.js` (new matching/wiring logic)

**Interfaces:**
- Consumes: `wireDropzone(dropzoneEl, inputEl, onFiles, statusEl)` and `filesFromDataTransferItems` (indirectly, via `wireDropzone`'s own drop handler) — both globals already defined in `webapp/public/app.js`, loaded before `redchief.js`. Also consumes existing RedChief module state/functions: `redchiefWorkflows`, `redchiefWorkflowSelectEl`, `redchiefSlotFiles`, `setRedchiefSlotFile(slot, file)`, `clearRedchiefSlot(slot)`, `redchiefUploadStatusEl`.
- Produces: nothing new consumed by later tasks — this is the final addition to the feature.

- [ ] **Step 1: Add the folder-dropzone markup**

In `webapp/public/index.html`, inside `#redchief-upload-panel`, right after its `<p class="hint">` line and before `<div class="redchief-slots" id="redchief-slots"></div>`:

```html
          <div class="upload-row">
            <div class="dropzone" id="redchief-folder-dropzone" tabindex="0">
              <input type="file" id="redchief-folder-input" webkitdirectory multiple hidden />
              <span class="icon">⬆</span>
              <span>Drag a whole folder of this item's photos here, or click to choose one — views are matched to slots automatically by filename</span>
            </div>
          </div>
```

- [ ] **Step 2: Add the matching/wiring logic to `redchief.js`**

Append this block right after the existing `updateRedchiefGenerateEnabled()` function definition (before the `resetRedchiefSlots`/confirm-panel code that follows it):

```js
// ---------- folder upload with automatic view detection ----------
const redchiefFolderDropzoneEl = document.getElementById('redchief-folder-dropzone');
const redchiefFolderInputEl = document.getElementById('redchief-folder-input');

// Stripped before matching so they never count as a "match" on their own —
// every real viewLabel already ends in one of these (e.g. "Left Side View"),
// so without stripping them a file named "photo.jpg" would spuriously score
// against every label's "view" token at once.
const REDCHIEF_GENERIC_WORDS = new Set(['view', 'side', 'photo', 'image', 'img']);

function redchiefWords(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 1 && !REDCHIEF_GENERIC_WORDS.has(w));
}

// Score = how many of the label's own significant words also appear, as
// whole tokens, in the filename. E.g. label "Tip Front Side View" has
// significant words ["tip","front"]: a file "tip-front-01.jpg" scores 2, a
// file "front-only.jpg" scores 1, a file "left.jpg" scores 0.
function redchiefMatchScore(label, filename) {
  const labelWords = new Set(redchiefWords(label));
  const fileWords = new Set(redchiefWords(filename.replace(/\.[^.]+$/, '')));
  let score = 0;
  for (const w of labelWords) if (fileWords.has(w)) score++;
  return score;
}

// Greedy best-match assignment across every (slot, file) pair: score them
// all, then repeatedly take the highest-scoring still-available pair. A
// slot with no positive-scoring file is left null (never guess with zero
// evidence — a wrong slot silently produces a bad paid job).
function redchiefAutoMatchFiles(viewLabels, files) {
  const pairs = [];
  for (let slot = 0; slot < viewLabels.length; slot++) {
    for (let f = 0; f < files.length; f++) {
      const score = redchiefMatchScore(viewLabels[slot], files[f].name);
      if (score > 0) pairs.push({ slot, f, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const usedSlots = new Set();
  const usedFiles = new Set();
  const assignment = new Array(viewLabels.length).fill(null);
  for (const { slot, f } of pairs) {
    if (usedSlots.has(slot) || usedFiles.has(f)) continue;
    assignment[slot] = files[f];
    usedSlots.add(slot);
    usedFiles.add(f);
  }
  return assignment;
}

function handleRedchiefFolderFiles(files) {
  const workflow = redchiefWorkflows[Number(redchiefWorkflowSelectEl.value)];
  if (!workflow) return;
  if (files.length === 0) {
    redchiefUploadStatusEl.textContent = 'No image files found in that folder (looked for .jpg/.jpeg/.png/.webp).';
    redchiefUploadStatusEl.className = 'status err';
    return;
  }
  // A folder drop represents "here is the complete set of views for this
  // item" — start from a clean slate so a re-drop after fixing one photo
  // can't leave a stale file sitting in some other slot.
  for (let slot = 0; slot < redchiefSlotFiles.length; slot++) clearRedchiefSlot(slot);

  const assignment = redchiefAutoMatchFiles(workflow.viewLabels, files);
  let matched = 0;
  for (let slot = 0; slot < assignment.length; slot++) {
    if (assignment[slot]) {
      setRedchiefSlotFile(slot, assignment[slot]);
      matched++;
    }
  }
  const unmatchedFiles = files.length - matched;
  const unmatchedSlots = assignment.length - matched;
  redchiefUploadStatusEl.className = 'status';
  redchiefUploadStatusEl.textContent =
    matched === assignment.length
      ? `Matched all ${matched} views automatically from the folder.`
      : `Matched ${matched} of ${assignment.length} views automatically from the folder. ${unmatchedSlots} slot(s) need a photo assigned manually` +
        (unmatchedFiles > 0 ? `, and ${unmatchedFiles} file(s) from the folder didn't match any view label.` : '.');
}

wireDropzone(redchiefFolderDropzoneEl, redchiefFolderInputEl, handleRedchiefFolderFiles, redchiefUploadStatusEl);
```

Note: `wireDropzone` is called exactly once here (not inside `renderRedchiefSlots`) because this dropzone's markup is static (written once in `index.html`, never regenerated via `innerHTML`) — unlike the per-slot dropzones, which `renderRedchiefSlots()` recreates on every workflow change and therefore must re-wire every time.

- [ ] **Step 3: Verify**

`node --check webapp/public/redchief.js`. Browser automation cannot reach `localhost` in this environment (confirmed throughout this feature's development) — verify via a manual trace of `redchiefAutoMatchFiles` against a few example label/filename sets (e.g. confirm labels `["Front","Left","Right","Sole"]` against filenames `["front.jpg","left-side.png","right_view.jpg","random.jpg"]` produce matches for slots 0-2 and leave slot 3 empty with `random.jpg` unused), and confirm every `getElementById` call resolves against the new markup from Step 1.

- [ ] **Step 4: Commit**

```bash
git add webapp/public/index.html webapp/public/redchief.js
git commit -m "feat: RedChief folder upload with automatic view detection by filename"
```

## Self-Review Notes

- **Spec coverage:** every numbered UI requirement (1-8) and every endpoint (1-5) in the spec doc maps to a task above — config load/error (Task 4), workflow selector + credit cost (Task 4), labeled slots + client-side checks (Task 4), Generate + job creation (Task 4), poll loop + result grid + expiry re-fetch (Task 5), FAILED display (Task 5), recent-jobs table + view/cancel (Task 6), visual match (Task 7), env isolation (Task 1-2 Global Constraints).
- **Placeholder scan:** no TBD/TODO left in any step; the one intentional placeholder (`startRedchiefJob` in Task 4) is explicitly a forward reference completed in Task 5, not a gap.
- **Type consistency:** `DevJob`/`RedchiefConfig`/`JobList` etc. from Task 1 are consumed as-is (no renaming) by Task 2's routes, which return them as JSON verbatim to `redchief.js` — the field names (`jobId`, `imageUrls`, `creditsCharged`, `kind`, etc.) are used identically across Tasks 4-6.
