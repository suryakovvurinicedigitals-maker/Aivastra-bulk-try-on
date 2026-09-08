# RedChief tab — backend contract & requirements spec

Transcribed 2026-09-08 from the live route/type/auth code of the propicly backend
(`apps/api/src/modules/dev/routes.ts`, `packages/types/src/dev.ts`,
`apps/api/src/plugins/dev-api-auth.ts`, `apps/api/dev-api-quickstart.md` — a
different repo, not this one) and pasted into this repo's chat by the user. This
is real, live, already-deployed. Field names, error codes, and endpoint paths
below are exact — do not invent or guess alternatives.

## Why a new tab, not a new base URL for the existing one

This repo already talks to an "aivastra" API for the existing bulk try-on flow
(`DEV_API_BASE_URL`/`DEV_API_KEY`, see `lib/api-client.mts` and
`webapp/server.mts`). The backend has since been rebranded aivastra → propicly,
and production is now `https://app.propicly.com` — but this tool's existing
tryon flow must keep pointing at its current config unchanged (it may be a
different environment/account). The RedChief tab is a **separate, self-contained
integration** with its own env vars, never repointing or reusing the existing
`DEV_API_BASE_URL`/`DEV_API_KEY`/`cfg`.

**Locked-in naming (do not rename):**
- `PROPICLY_API_BASE_URL` — defaults to `https://app.propicly.com` in code if unset. Overridable via `.env` (e.g. `http://localhost:4010` for local backend dev).
- `PROPICLY_API_KEY` — separate merchant key, `sk_live_` + 43 URL-safe base64 chars. Never hardcoded; read from env only. `.env.example` gets a placeholder `PROPICLY_API_KEY=sk_live_...` line — the user fills in the real value themselves after implementation, never mid-task.

Since this tool's web server (`webapp/server.mts`) makes API calls from Node
(server-side), not the browser, there is no `NEXT_PUBLIC_`-style prefix
concern — but the key must still never reach client JS. All propicly calls are
proxied through new `/api/redchief/*` routes in `webapp/server.mts`; the
browser never holds `PROPICLY_API_KEY`.

## Auth

Every request to the propicly API carries:
```
Authorization: Bearer <PROPICLY_API_KEY>
```
A missing/malformed/revoked key returns `401` with body
`{"error":{"code":"UNAUTHORIZED","message":"..."}}`.

## Universal error envelope

Every error response, any endpoint, any failure:
```json
{ "error": { "code": "SOME_CODE", "message": "human-readable text" } }
```

Codes relevant to this flow:

| Code | HTTP | When |
|---|---|---|
| `UNAUTHORIZED` | 401 | bad/missing/revoked key |
| `VALIDATION` | 400 | missing files, wrong field name, oversized file, more than 6 views, non-image content |
| `CONFIG` | 400 | no active RedChief workflow for the exact view count submitted (no credits charged) |
| `INSUFFICIENT_CREDITS` | 402 | merchant balance too low (no job created) |
| `NOT_FOUND` | 404 | unknown job id, or belongs to someone else |
| `CONFLICT` | 409 | `POST .../cancel` on a job no longer `QUEUED` |
| `RATE_LIMIT` | 429 | >60 req/min for this key; response has `Retry-After` header |
| `ENQUEUE_FAIL` | 503 | accepted but failed to queue; already-charged credits auto-refunded; safe to retry |

Surface `error.code` + `error.message` to the tester on any non-2xx response —
never swallow into a generic "something went wrong" (spec requirement, see UI
section below).

## Endpoints

All paths below are relative to `PROPICLY_API_BASE_URL`.

### 1. `GET /v1/dev/redchief/config`
Call first, before showing upload UI. No body. 200:
```json
{
  "creditCost": 5,
  "workflows": [
    { "inputCount": 4, "viewLabels": ["Front", "Left", "Right", "Sole"] },
    { "inputCount": 6, "viewLabels": ["Front", "Left", "Right", "Sole", "Tip", "Back"] }
  ]
}
```
`workflows` lists every currently-active view count (1-6) — this can change
(an admin can add/remove/deactivate workflows), so never hardcode "4 or 6" —
always drive the UI from this response. `creditCost` is flat per-job regardless
of view count.

### 2. `POST /v1/dev/redchief` (job creation)
Two equivalent request shapes — **this tool uses the JSON/base64 shape**
(reasoning below), not multipart, even though the upstream doc says "prefer
multipart":
```json
{ "views": ["<base64 or data:image/...;base64,... string>", "..."] }
```
1-6 entries, in the same order as the chosen workflow's `viewLabels`. Each
JPEG/PNG/WebP, checked server-side by content, max 10MB each by default
(admin-configurable — don't hardcode a hard block below 10MB, but don't
silently allow huge files either). 202 response:
```json
{ "jobId": "5f2b1a3e-9c4d-4e2a-8f1b-1234567890ab", "status": "QUEUED" }
```
Max JSON body size for this endpoint: 170MB (base64 inflates ~33%).

