// ---------- RedChief tab: multi-row batch testing ----------
// Backend is unchanged from the earlier single-row RedChief work — same
// /api/redchief/* proxy routes, same PROPICLY_API_KEY. This file replaces
// only the client-side UI: one card per product ("row"), each with its own
// independent job lifecycle (submit -> poll -> complete/fail, or cancel).

const redchiefConfigLoadingEl = document.getElementById('redchief-config-loading');
const redchiefConfigErrorEl = document.getElementById('redchief-config-error');
const redchiefConfigBodyEl = document.getElementById('redchief-config-body');
const redchiefCreditCostEl = document.getElementById('redchief-credit-cost');
const redchiefWorkflowPickerEl = document.getElementById('redchief-workflow-picker');
const redchiefWorkflowSwitchConfirmEl = document.getElementById('redchief-workflow-switch-confirm');
const redchiefWorkflowSwitchTextEl = document.getElementById('redchief-workflow-switch-text');
const redchiefWorkflowSwitchCancelBtn = document.getElementById('redchief-workflow-switch-cancel-btn');
const redchiefWorkflowSwitchConfirmBtn = document.getElementById('redchief-workflow-switch-confirm-btn');
const redchiefBulkPanelEl = document.getElementById('redchief-bulk-panel');
const redchiefRowsPanelEl = document.getElementById('redchief-rows-panel');
const redchiefRowsEl = document.getElementById('redchief-rows');
const redchiefFooterBarEl = document.getElementById('redchief-footer-bar');
const redchiefRowCountEl = document.getElementById('redchief-row-count');
const redchiefSubmitBtn = document.getElementById('redchief-submit-btn');
const redchiefBulkStatusEl = document.getElementById('redchief-bulk-status');

let redchiefConfig = null; // { creditCost, workflows: [{inputCount, viewLabels}] }
let redchiefSelectedWorkflowIndex = null;
let redchiefRows = []; // TestRow[]
let redchiefRowCounter = 0;
let redchiefPendingWorkflowSwitchIndex = null; // set while the switch-confirm banner is showing
let redchiefLoaded = false;

function redchiefUid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function redchiefEscapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

window.enterRedchiefView = async function enterRedchiefView() {
  if (!redchiefLoaded) await loadRedchiefConfig();
};

async function loadRedchiefConfig() {
  redchiefConfigLoadingEl.hidden = false;
  redchiefConfigErrorEl.hidden = true;
  redchiefConfigBodyEl.hidden = true;
  try {
    const res = await fetch('/api/redchief/config');
    const body = await res.json();
    if (!res.ok || body.available === false) {
      throw new Error(body.error || 'RedChief config unavailable.');
    }
    if (!Array.isArray(body.workflows) || body.workflows.length === 0) {
      throw new Error('No active RedChief workflow is configured. Ask an admin to activate one.');
    }
    redchiefConfig = { creditCost: body.creditCost, workflows: body.workflows };
    redchiefLoaded = true;
    redchiefCreditCostEl.textContent = String(redchiefConfig.creditCost);
    renderRedchiefWorkflowPicker();
    redchiefConfigLoadingEl.hidden = true;
    redchiefConfigBodyEl.hidden = false;
  } catch (err) {
    redchiefConfigLoadingEl.hidden = true;
    redchiefConfigErrorEl.hidden = false;
    redchiefConfigErrorEl.textContent = err instanceof Error ? err.message : String(err);
  }
}

function renderRedchiefWorkflowPicker() {
  redchiefWorkflowPickerEl.innerHTML = redchiefConfig.workflows
    .map(
      (w, i) => `
    <button type="button" class="redchief-workflow-card${i === redchiefSelectedWorkflowIndex ? ' selected' : ''}" data-index="${i}">
      <strong>${w.inputCount} views</strong>
      <span>${w.viewLabels.join(', ')}</span>
    </button>`,
    )
    .join('');
  for (const btn of redchiefWorkflowPickerEl.querySelectorAll('.redchief-workflow-card')) {
    btn.addEventListener('click', () => selectRedchiefWorkflow(Number(btn.dataset.index)));
  }
}

