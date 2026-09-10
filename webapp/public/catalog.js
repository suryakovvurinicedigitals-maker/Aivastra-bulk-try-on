// ---------- Catalog Batch tab ----------
// Bulk-tests the aivastra catalog surface (GET /v1/dev/catalog/options,
// POST /v1/dev/catalog/generate, GET /v1/dev/catalogues/:id — proxied here as
// /api/catalog/*). Uses the SAME cfg/DEV_API_KEY as the Upload/Generate tab
// (see lib/api-client.mts's catalog section and webapp/server.mts's catalog
// routes) — unlike RedChief, this is not a separate merchant account.
//
// Garments and test configuration are deliberately split: `catalogGarments`
// is just the list of uploaded photos (one card each, upload/remove only),
// while `catalogBatch` is a SINGLE shared config (gender, garment type,
// aspect ratio, resolution, and multi-select face/lower/shoe/pose/background
// pools) applied to every garment. That's the actual bulk-testing shape the
// tester wants: upload N garments, pick the test matrix once, hit Generate,
// get every garment x every combination back. (An earlier version put the
// full config on each row independently — that made every upload require
// re-picking faces/poses/backgrounds per garment, which defeated the point
// of a "batch".)
//
// The API's own POST /v1/dev/catalog/generate only takes ONE face, ONE
// lower, and ONE shoe per call (poses/backgrounds are the only fields that
// batch, via the `looks` array) — so each garment fans out into one
// "combination" (registerCatalogAggregateRun) PER (face, lower, shoe) pick
// under the hood: faces x max(lowers selected, 1) x max(shoes selected, 1)
// combinations per garment. Each combination itself fans out further,
// server-side, into one upstream generate call PER pose×background look
// (runCatalogAggregate, throttled by CATALOG_CONCURRENCY) — so there's no
// real per-combination job-count ceiling anymore, just the server's sanity
// cap on looks.length (see validateCatalogSharedFields). Leaving lower/shoe
// unselected isn't "0 combinations", it's "1 combination with neither" — that's what the
// max(...,1) is for. Each garment therefore tracks one "run" per combination
// (garment.runs[]), each with its own catalogueId/jobs/status — the
// garment's own status is just an aggregate over its runs. Same lifecycle
// shape as redchief.js otherwise: idle -> submitting -> RUNNING (poll) ->
// COMPLETED/FAILED/PARTIAL, or Retry (which only re-submits failed runs, so
// a partially-successful garment never re-spends credits on combinations
// that already completed).

const CATALOG_GENDERS = ['men', 'women', 'boys', 'girls'];
const CATALOG_GENDER_LABEL = { men: 'Men', women: 'Women', boys: 'Boys', girls: 'Girls' };
const CATALOG_ASPECT_RATIOS = ['1:1', '2:3', '3:4', '4:5'];
const CATALOG_RESOLUTIONS = ['HD', '2K', '4K'];

const catalogAvailabilityBannerEl = document.getElementById('catalog-availability-banner');
const catalogBulkDropzoneEl = document.getElementById('catalog-bulk-dropzone');
const catalogBulkInputEl = document.getElementById('catalog-bulk-input');
const catalogBulkStatusEl = document.getElementById('catalog-bulk-status');
const catalogAddRowBtn = document.getElementById('catalog-add-row-btn');
const catalogConfigBodyEl = document.getElementById('catalog-config-body');
const catalogRowsPanelEl = document.getElementById('catalog-rows-panel');
const catalogRowsEl = document.getElementById('catalog-rows');
const catalogResultsEl = document.getElementById('catalog-results');
const catalogClearAllBtn = document.getElementById('catalog-clear-all-btn');
const catalogFooterBarEl = document.getElementById('catalog-footer-bar');
const catalogRowCountEl = document.getElementById('catalog-row-count');
const catalogSubmitBtn = document.getElementById('catalog-submit-btn');
const catalogSubmitConfirmEl = document.getElementById('catalog-submit-confirm');
const catalogSubmitConfirmTextEl = document.getElementById('catalog-submit-confirm-text');
const catalogSubmitConfirmCancelBtn = document.getElementById('catalog-submit-confirm-cancel-btn');
const catalogSubmitConfirmBtn = document.getElementById('catalog-submit-confirm-btn');
const catalogRunBannerEl = document.getElementById('catalog-run-banner');

// Asset modal picker elements (SelectGridModal style)
const catalogModalOverlayEl = document.getElementById('catalog-modal-overlay');
const catalogModalTitleEl = document.getElementById('catalog-modal-title');
const catalogModalCounterEl = document.getElementById('catalog-modal-counter');
const catalogModalCloseBtn = document.getElementById('catalog-modal-close-btn');
const catalogModalToolbarEl = document.getElementById('catalog-modal-toolbar');
const catalogModalFilterChipsEl = document.getElementById('catalog-modal-filter-chips');
const catalogModalGridEl = document.getElementById('catalog-modal-grid');
const catalogModalEmptyEl = document.getElementById('catalog-modal-empty');
const catalogModalSelectAllBtn = document.getElementById('catalog-modal-select-all-btn');
const catalogModalClearBtn = document.getElementById('catalog-modal-clear-btn');
const catalogModalDoneBtn = document.getElementById('catalog-modal-done-btn');

const CATALOG_VISIBLE_PAGE_CAP = 10;

const CATALOG_ASSET_METADATA = {
  face: { title: 'Faces (Models)', required: true, aspect: '3/4', optionsKey: 'faces', setKey: 'faces' },
  lower: { title: 'Lower Garments', required: false, aspect: '1/1', optionsKey: 'lowerItems', setKey: 'lowers' },
  shoe: { title: 'Footwear', required: false, aspect: '1/1', optionsKey: 'shoeItems', setKey: 'shoes' },
  pose: { title: 'Poses', required: true, aspect: '3/4', optionsKey: 'poses', setKey: 'poses' },
  background: { title: 'Backgrounds', required: true, aspect: '3/4', optionsKey: 'backgrounds', setKey: 'backgrounds' },
};

const CATALOG_FILTER_TAGS = {
  background: ['All', 'Studio', 'Outdoor', 'Wall', 'Street', 'Room', 'Nature', 'Interior', 'Solid'],
  pose: ['All', 'Front', 'Side', 'Pocket', 'Walking', 'Sitting', 'Standing'],
  face: ['All'],
  lower: ['All'],
  shoe: ['All'],
};

let catalogModalState = {
  isOpen: false,
  kind: null,
  activeFilter: 'All',
};

let catalogGarments = [];
let catalogRowCounter = 0;
let catalogLoaded = false;

// The single shared test configuration applied to every uploaded garment.
const catalogBatch = {
  gender: 'men',
  garmentType: '',
  optionsToken: 0,
  optionsLoading: false,
  optionsError: null,
  options: null, // CatalogOptions for the current gender/garmentType, once loaded
  faces: new Set(), // multi-select — required, at least one
  lowers: new Set(), // multi-select — optional; empty means "one run with no lower item"
  shoes: new Set(), // multi-select — optional; empty means "one run with no shoe"
  poses: new Set(),
  backgrounds: new Set(),
  aspectRatio: '3:4',
  resolution: 'HD',
};

// Only successful option fetches are cached — a transient failure must not
// poison a gender/garmentType combo the tester switches back to later.
const catalogOptionsCache = new Map(); // `${gender}|${garmentType}` -> CatalogOptions

// ---------- bulk-select faces/lower/shoe/poses/backgrounds from a folder ----------
// The upstream catalog API only ever accepts a SLUG for face/lower/shoe/pose/
// background — there is no endpoint anywhere in lib/api-client.mts to upload
// a brand new custom image for any of these (unlike `garment`, which really
// is an arbitrary base64 upload). So "upload a folder" here can only mean
// bulk-*selecting* existing admin-curated assets by matching a dropped
// folder's filenames against each asset's label/slug — never creating new
// ones. This mirrors redchief.js's folder-matching (redchiefMatchViewLabels)
// but many-to-many instead of one-slot-per-label, since a picker here can
// have dozens of assets rather than a fixed handful of view slots.
let catalogAssetFolderStatus = { face: null, lower: null, shoe: null, pose: null, background: null }; // kind -> status message string, or null

// Every folder-uploaded file that DIDN'T match a curated asset used to just
// get named in the status text and dropped — the tester (who's using this as
// a sandbox to preview local candidate photos before manually adding winners
// to the aivastra admin panel) needs to actually SEE every file they
// uploaded, not just the lucky filename matches. So each kind also keeps the
// full list of unmatched files as real thumbnail previews (object URLs, kept
// alive only as long as they're shown — revoked on replacement/reset below).
// These are preview-only: there's no slug to select, so they're never wired
// into catalogBatch's Sets or a generate call — see catalogMatchAssetsFromFiles's
// doc comment for why that's a hard API limitation, not a UI gap.
let catalogAssetFolderUnmatched = { face: [], lower: [], shoe: [], pose: [], background: [] }; // kind -> [{id, name, previewUrl, file, uploading, uploadError}]

// ---------- backgrounds: the ONE axis where a genuinely-new candidate image
// can be tested for real (aivastra's dev API added POST /v1/dev/backgrounds/
// {presign,confirm} + GET/DELETE specifically for this — see
// lib/api-client.mts's doc comment on that section for the full story of
// why only background gets this treatment and not face/lower/shoe/pose).
// A confirmed background's `id` is a UUID that satisfies PUBLIC_SLUG's
// regex, so it's usable in catalogBatch.backgrounds exactly like a curated
// slug — no special-casing needed anywhere selection/looks/submit already
// happens, only in how the id gets INTO that Set in the first place.
// ---------------------------------------------------------------------------
let catalogUserBackgrounds = []; // [{id, label, thumbnailUrl}] — this merchant's own dev-API-uploaded backgrounds
let catalogUserBackgroundsLoaded = false; // loaded once per page load, NOT reset on gender/garmentType change (the list isn't gender-scoped)
let catalogBackgroundUploading = false; // true while handleCatalogBackgroundUploadFiles is mid-batch — disables the upload button so a tester can't fire a second overlapping batch
let catalogBackgroundUploadStatus = null; // {err: boolean, message: string} | null — last upload batch's outcome, shown the same way catalogAssetFolderStatus is

/** Loads (once) the merchant's own previously-uploaded backgrounds, so a returning tester doesn't have to re-upload every session. Best-effort — a failure here just means "no self-uploaded backgrounds shown yet", not a hard error, since the curated picker still works fine without it. */
async function loadCatalogUserBackgrounds() {
  if (catalogUserBackgroundsLoaded) return;
  catalogUserBackgroundsLoaded = true;
  try {
    const res = await fetch('/api/catalog/backgrounds');
    const body = await res.json();
    if (res.ok && body.available !== false) catalogUserBackgrounds = body.items ?? [];
  } catch {
    // best-effort — leave catalogUserBackgrounds empty, tester can still use curated backgrounds
  }
  renderCatalog();
}

