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
const catalogResultsEl = document.getElementById('catalog-results');
const catalogClearAllBtn = document.getElementById('catalog-clear-all-btn');
const catalogFooterBarEl = document.getElementById('catalog-footer-bar');
const catalogRowCountEl = document.getElementById('catalog-row-count');
const catalogSubmitBtn = document.getElementById('catalog-submit-btn');
const catalogSubmitConfirmEl = document.getElementById('catalog-submit-confirm');
const catalogSubmitConfirmTextEl = document.getElementById('catalog-submit-confirm-text');
const catalogSubmitConfirmCancelBtn = document.getElementById('catalog-submit-confirm-cancel-btn');
const catalogSubmitConfirmBtn = document.getElementById('catalog-submit-confirm-btn');

// Asset modal picker elements (SelectGridModal style)
const catalogModalOverlayEl = document.getElementById('catalog-modal-overlay');
const catalogModalTitleEl = document.getElementById('catalog-modal-title');
const catalogModalCounterEl = document.getElementById('catalog-modal-counter');
const catalogModalCloseBtn = document.getElementById('catalog-modal-close-btn');
const catalogModalToolbarEl = document.getElementById('catalog-modal-toolbar');
const catalogModalFilterChipsEl = document.getElementById('catalog-modal-filter-chips');
const catalogModalGridEl = document.getElementById('catalog-modal-grid');
const catalogModalEmptyEl = document.getElementById('catalog-modal-empty');
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

function catalogUid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function catalogEscapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

window.enterCatalogView = async function enterCatalogView() {
  initCatalogModalEvents();
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
  return `
    <div class="catalog-asset-card${selected ? ' selected' : ''}" data-kind="${kind}" data-slug="${catalogEscapeHtml(asset.slug)}" role="button" tabindex="0" title="${catalogEscapeHtml(asset.label)}">
      <div class="catalog-asset-thumb-wrap${isSquare ? ' square' : ''}">
        <img src="${asset.thumbnailUrl}" alt="${catalogEscapeHtml(asset.label)}" loading="lazy" />
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
    const items = o[meta.optionsKey] ?? [];
    if (items.length === 0 && !meta.required) return '';

    const set = catalogBatch[meta.setKey];
    const selectedItems = items.filter((i) => set.has(i.slug));
    const unselectedItems = items.filter((i) => !set.has(i.slug));

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
            ${items.length > CATALOG_VISIBLE_PAGE_CAP ? `
              <button type="button" class="catalog-view-more-btn" data-kind="${kind}" title="Browse all ${items.length} options">
                <span>View all (${items.length})</span>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="9 18 15 12 9 6"/>
                </svg>
              </button>` : ''}
          </div>
        </div>
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

  for (const btn of catalogConfigBodyEl.querySelectorAll('.catalog-view-more-btn, .catalog-asset-more-card')) {
    btn.addEventListener('click', () => {
      openCatalogAssetModal(btn.dataset.kind);
    });
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

function renderCatalogModalGrid() {
  const kind = catalogModalState.kind;
  if (!kind || !catalogBatch.options) return;

  const meta = CATALOG_ASSET_METADATA[kind];
  const allItems = catalogBatch.options[meta.optionsKey] ?? [];
  const set = catalogBatch[meta.setKey];
  const filterTag = catalogModalState.activeFilter;

  const filtered = allItems.filter((item) => {
    if (filterTag && filterTag !== 'All') {
      const tagLower = filterTag.toLowerCase();
      const matchLabel = item.label && item.label.toLowerCase().includes(tagLower);
      const matchSlug = item.slug && item.slug.toLowerCase().includes(tagLower);
      if (!matchLabel && !matchSlug) return false;
    }
    return true;
  });

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
      looks,
      garmentType: catalogBatch.garmentType || undefined,
      lower: run.lower,
      shoe: run.shoe,
      aspectRatio: catalogBatch.aspectRatio,
      resolution: catalogBatch.resolution,
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

const catalogRecordedJobs = new Set(); // job ids already reported to /api/results/record — avoids re-recording on every poll tick once a job is terminal

function catalogPoseLabel(job) {
  return catalogBatch.options?.poses.find((p) => p.slug === job.pose)?.label ?? job.pose;
}
function catalogBackgroundLabel(job) {
  return catalogBatch.options?.backgrounds.find((b) => b.slug === job.background)?.label ?? job.background;
}

/** Reports one terminal (COMPLETED/FAILED) job to the Results page's DB — see webapp/server.mts's POST /api/results/record for why this has to be client-driven: this file is the only place that knows the face/lower/shoe/pose/background labels behind a given jobId. Fire-and-forget — a failed recording doesn't affect the tester's own view of this run, which already shows its own status/thumbnail live regardless. */
function recordCatalogJobResult(garment, run, job) {
  if (job.status !== 'COMPLETED' && job.status !== 'FAILED') return;
  if (catalogRecordedJobs.has(job.jobId)) return;
  catalogRecordedJobs.add(job.jobId);
  fetch('/api/results/record', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: 'catalog',
      status: job.status,
      gender: catalogBatch.gender,
      personName: run.runLabel,
      categorySlug: 'catalog',
      garmentName: `${garment.label} — ${catalogPoseLabel(job)} × ${catalogBackgroundLabel(job)}`,
      jobId: job.jobId,
      imageUrl: job.imageUrl,
      error: job.error,
    }),
  }).catch(() => {}); // best-effort
}

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
      for (const job of run.jobs) recordCatalogJobResult(garment, run, job);
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

initCatalogModalEvents();