function selectRedchiefWorkflow(index) {
  if (index === redchiefSelectedWorkflowIndex) return;
  if (redchiefRows.length === 0) {
    applyRedchiefWorkflowSelection(index);
    return;
  }
  // Rows already exist — warn before re-labeling them (spec: never silently
  // resize/relabel an in-progress batch).
  redchiefPendingWorkflowSwitchIndex = index;
  const w = redchiefConfig.workflows[index];
  redchiefWorkflowSwitchTextEl.textContent =
    `Switching to ${w.inputCount} views will re-label every existing row's slots to match — ` +
    `any photos already placed will be cleared, and any row with a job in progress or completed will be detached from it. Continue?`;
  redchiefSubmitConfirmEl.hidden = true; // never show both danger-confirm panels at once
  redchiefWorkflowSwitchConfirmEl.hidden = false;
}

redchiefWorkflowSwitchCancelBtn.addEventListener('click', () => {
  redchiefPendingWorkflowSwitchIndex = null;
  redchiefWorkflowSwitchConfirmEl.hidden = true;
});

redchiefWorkflowSwitchConfirmBtn.addEventListener('click', () => {
  const index = redchiefPendingWorkflowSwitchIndex;
  redchiefPendingWorkflowSwitchIndex = null;
  redchiefWorkflowSwitchConfirmEl.hidden = true;
  if (index !== null) applyRedchiefWorkflowSelection(index);
});

function applyRedchiefWorkflowSelection(index) {
  redchiefSelectedWorkflowIndex = index;
  const w = redchiefConfig.workflows[index];
  // Re-labeling an existing row means rebuilding its slots from scratch at
  // the new length/labels — partial preservation would misalign which
  // photo was meant for which view, so a clean rebuild is the only safe
  // move. Any in-flight or completed job for that row is also detached:
  // its poll token is bumped so a stale continuation can't resurrect a row
  // whose slots no longer correspond to what was actually submitted.
  for (const row of redchiefRows) {
    row.pollToken++;
    if (row.pollTimer) clearTimeout(row.pollTimer);
    row.pollTimer = null;
    row.slots = w.viewLabels.map((label) => ({ id: redchiefUid('slot'), label, file: null, previewUrl: null }));
    row.status = 'idle';
    row.jobId = null;
    row.error = null;
    row.resultUrls = null;
    row.cancelNote = null;
  }
  renderRedchiefWorkflowPicker();
  redchiefBulkPanelEl.hidden = false;
  renderRedchiefRows();
}

// ---------- add-row button ----------
const redchiefAddRowBtn = document.getElementById('redchief-add-row-btn');
redchiefAddRowBtn.addEventListener('click', () => {
  if (redchiefSelectedWorkflowIndex === null) return; // button is only enabled once a workflow is chosen (see render below)
  const w = redchiefConfig.workflows[redchiefSelectedWorkflowIndex];
  redchiefRows.push({
    id: redchiefUid('row'),
    label: `Item ${++redchiefRowCounter}`,
    slots: w.viewLabels.map((label) => ({ id: redchiefUid('slot'), label, file: null, previewUrl: null })),
    jobId: null,
    status: 'idle',
    resultUrls: null,
    error: null,
    pollTimer: null,
    pollToken: 0,
  });
  renderRedchiefRows();
});

const REDCHIEF_ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const REDCHIEF_MAX_MB = 10;

function redchiefFindRow(rowId) {
  return redchiefRows.find((r) => r.id === rowId);
}

function redchiefRowUnfilledCount(row) {
  return row.slots.filter((s) => !s.file).length;
}