/**
 * Uploads ONE candidate background through the real 3-step flow —
 * presign (this server, JSON) -> PUT raw bytes directly to the presigned
 * URL (NOT through this server — see the /api/catalog/backgrounds/presign
 * route's doc comment) -> confirm (this server, JSON). On success the new
 * background is added to catalogUserBackgrounds AND auto-selected into
 * catalogBatch.backgrounds, since uploading it was an explicit "I want to
 * test this one" action — there's no reason to make the tester then also
 * go find and click its tile.
 */
async function uploadCandidateBackground(file, label) {
  const contentType = file.type;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
    throw new Error(`${file.name}: only JPEG/PNG/WEBP are supported (got ${contentType || 'unknown type'})`);
  }
  const presignRes = await fetch('/api/catalog/backgrounds/presign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentType, contentLength: file.size }),
  });
  const presignBody = await presignRes.json();
  if (!presignRes.ok) throw new Error(`${presignBody.error?.code ?? presignRes.status}: ${presignBody.error?.message ?? 'presign failed'}`);

  // Straight to storage — this is the one upload in this whole tool that
  // does NOT go through webapp/server.mts, because the presigned URL is
  // exactly what makes that unnecessary (and sending 50MB through our own
  // node:http server first would just be slower for no benefit).
  const putRes = await fetch(presignBody.uploadUrl, { method: 'PUT', headers: { 'Content-Type': contentType }, body: file });
  if (!putRes.ok) throw new Error(`${file.name}: upload to storage failed (${putRes.status})`);

  const confirmRes = await fetch('/api/catalog/backgrounds/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ r2Key: presignBody.r2Key, label: label || file.name.replace(/\.[^.]+$/, '') }),
  });
  const confirmBody = await confirmRes.json();
  if (!confirmRes.ok) throw new Error(`${confirmBody.error?.code ?? confirmRes.status}: ${confirmBody.error?.message ?? 'confirm failed'}`);
  return confirmBody; // DevBackgroundItem: {id, label, thumbnailUrl}
}

/**
 * Uploads a whole batch of candidate backgrounds picked directly via the
 * section header's "Upload new background(s)" button — the main, deliberate
 * entry point for "I want to test a photo that's not in the admin library
 * at all", as opposed to the folder-match flow above (which is about
 * bulk-*selecting* existing curated assets by filename). Sequential, not
 * Promise.all — presign+confirm share a 10/min write-rate budget upstream,
 * and firing a big batch all at once would just pile up 429 retries inside
 * request()'s own backoff instead of finishing any faster. Renders progress
 * after each file so a large batch doesn't look frozen.
 */