**Why JSON/base64 here instead of multipart:** this tool's web server
(`webapp/server.mts`) deliberately has no incoming multipart parser — see its
header comment on why `/api/upload` uses raw request bodies instead. The
propicly API documents JSON/base64 as a fully-equivalent alternative
("everything else — job creation, polling, credits, errors — is identical"),
so the browser base64-encodes each file (`FileReader.readAsDataURL`) and the
server proxies that same JSON straight through, adding only the
`Authorization` header. This is the documented other path, not a workaround.

### 3. `GET /v1/dev/jobs/:id` (poll)
No body. Poll until `COMPLETED` or `FAILED`.
```json
// still working
{ "jobId": "...", "status": "QUEUED" }   // or "RUNNING"

// done
{
  "jobId": "...", "status": "COMPLETED",
  "imageUrl": "https://.../result-0.png?X-Amz-...",
  "imageUrls": ["...result-0...", "...result-1...", "...result-2...", "...result-3..."]
}

// failed
{ "jobId": "...", "status": "FAILED", "error": "SOME_ERROR_CODE" }
```
RedChief always produces exactly 4 outputs on success — render all 4 from
`imageUrls` (ignore `imageUrl`, which is just `imageUrls[0]` for single-image
callers). Result URLs are presigned, expire after 900s (15 min) — re-poll this
endpoint for fresh URLs rather than caching old ones. Use a backing-off poll
loop: start at 2s, ×1.5 each attempt, cap at 20s, give up after ~20 attempts
(~5 min) and show "still processing" rather than an error.

### 4. `GET /v1/dev/jobs` (queue/history list)
Query: `page` (default 1), `pageSize` (default 25, max 100). 200:
```json
{
  "page": 1, "pageSize": 25, "total": 3,
  "jobs": [
    { "jobId": "...", "kind": "redchief", "status": "RUNNING", "creditsCharged": 5, "createdAt": "2026-09-08T12:00:00.000Z" }
  ]
}
```
`kind` can be `"redchief"`, `"tryon"`, or `"saree_mannequin"` if the key is
shared with other tabs — **filter client-side on `kind === "redchief"`** for
this tab's history view. `status` here is coarse (no result URLs) — "View
result" on a row calls endpoint 3 for that row's `jobId`.

### 5. `POST /v1/dev/jobs/:id/cancel`
No body. Only works while still `QUEUED`. Success (200):
```json
{ "ok": true, "creditsRefunded": 5 }
```
Already RUNNING/COMPLETED/FAILED → `409 CONFLICT` — show as "too late to
cancel, already processing", not a generic error. Wire a Cancel button next to
any `QUEUED` row in the jobs list, and next to an in-flight upload while its
own poll still shows `QUEUED`.

## UI requirements (RedChief tab)

1. On tab load, call endpoint 1. Loading state while waiting; clear error state
   if it fails or `workflows` comes back empty.
2. Tester picks the view-count workflow (selector) if more than one is active;
   show the flat credit cost near the selector.
3. Once chosen, render exactly `inputCount` upload slots labeled from
   `viewLabels` (not generic "Image 1/2/3/4"). Each slot: drag-and-drop or
   click-to-browse, preview thumbnail, clear/replace, client-side type/size
   check (JPEG/PNG/WebP, ~10MB) that warns but never hard-blocks — the server
   is the final authority.
4. "Generate" button disabled until every slot for the chosen count is filled.
   On click: POST endpoint 2, show the returned `jobId`, start polling
   endpoint 3 with the backoff loop above, with a status indicator
   (queued/running/done/failed).
5. On `COMPLETED`: show all 4 `imageUrls` in a 2x2 grid, each with an
   open/download action. On an image load error (expired URL), re-fetch
   endpoint 3 on demand rather than erroring out permanently.
6. On `FAILED`: show the `error` code plainly — this is a testing tool, don't
   translate or hide it.
7. "Recent RedChief jobs" table backed by endpoint 4 (filtered to
   `kind === "redchief"`): jobId (truncated), status, creditsCharged,
   createdAt, "View result" (endpoint 3), and — only when `QUEUED` — "Cancel"
   (endpoint 5).
8. Match the existing visual style/components of the other tabs — no new
   design language.

## Explicitly out of scope for this feature

- No changes to `DEV_API_BASE_URL`/`DEV_API_KEY`/`lib/api-client.mts`'s
  existing behavior or the bulk try-on flow.
- No local SQLite (`lib/db.mts`) involvement — "recent jobs" reads live from
  the propicly API (endpoint 4), not a local table.
- No real API key is available yet — the user supplies it after
  implementation. Verification during implementation uses the error paths
  (401 on a bad/missing key) against the real live host, which is free and
  safe (no auth = no job = no credits charged). The one real, low-cost
  end-to-end job (5 credits per the sample `creditCost`) happens in the final
  task once the user has dropped a real key into `.env`.