function redchiefRowSlotHtml(row, slot) {
  const previewSrc = slot.previewUrl ?? '';
  if (slot.file) {
    return `
      <div class="redchief-slot" data-row="${row.id}" data-slot="${slot.id}">
        <div class="redchief-slot-label">${slot.label}</div>
        <div class="dropzone redchief-dropzone redchief-slot-filled">
          <img class="redchief-slot-preview" src="${previewSrc}" />
          <button type="button" class="redchief-slot-clear" title="Clear" aria-label="Clear slot">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>`;
  }
  // slot.unmatched (set only by folder-grouping when a label had no lenient
  // match) renders a visibly different, danger-tinted placeholder per spec —
  // still clickable to fill that exact slot in place. Base `.dropzone` class
  // is required here (not just `.redchief-dropzone`) — that's what actually
  // supplies the dashed border/cursor/hover styling; `.redchief-dropzone`
  // alone only carries the size/layout tweaks, exactly like the single-row
  // UI's own per-slot dropzones always paired the two classes together.
  const cls = slot.unmatched
    ? 'dropzone redchief-dropzone redchief-slot-empty redchief-slot-unmatched'
    : 'dropzone redchief-dropzone redchief-slot-empty';
  return `
    <div class="redchief-slot" data-row="${row.id}" data-slot="${slot.id}">
      <div class="redchief-slot-label">${slot.label}</div>
      <div class="${cls}" tabindex="0">
        <input type="file" class="redchief-slot-input" accept="image/*" hidden />
        <span class="icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        </span>
        <span>${slot.unmatched ? `Missing: ${slot.label}` : 'Choose image'}</span>
      </div>
    </div>`;
}

function redchiefRowCardHtml(row) {
  const unfilled = redchiefRowUnfilledCount(row);
  const invalid = unfilled > 0;
  return `
    <div class="redchief-row-card${invalid ? ' invalid' : ''}" data-row="${row.id}">
      <div class="redchief-row-header">
        <span class="redchief-row-index">Row</span>
        <input type="text" class="redchief-row-label-input" value="${redchiefEscapeHtml(row.label)}" />
        <button type="button" class="link-btn danger redchief-row-remove-btn" title="Remove row">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          <span>Remove</span>
        </button>
      </div>
      <div class="redchief-row-slots">${row.slots.map((s) => redchiefRowSlotHtml(row, s)).join('')}</div>
      ${invalid ? `<p class="redchief-validation-msg">${unfilled} view(s) still need an image — click the dashed slot(s) above to fill them in</p>` : ''}
      ${redchiefRowStatusHtml(row)}
    </div>`;
}

const REDCHIEF_STATUS_LABEL = { QUEUED: 'Queued', RUNNING: 'Running', COMPLETED: 'Completed', FAILED: 'Failed', submitting: 'Submitting…' };
const REDCHIEF_STATUS_CLASS = { QUEUED: 'warn', RUNNING: 'accent', COMPLETED: 'ok', FAILED: 'err', submitting: 'muted' };

function redchiefRowStatusHtml(row) {
  if (row.status === 'idle') return '';
  const cls = REDCHIEF_STATUS_CLASS[row.status] ?? 'muted';
  const label = REDCHIEF_STATUS_LABEL[row.status] ?? row.status;
  let body = `<span class="redchief-status-badge ${cls}">${label}</span>`;

  if (row.status === 'QUEUED') {
    body += ` <button type="button" class="link-btn danger redchief-row-cancel-btn">Cancel</button>`;
  }
  if (row.cancelNote) {
    body += ` <span class="redchief-cancel-note">${redchiefEscapeHtml(row.cancelNote)}</span>`;
  }
  if (row.status === 'FAILED') {
    body += ` <span class="redchief-error-code">${redchiefEscapeHtml(row.error ?? 'unknown error')}</span>`;
    body += ` <button type="button" class="btn-secondary btn-small redchief-row-retry-btn">Retry</button>`;
  }
  if (row.status === 'COMPLETED' && row.resultUrls) {
    body += `<div class="redchief-result-grid">${row.resultUrls
      .map((url) => `<div class="redchief-result-cell"><img src="${url}" data-row="${row.id}" /><a href="${url}" target="_blank" rel="noopener" class="link-btn">Open</a></div>`)
      .join('')}</div>`;
  }
  return `<div class="redchief-row-status">${body}</div>`;
}

