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
// batch, via the `looks` array, capped at 12 pairs) — so each garment fans
// out into one generate call PER (face, lower, shoe) combination under the
// hood: faces x max(lowers selected, 1) x max(shoes selected, 1) calls per
// garment, each producing up to 12 jobs. Leaving lower/shoe unselected isn't
// "0 combinations", it's "1 combination with neither" — that's what the
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
const catalogFooterBarEl = document.getElementById('catalog-footer-bar');
const catalogRowCountEl = document.getElementById('catalog-row-count');
const catalogSubmitBtn = document.getElementById('catalog-submit-btn');
const catalogSubmitConfirmEl = document.getElementById('catalog-submit-confirm');
const catalogSubmitConfirmTextEl = document.getElementById('catalog-submit-confirm-text');
const catalogSubmitConfirmCancelBtn = document.getElementById('catalog-submit-confirm-cancel-btn');
const catalogSubmitConfirmBtn = document.getElementById('catalog-submit-confirm-btn');

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
let catalogAssetFolderUnmatched = { face: [], lower: [], shoe: [], pose: [], background: [] }; // kind -> [{id, name, previewUrl}]

// Maps a picker `kind` to the CatalogAsset[] it draws from in the currently-
// loaded options, and to the Set key catalogBatch tracks selections in — the
// same two mappings CATALOG_ASSET_SET_KEY (defined below, tile click
// handling) and catalogAssetPickersHtml already need, kept in one place so a
// new axis can't be added to one and forgotten in the other.
function catalogAssetListForKind(kind) {
  const o = catalogBatch.options;
  if (!o) return [];
  if (kind === 'face') return o.faces;
  if (kind === 'lower') return o.lowerItems;
  if (kind === 'shoe') return o.shoeItems;
  if (kind === 'pose') return o.poses;
  if (kind === 'background') return o.backgrounds;
  return [];
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
  if (catalogLoaded) return;
  catalogLoaded = true;
  await loadCatalogBatchOptions();
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

function catalogNewGarment(file) {
  return {
    id: catalogUid('garment'),
    label: `Garment ${++catalogRowCounter}`,
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
  garment.file = file;
  garment.previewUrl = URL.createObjectURL(file);
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

/** Cross product of selected poses x selected backgrounds, in the order those assets appear in the loaded options list (not selection order) — deterministic regardless of click order. Callers cap this at 12 themselves (the API's own `looks`-per-call limit). */
function catalogComputeLooks() {
  if (!catalogBatch.options) return [];
  const poses = catalogBatch.options.poses.filter((p) => catalogBatch.poses.has(p.slug));
  const backgrounds = catalogBatch.options.backgrounds.filter((b) => catalogBatch.backgrounds.has(b.slug));
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

function catalogGarmentSlotHtml(garment) {
  if (garment.file) {
    return `
      <div class="dropzone redchief-dropzone redchief-slot-filled">
        <img class="redchief-slot-preview" src="${garment.previewUrl ?? ''}" />
        <button type="button" class="redchief-slot-clear" title="Clear">×</button>
      </div>`;
  }
  return `
    <div class="dropzone redchief-dropzone redchief-slot-empty" tabindex="0">
      <input type="file" class="catalog-garment-input" accept="image/*" hidden />
      <span class="icon">⬆</span>
      <span>Choose garment photo</span>
    </div>`;
}

function catalogAssetTileHtml(kind, asset, selected) {
  return `
    <label class="catalog-asset-item${selected ? ' selected' : ''}" data-kind="${kind}" data-slug="${asset.slug}">
      <input type="checkbox" hidden${selected ? ' checked' : ''} />
      <img src="${asset.thumbnailUrl}" alt="" loading="lazy" />
      <span>${catalogEscapeHtml(asset.label)}</span>
    </label>`;
}

function catalogLooksSummaryHtml() {
  const pairs = catalogComputeLooks();
  const totalPairs = pairs.length;
  const runsPerGarment = catalogRunCount();
  const garmentCount = catalogSubmittableGarments().length;
  if (totalPairs === 0 || runsPerGarment === 0) {
    return '<p class="catalog-looks-summary">Select at least one face, one pose, and one background to see how many jobs this creates.</p>';
  }
  const perRunJobs = Math.min(totalPairs, 12);
  const totalCalls = runsPerGarment * Math.max(garmentCount, 1);
  const totalJobs = perRunJobs * totalCalls;
  const overflow = totalPairs > 12;
  const overflowNote = overflow
    ? ` — the API allows at most 12 pose×background looks per generate call, so only the first 12 are used for EACH combination (${totalPairs - 12} dropped per call)`
    : '';
  const axisDesc = [`${garmentCount} garment(s)`, `${catalogBatch.faces.size} face(s)`];
  if (catalogBatch.lowers.size > 0) axisDesc.push(`${catalogBatch.lowers.size} lower(s)`);
  if (catalogBatch.shoes.size > 0) axisDesc.push(`${catalogBatch.shoes.size} shoe(s)`);
  axisDesc.push(`${catalogBatch.poses.size} pose(s)`, `${catalogBatch.backgrounds.size} background(s)`);
  return `<p class="catalog-looks-summary${overflow ? ' warn' : ''}">${axisDesc.join(' × ')}${overflowNote}. ` +
    `This creates ${totalCalls} generate call${totalCalls === 1 ? '' : 's'} — ${totalJobs} job${totalJobs === 1 ? '' : 's'} total across all garments.</p>`;
}

function catalogConfigFieldsHtml() {
  const garmentTypeOptions = (catalogBatch.options?.garmentTypes ?? [])
    .map((t) => `<option value="${t.slug}"${catalogBatch.garmentType === t.slug ? ' selected' : ''}>${catalogEscapeHtml(t.label)}</option>`)
    .join('');
  return `
    <div class="catalog-row-fields">
      <label>Gender
        <select id="catalog-gender-select">
          ${CATALOG_GENDERS.map((g) => `<option value="${g}"${catalogBatch.gender === g ? ' selected' : ''}>${CATALOG_GENDER_LABEL[g]}</option>`).join('')}
        </select>
      </label>
      <label>Garment type <span class="hint">(optional)</span>
        <select id="catalog-garment-type-select">
          <option value=""${catalogBatch.garmentType ? '' : ' selected'}>— any —</option>
          ${garmentTypeOptions}
        </select>
      </label>
      <label>Aspect ratio
        <select id="catalog-aspect-select">
          ${CATALOG_ASPECT_RATIOS.map((a) => `<option value="${a}"${catalogBatch.aspectRatio === a ? ' selected' : ''}>${a}</option>`).join('')}
        </select>
      </label>
      <label>Resolution
        <select id="catalog-resolution-select">
          ${CATALOG_RESOLUTIONS.map((r) => `<option value="${r}"${catalogBatch.resolution === r ? ' selected' : ''}>${r}</option>`).join('')}
        </select>
      </label>
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
 * Lives inside catalogAssetPickersHtml's per-section markup, wired in
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
 * "Here's everything currently selected for this axis" review grid —
 * regardless of whether an item got selected by a manual tile click or a
 * folder bulk-match. Exists because a folder match can silently check a
 * couple dozen tiles scattered across a big grid — nothing on the grid
 * itself makes "here's everything you're about to submit" easy to scan, and
 * there was no way to prune a bad match without hunting the exact tile down.
 *
 * Deliberately reuses the Upload tab's own .upload-thumbs/.upload-thumb/
 * .thumb-remove classes (large photo, red circular × badge overlapping the
 * top-right corner) rather than a bespoke smaller chip design, so a
 * tester's "here's what I just added, remove anything wrong" moment looks
 * and behaves the same whether they're looking at uploaded garment/person
 * photos or bulk-matched catalog assets. Clicking × just unchecks that one
 * asset (same effect as clicking its grid tile again) — it never touches
 * anything else, and — unlike the Upload tab's × (which deletes the file
 * server-side) — there's no file to delete here, this is a selection only.
 */
function catalogSelectedThumbsHtml(kind, assets, selectedSet) {
  if (selectedSet.size === 0) return '';
  const selected = assets.filter((a) => selectedSet.has(a.slug));
  return `
    <div class="upload-thumbs catalog-selected-thumbs">
      ${selected
        .map(
          (a) => `
        <div class="upload-thumb" data-kind="${kind}" data-slug="${a.slug}">
          <img src="${a.thumbnailUrl}" loading="lazy" title="${catalogEscapeHtml(a.label)}" />
          <button type="button" class="thumb-remove catalog-selected-thumb-remove" title="Remove ${catalogEscapeHtml(a.label)}" aria-label="Remove ${catalogEscapeHtml(a.label)}">×</button>
        </div>`,
        )
        .join('')}
    </div>`;
}

/**
 * Folder files that matched nothing in the curated library — shown as plain
 * photo previews (no checkbox, not part of any Set) so a folder upload never
 * silently hides files the tester dropped in. There is no way to wire these
 * into an actual generate call: the upstream catalog API only ever accepts
 * an EXISTING asset's slug for face/lower/shoe/pose/background (unlike
 * `garment`, which takes an arbitrary image) — see lib/api-client.mts's
 * CatalogGenerateBody and catalogMatchAssetsFromFiles's doc comment above.
 * The intended loop: browse these previews, pick the ones worth keeping,
 * add them as real assets via the aivastra admin panel, then they'll show up
 * (and match) here on the next folder upload.
 */
function catalogUnmatchedThumbsHtml(kind) {
  const items = catalogAssetFolderUnmatched[kind];
  if (!items || items.length === 0) return '';
  return `
    <p class="hint catalog-unmatched-label">Not in the asset library — preview only, can't be used to generate until added via the admin panel:</p>
    <div class="upload-thumbs catalog-unmatched-thumbs">
      ${items
        .map(
          (it) => `
        <div class="upload-thumb catalog-unmatched-thumb" data-kind="${kind}" data-id="${it.id}" title="${catalogEscapeHtml(it.name)}">
          <img src="${it.previewUrl}" loading="lazy" />
          <button type="button" class="thumb-remove catalog-unmatched-thumb-remove" title="Dismiss ${catalogEscapeHtml(it.name)}" aria-label="Dismiss ${catalogEscapeHtml(it.name)}">×</button>
        </div>`,
        )
        .join('')}
    </div>`;
}

function catalogAssetSectionHtml(kind, title, hint, assets, selectedSet) {
  const count = selectedSet.size > 0 ? ` <span class="catalog-asset-selected-count">${selectedSet.size} selected</span>` : '';
  return `
    <div class="catalog-asset-section">
      <div class="catalog-asset-section-label">${title}${hint ? ` <span class="hint">${hint}</span>` : ''}${count} ${catalogAssetFolderControlHtml(kind)}</div>
      ${catalogSelectedThumbsHtml(kind, assets, selectedSet)}
      ${catalogUnmatchedThumbsHtml(kind)}
      <div class="catalog-asset-grid">${assets.map((a) => catalogAssetTileHtml(kind, a, selectedSet.has(a.slug))).join('')}</div>
    </div>`;
}

function catalogAssetPickersHtml() {
  const o = catalogBatch.options;
  return `
    ${catalogAssetSectionHtml('face', 'Faces', '(select as many as you want to test — required)', o.faces, catalogBatch.faces)}
    ${catalogAssetSectionHtml('lower', 'Lower', '(optional — select any to test each, or leave empty for none)', o.lowerItems, catalogBatch.lowers)}
    ${catalogAssetSectionHtml('shoe', 'Shoe', '(optional — select any to test each, or leave empty for none)', o.shoeItems, catalogBatch.shoes)}
    ${catalogAssetSectionHtml('pose', 'Poses', '(select at least one)', o.poses, catalogBatch.poses)}
    ${catalogAssetSectionHtml('background', 'Backgrounds', '(select at least one)', o.backgrounds, catalogBatch.backgrounds)}
    ${catalogLooksSummaryHtml()}`;
}

function catalogGarmentCardHtml(garment) {
  const invalid = garment.status === 'idle' && !garment.file;
  return `
    <div class="redchief-row-card${invalid ? ' invalid' : ''}" data-row="${garment.id}">
      <div class="redchief-row-header">
        <span class="redchief-row-index">Garment</span>
        <input type="text" class="redchief-row-label-input" value="${catalogEscapeHtml(garment.label)}" />
        <button type="button" class="link-btn danger redchief-row-remove-btn" title="Remove">×</button>
      </div>
      <div class="redchief-slot catalog-garment-slot">
        <div class="redchief-slot-label">Garment photo</div>
        ${catalogGarmentSlotHtml(garment)}
      </div>
      ${invalid ? '<p class="redchief-validation-msg">Still needs a garment photo.</p>' : ''}
      ${catalogGarmentStatusHtml(garment)}
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
  const bgLabel = catalogBatch.options?.backgrounds.find((b) => b.slug === job.background)?.label ?? job.background;
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
    body += ` <button type="button" class="btn-secondary btn-small catalog-row-retry-btn">Retry ${failedCount} failed combination${failedCount === 1 ? '' : 's'}</button>`;
  }
  if (garment.runs.length > 0) {
    body += `<div class="catalog-runs">${garment.runs.map((r) => catalogRunStatusHtml(garment, r)).join('')}</div>`;
  }
  return `<div class="redchief-row-status">${body}</div>`;
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
  const jobsPerRun = Math.min(catalogComputeLooks().length, 12);
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
  document.getElementById('catalog-gender-select').addEventListener('change', (e) => {
    catalogBatch.gender = e.target.value;
    catalogBatch.garmentType = '';
    catalogResetBatchSelections();
    loadCatalogBatchOptions();
  });
  document.getElementById('catalog-garment-type-select').addEventListener('change', (e) => {
    catalogBatch.garmentType = e.target.value;
    catalogResetBatchSelections();
    loadCatalogBatchOptions();
  });
  document.getElementById('catalog-aspect-select').addEventListener('change', (e) => {
    catalogBatch.aspectRatio = e.target.value;
  });
  document.getElementById('catalog-resolution-select').addEventListener('change', (e) => {
    catalogBatch.resolution = e.target.value;
  });

  for (const tile of catalogConfigBodyEl.querySelectorAll('.catalog-asset-item')) {
    tile.addEventListener('click', (e) => {
      e.preventDefault(); // this is a <label>; default behavior would toggle the hidden checkbox redundantly with our own state
      const set = catalogBatch[CATALOG_ASSET_SET_KEY[tile.dataset.kind]];
      const slug = tile.dataset.slug;
      if (set.has(slug)) set.delete(slug);
      else set.add(slug);
      renderCatalog(); // every asset axis affects validity and/or the combination/job-count summary
    });
  }

  // Selected-thumbs review grid's × — same effect as unclicking the matching
  // grid tile, just reachable without hunting it down in a big grid. Unlike
  // the Upload tab's identically-styled × (removeUploadedItem), this never
  // hits the server — there's no file to delete, just a Set entry to clear.
  for (const removeBtn of catalogConfigBodyEl.querySelectorAll('.catalog-selected-thumb-remove')) {
    removeBtn.addEventListener('click', () => {
      const thumb = removeBtn.closest('.upload-thumb');
      catalogBatch[CATALOG_ASSET_SET_KEY[thumb.dataset.kind]].delete(thumb.dataset.slug);
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
  // labeled tile. Same treatment for the grid tiles, which share the exact
  // same thumbnailUrls and TTL.
  for (const img of catalogConfigBodyEl.querySelectorAll('.catalog-selected-thumbs img, .catalog-asset-item img')) {
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
}

function wireCatalogGarmentEvents() {
  for (const card of catalogRowsEl.querySelectorAll('.redchief-row-card')) {
    const garmentId = card.dataset.row;
    const garment = catalogFindGarment(garmentId);
    if (!garment) continue;

    card.querySelector('.redchief-row-label-input').addEventListener('change', (e) => {
      const value = e.target.value.trim();
      garment.label = value || garment.label; // never blank — revert if cleared
      e.target.value = garment.label;
    });
    card.querySelector('.redchief-row-remove-btn').addEventListener('click', () => removeCatalogGarment(garmentId));

    const clearBtn = card.querySelector('.redchief-slot-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        clearCatalogGarmentFile(garmentId);
      });
    } else {
      const dz = card.querySelector('.catalog-garment-slot .redchief-dropzone');
      const input = card.querySelector('.catalog-garment-input');
      dz.addEventListener('click', (e) => {
        // Same synthetic-click guard as app.js's wireDropzone / redchief.js's
        // per-slot dropzones: input.click() re-dispatches a bubbling click on
        // the (hidden) input itself, which would otherwise re-enter this
        // handler and call input.click() again, forever.
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

    const retryBtn = card.querySelector('.catalog-row-retry-btn');
    if (retryBtn) retryBtn.addEventListener('click', () => retryCatalogGarment(garmentId));

    for (const img of card.querySelectorAll('.redchief-result-cell img')) {
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
  const jobsPerRun = Math.min(catalogComputeLooks().length, 12);
  const totalCalls = runsPerGarment * submittable.length;
  const totalJobs = jobsPerRun * totalCalls;
  // Credit cost per job is resolution-dependent and set by admin config —
  // it isn't exposed by any dev-API response (see the catalog API contract),
  // so this warns honestly about spending real credits without inventing a
  // number the tool can't actually verify.
  catalogSubmitConfirmTextEl.textContent =
    `This will submit ${totalCalls} generate call${totalCalls === 1 ? '' : 's'} across ${submittable.length} garment${submittable.length === 1 ? '' : 's'} ` +
    `(${totalJobs} job${totalJobs === 1 ? '' : 's'} total) against PRODUCTION. ` +
    `Exact credit cost per job depends on the selected resolution and is set by admin config (not shown here). This can't be undone. Continue?`;
  catalogSubmitConfirmEl.hidden = false;
});

catalogSubmitConfirmCancelBtn.addEventListener('click', () => {
  catalogSubmitConfirmEl.hidden = true;
});

catalogSubmitConfirmBtn.addEventListener('click', () => {
  catalogSubmitConfirmEl.hidden = true;
  submitCatalogGarments();
});

function submitCatalogGarments() {
  const submittable = catalogSubmittableGarments();
  if (submittable.length === 0 || !catalogBatchIsValid()) return;
  const looks = catalogComputeLooks().slice(0, 12);
  const templates = catalogBuildRunTemplates(); // same combination set applied to every garment
  for (const garment of submittable) garment.status = 'submitting';
  renderCatalog();
  Promise.allSettled(submittable.map((garment) => submitCatalogGarment(garment, templates, looks)));
}

/** Builds this garment's runs from the shared templates, then submits every run in parallel. */
async function submitCatalogGarment(garment, templates, looks) {
  let garmentDataUrl;
  try {
    garmentDataUrl = await catalogFileToDataUrl(garment.file);
  } catch (err) {
    garment.status = 'FAILED';
    garment.error = err instanceof Error ? err.message : String(err);
    renderCatalog();
    return;
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
  garment.status = 'RUNNING';
  garment.error = null;
  renderCatalog();
  await Promise.allSettled(garment.runs.map((run) => submitCatalogRun(garment, run, garmentDataUrl, looks)));
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
  if (garment.runs.some((r) => r.status === 'submitting' || r.status === 'RUNNING')) {
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
  return catalogBatch.options?.backgrounds.find((b) => b.slug === job.background)?.label ?? job.background;
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
      run.status = 'RUNNING';
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
      const looks = catalogComputeLooks().slice(0, 12);
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