async function handleCatalogBackgroundUploadFiles(fileList) {
  const images = filterImageFiles(fileList);
  if (images.length === 0) return;
  catalogBackgroundUploading = true;
  catalogBackgroundUploadStatus = null;
  renderCatalog();
  let uploaded = 0;
  const errors = [];
  for (const file of images) {
    try {
      const item = await uploadCandidateBackground(file);
      catalogUserBackgrounds.push(item);
      catalogBatch.backgrounds.add(item.id); // auto-select — uploading it was already an explicit "test this one" action
      uploaded++;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
    catalogBackgroundUploadStatus = { err: false, message: `Uploading… ${uploaded + errors.length} of ${images.length} processed.` };
    renderCatalog();
  }
  catalogBackgroundUploading = false;
  catalogBackgroundUploadStatus = {
    err: uploaded === 0,
    message:
      uploaded === images.length
        ? `Uploaded and selected ${uploaded} new background${uploaded === 1 ? '' : 's'}.`
        : `Uploaded and selected ${uploaded} of ${images.length}.` +
          (errors.length ? ` Errors: ${errors.slice(0, 3).join('; ')}${errors.length > 3 ? `, +${errors.length - 3} more` : ''}.` : ''),
  };
  renderCatalog();
}

/**
 * Uploads ONE tile from the folder-match "unmatched" preview grid — the
 * bridge between the two upload flows: a tester drops a folder in expecting
 * filename matches, most don't match, and rather than making them re-pick
 * the same file through a second file dialog, each unmatched preview tile
 * (background axis only — see catalogUnmatchedThumbsHtml) gets its own
 * "Upload & use" action that reuses the File object already held in memory.
 * On success the tile moves from "unmatched preview" to "real, selected
 * background" and disappears from this list; on failure it stays with an
 * inline error so the tester can retry or give up on just that one file.
 */
async function uploadUnmatchedBackgroundTile(kind, id) {
  const item = catalogAssetFolderUnmatched[kind]?.find((it) => it.id === id);
  if (!item || item.uploading) return;
  item.uploading = true;
  item.uploadError = null;
  renderCatalog();
  try {
    const uploaded = await uploadCandidateBackground(item.file, item.name.replace(/\.[^.]+$/, ''));
    catalogUserBackgrounds.push(uploaded);
    catalogBatch.backgrounds.add(uploaded.id);
    URL.revokeObjectURL(item.previewUrl);
    catalogAssetFolderUnmatched[kind] = catalogAssetFolderUnmatched[kind].filter((it) => it.id !== id);
  } catch (err) {
    item.uploading = false;
    item.uploadError = err instanceof Error ? err.message : String(err);
  }
  renderCatalog();
}

// Maps a picker `kind` to the CatalogAsset[] it draws from in the currently-
// loaded options, and to the Set key catalogBatch tracks selections in — the
// same two mappings CATALOG_ASSET_SET_KEY (defined below, tile click
// handling) and catalogAssetPickersHtml already need, kept in one place so a
// new axis can't be added to one and forgotten in the other.
function catalogAssetListForKind(kind) {
  const o = catalogBatch.options;
  if (!o) return kind === 'background' ? catalogUserBackgroundsAsAssets() : [];
  if (kind === 'face') return o.faces;
  if (kind === 'lower') return o.lowerItems;
  if (kind === 'shoe') return o.shoeItems;
  if (kind === 'pose') return o.poses;
  // Backgrounds merge the curated (admin) list with this merchant's own
  // dev-API-uploaded ones — the only axis with a second source, so it's the
  // only one that needs merging here. A user background's `id` doubles as
  // its slug (see uploadCandidateBackground's doc comment), so once mapped
  // into {slug, label, thumbnailUrl} shape it's indistinguishable to every
  // other piece of selection/looks/submit code in this file.
  if (kind === 'background') return [...o.backgrounds, ...catalogUserBackgroundsAsAssets()];
  return [];
}

function catalogUserBackgroundsAsAssets() {
  return catalogUserBackgrounds.map((b) => ({ slug: b.id, label: b.label, thumbnailUrl: b.thumbnailUrl, mine: true }));
}

function catalogNormalize(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * For each asset (in list order, deterministic regardless of file order),
 * claims the first not-yet-used file whose normalized stem contains the
 * asset's normalized label or slug, or vice versa — same lenient
 * containment match as redchief.js's redchiefMatchViewLabels. Returns the
 * matched slugs plus the File objects that matched nothing (so the caller
 * can preview them, not just name them); never touches catalogBatch state
 * itself (caller decides how to merge).
 */
function catalogMatchAssetsFromFiles(assets, files) {
  const usedFileIdx = new Set();
  const matchedSlugs = [];
  for (const asset of assets) {
    const normLabel = catalogNormalize(asset.label);
    const normSlug = catalogNormalize(asset.slug);
    const idx = files.findIndex((f, i) => {
      if (usedFileIdx.has(i)) return false;
      const stem = catalogNormalize(f.name.replace(/\.[^.]+$/, ''));
      return stem.includes(normLabel) || normLabel.includes(stem) || stem.includes(normSlug) || normSlug.includes(stem);
    });
    if (idx !== -1) {
      usedFileIdx.add(idx);
      matchedSlugs.push(asset.slug);
    }
  }
  const unmatchedFiles = files.filter((_, i) => !usedFileIdx.has(i));
  return { matchedSlugs, unmatchedFiles };
}

/**
 * Bulk-selects assets for one picker (`kind` is 'face'|'lower'|'shoe'|
 * 'pose'|'background') by matching a dropped/picked folder's filenames.
 * ADDS matched slugs to whatever's already selected — a folder upload never
 * clears or replaces the tester's existing clicks-in-the-grid selections
 * (or a previous folder upload's matches) for that same axis, it only ever
 * grows the Set. Re-uploading the same folder twice is a harmless no-op
 * (Set.add is idempotent).
 */
function handleCatalogAssetFolderFiles(kind, fileList) {
  const images = filterImageFiles(fileList);
  if (images.length === 0) return;
  const assets = catalogAssetListForKind(kind);
  const { matchedSlugs, unmatchedFiles } = assets.length > 0
    ? catalogMatchAssetsFromFiles(assets, images)
    : { matchedSlugs: [], unmatchedFiles: images }; // options not loaded yet for this axis — nothing to match against, so every file is "unmatched" (still previewed below, not silently dropped)
  const set = catalogBatch[CATALOG_ASSET_SET_KEY[kind]];
  for (const slug of matchedSlugs) set.add(slug);

  // Replace (not append) this axis's unmatched preview with THIS upload's
  // leftovers — revoke the previous batch's object URLs first so repeated
  // folder uploads don't leak blob: URLs for images no longer shown anywhere.
  for (const item of catalogAssetFolderUnmatched[kind]) URL.revokeObjectURL(item.previewUrl);
  catalogAssetFolderUnmatched[kind] = unmatchedFiles.map((f) => ({
    id: catalogUid('unmatched'),
    name: f.name,
    previewUrl: URL.createObjectURL(f),
    file: f, // kept alive (not just the preview URL) so background candidates can actually be uploaded later via uploadCandidateBackground — see catalogUnmatchedThumbsHtml
    uploading: false,
    uploadError: null,
  }));

  catalogAssetFolderStatus[kind] =
    matchedSlugs.length === 0
      ? `No filenames matched any asset label or slug in this category — showing all ${images.length} below for reference.`
      : `Matched and selected ${matchedSlugs.length} of ${images.length} file(s) — the other ${unmatchedFiles.length} are shown below for reference.`;
  renderCatalog();
}

function catalogUid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function catalogEscapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

window.enterCatalogView = async function enterCatalogView() {
  initCatalogModalEvents();
  catalogPollBatchStatus(); // reflect an already-in-flight/queued/paused batch from another session, even on a repeat visit to this tab
  if (catalogLoaded) return;
  catalogLoaded = true;
  await Promise.all([loadCatalogBatchOptions(), loadCatalogUserBackgrounds()]);
};

async function fetchCatalogOptionsCached(gender, garmentType) {
  const key = `${gender}|${garmentType || ''}`;
  if (catalogOptionsCache.has(key)) return catalogOptionsCache.get(key);
  const params = new URLSearchParams({ gender });
  if (garmentType) params.set('garmentType', garmentType);
  const res = await fetch(`/api/catalog/options?${params}`);
  const body = await res.json();
  if (!res.ok || body.available === false) {
    throw new Error(body.error || 'Could not load catalog options.');
  }
  catalogOptionsCache.set(key, body);
  return body;
}

/** Loads the asset pool for the batch's current gender/garmentType. Also doubles as the availability probe — a missing DEV_API_KEY (or unreachable dev API) surfaces here as a clear banner on first entry rather than a silent empty picker. */
async function loadCatalogBatchOptions() {
  const token = ++catalogBatch.optionsToken;
  catalogBatch.optionsLoading = true;
  catalogBatch.optionsError = null;
  renderCatalog();
  try {
    const options = await fetchCatalogOptionsCached(catalogBatch.gender, catalogBatch.garmentType);
    if (token !== catalogBatch.optionsToken) return; // superseded by a newer gender/garmentType change
    catalogBatch.options = options;
    catalogBatch.optionsLoading = false;
    catalogAvailabilityBannerEl.hidden = true;
  } catch (err) {
    if (token !== catalogBatch.optionsToken) return;
    catalogBatch.options = null;
    catalogBatch.optionsLoading = false;
    catalogBatch.optionsError = err instanceof Error ? err.message : String(err);
    catalogAvailabilityBannerEl.textContent = catalogBatch.optionsError;
    catalogAvailabilityBannerEl.hidden = false;
  }
  renderCatalog();
}

function catalogFileNameToLabel(file) {
  if (!file || !file.name) return `Garment ${++catalogRowCounter}`;
  const base = file.name.replace(/\.[^/.]+$/, '').trim();
  return base || `Garment ${++catalogRowCounter}`;
}

function catalogNewGarment(file) {
  return {
    id: catalogUid('garment'),
    label: file ? catalogFileNameToLabel(file) : `Garment ${++catalogRowCounter}`,
    file: file ?? null,
    previewUrl: file ? URL.createObjectURL(file) : null,
    status: 'idle', // idle | submitting | RUNNING | COMPLETED | FAILED | PARTIAL
    runs: [], // one per (face, lower, shoe) combination: [{id, face, lower, shoe, runLabel, catalogueId, jobs, status, error, pollTimer, pollToken}]
    error: null, // garment-level error (e.g. couldn't even read the file before fanning out to runs)
  };
}

catalogAddRowBtn.addEventListener('click', () => {
  catalogGarments.push(catalogNewGarment(null));
  renderCatalog();
});

if (catalogClearAllBtn) {
  catalogClearAllBtn.addEventListener('click', () => {
    for (const g of catalogGarments) catalogClearGarmentRuns(g);
    catalogGarments = [];
    renderCatalog();
  });
}

function handleCatalogBulkFiles(files) {
  const images = filterImageFiles(files);
  if (images.length === 0) return;
  for (const file of images) catalogGarments.push(catalogNewGarment(file));
  renderCatalog();
}
wireDropzone(catalogBulkDropzoneEl, catalogBulkInputEl, handleCatalogBulkFiles, catalogBulkStatusEl);

function catalogFindGarment(garmentId) {
  return catalogGarments.find((g) => g.id === garmentId);
}

function setCatalogGarmentFile(garmentId, file) {
  const garment = catalogFindGarment(garmentId);
  if (!garment) return;
  garment.file = file;
  garment.previewUrl = URL.createObjectURL(file);
  if (!garment.label || /^Garment\s+\d+$/i.test(garment.label)) {
    garment.label = catalogFileNameToLabel(file);
  }
  renderCatalog();
}

function clearCatalogGarmentFile(garmentId) {
  const garment = catalogFindGarment(garmentId);
  garment.file = null;
  garment.previewUrl = null;
  renderCatalog();
}

function catalogClearGarmentRuns(garment) {
  for (const run of garment.runs) {
    run.pollToken++;
    if (run.pollTimer) clearTimeout(run.pollTimer);
  }
}

function removeCatalogGarment(garmentId) {
  const garment = catalogFindGarment(garmentId);
  if (garment) catalogClearGarmentRuns(garment);
  catalogGarments = catalogGarments.filter((g) => g.id !== garmentId);
  renderCatalog();
}

/** Cross product of selected poses x selected backgrounds, in the order those assets appear in the loaded options list (not selection order) — deterministic regardless of click order. Callers used to cap this at 12 (an old `looks`-per-call limit that no longer applies — see submitCatalogGarments' comment); the full cross product is sent as-is now, up to the server's much higher sanity cap. Backgrounds come from catalogAssetListForKind (curated + this merchant's own uploaded ones), not catalogBatch.options.backgrounds directly — otherwise a selected self-uploaded background would silently vanish from every look here. */
function catalogComputeLooks() {
  if (!catalogBatch.options) return [];
  const poses = catalogBatch.options.poses.filter((p) => catalogBatch.poses.has(p.slug));
  const backgrounds = catalogAssetListForKind('background').filter((b) => catalogBatch.backgrounds.has(b.slug));
  const pairs = [];
  for (const p of poses) for (const b of backgrounds) pairs.push({ pose: p.slug, background: b.slug });
  return pairs;
}

function catalogSelectedFaces() {
  if (!catalogBatch.options) return [];
  return catalogBatch.options.faces.filter((f) => catalogBatch.faces.has(f.slug));
}
function catalogSelectedLowers() {
  if (!catalogBatch.options) return [];
  return catalogBatch.options.lowerItems.filter((l) => catalogBatch.lowers.has(l.slug));
}
function catalogSelectedShoes() {
  if (!catalogBatch.options) return [];
  return catalogBatch.options.shoeItems.filter((s) => catalogBatch.shoes.has(s.slug));
}

/** How many generate calls (runs) EACH garment fans out into: faces x max(lowers,1) x max(shoes,1) — an unselected lower/shoe axis still contributes exactly one "no item on this axis" run, it doesn't multiply by zero. */
function catalogRunCount() {
  const faceCount = catalogBatch.faces.size;
  if (faceCount === 0) return 0;
  return faceCount * Math.max(catalogBatch.lowers.size, 1) * Math.max(catalogBatch.shoes.size, 1);
}

/** Builds the shared per-combination run templates — one per (face, lower, shoe) triple, in options-list order for determinism. Applied identically to every garment being submitted. */
function catalogBuildRunTemplates() {
  const faces = catalogSelectedFaces();
  const lowerAxis = catalogSelectedLowers();
  const shoeAxis = catalogSelectedShoes();
  const lowers = lowerAxis.length > 0 ? lowerAxis : [null];
  const shoes = shoeAxis.length > 0 ? shoeAxis : [null];
  const templates = [];
  for (const f of faces) {
    for (const l of lowers) {
      for (const s of shoes) {
        const labelParts = [f.label];
        if (l) labelParts.push(l.label);
        if (s) labelParts.push(s.label);
        templates.push({
          face: f.slug,
          lower: l ? l.slug : undefined,
          shoe: s ? s.slug : undefined,
          runLabel: labelParts.join(' · '),
          // Ride along for the server's benefit only (the Results page's
          // dedicated Catalog row — see webapp/server.mts's
          // CatalogAggregateRun) — never sent upstream to generateCatalog.
          faceLabel: f.label,
          faceThumbnailUrl: f.thumbnailUrl,
          lowerLabel: l ? l.label : undefined,
          lowerThumbnailUrl: l ? l.thumbnailUrl : undefined,
          shoeLabel: s ? s.label : undefined,
          shoeThumbnailUrl: s ? s.thumbnailUrl : undefined,
        });
      }
    }
  }
  return templates;
}

function catalogBatchIsValid() {
  return Boolean(catalogBatch.options) && catalogBatch.faces.size > 0 && catalogBatch.poses.size > 0 && catalogBatch.backgrounds.size > 0;
}

function catalogAssetTileHtml(kind, asset, selected, aspect = '3/4') {
  const isSquare = aspect === '1/1';
  // asset.mine (see catalogUserBackgroundsAsAssets) only ever true for
  // kind === 'background' — a small badge so a tester can tell "this is one
  // of my own test uploads" apart from an admin-curated one at a glance,
  // since they're otherwise mixed into the exact same grid/Set.
  const mineBadge = asset.mine ? `<span class="catalog-asset-mine-badge" title="Your uploaded background — not in the admin-curated library">Mine</span>` : '';
  return `
    <div class="catalog-asset-card${selected ? ' selected' : ''}" data-kind="${kind}" data-slug="${catalogEscapeHtml(asset.slug)}" role="button" tabindex="0" title="${catalogEscapeHtml(asset.label)}">
      <div class="catalog-asset-thumb-wrap${isSquare ? ' square' : ''}">
        <img src="${asset.thumbnailUrl}" alt="${catalogEscapeHtml(asset.label)}" loading="lazy" />
        ${mineBadge}
        <span class="catalog-asset-check" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </span>
      </div>
    </div>`;
}

function catalogAssetMoreTileHtml(kind, extraCount, aspect = '3/4') {
  const isSquare = aspect === '1/1';
  const meta = CATALOG_ASSET_METADATA[kind] || {};
  return `
    <button type="button" class="catalog-asset-more-card${isSquare ? ' square' : ''}" data-kind="${kind}" title="View all selected ${catalogEscapeHtml(meta.title || '')}">
      <span class="catalog-asset-more-count">+${extraCount}</span>
      <span class="catalog-asset-more-text">more</span>
    </button>`;
}

function catalogAssetPickersHtml() {
  const o = catalogBatch.options;
  if (!o) return '';

  const sections = ['face', 'lower', 'shoe', 'pose', 'background'];
  return sections.map((kind) => {
    const meta = CATALOG_ASSET_METADATA[kind];
    // catalogAssetListForKind, not o[meta.optionsKey] directly — for
    // 'background' this also brings in the merchant's own uploaded
    // candidates (see that function's doc comment); every other kind is
    // unaffected, it's exactly o[meta.optionsKey] either way.
    const items = catalogAssetListForKind(kind);
    if (items.length === 0 && !meta.required) return '';

    const set = catalogBatch[meta.setKey];
    const selectedItems = items.filter((i) => set.has(i.slug));
    const unselectedItems = items.filter((i) => !set.has(i.slug));
    const allSelected = items.length > 0 && set.size === items.length;

    let cardsHtml = '';
    if (selectedItems.length <= CATALOG_VISIBLE_PAGE_CAP) {
      const slotsLeft = CATALOG_VISIBLE_PAGE_CAP - selectedItems.length;
      const visible = [...selectedItems, ...unselectedItems.slice(0, slotsLeft)];
      cardsHtml = visible.map((item) => catalogAssetTileHtml(kind, item, set.has(item.slug), meta.aspect)).join('');
    } else {
      const visible = selectedItems.slice(0, CATALOG_VISIBLE_PAGE_CAP - 1);
      const extraCount = selectedItems.length - (CATALOG_VISIBLE_PAGE_CAP - 1);
      cardsHtml = visible.map((item) => catalogAssetTileHtml(kind, item, true, meta.aspect)).join('') +
        catalogAssetMoreTileHtml(kind, extraCount, meta.aspect);
    }

    return `
      <div class="catalog-asset-section" data-kind="${kind}">
        <div class="catalog-asset-section-header">
          <div class="catalog-asset-header-left">
            <span class="catalog-asset-section-label">${meta.title}</span>
            <span class="catalog-asset-req-badge">${meta.required ? '(required)' : '(optional)'}</span>
            ${set.size > 0 ? `<span class="catalog-selected-badge">${set.size} selected</span>` : ''}
          </div>
          <div class="catalog-asset-header-right">
            ${items.length > 0 ? `
              <button type="button" class="catalog-view-more-btn catalog-select-all-btn" data-kind="${kind}" data-action="${allSelected ? 'clear' : 'select'}">
                <span>${allSelected ? 'Clear all' : `Select all (${items.length})`}</span>
              </button>` : ''}
            ${catalogAssetFolderControlHtml(kind)}
            ${kind === 'background' ? catalogBackgroundUploadControlHtml() : ''}
            ${items.length > CATALOG_VISIBLE_PAGE_CAP ? `
              <button type="button" class="catalog-view-more-btn" data-kind="${kind}" title="Browse all ${items.length} options">
                <span>View all (${items.length})</span>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="9 18 15 12 9 6"/>
                </svg>
              </button>` : ''}
          </div>
        </div>
        ${catalogUnmatchedThumbsHtml(kind)}
        <div class="catalog-asset-grid">
          ${cardsHtml || '<p class="hint">No items available.</p>'}
        </div>
      </div>`;
  }).join('') + catalogLooksSummaryHtml();
}

function catalogLooksSummaryHtml() {
  const pairs = catalogComputeLooks();
  const totalPairs = pairs.length;
  const runsPerGarment = catalogRunCount();
  const garmentCount = catalogSubmittableGarments().length;
  if (totalPairs === 0 || runsPerGarment === 0) {
    return '<p class="catalog-looks-summary">Select at least one face, one pose, and one background to see how many jobs this creates.</p>';
  }
  // Every pose×background pair now actually gets submitted — the server's
  // runCatalogAggregate fans each look out to its own upstream
  // /v1/dev/catalog/generate call one at a time (throttled by
  // CATALOG_CONCURRENCY), rather than the client packing up to 12 looks
  // into a single call. So nothing gets silently dropped above 12 anymore;
  // what matters at real scale (hundreds/thousands of backgrounds) is
  // making the true credit/time cost impossible to miss before confirming.
  const totalRuns = runsPerGarment * Math.max(garmentCount, 1);
  const totalJobs = totalPairs * totalRuns;
  const axisDesc = [`${garmentCount} garment(s)`, `${catalogBatch.faces.size} face(s)`];
  if (catalogBatch.lowers.size > 0) axisDesc.push(`${catalogBatch.lowers.size} lower(s)`);
  if (catalogBatch.shoes.size > 0) axisDesc.push(`${catalogBatch.shoes.size} shoe(s)`);
  axisDesc.push(`${catalogBatch.poses.size} pose(s)`, `${catalogBatch.backgrounds.size} background(s)`);
  // Not a hard cap (server allows up to 5000 looks) — just the line above
  // which the warning styling kicks in, so a large intentional test batch
  // (the "1000+ backgrounds" case) still gets a loud, explicit heads-up.
  const HEAVY_JOB_THRESHOLD = 200;
  const heavy = totalJobs > HEAVY_JOB_THRESHOLD;
  const costNote = heavy
    ? ` <strong>This spends real credits on ${totalJobs} jobs and, at the current concurrency limit, will take a while to finish — double-check the selection before confirming.</strong>`
    : '';
  return `<p class="catalog-looks-summary${heavy ? ' warn' : ''}">${axisDesc.join(' × ')} = ${totalPairs} pose×background pair${totalPairs === 1 ? '' : 's'} per combination. ` +
    `This creates ${totalRuns} combination${totalRuns === 1 ? '' : 's'} — ${totalJobs} job${totalJobs === 1 ? '' : 's'} total across all garments.${costNote}</p>`;
}

function catalogConfigFieldsHtml() {
  const garmentTypes = catalogBatch.options?.garmentTypes ?? [];
  return `
    <div class="catalog-controls-group">
      <div class="control-row">
        <span class="control-row-label">Gender</span>
        <div class="segmented-control" id="catalog-gender-pills" role="tablist" aria-label="Gender">
          ${CATALOG_GENDERS.map((g) => `
            <button type="button" class="segmented-pill${catalogBatch.gender === g ? ' active' : ''}" data-value="${g}" role="tab" aria-selected="${catalogBatch.gender === g}">
              ${CATALOG_GENDER_LABEL[g]}
            </button>
          `).join('')}
        </div>
      </div>
      <div class="control-row control-row-top">
        <span class="control-row-label">Garment type</span>
        <div class="catalog-pill-cloud" id="catalog-garment-type-pills" role="tablist" aria-label="Garment type">
          <button type="button" class="segmented-pill${!catalogBatch.garmentType ? ' active' : ''}" data-value="" role="tab" aria-selected="${!catalogBatch.garmentType}">
            Any
          </button>
          ${garmentTypes.map((t) => `
            <button type="button" class="segmented-pill${catalogBatch.garmentType === t.slug ? ' active' : ''}" data-value="${t.slug}" role="tab" aria-selected="${catalogBatch.garmentType === t.slug}">
              ${catalogEscapeHtml(t.label)}
            </button>
          `).join('')}
        </div>
      </div>
      <div class="control-row">
        <span class="control-row-label">Aspect ratio</span>
        <div class="segmented-control" id="catalog-aspect-pills" role="tablist" aria-label="Aspect ratio">
          ${CATALOG_ASPECT_RATIOS.map((a) => `
            <button type="button" class="segmented-pill${catalogBatch.aspectRatio === a ? ' active' : ''}" data-value="${a}" role="tab" aria-selected="${catalogBatch.aspectRatio === a}">
              ${a}
            </button>
          `).join('')}
        </div>
      </div>
    </div>
    ${catalogBatch.optionsLoading ? '<p class="hint">Loading assets for this gender…</p>' : ''}
    ${catalogBatch.optionsError ? `<p class="redchief-validation-msg">${catalogEscapeHtml(catalogBatch.optionsError)}</p>` : ''}
    ${catalogBatch.options ? catalogAssetPickersHtml() : ''}`;
}

/**
 * Folder-upload control for one asset picker: a small button (opens a
 * folder picker via a hidden `webkitdirectory` input, same browser-support
 * caveat as redchief.js's own folder picker — Chromium-family only) plus
 * whatever status text the last match attempt for this axis left behind.
 * Lives inside catalogAssetPickersHtml's per-section header, wired in
 * wireCatalogConfigEvents alongside the tile click handlers, since both are
 * rebuilt fresh on every renderCatalog() call.
 */
function catalogAssetFolderControlHtml(kind) {
  const status = catalogAssetFolderStatus[kind];
  // Same "Done: N uploaded."-style green/red status line as the Upload
  // tab's own bulk upload (see app.js's uploadFiles) — .status/.status.ok/
  // .status.err are shared, not re-implemented here, so the two features
  // read as the same interaction pattern rather than two different ones.
  const statusClass = status ? (status.startsWith('Matched') ? 'ok' : 'err') : '';
  return `
    <span class="catalog-asset-folder-control">
      <button type="button" class="link-btn catalog-asset-folder-btn" data-kind="${kind}">📁 Bulk-select from folder</button>
      <input type="file" class="catalog-asset-folder-input" data-kind="${kind}" webkitdirectory multiple hidden />
    </span>
    ${status ? `<p class="status ${statusClass} catalog-asset-folder-status">${catalogEscapeHtml(status)}</p>` : ''}`;
}

/**
 * Background-only "add a brand-new candidate" control — a plain multi-file
 * picker (no directory requirement, unlike the folder-match control above,
 * since this is a deliberate "add exactly these N images" action, not a
 * filename-matching guess). Each picked file goes through
 * uploadCandidateBackground's real presign->PUT->confirm flow via
 * handleCatalogBackgroundUploadFiles and, on success, becomes a real,
 * selected background tile in the grid above. This is the ONE axis this
 * exists for — aivastra's dev API added POST /v1/dev/backgrounds/* (see
 * lib/api-client.mts's doc comment) specifically so background candidates
 * could be tested before being admin-curated; there's no equivalent for
 * face/lower/shoe/pose.
 */
function catalogBackgroundUploadControlHtml() {
  const status = catalogBackgroundUploadStatus;
  const statusClass = status ? (status.err ? 'err' : 'ok') : '';
  return `
    <span class="catalog-asset-folder-control catalog-bg-upload-control">
      <button type="button" class="link-btn catalog-bg-upload-btn"${catalogBackgroundUploading ? ' disabled' : ''}>⬆ ${catalogBackgroundUploading ? 'Uploading…' : 'Upload new background(s)'}</button>
      <input type="file" class="catalog-bg-upload-input" accept="image/jpeg,image/png,image/webp" multiple hidden${catalogBackgroundUploading ? ' disabled' : ''} />
    </span>
    ${status ? `<p class="status ${statusClass} catalog-asset-folder-status">${catalogEscapeHtml(status.message)}</p>` : ''}`;
}

/**
 * Folder files that matched nothing in the curated library — shown as plain
 * photo previews so a folder upload never silently hides files the tester
 * dropped in. For face/lower/shoe/pose these stay preview-only: the upstream
 * catalog API only ever accepts an EXISTING asset's slug for those four
 * (unlike `garment`, which takes an arbitrary image) — see
 * lib/api-client.mts's CatalogGenerateBody. The intended loop for those:
 * browse the previews, pick the ones worth keeping, add them as real assets
 * via the aivastra admin panel, then they'll show up (and match) here on the
 * next folder upload.
 *
 * background is the one exception — each tile gets its own "Upload & use"
 * button (uploadUnmatchedBackgroundTile) that runs the real presign->PUT->
 * confirm flow on that exact file, since aivastra's dev API added a real
 * upload path for this one axis (see catalogBackgroundUploadControlHtml).
 */
function catalogUnmatchedThumbsHtml(kind) {
  const items = catalogAssetFolderUnmatched[kind];
  if (!items || items.length === 0) return '';
  const isBackground = kind === 'background';
  const label = isBackground
    ? `Not in the asset library yet — upload the ones worth testing:`
    : `Not in the asset library — preview only, can't be used to generate until added via the admin panel:`;
  return `
    <p class="hint catalog-unmatched-label">${label}</p>
    <div class="upload-thumbs catalog-unmatched-thumbs">
      ${items
        .map(
          (it) => `
        <div class="upload-thumb catalog-unmatched-thumb${it.uploading ? ' uploading' : ''}" data-kind="${kind}" data-id="${it.id}" title="${catalogEscapeHtml(it.name)}${it.uploadError ? ` — ${catalogEscapeHtml(it.uploadError)}` : ''}">
          <img src="${it.previewUrl}" loading="lazy" />
          <button type="button" class="thumb-remove catalog-unmatched-thumb-remove" title="Dismiss ${catalogEscapeHtml(it.name)}" aria-label="Dismiss ${catalogEscapeHtml(it.name)}">×</button>
          ${isBackground ? `<button type="button" class="catalog-unmatched-upload-btn" data-kind="${kind}" data-id="${it.id}"${it.uploading ? ' disabled' : ''}>${it.uploading ? 'Uploading…' : '⬆ Upload & use'}</button>` : ''}
          ${it.uploadError ? `<span class="catalog-unmatched-upload-error" title="${catalogEscapeHtml(it.uploadError)}">⚠ failed</span>` : ''}
        </div>`,
        )
        .join('')}
    </div>`;
}

function catalogGarmentCardHtml(garment) {
  const invalid = garment.status === 'idle' && !garment.file;
  if (garment.previewUrl) {
    const badgeHtml = garment.status !== 'idle'
      ? `<span class="catalog-garment-badge redchief-status-badge ${CATALOG_STATUS_CLASS[garment.status] ?? 'muted'}">${CATALOG_STATUS_LABEL[garment.status] ?? garment.status}</span>`
      : '';
    return `
      <div class="catalog-garment-card upload-thumb" data-row="${garment.id}">
        <img src="${garment.previewUrl}" alt="${catalogEscapeHtml(garment.label)}" title="${catalogEscapeHtml(garment.label)}" />
        <button type="button" class="thumb-remove catalog-garment-remove" title="Remove" aria-label="Remove">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
        ${badgeHtml}
      </div>`;
  }
  return `
    <div class="catalog-garment-card upload-thumb catalog-garment-empty dropzone redchief-dropzone${invalid ? ' invalid' : ''}" data-row="${garment.id}" tabindex="0" title="Click or drop photo">
      <input type="file" class="catalog-garment-input" accept="image/*" hidden />
      <button type="button" class="thumb-remove catalog-garment-remove" title="Remove slot" aria-label="Remove slot">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
      <div class="catalog-empty-placeholder">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        <span>Add photo</span>
      </div>
    </div>`;
}

const CATALOG_STATUS_LABEL = {
  QUEUED: 'Queued',
  RUNNING: 'Running',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  PARTIAL: 'Partially failed',
  submitting: 'Submitting…',
};
const CATALOG_STATUS_CLASS = {
  QUEUED: 'warn',
  RUNNING: 'accent',
  COMPLETED: 'ok',
  FAILED: 'err',
  PARTIAL: 'warn',
  submitting: 'muted',
};

function catalogJobCellHtml(garment, run, job) {
  const poseLabel = catalogBatch.options?.poses.find((p) => p.slug === job.pose)?.label ?? job.pose;
  const bgLabel = catalogAssetListForKind('background').find((b) => b.slug === job.background)?.label ?? job.background;
  const badgeCls = CATALOG_STATUS_CLASS[job.status] ?? 'muted';
  const badgeLabel = CATALOG_STATUS_LABEL[job.status] ?? job.status;
  let inner = `<span class="catalog-result-label">${catalogEscapeHtml(poseLabel)} · ${catalogEscapeHtml(bgLabel)}</span> <span class="redchief-status-badge ${badgeCls}">${badgeLabel}</span>`;
  if (job.status === 'COMPLETED' && job.imageUrl) {
    inner += `<img src="${job.imageUrl}" data-row="${garment.id}" data-run="${run.id}" data-job="${job.jobId}" /><a href="${job.imageUrl}" target="_blank" rel="noopener" class="link-btn">Open</a>`;
  }
  if (job.status === 'FAILED' && job.error) {
    inner += `<span class="redchief-error-code">${catalogEscapeHtml(job.error)}</span>`;
  }
  return `<div class="redchief-result-cell">${inner}</div>`;
}

function catalogRunStatusHtml(garment, run) {
  const cls = CATALOG_STATUS_CLASS[run.status] ?? 'muted';
  const label = CATALOG_STATUS_LABEL[run.status] ?? run.status;
  let body = `<div class="catalog-run-header"><strong>${catalogEscapeHtml(run.runLabel)}</strong> <span class="redchief-status-badge ${cls}">${label}</span>`;
  if (run.error) body += ` <span class="redchief-error-code">${catalogEscapeHtml(run.error)}</span>`;
  body += `</div>`;
  if (run.jobs.length > 0) {
    body += `<div class="redchief-result-grid">${run.jobs.map((j) => catalogJobCellHtml(garment, run, j)).join('')}</div>`;
  }
  return `<div class="catalog-run">${body}</div>`;
}

function catalogGarmentStatusHtml(garment) {
  if (garment.status === 'idle') return '';
  const cls = CATALOG_STATUS_CLASS[garment.status] ?? 'muted';
  const label = CATALOG_STATUS_LABEL[garment.status] ?? garment.status;
  let body = `<span class="redchief-status-badge ${cls}">${label}</span>`;
  if (garment.error) body += ` <span class="redchief-error-code">${catalogEscapeHtml(garment.error)}</span>`;
  if (garment.status === 'FAILED' || garment.status === 'PARTIAL') {
    const failedCount = garment.runs.filter((r) => r.status === 'FAILED').length;
    body += ` <button type="button" class="btn-secondary btn-small catalog-row-retry-btn" data-row="${garment.id}">Retry ${failedCount} failed combination${failedCount === 1 ? '' : 's'}</button>`;
  }
  if (garment.runs.length > 0) {
    body += `<div class="catalog-runs">${garment.runs.map((r) => catalogRunStatusHtml(garment, r)).join('')}</div>`;
  }
  return `<div class="redchief-row-status">${body}</div>`;
}

function catalogResultsHtml() {
  const withRuns = catalogGarments.filter((g) => g.status !== 'idle' && (g.runs.length > 0 || g.error));
  if (withRuns.length === 0) return '';
  return `
    <div class="catalog-results-panel">
      <h3 class="catalog-results-title">Generation Results</h3>
      <div class="catalog-results-list">
        ${withRuns.map((g) => {
          const cls = CATALOG_STATUS_CLASS[g.status] ?? 'muted';
          const label = CATALOG_STATUS_LABEL[g.status] ?? g.status;
          const failedCount = g.runs.filter((r) => r.status === 'FAILED').length;
          return `
            <div class="catalog-result-row-card" data-row="${g.id}">
              <div class="catalog-result-row-header">
                ${g.previewUrl ? `<img class="catalog-result-row-thumb" src="${g.previewUrl}" alt="${catalogEscapeHtml(g.label)}" />` : ''}
                <div class="catalog-result-row-info">
                  <span class="catalog-result-row-name">${catalogEscapeHtml(g.label)}</span>
                  <span class="redchief-status-badge ${cls}">${label}</span>
                </div>
                ${(g.status === 'FAILED' || g.status === 'PARTIAL') ? `
                  <button type="button" class="btn-secondary btn-small catalog-row-retry-btn" data-row="${g.id}">
                    Retry ${failedCount} failed combination${failedCount === 1 ? '' : 's'}
                  </button>` : ''}
              </div>
              ${g.error ? `<p class="redchief-error-code">${catalogEscapeHtml(g.error)}</p>` : ''}
              ${g.runs.length > 0 ? `<div class="catalog-runs">${g.runs.map((r) => catalogRunStatusHtml(g, r)).join('')}</div>` : ''}
            </div>`;
        }).join('')}
      </div>
    </div>`;
}

function catalogSubmittableGarments() {
  return catalogGarments.filter((g) => g.status === 'idle' && g.file);
}

function updateCatalogSubmitEnabled() {
  const submittable = catalogSubmittableGarments();
  const valid = catalogBatchIsValid();
  catalogSubmitBtn.disabled = submittable.length === 0 || !valid;
  if (submittable.length === 0 || !valid) {
    catalogSubmitBtn.textContent = 'Generate';
    return;
  }
  const runsPerGarment = catalogRunCount();
  // No more 12-cap — see submitCatalogGarments' comment. Every selected
  // pose×background pair actually gets submitted now.
  const jobsPerRun = catalogComputeLooks().length;
  const totalCalls = runsPerGarment * submittable.length;
  const totalJobs = jobsPerRun * totalCalls;
  catalogSubmitBtn.textContent = `Generate ${totalJobs} job${totalJobs === 1 ? '' : 's'} (${submittable.length} garment${submittable.length === 1 ? '' : 's'}, ${runsPerGarment} combination${runsPerGarment === 1 ? '' : 's'} each)`;
}

/** Single full re-render, same "blow away and rebuild" style as redchief.js — covers both the shared config panel and the garment cards, since either one's state can affect the other (garment count feeds the config panel's job-count summary; config validity feeds each garment card's Generate-readiness). */
function renderCatalog() {
  catalogSubmitConfirmEl.hidden = true; // any change invalidates a pending submit confirmation
  catalogConfigBodyEl.innerHTML = catalogConfigFieldsHtml();
  wireCatalogConfigEvents();
  catalogRowsEl.innerHTML = catalogGarments.map(catalogGarmentCardHtml).join('');
  if (catalogResultsEl) {
    catalogResultsEl.innerHTML = catalogResultsHtml();
  }
  wireCatalogGarmentEvents();
  catalogRowsPanelEl.hidden = catalogGarments.length === 0;
  catalogFooterBarEl.hidden = catalogGarments.length === 0;
  if (catalogGarments.length > 0) catalogRowCountEl.textContent = `${catalogGarments.length} garment${catalogGarments.length === 1 ? '' : 's'}`;
  updateCatalogSubmitEnabled();
}

/** Resets the batch's asset selections — shared by the gender and garment-type change handlers below, since both invalidate the previously-loaded options list (gender scopes the whole asset pool; garment type narrows pose/lower/shoe compatibility within it) and any slug picked against the old list may not even exist in the new one. */
function catalogResetBatchSelections() {
  catalogBatch.faces = new Set();
  catalogBatch.lowers = new Set();
  catalogBatch.shoes = new Set();
  catalogBatch.poses = new Set();
  catalogBatch.backgrounds = new Set();
  catalogBatch.options = null;
  // A previous folder-match's status text ("Matched 4 of 5 files…") refers
  // to the asset list that's about to be thrown away — leaving it up would
  // read as still describing the new (unrelated) list once options reload.
  catalogAssetFolderStatus = { face: null, lower: null, shoe: null, pose: null, background: null };
  // Unmatched previews are also scoped to the asset list just invalidated —
  // revoke their object URLs (they'd otherwise leak for the rest of the tab's
  // lifetime) and drop them along with everything else.
  for (const kind of Object.keys(catalogAssetFolderUnmatched)) {
    for (const item of catalogAssetFolderUnmatched[kind]) URL.revokeObjectURL(item.previewUrl);
  }
  catalogAssetFolderUnmatched = { face: [], lower: [], shoe: [], pose: [], background: [] };
}

const CATALOG_ASSET_SET_KEY = { face: 'faces', lower: 'lowers', shoe: 'shoes', pose: 'poses', background: 'backgrounds' };

function wireCatalogConfigEvents() {
  for (const btn of catalogConfigBodyEl.querySelectorAll('#catalog-gender-pills .segmented-pill')) {
    btn.addEventListener('click', () => {
      const val = btn.dataset.value;
      if (catalogBatch.gender === val) return;
      catalogBatch.gender = val;
      catalogBatch.garmentType = '';
      catalogResetBatchSelections();
      loadCatalogBatchOptions();
    });
  }

  for (const btn of catalogConfigBodyEl.querySelectorAll('#catalog-garment-type-pills .segmented-pill')) {
    btn.addEventListener('click', () => {
      const val = btn.dataset.value;
      if (catalogBatch.garmentType === val) return;
      catalogBatch.garmentType = val;
      catalogResetBatchSelections();
      loadCatalogBatchOptions();
    });
  }

  for (const btn of catalogConfigBodyEl.querySelectorAll('#catalog-aspect-pills .segmented-pill')) {
    btn.addEventListener('click', () => {
      const val = btn.dataset.value;
      if (catalogBatch.aspectRatio === val) return;
      catalogBatch.aspectRatio = val;
      renderCatalog();
    });
  }

  for (const card of catalogConfigBodyEl.querySelectorAll('.catalog-asset-card')) {
    card.addEventListener('click', () => {
      const kind = card.dataset.kind;
      const slug = card.dataset.slug;
      const meta = CATALOG_ASSET_METADATA[kind];
      if (!meta) return;
      const set = catalogBatch[meta.setKey];
      if (set.has(slug)) set.delete(slug);
      else set.add(slug);
      renderCatalog(); // every asset axis affects validity and/or the combination/job-count summary
    });
  }

  // :not(.catalog-select-all-btn) — the select-all button reuses
  // .catalog-view-more-btn's pill styling but must NOT open the modal, it
  // has its own handler right below.
  for (const btn of catalogConfigBodyEl.querySelectorAll('.catalog-view-more-btn:not(.catalog-select-all-btn), .catalog-asset-more-card')) {
    btn.addEventListener('click', () => {
      openCatalogAssetModal(btn.dataset.kind);
    });
  }

  // Per-section "Select all (N)" / "Clear all" toggle — selects/clears
  // EVERY item in the full library for that kind, not just the paginated
  // visible subset (catalogBatch.options[...] is the full list either way).
  for (const btn of catalogConfigBodyEl.querySelectorAll('.catalog-select-all-btn')) {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.kind;
      const meta = CATALOG_ASSET_METADATA[kind];
      if (!meta) return;
      const items = catalogAssetListForKind(kind); // includes self-uploaded backgrounds for kind === 'background'
      const set = catalogBatch[meta.setKey];
      if (btn.dataset.action === 'clear') set.clear();
      else for (const item of items) set.add(item.slug);
      renderCatalog();
    });
  }

  // Unmatched-preview ×: purely dismisses that one preview tile (revoking its
  // object URL) — there's no Set entry to touch, these were never selectable.
  for (const removeBtn of catalogConfigBodyEl.querySelectorAll('.catalog-unmatched-thumb-remove')) {
    removeBtn.addEventListener('click', () => {
      const thumb = removeBtn.closest('.catalog-unmatched-thumb');
      const kind = thumb.dataset.kind;
      const item = catalogAssetFolderUnmatched[kind].find((it) => it.id === thumb.dataset.id);
      if (item) URL.revokeObjectURL(item.previewUrl);
      catalogAssetFolderUnmatched[kind] = catalogAssetFolderUnmatched[kind].filter((it) => it.id !== thumb.dataset.id);
      renderCatalog();
    });
  }

  // Asset thumbnailUrls are presigned (1h TTL — see the network probe that
  // confirmed this) — a picker left open past that, or a genuine network
  // blip, makes the <img> fail to load. Left alone, a failed <img> shows the
  // browser's own broken-image glyph. Swap in the .broken class instead (see
  // the CSS) so it just quietly drops the thumbnail and reads as a clean
  // labeled tile.
  for (const img of catalogConfigBodyEl.querySelectorAll('.catalog-asset-card img')) {
    img.addEventListener('error', () => img.classList.add('broken'), { once: true });
  }

  for (const btn of catalogConfigBodyEl.querySelectorAll('.catalog-asset-folder-btn')) {
    const input = catalogConfigBodyEl.querySelector(`.catalog-asset-folder-input[data-kind="${btn.dataset.kind}"]`);
    btn.addEventListener('click', () => input.click());
  }
  for (const input of catalogConfigBodyEl.querySelectorAll('.catalog-asset-folder-input')) {
    input.addEventListener('change', () => {
      if (input.files.length > 0) handleCatalogAssetFolderFiles(input.dataset.kind, input.files);
      input.value = ''; // same folder can be re-picked later (e.g. after adding more files to it) without this no-op-ing on an unchanged FileList
    });
  }

  // Background-only "Upload new background(s)" — see catalogBackgroundUploadControlHtml.
  const bgUploadBtn = catalogConfigBodyEl.querySelector('.catalog-bg-upload-btn');
  if (bgUploadBtn) {
    const bgUploadInput = catalogConfigBodyEl.querySelector('.catalog-bg-upload-input');
    bgUploadBtn.addEventListener('click', () => bgUploadInput.click());
    bgUploadInput.addEventListener('change', () => {
      if (bgUploadInput.files.length > 0) handleCatalogBackgroundUploadFiles(bgUploadInput.files);
      bgUploadInput.value = '';
    });
  }

  // Per-tile "Upload & use" on the unmatched-preview grid — background only,
  // see catalogUnmatchedThumbsHtml. stopPropagation isn't needed here (this
  // button isn't nested inside anything with its own click handler), unlike
  // the dismiss ×.
  for (const uploadBtn of catalogConfigBodyEl.querySelectorAll('.catalog-unmatched-upload-btn')) {
    uploadBtn.addEventListener('click', () => uploadUnmatchedBackgroundTile(uploadBtn.dataset.kind, uploadBtn.dataset.id));
  }
}