function renderRedchiefRows() {
  redchiefSubmitConfirmEl.hidden = true; // any row change invalidates a pending submit confirmation
  redchiefRowsEl.innerHTML = redchiefRows.map(redchiefRowCardHtml).join('');
  wireRedchiefRowEvents();
  redchiefAddRowBtn.disabled = redchiefSelectedWorkflowIndex === null;
  redchiefAddRowBtn.title = redchiefSelectedWorkflowIndex === null ? 'Choose a view count above first' : '';
  redchiefRowsPanelEl.hidden = redchiefRows.length === 0;
  redchiefFooterBarEl.hidden = redchiefRows.length === 0;
  if (redchiefRows.length > 0) redchiefRowCountEl.textContent = `${redchiefRows.length} row${redchiefRows.length === 1 ? '' : 's'}`;
  updateRedchiefSubmitEnabled();
}

function wireRedchiefRowEvents() {
  for (const card of redchiefRowsEl.querySelectorAll('.redchief-row-card')) {
    const rowId = card.dataset.row;
    card.querySelector('.redchief-row-label-input').addEventListener('change', (e) => {
      const row = redchiefFindRow(rowId);
      const value = e.target.value.trim();
      row.label = value || row.label; // never blank — revert if cleared
      e.target.value = row.label;
    });
    card.querySelector('.redchief-row-remove-btn').addEventListener('click', () => removeRedchiefRow(rowId));

    for (const slotEl of card.querySelectorAll('.redchief-slot')) {
      const slotId = slotEl.dataset.slot;
      const dz = slotEl.querySelector('.redchief-dropzone');
      const clearBtn = slotEl.querySelector('.redchief-slot-clear');
      if (clearBtn) {
        clearBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          clearRedchiefRowSlotFile(rowId, slotId);
        });
        continue; // filled slots don't need click-to-browse wiring
      }
      const input = slotEl.querySelector('.redchief-slot-input');
      dz.addEventListener('click', (e) => {
        // input.click() dispatches a real, bubbling click event on the
        // input itself (it's a child of dz) — that synthetic event bubbles
        // straight back up to this same listener, which would call
        // input.click() again, forever, without this guard. Same fix as
        // app.js's wireDropzone() uses for the identical bug: a real user
        // click can never land ON a hidden <input>, so any click whose
        // target is the <input> is necessarily one of these echoes.
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
        if (file) setRedchiefRowSlotFile(rowId, slotId, file);
      });
      input.addEventListener('change', () => {
        const file = input.files[0];
        if (file) setRedchiefRowSlotFile(rowId, slotId, file);
        input.value = '';
      });
    }

    const cancelBtn = card.querySelector('.redchief-row-cancel-btn');
    if (cancelBtn) cancelBtn.addEventListener('click', () => cancelRedchiefRow(rowId));
    const retryBtn = card.querySelector('.redchief-row-retry-btn');
    if (retryBtn) retryBtn.addEventListener('click', () => retryRedchiefRow(rowId));

    for (const img of card.querySelectorAll('.redchief-result-cell img')) {
      img.addEventListener('error', () => refreshRedchiefRowResult(img.dataset.row));
    }
  }
}

function setRedchiefRowSlotFile(rowId, slotId, file) {
  const row = redchiefFindRow(rowId);
  const slot = row.slots.find((s) => s.id === slotId);
  if (!REDCHIEF_ACCEPTED_TYPES.has(file.type) || file.size > REDCHIEF_MAX_MB * 1024 * 1024) {
    // Warn-only, matching the single-row UI's earlier established rule —
    // the server is the final authority on type/size, this is informational.
    console.warn(`${file.name}: outside the usual JPEG/PNG/WebP, ${REDCHIEF_MAX_MB}MB guideline — the server may reject this.`);
  }
  slot.file = file;
  slot.unmatched = false;
  slot.previewUrl = URL.createObjectURL(file);
  renderRedchiefRows();
}

