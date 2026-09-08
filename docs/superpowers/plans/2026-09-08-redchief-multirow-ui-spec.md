# RedChief multi-row UI — spec

Pasted by the user 2026-09-08 as a UI-only redesign of the already-shipped RedChief tab
(`docs/superpowers/plans/2026-09-08-redchief-tab.md`, Tasks 1-9). **No backend change**: the
same `lib/propicly-client.mts`, the same five `/api/redchief/*` proxy routes, and the same
`PROPICLY_API_KEY`/`PROPICLY_API_BASE_URL` env vars from that earlier work are reused as-is.
This plan only replaces `webapp/public/index.html`'s RedChief section, `webapp/public/redchief.js`
in full, and adds/removes CSS in `webapp/public/style.css`.

**Explicitly out of scope (per the user):** a separate Results/history page, a credits/balance
page, a generic multi-kind (tryon/saree-mannequin) job builder. The existing `GET
/api/redchief/jobs` (list) proxy route stays in the backend unused by this UI — removing working
backend code was never asked for and isn't necessary.

## Design-token decision

The pasted spec supplies a full oklch color/radius/font token set, but also says: *"If this tool
already has its own token system / component library with equivalent roles... use THOSE instead
of introducing a second, parallel style system — only fall back to the tokens above if there's
genuinely nothing to reuse."* This app already has a complete, working light+dark token set at
`webapp/public/style.css:1-36` (`--bg`, `--panel`, `--text`, `--muted`, `--border`, `--pink`
(the app's one accent color), `--pink-tint`, `--warn`/`--warn-tint`, `--ok`/`--ok-tint`, `--err`,
`--grad`, `--shadow`), and existing reusable components: `.panel`, `.btn-primary`/
`.btn-secondary`/`.btn-danger` (+ `.btn-small` variant), `.link-btn`/`.link-btn.danger`,
`.dropzone`, `.status`/`.status.ok`/`.status.err`, `.confirm-panel`/`.confirm-actions`,
`.role-badge`/`.role-badge.superadmin`/`.role-badge.user` (a tinted-pill badge — exactly the
"status pill" shape the new spec wants), `.redchief-dropzone`/`.redchief-slot-preview`/
`.redchief-result-grid`/`.redchief-result-cell` (from the shipped single-row RedChief work,
directly reusable for per-row slot tiles and per-row result grids).

**Ruling: reuse the existing system throughout. Do not introduce the oklch token block.** Role
mapping used by every task below:

| Spec role | This app's token/class |
|---|---|
| `--bg` | `--bg` |
| `--surface` / card background | `--panel` (via the existing `.panel` class) |
| `--surface-2` (empty-slot fill) | `--border` (matches `.redchief-slot-preview`'s existing empty look; no new token needed) |
| `--ink` / `--ink-2` | `--text` / `--muted` |
| `--muted` | `--muted` |
| `--accent` / `--accent-soft` | `--pink` / `--pink-tint` |
| `--success` / `--success-soft` / `--success-ink` | `--ok` / `--ok-tint` / `--ok` |
| `--danger` / `--danger-soft` / `--danger-ink` | `--err` / **`--err-tint` (new — see below)** / `--err` |
| `--warn` / `--warn-soft` / `--warn-ink` | `--warn` / `--warn-tint` / `--warn` |
| `--sans` / `--mono` | inherit `body`'s existing font stack; no new token |
| `--r` / `--r-lg` / `--r-xl` | match existing hardcoded radii already used nearby (8-10px for cards/tiles, 999px for pills) — no new radius tokens, to avoid touching unrelated existing rules |
| primary / ghost / danger buttons | `.btn-primary` / `.btn-secondary` / `.btn-danger` (`.link-btn`/`.link-btn.danger` for text-only ghost actions), all already at the spec's described weight/padding/radius |
| status pill/badge | same shape as `.role-badge` — new `.redchief-status-badge` variants using `--muted`/`--warn-tint`+`--warn`/`--pink-tint`+`--pink`/`--ok-tint`+`--ok`/`--err-tint`+`--err` for idle/queued/running/completed/failed respectively |
| validation/error banner | same shape as `.confirm-panel` (currently `--err`-bordered) — reuse directly for the workflow-switch warning; a new `.redchief-validation-banner` (tinted background, left icon chip) for per-row validation messages |

**One genuine gap, filled the way this file already fills it elsewhere:** every other status
color already has a `--X-tint` pair (`--pink-tint`, `--warn-tint`, `--ok-tint`) except `--err`.
Add `--err-tint` (light + the `prefers-color-scheme: dark` block) following the exact existing
pattern — this is completing an established convention, not adding a new one.

## Data model

```ts
interface ViewSlot {
  id: string;              // stable key, independent of array position
  label: string;           // e.g. "Front", "Left", "Sole" — from the chosen workflow's viewLabels
  file: File | null;        // null = unfilled slot
  previewUrl: string | null;
}

interface TestRow {
  id: string;
  label: string;                  // editable, defaults to "Item N", never blank
  slots: ViewSlot[];               // length === chosen inputCount, index-aligned with viewLabels
  jobId: string | null;
  status: 'idle' | 'submitting' | 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  resultUrls: string[] | null;     // 4 presigned URLs once COMPLETED
  error: string | null;            // error.code from a failed create, or a FAILED job's error
  pollTimer: number | null;        // this row's own setTimeout handle (not module-level — rows poll independently)
  pollToken: number;               // bumped on cancel/retry so a stale poll continuation for THIS row's old jobId is discarded
}
```

Since every row now owns its own `pollTimer`/`pollToken`, there is no module-level poll-timer
race this time (unlike the single-row UI's Task 4/5 fix-loop finding) — each row's polling is
self-contained by construction.

## Backend contract (already implemented, reused as-is — do not add/change any route)

- `GET /api/redchief/config` → `{available, creditCost, workflows: [{inputCount, viewLabels}]}` (unchanged).
- `POST /api/redchief` → this UI still posts JSON `{"views": ["<data-url>", ...]}` through the
  **existing** proxy route (which accepts JSON/base64, not multipart) — the pasted spec's
  upstream contract mentions multipart as one option, but this tool's server has no multipart
  parser by design (see `lib/propicly-client.mts`'s header comment) and JSON/base64 is the
  documented equivalent already wired end-to-end. Each row's slot files are base64-encoded
  client-side exactly like the single-row UI did, then posted to this same route. Returns
  `202 {jobId, status:"QUEUED"}`.
- `GET /api/redchief/jobs/:id` → poll shape unchanged (`QUEUED`/`RUNNING`/`COMPLETED` with
  `imageUrls`/`FAILED` with `error`).
- `POST /api/redchief/jobs/:id/cancel` → unchanged (`{ok, creditsRefunded}` or `409 CONFLICT`).

Every error envelope is `{error:{code,message}}` — shown on the specific row, never a
page-level toast.

## Filename-prefix grouping (bulk dropzone)

Strip a trailing `-N`/`_N`/`-viewN`/`_viewN` suffix (case-insensitive) from the filename stem
(extension removed first) via `/^(.+?)[-_](?:view)?(\d+)$/i`. Files sharing the same stripped
prefix become one row, sorted by the captured trailing number before filling slots in order.
A file with no match for that regex (no trailing number) becomes its own singleton row. Cap
each group at the chosen workflow's `inputCount` — extra files beyond that are dropped from the
group (not silently placed in a new row, not merged into another group).

## Folder-picker grouping

A `<input type="file" webkitdirectory multiple>` returns a flat `FileList`, but every file
carries `webkitRelativePath` (e.g. `AllShoes/Shoe1/front.jpg`). Segment count of that path
(split on `/`) decides grouping:
- Every file has exactly 2 segments (root/filename, no subfolder) → ONE row, all files matched
  against the current workflow's `viewLabels`.
- Any file has 3+ segments → group by the 2nd path segment (immediate subfolder name); each
  subfolder is its own row. Files with exactly 2 segments in this same selection (loose files
  sitting directly in the root alongside real subfolders) become their own row(s) labeled
  distinctly (e.g. "Unmatched root files") so a stray file is never silently folded into a real
  product's row.

**Lenient normalized matching** (per group → viewLabels): normalize both sides with
`s.toLowerCase().replace(/[^a-z0-9]/g, '')`; for each label in order, find the first
not-yet-claimed file whose normalized stem contains the normalized label, or vice versa. A
label with no match leaves that slot's `file` `null` **in place** — never compact/reindex the
slots array, since array position is the view identity used by the create-job payload's order.

## Submission

Clicking the footer's "Create N job(s)" button submits every row currently `idle` — all their
`POST /api/redchief` calls fire concurrently via `Promise.allSettled`, never sequentially. Each
row's own state transitions independently:
- `idle` → `submitting` (immediately on click)
- `submitting` → `QUEUED` (create call succeeded, `jobId` stored) → begins that row's own
  backoff poll loop (2s → ×1.5 → cap 20s → give up after ~20 attempts, "still processing" state,
  no error)
- `submitting` → `FAILED` (create call itself failed — e.g. `INSUFFICIENT_CREDITS` partway
  through a batch; other rows that already got a `jobId` are completely unaffected and keep
  polling)
- `QUEUED`/`RUNNING` → `COMPLETED` (render `resultUrls`, stop polling) or `FAILED` (show
  `error`, stop polling)
- Cancel (only while `QUEUED`): success → row resets fully to `idle` (jobId/status/error
  cleared, **slot files kept** so it's instantly resubmittable); `409` → row shows "already
  processing, can't cancel" and stops offering the Cancel button (still `QUEUED` state-wise
  until the next poll updates it).
- Retry (only after `FAILED`): resubmits the **same row's existing slot files** as a brand-new
  `POST /api/redchief` call (new `jobId`), leaving every other row untouched.

Footer's "Create N job(s)" button is disabled when: no workflow selected, zero rows, any row has
an unfilled slot, or every row is already non-idle (mid-flight/completed/failed) — never
globally disabled just because *some* rows are mid-flight while others are still editable.