function openCatalogAssetModal(kind) {
  const meta = CATALOG_ASSET_METADATA[kind];
  if (!meta || !catalogBatch.options) return;

  catalogModalState.isOpen = true;
  catalogModalState.kind = kind;
  catalogModalState.activeFilter = 'All';

  catalogModalTitleEl.textContent = `Select ${meta.title}`;

  const tags = CATALOG_FILTER_TAGS[kind] ?? ['All'];
  if (tags.length > 1) {
    catalogModalFilterChipsEl.innerHTML = tags.map((tag) => `
      <button type="button" class="catalog-modal-chip${tag === 'All' ? ' active' : ''}" data-tag="${catalogEscapeHtml(tag)}">
        ${catalogEscapeHtml(tag)}
      </button>
    `).join('');
    if (catalogModalToolbarEl) catalogModalToolbarEl.hidden = false;
  } else {
    catalogModalFilterChipsEl.innerHTML = '';
    if (catalogModalToolbarEl) catalogModalToolbarEl.hidden = true;
  }

  updateCatalogModalCounter();
  renderCatalogModalGrid();

  catalogModalOverlayEl.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeCatalogAssetModal() {
  if (!catalogModalState.isOpen) return;
  catalogModalState.isOpen = false;
  catalogModalState.kind = null;
  catalogModalOverlayEl.hidden = true;
  document.body.style.overflow = '';
  renderCatalog();
}

function updateCatalogModalCounter() {
  const kind = catalogModalState.kind;
  if (!kind) return;
  const setKey = CATALOG_ASSET_METADATA[kind].setKey;
  const count = catalogBatch[setKey].size;
  catalogModalCounterEl.textContent = `${count} selected`;
  catalogModalClearBtn.disabled = count === 0;
}

/** The modal grid's filter logic, shared by the grid render and the "Select
 * all" button so the two can never disagree about which items are "currently
 * shown" — returns [] if the modal isn't open on a known kind. */
function catalogModalFilteredItems() {
  const kind = catalogModalState.kind;
  if (!kind || !catalogBatch.options) return [];

  const allItems = catalogAssetListForKind(kind); // includes self-uploaded backgrounds for kind === 'background'
  const filterTag = catalogModalState.activeFilter;

  return allItems.filter((item) => {
    if (filterTag && filterTag !== 'All') {
      const tagLower = filterTag.toLowerCase();
      const matchLabel = item.label && item.label.toLowerCase().includes(tagLower);
      const matchSlug = item.slug && item.slug.toLowerCase().includes(tagLower);
      if (!matchLabel && !matchSlug) return false;
    }
    return true;
  });
}

function renderCatalogModalGrid() {
  const kind = catalogModalState.kind;
  if (!kind || !catalogBatch.options) return;

  const meta = CATALOG_ASSET_METADATA[kind];
  const set = catalogBatch[meta.setKey];
  const filtered = catalogModalFilteredItems();

  if (filtered.length === 0) {
    catalogModalGridEl.innerHTML = '';
    catalogModalEmptyEl.hidden = false;
  } else {
    catalogModalEmptyEl.hidden = true;
    catalogModalGridEl.innerHTML = filtered.map((item) => {
      const isSelected = set.has(item.slug);
      return catalogAssetTileHtml(kind, item, isSelected, meta.aspect);
    }).join('');
  }
}

let catalogModalEventsInitialized = false;
function initCatalogModalEvents() {
  if (catalogModalEventsInitialized || !catalogModalOverlayEl) return;
  catalogModalEventsInitialized = true;

  catalogModalCloseBtn.addEventListener('click', closeCatalogAssetModal);
  catalogModalDoneBtn.addEventListener('click', closeCatalogAssetModal);
  catalogModalOverlayEl.addEventListener('click', (e) => {
    if (e.target === catalogModalOverlayEl) closeCatalogAssetModal();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && catalogModalState.isOpen) closeCatalogAssetModal();
  });

  catalogModalFilterChipsEl.addEventListener('click', (e) => {
    const chip = e.target.closest('.catalog-modal-chip');
    if (!chip) return;
    const tag = chip.dataset.tag;
    if (catalogModalState.activeFilter === tag) return;
    catalogModalState.activeFilter = tag;
    for (const c of catalogModalFilterChipsEl.querySelectorAll('.catalog-modal-chip')) {
      c.classList.toggle('active', c.dataset.tag === tag);
    }
    renderCatalogModalGrid();
  });

  catalogModalGridEl.addEventListener('click', (e) => {
    const card = e.target.closest('.catalog-asset-card');
    if (!card) return;
    const kind = card.dataset.kind;
    const slug = card.dataset.slug;
    const meta = CATALOG_ASSET_METADATA[kind];
    if (!meta) return;
    const set = catalogBatch[meta.setKey];

    if (set.has(slug)) {
      set.delete(slug);
      card.classList.remove('selected');
    } else {
      set.add(slug);
      card.classList.add('selected');
    }
    updateCatalogModalCounter();
  });

  catalogModalClearBtn.addEventListener('click', () => {
    const kind = catalogModalState.kind;
    if (!kind) return;
    const setKey = CATALOG_ASSET_METADATA[kind].setKey;
    catalogBatch[setKey].clear();
    for (const card of catalogModalGridEl.querySelectorAll('.catalog-asset-card.selected')) {
      card.classList.remove('selected');
    }
    updateCatalogModalCounter();
  });

  // Deliberate asymmetry with "Deselect all" above: this only selects the
  // currently-FILTERED tiles (e.g. just the Studio backgrounds when that
  // chip is active), while Deselect all always clears the whole set for
  // this kind regardless of filter — matches each button's own scope.
  catalogModalSelectAllBtn?.addEventListener('click', () => {
    const kind = catalogModalState.kind;
    if (!kind) return;
    const setKey = CATALOG_ASSET_METADATA[kind].setKey;
    const set = catalogBatch[setKey];
    for (const item of catalogModalFilteredItems()) set.add(item.slug);
    for (const card of catalogModalGridEl.querySelectorAll('.catalog-asset-card')) {
      card.classList.add('selected');
    }
    updateCatalogModalCounter();
  });
}