function clearRedchiefRowSlotFile(rowId, slotId) {
  const row = redchiefFindRow(rowId);
  const slot = row.slots.find((s) => s.id === slotId);
  slot.file = null;
  slot.previewUrl = null;
  renderRedchiefRows();
}

function removeRedchiefRow(rowId) {
  const row = redchiefFindRow(rowId);
  if (row) {
    row.pollToken++;
    if (row.pollTimer) clearTimeout(row.pollTimer);
  }
  redchiefRows = redchiefRows.filter((r) => r.id !== rowId);
  renderRedchiefRows();
}

function redchiefSubmittableRows() {
  return redchiefRows.filter((r) => r.status === 'idle' && redchiefRowUnfilledCount(r) === 0);
}

function updateRedchiefSubmitEnabled() {
  const submittable = redchiefSubmittableRows();
  redchiefSubmitBtn.disabled = redchiefSelectedWorkflowIndex === null || redchiefRows.length === 0 || submittable.length === 0;
  redchiefSubmitBtn.textContent = `Create ${submittable.length} job${submittable.length === 1 ? '' : 's'}`;
}

// ---------- bulk dropzone: group flat files by filename prefix ----------
const redchiefBulkDropzoneEl = document.getElementById('redchief-bulk-dropzone');
const redchiefBulkInputEl = document.getElementById('redchief-bulk-input');

function redchiefGroupByPrefix(files) {
  const groups = new Map(); // prefix -> [{file, order}]
  for (const file of files) {
    const stem = file.name.replace(/\.[^.]+$/, '');
    const sepIndex = stem.search(/[-_]/);
    const hasTrailingNumber = /\d+$/.test(stem);
    if (sepIndex > 0 && hasTrailingNumber) {
      // Everything before the FIRST separator is the group key — e.g.
      // "shoe-front-1"/"shoe-left-2"/"shoe-sole-3" all key "shoe"; the
      // trailing number anywhere in the remainder decides sort order.
      const prefix = stem.slice(0, sepIndex).toLowerCase();
      const rest = stem.slice(sepIndex + 1);
      const numMatch = rest.match(/(\d+)$/);
      const order = numMatch ? Number(numMatch[1]) : 0;
      if (!groups.has(prefix)) groups.set(prefix, []);
      groups.get(prefix).push({ file, order });
    } else {
      // No separator, or no trailing digit at all — its own singleton
      // group, keyed uniquely so it never accidentally merges with another
      // such file of the same stem.
      groups.set(`${stem}-${redchiefUid('singleton')}`, [{ file, order: 0 }]);
    }
  }
  return [...groups.values()].map((entries) => entries.sort((a, b) => a.order - b.order).map((e) => e.file));
}

function createRedchiefRowsFromFileGroups(groups) {
  const w = redchiefConfig.workflows[redchiefSelectedWorkflowIndex];
  for (const files of groups) {
    const slots = w.viewLabels.map((label, i) => {
      const file = files[i] ?? null; // extra files beyond inputCount are dropped, not placed elsewhere
      return {
        id: redchiefUid('slot'),
        label,
        file,
        previewUrl: file ? URL.createObjectURL(file) : null,
      };
    });
    redchiefRows.push({
      id: redchiefUid('row'),
      label: `Item ${++redchiefRowCounter}`,
      slots,
      jobId: null,
      status: 'idle',
      resultUrls: null,
      error: null,
      pollTimer: null,
      pollToken: 0,
    });
  }
  renderRedchiefRows();
}

function handleRedchiefBulkFiles(files) {
  if (redchiefSelectedWorkflowIndex === null || files.length === 0) return;
  createRedchiefRowsFromFileGroups(redchiefGroupByPrefix(files));
}

wireDropzone(redchiefBulkDropzoneEl, redchiefBulkInputEl, handleRedchiefBulkFiles, redchiefBulkStatusEl);

// ---------- folder picker: group by subfolder, lenient filename matching ----------
const redchiefFolderDropzoneEl = document.getElementById('redchief-folder-dropzone');
const redchiefFolderInputEl = document.getElementById('redchief-folder-input');

