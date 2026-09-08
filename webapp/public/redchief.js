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
  // loadRedchiefJobs is added in Task 6; guard so this file runs standalone
  // (same forward-reference shape as startRedchiefJob below) until it lands.
  if (typeof loadRedchiefJobs === 'function') loadRedchiefJobs();
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
  redchiefUploadStatusEl.textContent = !REDCHIEF_ACCEPTED_TYPES.has(file.type)
    ? `${file.name}: only JPEG, PNG, or WebP images are accepted — the server may reject this, but you can still try.`
    : file.size > REDCHIEF_MAX_MB * 1024 * 1024
      ? `${file.name}: over ${REDCHIEF_MAX_MB}MB — the server may reject this, but you can still try.`
      : '';
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
