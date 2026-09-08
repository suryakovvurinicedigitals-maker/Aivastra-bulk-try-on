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
    `any photos already placed will be cleared. Continue?`;
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
  // photo was meant for which view, so a clean rebuild is the only safe move.
  for (const row of redchiefRows) {
    for (const timer of [row.pollTimer]) if (timer) clearTimeout(timer);
    row.pollTimer = null;
    row.slots = w.viewLabels.map((label) => ({ id: redchiefUid('slot'), label, file: null, previewUrl: null }));
  }
  renderRedchiefWorkflowPicker();
  redchiefBulkPanelEl.hidden = false;
  renderRedchiefRows();
}

// Forward declaration — Task 4 provides the real implementation (row-card
// rendering). Defined here as a safe no-op so Tasks 1-3 are independently
// runnable/verifiable without a ReferenceError.
function renderRedchiefRows() {
  redchiefRowsPanelEl.hidden = redchiefRows.length === 0;
  redchiefFooterBarEl.hidden = redchiefRows.length === 0;
  if (redchiefRows.length > 0) redchiefRowCountEl.textContent = `${redchiefRows.length} row${redchiefRows.length === 1 ? '' : 's'}`;
}