function redchiefNormalize(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// For each label, in order, claim the first not-yet-used file whose
// normalized stem contains the normalized label or vice versa. A label with
// no match leaves that slot null IN PLACE — array position is the view
// identity used by the job-creation payload's order, so slots are never
// compacted/reindexed.
function redchiefMatchViewLabels(viewLabels, files) {
  const used = new Set();
  return viewLabels.map((label) => {
    const normLabel = redchiefNormalize(label);
    const match = files.find((f, i) => {
      if (used.has(i)) return false;
      const normStem = redchiefNormalize(f.name.replace(/\.[^.]+$/, ''));
      return normStem.includes(normLabel) || normLabel.includes(normStem);
    });
    if (match) used.add(files.indexOf(match));
    // `unmatched` (true only when this specific label found no file) is what
    // Task 4's row-card rendering reads to show the danger-tinted "Missing:
    // <label>" placeholder instead of a plain empty slot — a slot from a
    // manually-added row or a bulk-prefix-grouped row is never `unmatched`
    // (only this folder-matching path sets it), since those paths never
    // attempted an automatic match in the first place.
    return {
      id: redchiefUid('slot'),
      label,
      file: match ?? null,
      previewUrl: match ? URL.createObjectURL(match) : null,
      unmatched: !match,
    };
  });
}

function redchiefGroupByFolder(fileList) {
  const files = filterImageFiles(fileList);
  const withPaths = files.map((f) => ({ file: f, segments: (f.webkitRelativePath || f.relPath || f.name).split('/') }));
  const hasSubfolders = withPaths.some((f) => f.segments.length >= 3);

  if (!hasSubfolders) {
    return [{ label: null, files: withPaths.map((f) => f.file) }];
  }

  const bySubfolder = new Map(); // subfolder name -> File[]
  const rootLoose = [];
  for (const { file, segments } of withPaths) {
    if (segments.length >= 3) {
      const subfolder = segments[1];
      if (!bySubfolder.has(subfolder)) bySubfolder.set(subfolder, []);
      bySubfolder.get(subfolder).push(file);
    } else {
      rootLoose.push(file);
    }
  }
  const groups = [...bySubfolder.entries()].map(([label, files]) => ({ label, files }));
  if (rootLoose.length > 0) groups.push({ label: 'Unmatched root files', files: rootLoose });
  return groups;
}

function createRedchiefRowsFromFolderGroups(groups) {
  const w = redchiefConfig.workflows[redchiefSelectedWorkflowIndex];
  for (const group of groups) {
    redchiefRows.push({
      id: redchiefUid('row'),
      label: group.label ?? `Item ${redchiefRowCounter + 1}`,
      slots: redchiefMatchViewLabels(w.viewLabels, group.files),
      jobId: null,
      status: 'idle',
      resultUrls: null,
      error: null,
      pollTimer: null,
      pollToken: 0,
    });
    if (!group.label) redchiefRowCounter++;
  }
  renderRedchiefRows();
}

function handleRedchiefFolderFiles(files) {
  if (redchiefSelectedWorkflowIndex === null || files.length === 0) return;
  const groups = redchiefGroupByFolder(files);
  createRedchiefRowsFromFolderGroups(groups);
}

// ---------- submission and per-row polling ----------
function redchiefFileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

const redchiefSubmitConfirmEl = document.getElementById('redchief-submit-confirm');
const redchiefSubmitConfirmTextEl = document.getElementById('redchief-submit-confirm-text');
const redchiefSubmitConfirmCancelBtn = document.getElementById('redchief-submit-confirm-cancel-btn');
const redchiefSubmitConfirmBtn = document.getElementById('redchief-submit-confirm-btn');

redchiefSubmitBtn.addEventListener('click', () => {
  const submittable = redchiefSubmittableRows();
  if (submittable.length === 0) return;
  const totalCredits = submittable.length * redchiefConfig.creditCost;
  redchiefSubmitConfirmTextEl.textContent =
    `This will submit ${submittable.length} job${submittable.length === 1 ? '' : 's'} against PRODUCTION, spending ${totalCredits} credit(s) total. This can't be undone. Continue?`;
  redchiefSubmitConfirmEl.hidden = false;
});

redchiefSubmitConfirmCancelBtn.addEventListener('click', () => {
  redchiefSubmitConfirmEl.hidden = true;
});

redchiefSubmitConfirmBtn.addEventListener('click', () => {
  redchiefSubmitConfirmEl.hidden = true;
  submitRedchiefRows();
});

function submitRedchiefRows() {
  const submittable = redchiefSubmittableRows();
  if (submittable.length === 0) return;
  for (const row of submittable) row.status = 'submitting';
  renderRedchiefRows();
  Promise.allSettled(submittable.map(submitRedchiefRow));
}

async function submitRedchiefRow(row) {
  try {
    const views = await Promise.all(row.slots.map((s) => redchiefFileToDataUrl(s.file)));
    const res = await fetch('/api/redchief', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ views }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`${body.error?.code ?? res.status}: ${body.error?.message ?? 'request failed'}`);
    row.jobId = body.jobId;
    redchiefRefreshedRows.delete(row.id);
    row.status = 'QUEUED';
    row.error = null;
    pollRedchiefRow(row);
  } catch (err) {
    row.status = 'FAILED';
    row.error = err instanceof Error ? err.message : String(err);
  }
  renderRedchiefRows();
}