function wireCatalogGarmentEvents() {
  for (const card of catalogRowsEl.querySelectorAll('.catalog-garment-card')) {
    const garmentId = card.dataset.row;
    const garment = catalogFindGarment(garmentId);
    if (!garment) continue;

    const removeBtn = card.querySelector('.catalog-garment-remove');
    if (removeBtn) {
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeCatalogGarment(garmentId);
      });
    }

    const dz = card.querySelector('.catalog-garment-empty');
    if (dz) {
      const input = card.querySelector('.catalog-garment-input');
      dz.addEventListener('click', (e) => {
        if (e.target.closest('.catalog-garment-remove')) return;
        if (e.target.tagName === 'INPUT') return;
        input.click();
      });
      dz.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') input.click();
      });
      dz.addEventListener('dragover', (e) => e.preventDefault());
      dz.addEventListener('drop', (e) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (file) setCatalogGarmentFile(garmentId, file);
      });
      input.addEventListener('change', () => {
        const file = input.files[0];
        if (file) setCatalogGarmentFile(garmentId, file);
        input.value = '';
      });
    }
  }

  if (catalogResultsEl) {
    for (const retryBtn of catalogResultsEl.querySelectorAll('.catalog-row-retry-btn')) {
      retryBtn.addEventListener('click', () => retryCatalogGarment(retryBtn.dataset.row));
    }
    for (const img of catalogResultsEl.querySelectorAll('.redchief-result-cell img')) {
      img.addEventListener('error', () => refreshCatalogGarmentRun(img.dataset.row, img.dataset.run, img.dataset.job));
    }
  }
}

function catalogFileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

catalogSubmitBtn.addEventListener('click', () => {
  const submittable = catalogSubmittableGarments();
  if (submittable.length === 0 || !catalogBatchIsValid()) return;
  const runsPerGarment = catalogRunCount();
  // No more 12-cap — see submitCatalogGarments' comment. Every selected
  // pose×background pair actually gets submitted, one upstream call at a
  // time (throttled server-side), not batched 12-per-call.
  const jobsPerRun = catalogComputeLooks().length;
  const totalCombinations = runsPerGarment * submittable.length;
  const totalJobs = jobsPerRun * totalCombinations;
  // Credit cost per job is resolution-dependent and set by admin config —
  // it isn't exposed by any dev-API response (see the catalog API contract),
  // so this warns honestly about spending real credits without inventing a
  // number the tool can't actually verify.
  const scaleNote = totalJobs > 200
    ? ` This is a large batch — at the current concurrency limit it will take a while to fully process; the queue banner will show live progress and can be paused/resumed.`
    : '';
  catalogSubmitConfirmTextEl.textContent =
    `This will submit ${totalCombinations} combination${totalCombinations === 1 ? '' : 's'} across ${submittable.length} garment${submittable.length === 1 ? '' : 's'} ` +
    `(${totalJobs} job${totalJobs === 1 ? '' : 's'} total, ${jobsPerRun} pose×background pair${jobsPerRun === 1 ? '' : 's'} each) against PRODUCTION. ` +
    `Exact credit cost per job depends on the selected resolution and is set by admin config (not shown here).${scaleNote} This can't be undone. Continue?`;
  catalogSubmitConfirmEl.hidden = false;
});