const redchiefRecordedJobs = new Set(); // job ids already reported to /api/results/record — avoids re-recording on every poll tick or on a later thumbnail refresh

/**
 * Reports a row's terminal (COMPLETED/FAILED) job to the Results page's DB —
 * see webapp/server.mts's POST /api/results/record for why this has to be
 * client-driven: this file is the only place that knows the product/row
 * label, per-view labels, and credit cost for a given jobId, and the only
 * place row.slots[].file (the actual input image bytes) still exists at all
 * — they're never uploaded/persisted anywhere else, so this re-derives base64
 * from those same in-memory File objects one last time before reporting.
 *
 * One consolidated POST per row (not one per output image like the old
 * per-source-imageUrl contract) — carries every input (label + data URI) and
 * every output (label + presigned URL, server downloads it) together, so the
 * Results page can render the full multi-thumbnail row in one DB record.
 * Fire-and-forget — a failed recording doesn't affect the tester's own view
 * of this row, which already shows its own status/thumbnails live regardless.
 */
async function recordRedchiefRowResult(row) {
  if (row.status !== 'COMPLETED' && row.status !== 'FAILED') return;
  if (redchiefRecordedJobs.has(row.jobId)) return;
  redchiefRecordedJobs.add(row.jobId);
  const payload = {
    source: 'redchief',
    status: row.status,
    personName: row.label,
    categorySlug: 'redchief',
    garmentName: row.label,
    jobId: row.jobId,
  };
  if (row.status === 'COMPLETED') {
    payload.credits = redchiefConfig?.creditCost;
    try {
      payload.inputs = await Promise.all(row.slots.map(async (s) => ({ label: s.label, dataUrl: await redchiefFileToDataUrl(s.file) })));
    } catch {
      // A slot's File became unreadable (e.g. GC'd/revoked) between
      // completion and now — record the outputs without inputs rather than
      // losing the row entirely.
      payload.inputs = [];
    }
    payload.outputs = (row.resultUrls ?? []).map((url, i) => ({ label: `Output ${i + 1}`, imageUrl: url }));
  } else {
    payload.error = row.error ?? 'unknown error';
  }
  fetch('/api/results/record', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).catch(() => {}); // best-effort
}

function pollRedchiefRow(row, attempt = 0, delay = 2000) {
  const maxAttempts = 20;
  const maxDelay = 20000;
  const token = row.pollToken;

  fetch(`/api/redchief/jobs/${row.jobId}`)
    .then((res) => res.json().then((body) => ({ ok: res.ok, body })))
    .then(({ ok, body }) => {
      if (token !== row.pollToken) return; // superseded by a cancel/retry — discard
      if (!ok) throw new Error(`${body.error?.code ?? 'ERROR'}: ${body.error?.message ?? 'poll failed'}`);

      if (body.status === 'COMPLETED') {
        row.status = 'COMPLETED';
        row.resultUrls = body.imageUrls ?? (body.imageUrl ? [body.imageUrl] : []);
        recordRedchiefRowResult(row);
        renderRedchiefRows();
        return;
      }
      if (body.status === 'FAILED') {
        row.status = 'FAILED';
        row.error = body.error ?? 'unknown error';
        recordRedchiefRowResult(row);
        renderRedchiefRows();
        return;
      }
      row.status = body.status; // QUEUED or RUNNING
      renderRedchiefRows();
      if (attempt >= maxAttempts) return; // give up quietly — row stays QUEUED/RUNNING, tester can check back
      row.pollTimer = setTimeout(() => pollRedchiefRow(row, attempt + 1, Math.min(delay * 1.5, maxDelay)), delay);
    })
    .catch((err) => {
      if (token !== row.pollToken) return;
      row.status = 'FAILED';
      row.error = err instanceof Error ? err.message : String(err);
      renderRedchiefRows();
    });
}

const redchiefRefreshedRows = new Set(); // one auto-retry per row per completed result, avoids a hot loop against a permanently-broken URL

async function refreshRedchiefRowResult(rowId) {
  const row = redchiefFindRow(rowId);
  if (!row || row.status !== 'COMPLETED') return;
  if (redchiefRefreshedRows.has(rowId)) return;
  redchiefRefreshedRows.add(rowId);
  try {
    const res = await fetch(`/api/redchief/jobs/${row.jobId}`);
    const body = await res.json();
    if (res.ok && body.status === 'COMPLETED') {
      row.resultUrls = body.imageUrls ?? (body.imageUrl ? [body.imageUrl] : []);
      renderRedchiefRows();
    }
  } catch {
    // best-effort — leave the broken thumbnail if this also fails
  }
}

async function cancelRedchiefRow(rowId) {
  const row = redchiefFindRow(rowId);
  if (!row || row.status !== 'QUEUED') return;
  try {
    const res = await fetch(`/api/redchief/jobs/${row.jobId}/cancel`, { method: 'POST' });
    const body = await res.json();
    if (!res.ok) {
      // 409 CONFLICT: the job moved past QUEUED between this click and the
      // request landing — show that plainly rather than a generic failure,
      // and stop offering Cancel (the next poll tick will move status on).
      row.cancelNote = res.status === 409 ? 'Already processing — too late to cancel.' : `${body.error?.code ?? res.status}: ${body.error?.message ?? 'cancel failed'}`;
      renderRedchiefRows();
      return;
    }
    // Success — reset to fully editable/idle, keep the row's photos so it's
    // instantly resubmittable. Bump pollToken so any in-flight poll
    // continuation for the old jobId is discarded rather than reviving this row.
    row.pollToken++;
    if (row.pollTimer) clearTimeout(row.pollTimer);
    row.pollTimer = null;
    row.jobId = null;
    row.status = 'idle';
    row.error = null;
    row.cancelNote = null;
    renderRedchiefRows();
  } catch (err) {
    row.cancelNote = err instanceof Error ? err.message : String(err);
    renderRedchiefRows();
  }
}

function retryRedchiefRow(rowId) {
  const row = redchiefFindRow(rowId);
  if (!row || row.status !== 'FAILED') return;
  row.pollToken++; // discard any stale continuation from the failed attempt
  row.jobId = null;
  row.error = null;
  row.cancelNote = null;
  row.resultUrls = null;
  row.status = 'submitting';
  renderRedchiefRows();
  submitRedchiefRow(row);
}

wireDropzone(redchiefFolderDropzoneEl, redchiefFolderInputEl, handleRedchiefFolderFiles, redchiefBulkStatusEl);