catalogSubmitConfirmCancelBtn.addEventListener('click', () => {
  catalogSubmitConfirmEl.hidden = true;
});

catalogSubmitConfirmBtn.addEventListener('click', () => {
  catalogSubmitConfirmEl.hidden = true;
  submitCatalogGarments();
});

/** Submits every submittable garment as ONE whole Catalog Batch — a single
 * POST to /api/catalog/batch/start — instead of N independent
 * /api/catalog/generate calls racing each other for the shared throttler.
 * This is what lets a second Generate click while one batch is already
 * running QUEUE behind it (server-side whole-batch queue) rather than
 * interleave with it. A garment whose local file fails to read is marked
 * FAILED and left out of the request entirely (no network call, no upstream
 * spend for it); every other garment still goes in the same request so they
 * queue/run together as one batch. */
async function submitCatalogGarments() {
  const submittable = catalogSubmittableGarments();
  if (submittable.length === 0 || !catalogBatchIsValid()) return;
  // Used to be .slice(0, 12) — that cap dated from when the client packed
  // multiple looks into a single upstream generate call (max 12 per call).
  // The server's runCatalogAggregate has always fanned each look out to its
  // own upstream call one at a time instead, so the cap was silently
  // dropping most of a large background selection for no real reason. Send
  // the full set; validateCatalogSharedFields still enforces a sane upper
  // bound (5000) server-side against a catastrophic accidental selection.
  const looks = catalogComputeLooks();
  const templates = catalogBuildRunTemplates(); // same combination set applied to every garment
  for (const garment of submittable) garment.status = 'submitting';
  renderCatalog();

  const reads = await Promise.allSettled(submittable.map((garment) => catalogFileToDataUrl(garment.file)));
  const included = []; // [{garment, garmentDataUrl}] — only garments whose file actually read
  for (let i = 0; i < submittable.length; i++) {
    const garment = submittable[i];
    const read = reads[i];
    if (read.status === 'rejected') {
      garment.status = 'FAILED';
      garment.error = read.reason instanceof Error ? read.reason.message : String(read.reason);
      continue;
    }
    garment.runs = templates.map((t) => ({
      id: catalogUid('run'),
      ...t,
      catalogueId: null,
      jobs: [],
      status: 'submitting',
      error: null,
      pollTimer: null,
      pollToken: 0,
    }));
    garment.error = null;
    included.push({ garment, garmentDataUrl: read.value });
  }
  renderCatalog();
  if (included.length === 0) return; // every file failed to read locally — nothing to send

  try {
    const res = await fetch('/api/catalog/batch/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gender: catalogBatch.gender,
        garmentType: catalogBatch.garmentType || undefined,
        // Cosmetic only (queue banner's category chip) — falls back to the
        // slug server-side if this lookup ever comes up empty.
        garmentTypeLabel: catalogBatch.options?.garmentTypes?.find((t) => t.slug === catalogBatch.garmentType)?.label,
        aspectRatio: catalogBatch.aspectRatio,
        resolution: catalogBatch.resolution,
        // poseLabel/backgroundLabel/*ThumbnailUrl ride along for the
        // server's benefit only (the Results page's dedicated Catalog row)
        // — see webapp/server.mts's buildCatalogJobStubs.
        looks: looks.map((l) => ({
          ...l,
          poseLabel: catalogPoseLabel(l),
          backgroundLabel: catalogBackgroundLabel(l),
          poseThumbnailUrl: catalogBatch.options?.poses.find((p) => p.slug === l.pose)?.thumbnailUrl,
          backgroundThumbnailUrl: catalogAssetListForKind('background').find((b) => b.slug === l.background)?.thumbnailUrl,
        })),
        garments: included.map(({ garment, garmentDataUrl }) => ({
          garmentId: garment.id,
          garmentDataUrl,
          garmentLabel: garment.label,
          runs: garment.runs.map((run) => ({
            runId: run.id,
            face: run.face,
            faceLabel: run.faceLabel,
            faceThumbnailUrl: run.faceThumbnailUrl,
            lower: run.lower,
            lowerLabel: run.lowerLabel,
            lowerThumbnailUrl: run.lowerThumbnailUrl,
            shoe: run.shoe,
            shoeLabel: run.shoeLabel,
            shoeThumbnailUrl: run.shoeThumbnailUrl,
            runLabel: run.runLabel,
          })),
        })),
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`${body.error?.code ?? res.status}: ${body.error?.message ?? 'request failed'}`);

    const byGarmentId = new Map(body.garments.map((g) => [g.garmentId, g]));
    for (const { garment } of included) {
      const echoedGarment = byGarmentId.get(garment.id);
      const byRunId = new Map((echoedGarment?.runs ?? []).map((r) => [r.runId, r]));
      for (const run of garment.runs) {
        const echoedRun = byRunId.get(run.id);
        if (!echoedRun) {
          run.status = 'FAILED';
          run.error = 'Server did not echo this run back — treating as failed.';
          continue;
        }
        run.catalogueId = echoedRun.catalogueId;
        // Every job stub starts QUEUED whether or not the whole batch itself
        // is queued behind another one — pollCatalogRun already derives the
        // right RUNNING/QUEUED display state from the jobs themselves.
        run.jobs = echoedRun.jobs.map((j) => ({ ...j, status: 'QUEUED' }));
        run.status = 'QUEUED';
        pollCatalogRun(garment, run);
      }
      catalogUpdateGarmentAggregateStatus(garment);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    for (const { garment } of included) {
      garment.status = 'FAILED';
      garment.error = message;
    }
  }
  catalogStartBatchPolling();
  renderCatalog();
}

async function submitCatalogRun(garment, run, garmentDataUrl, looks) {
  try {
    const payload = {
      garment: garmentDataUrl,
      gender: catalogBatch.gender,
      face: run.face,
      // poseLabel/backgroundLabel/*ThumbnailUrl ride along for the server's
      // benefit only (the Results page's dedicated Catalog row) — see
      // webapp/server.mts's POST /api/catalog/generate doc comment on why
      // the server now records each look's result itself instead of
      // waiting on this client to notice and report it.
      looks: looks.map((l) => ({
        ...l,
        poseLabel: catalogPoseLabel(l),
        backgroundLabel: catalogBackgroundLabel(l),
        poseThumbnailUrl: catalogBatch.options?.poses.find((p) => p.slug === l.pose)?.thumbnailUrl,
        backgroundThumbnailUrl: catalogBatch.options?.backgrounds.find((b) => b.slug === l.background)?.thumbnailUrl,
      })),
      garmentType: catalogBatch.garmentType || undefined,
      lower: run.lower,
      shoe: run.shoe,
      aspectRatio: catalogBatch.aspectRatio,
      resolution: catalogBatch.resolution,
      garmentLabel: garment.label,
      runLabel: run.runLabel,
      faceLabel: run.faceLabel,
      faceThumbnailUrl: run.faceThumbnailUrl,
      lowerLabel: run.lowerLabel,
      lowerThumbnailUrl: run.lowerThumbnailUrl,
      shoeLabel: run.shoeLabel,
      shoeThumbnailUrl: run.shoeThumbnailUrl,
    };
    const res = await fetch('/api/catalog/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`${body.error?.code ?? res.status}: ${body.error?.message ?? 'request failed'}`);
    run.catalogueId = body.catalogueId;
    run.jobs = body.jobs.map((j) => ({ ...j, status: 'QUEUED' }));
    run.status = 'RUNNING';
    pollCatalogRun(garment, run);
  } catch (err) {
    run.status = 'FAILED';
    run.error = err instanceof Error ? err.message : String(err);
  }
  catalogUpdateGarmentAggregateStatus(garment);
  renderCatalog();
}

/** A garment's status is purely derived from its runs' statuses — RUNNING if anything is still in flight, else COMPLETED only if every run's every job completed, FAILED only if every run failed outright, PARTIAL for anything in between. */
function catalogUpdateGarmentAggregateStatus(garment) {
  if (garment.runs.length === 0) return;
  // Every run's jobs are still QUEUED — the whole batch this garment belongs
  // to hasn't started yet (or is waiting behind another queued batch).
  if (garment.runs.every((r) => r.status === 'QUEUED')) {
    garment.status = 'QUEUED';
    return;
  }
  if (garment.runs.some((r) => r.status === 'submitting' || r.status === 'RUNNING' || r.status === 'QUEUED')) {
    garment.status = 'RUNNING';
    return;
  }
  const allCompleted = garment.runs.every((r) => r.status === 'COMPLETED');
  const allFailed = garment.runs.every((r) => r.status === 'FAILED');
  garment.status = allCompleted ? 'COMPLETED' : allFailed ? 'FAILED' : 'PARTIAL';
}

function catalogPoseLabel(job) {
  return catalogBatch.options?.poses.find((p) => p.slug === job.pose)?.label ?? job.pose;
}
function catalogBackgroundLabel(job) {
  return catalogAssetListForKind('background').find((b) => b.slug === job.background)?.label ?? job.background;
}

// Catalog results used to be reported to the Results page's DB from here,
// client-side, the first time a poll noticed a job go terminal — but that
// meant a result the server had already finished (and spent credits on)
// could be lost for good if this tab closed or the server restarted before
// the next poll tick caught up to it. The server now records each look's
// result itself, synchronously, the instant its own poll loop (inside
// runCatalogAggregate) observes the terminal state — see that function's
// doc comment in webapp/server.mts. Nothing left to do here but keep
// reflecting run.jobs into the UI as it already did.

function pollCatalogRun(garment, run, attempt = 0, delay = 3000) {
  const maxAttempts = 30;
  const maxDelay = 20000;
  const token = run.pollToken;

  fetch(`/api/catalog/catalogues/${run.catalogueId}`)
    .then((res) => res.json().then((body) => ({ ok: res.ok, body })))
    .then(({ ok, body }) => {
      if (token !== run.pollToken) return; // superseded by a retry — discard
      if (!ok) throw new Error(`${body.error?.code ?? 'ERROR'}: ${body.error?.message ?? 'poll failed'}`);

      run.jobs = body.jobs;
      const allDone = run.jobs.every((j) => j.status === 'COMPLETED' || j.status === 'FAILED');
      if (allDone) {
        const allFailed = run.jobs.every((j) => j.status === 'FAILED');
        const anyFailed = run.jobs.some((j) => j.status === 'FAILED');
        run.status = allFailed ? 'FAILED' : anyFailed ? 'PARTIAL' : 'COMPLETED';
        catalogUpdateGarmentAggregateStatus(garment);
        renderCatalog();
        return;
      }
      // Every job stub starts life QUEUED the moment the batch-start request
      // responds, whether or not the whole batch itself is still waiting in
      // line — only flip to RUNNING once the upstream call has actually
      // been dispatched for at least one job (see runCatalogAggregate).
      run.status = run.jobs.every((j) => j.status === 'QUEUED') ? 'QUEUED' : 'RUNNING';
      catalogUpdateGarmentAggregateStatus(garment);
      renderCatalog();
      if (attempt >= maxAttempts) return; // give up quietly — run stays RUNNING, tester can check back
      run.pollTimer = setTimeout(() => pollCatalogRun(garment, run, attempt + 1, Math.min(delay * 1.5, maxDelay)), delay);
    })
    .catch((err) => {
      if (token !== run.pollToken) return;
      run.status = 'FAILED';
      run.error = err instanceof Error ? err.message : String(err);
      catalogUpdateGarmentAggregateStatus(garment);
      renderCatalog();
    });
}

const catalogRefreshedJobs = new Set(); // one auto-retry per job per completed result, avoids a hot loop against a permanently-broken (or expired-presigned) URL

async function refreshCatalogGarmentRun(garmentId, runId, jobId) {
  const garment = catalogFindGarment(garmentId);
  const run = garment?.runs.find((r) => r.id === runId);
  if (!run || !run.catalogueId) return;
  if (catalogRefreshedJobs.has(jobId)) return;
  catalogRefreshedJobs.add(jobId);
  try {
    // imageUrl is a 900s-TTL presigned URL — if the tester left this tab open
    // past that, a full status refetch is the only way to get a fresh one.
    const res = await fetch(`/api/catalog/catalogues/${run.catalogueId}`);
    const body = await res.json();
    if (res.ok) {
      run.jobs = body.jobs;
      renderCatalog();
    }
  } catch {
    // best-effort — leave the broken thumbnail if this also fails
  }
}

/** Re-submits only the FAILED runs (combinations) for a garment — a COMPLETED or still-RUNNING run is left untouched, so a partially-successful garment never re-spends credits on a combination that already succeeded. */
function retryCatalogGarment(garmentId) {
  const garment = catalogFindGarment(garmentId);
  if (!garment || (garment.status !== 'FAILED' && garment.status !== 'PARTIAL')) return;
  const failedRuns = garment.runs.filter((r) => r.status === 'FAILED');
  if (failedRuns.length === 0) return;

  catalogFileToDataUrl(garment.file)
    .then((garmentDataUrl) => {
      // See submitCatalogGarments' comment — the 12-cap here was the same
      // vestigial artifact and is removed for the same reason.
      const looks = catalogComputeLooks();
      for (const run of failedRuns) {
        run.pollToken++; // discard any stale continuation from the failed attempt
        if (run.pollTimer) clearTimeout(run.pollTimer);
        run.pollTimer = null;
        run.catalogueId = null;
        run.jobs = [];
        run.error = null;
        run.status = 'submitting';
      }
      garment.status = 'RUNNING';
      renderCatalog();
      return Promise.allSettled(failedRuns.map((run) => submitCatalogRun(garment, run, garmentDataUrl, looks)));
    })
    .catch((err) => {
      garment.error = err instanceof Error ? err.message : String(err);
      renderCatalog();
    });
}

// ---------- whole-batch queue banner (mirrors app.js's renderUploadRunBanner
// / pollRunStatus / startPolling / stopPolling for the Upload view's queue,
// but against /api/catalog/batch/* instead of /api/run/*) ----------

let catalogPollHandle = null;

// Reuses app.js's queuedCategoriesHtml (both scripts share one global scope
// — see index.html's plain, non-module <script> tags) rather than
// duplicating its "one chip per category, em-dash for none" rendering.

function renderCatalogBatchBanner(status) {
  const queuedList = status?.queued ?? [];
  const running = status?.status === 'running';
  if (!running && queuedList.length === 0) {
    catalogRunBannerEl.hidden = true;
    catalogRunBannerEl.innerHTML = '';
    return;
  }
  catalogRunBannerEl.hidden = false;
  const runningLine = running
    ? `<div class="run-banner-item in-progress"><span class="run-spinner"></span><span>Batch in progress: <b>${status.completed + status.failed} / ${status.total}</b> (${status.completed} completed${status.failed ? `, ${status.failed} failed` : ''})</span></div>`
    : '';
  const canManage = currentUser?.role === 'superadmin';
  const queuedLines = queuedList
    .map((q, i) => {
      const badge = `<span class="queue-badge">#${i + 1}</span>`;
      const categories = queuedCategoriesHtml(q.categories);
      if (q.paused) {
        const resumeBtn = canManage ? ` <button type="button" class="link-btn" data-resume-catalog-queue-id="${q.id}">Resume</button>` : '';
        const cancelBtn = canManage ? ` <button type="button" class="link-btn danger" data-cancel-catalog-queue-id="${q.id}">Cancel</button>` : '';
        return `<div class="run-banner-item queued-line paused">${badge}<span>Paused: <b>${q.total} job(s)</b> — ${categories} (queued by ${q.queuedBy}) — won't start until resumed.</span>${resumeBtn}${cancelBtn}</div>`;
      }
      const pauseBtn = canManage ? ` <button type="button" class="link-btn" data-pause-catalog-queue-id="${q.id}">Pause</button>` : '';
      const cancelBtn = canManage ? ` <button type="button" class="link-btn danger" data-cancel-catalog-queue-id="${q.id}">Cancel</button>` : '';
      return `<div class="run-banner-item queued-line">${badge}<span>Queued: <b>${q.total} job(s)</b> — ${categories} (by ${q.queuedBy}) — will start automatically once turn arrives.</span>${pauseBtn}${cancelBtn}</div>`;
    })
    .join('');
  catalogRunBannerEl.innerHTML = runningLine + queuedLines;
}

// Delegated once (banner's innerHTML is fully replaced every poll tick, so
// per-button listeners would need rebinding anyway — delegating on the
// stable parent avoids that), same pattern as app.js's upload-run-banner.
catalogRunBannerEl?.addEventListener('click', (e) => {
  const cancelBtn = e.target.closest('[data-cancel-catalog-queue-id]');
  if (cancelBtn) return cancelCatalogQueuedBatch(cancelBtn.dataset.cancelCatalogQueueId);
  const pauseBtn = e.target.closest('[data-pause-catalog-queue-id]');
  if (pauseBtn) return pauseCatalogQueuedBatch(pauseBtn.dataset.pauseCatalogQueueId);
  const resumeBtn = e.target.closest('[data-resume-catalog-queue-id]');
  if (resumeBtn) return resumeCatalogQueuedBatch(resumeBtn.dataset.resumeCatalogQueueId);
});

async function cancelCatalogQueuedBatch(id) {
  if (!confirm('Cancel this queued batch? It will not start automatically.')) return;
  await fetch(`/api/catalog/batch/queue/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await catalogPollBatchStatus();
}

// No confirm() for pause/resume — unlike Cancel, both are fully reversible
// and never touch upstream (a paused batch just keeps its queue position).
async function pauseCatalogQueuedBatch(id) {
  await fetch(`/api/catalog/batch/queue/${encodeURIComponent(id)}/pause`, { method: 'POST' });
  await catalogPollBatchStatus();
}
async function resumeCatalogQueuedBatch(id) {
  await fetch(`/api/catalog/batch/queue/${encodeURIComponent(id)}/resume`, { method: 'POST' });
  await catalogPollBatchStatus();
}

async function catalogPollBatchStatus() {
  const res = await fetch('/api/catalog/batch/status');
  const status = await res.json();
  renderCatalogBatchBanner(status);
  const hasQueued = (status.queued ?? []).length > 0;
  if ((status.status === 'running' || hasQueued) && !catalogPollHandle) catalogStartBatchPolling();
  if (status.status !== 'running' && !hasQueued && catalogPollHandle) catalogStopBatchPolling();
  return status;
}
function catalogStartBatchPolling() {
  if (catalogPollHandle) return;
  catalogPollHandle = setInterval(catalogPollBatchStatus, 1500);
}
function catalogStopBatchPolling() {
  clearInterval(catalogPollHandle);
  catalogPollHandle = null;
}

initCatalogModalEvents();

