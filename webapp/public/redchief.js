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
const redchiefConfirmPanelEl = document.getElementById('redchief-confirm-panel');
const redchiefConfirmTextEl = document.getElementById('redchief-confirm-text');
const redchiefConfirmCancelBtn = document.getElementById('redchief-confirm-cancel-btn');
const redchiefConfirmRunBtn = document.getElementById('redchief-confirm-run-btn');

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
  // Slots are rendered from viewLabels below, so viewLabels.length — not the
  // separately-reported inputCount — is the single source of truth for slot
  // count; if the two ever disagreed, sizing off inputCount would misalign
  // slot indices against redchiefSlotFiles (finding #6).
  redchiefSlotFiles = new Array(workflow.viewLabels.length).fill(null);
  redchiefConfirmPanelEl.hidden = true;
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
  // Slots changed after a confirm was already showing (e.g. tester swaps a
  // photo mid-confirm) — force a fresh Generate click rather than let a stale
  // confirm submit against the new file set.
  redchiefConfirmPanelEl.hidden = true;
  updateRedchiefGenerateEnabled();
}

function clearRedchiefSlot(slot) {
  redchiefSlotFiles[slot] = null;
  const preview = redchiefSlotsEl.querySelector(`.redchief-slot-preview[data-slot="${slot}"]`);
  const clearBtn = redchiefSlotsEl.querySelector(`.redchief-slot-clear[data-slot="${slot}"]`);
  preview.hidden = true;
  preview.src = '';
  clearBtn.hidden = true;
  redchiefConfirmPanelEl.hidden = true;
  updateRedchiefGenerateEnabled();
}

function updateRedchiefGenerateEnabled() {
  redchiefGenerateBtn.disabled = redchiefSlotFiles.length === 0 || redchiefSlotFiles.some((f) => f === null);
}

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

/** Resets every slot back to empty after a successful submit, without a full
 * re-render (which would tear down and re-wire the dropzone/input elements
 * unnecessarily) — see finding #1: spent credits must require a deliberate
 * re-select, even of the same files, before Generate can fire again. */
function resetRedchiefSlots() {
  redchiefSlotFiles = new Array(redchiefSlotFiles.length).fill(null);
  for (const preview of redchiefSlotsEl.querySelectorAll('.redchief-slot-preview')) {
    preview.hidden = true;
    preview.src = '';
  }
  for (const btn of redchiefSlotsEl.querySelectorAll('.redchief-slot-clear')) {
    btn.hidden = true;
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Generate never submits directly — a single accidental click must not spend
// credits (finding #1). Clicking it only opens an inline confirm panel
// (matching the Upload tab's #confirm-panel pattern); the actual POST only
// fires from redchief-confirm-run-btn below.
redchiefGenerateBtn.addEventListener('click', () => {
  redchiefConfirmTextEl.innerHTML = `You're about to submit a RedChief job — this spends <b>${redchiefCreditCost} credit(s)</b> against <b>PRODUCTION</b> and can't be undone.`;
  redchiefConfirmPanelEl.hidden = false;
  redchiefGenerateBtn.disabled = true;
});

redchiefConfirmCancelBtn.addEventListener('click', () => {
  redchiefConfirmPanelEl.hidden = true;
  updateRedchiefGenerateEnabled();
});

redchiefConfirmRunBtn.addEventListener('click', async () => {
  redchiefConfirmRunBtn.disabled = true;
  redchiefConfirmCancelBtn.disabled = true;
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
    redchiefConfirmPanelEl.hidden = true;
    // Credits are already spent — clear the slots so the tester must
    // deliberately re-select files (even the same ones) before Generate can
    // be clicked again, rather than the button silently re-arming on the
    // same filled slots and risking a double charge.
    resetRedchiefSlots();
    startRedchiefJob(body.jobId);
  } catch (err) {
    redchiefUploadStatusEl.textContent = err instanceof Error ? err.message : String(err);
    redchiefConfirmPanelEl.hidden = true;
  } finally {
    redchiefConfirmRunBtn.disabled = false;
    redchiefConfirmCancelBtn.disabled = false;
    updateRedchiefGenerateEnabled();
  }
});

let redchiefPollTimer = null;
// Monotonic token identifying "the job currently owning the panel". Every
// poll continuation captures the token in force when it started and checks
// it again after each await; if it no longer matches, a newer job (or a
// cancel) has taken over and this continuation must not touch the DOM
// (finding #4) — otherwise a stale poll for job A can overwrite job B's
// banner/results, or clobber a cancel outcome that just got rendered.
let redchiefPollToken = 0;
const redchiefRetriedJobs = new Set(); // one auto-retry per job on an expired image URL, never a retry loop

function startRedchiefJob(jobId) {
  const token = ++redchiefPollToken;
  redchiefJobPanelEl.hidden = false;
  redchiefResultGridEl.hidden = true;
  redchiefResultGridEl.innerHTML = '';
  redchiefJobBannerEl.hidden = false;
  redchiefJobBannerEl.textContent = 'Loading job status…';
  clearTimeout(redchiefPollTimer);
  pollRedchiefJob(jobId, token);
}

function renderRedchiefJobBanner(job) {
  const cancelBtn =
    job.status === 'QUEUED' ? `<button type="button" class="btn-secondary btn-small" id="redchief-cancel-btn">Cancel</button>` : '';
  redchiefJobBannerEl.hidden = false;
  redchiefJobBannerEl.innerHTML = `<span>Job <code>${job.jobId}</code>: <strong>${job.status}</strong></span>${cancelBtn}`;
  document.getElementById('redchief-cancel-btn')?.addEventListener('click', () => cancelRedchiefJob(job.jobId));
}

async function pollRedchiefJob(jobId, token, attempt = 0, delayMs = 2000) {
  const maxAttempts = 20;
  const maxDelayMs = 20000;

  if (token !== redchiefPollToken) return; // a newer job (or a cancel) has taken over

  let job;
  try {
    const res = await fetch(`/api/redchief/jobs/${jobId}`);
    job = await res.json();
    if (!res.ok) throw new Error(`${job.error?.code ?? res.status}: ${job.error?.message ?? 'poll failed'}`);
  } catch (err) {
    if (token !== redchiefPollToken) return;
    redchiefJobBannerEl.innerHTML = `<span>Job <code>${jobId}</code>: <strong>error polling status</strong> — ${
      err instanceof Error ? err.message : String(err)
    }</span>`;
    return;
  }

  if (token !== redchiefPollToken) return;

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
  redchiefPollTimer = setTimeout(() => pollRedchiefJob(jobId, token, attempt + 1, Math.min(delayMs * 1.5, maxDelayMs)), delayMs);
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

/**
 * @param {string} jobId
 * @param {{ fromRow?: boolean }} [opts] - fromRow: true when triggered from a
 *   "Recent RedChief jobs" table row rather than the in-flight job panel's
 *   own Cancel button. The job panel may be hidden, or showing a different
 *   job, in that case — take it over (same as clicking "View result" on this
 *   job) so the outcome is always visible, never written into a hidden panel
 *   (finding #2).
 */
async function cancelRedchiefJob(jobId, opts = {}) {
  const { fromRow = false } = opts;
  // Bump the poll token first so a stale in-flight poll continuation (for
  // this job or whatever job previously owned the panel) can't overwrite the
  // cancel outcome rendered below (finding #4).
  redchiefPollToken++;
  clearTimeout(redchiefPollTimer);
  if (fromRow) {
    redchiefJobPanelEl.hidden = false;
    redchiefResultGridEl.hidden = true;
    redchiefResultGridEl.innerHTML = '';
    redchiefJobBannerEl.hidden = false;
    redchiefJobBannerEl.innerHTML = `<span>Job <code>${jobId}</code>: <strong>Cancelling…</strong></span>`;
  }
  try {
    const res = await fetch(`/api/redchief/jobs/${jobId}/cancel`, { method: 'POST' });
    const body = await res.json();
    if (!res.ok) throw new Error(`${body.error?.code ?? res.status}: ${body.error?.message ?? 'cancel failed'}`);
    redchiefJobBannerEl.hidden = false;
    redchiefJobBannerEl.innerHTML = `<span>Job <code>${jobId}</code>: <strong>CANCELLED</strong> — ${body.creditsRefunded} credit(s) refunded.</span>`;
    loadRedchiefJobs();
  } catch (err) {
    // A 409 CONFLICT here means it's already RUNNING/COMPLETED/FAILED — show
    // that plainly rather than a generic failure (spec requirement).
    redchiefJobBannerEl.hidden = false;
    redchiefJobBannerEl.innerHTML += `<div class="status err">${err instanceof Error ? err.message : String(err)}</div>`;
  }
}

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
      // cancelRedchiefJob already refreshes the table itself on success — no
      // .then(loadRedchiefJobs) here, or a successful cancel double-fetches
      // and a failed one refreshes for nothing (finding #11).
      btn.addEventListener('click', () => cancelRedchiefJob(btn.dataset.jobid, { fromRow: true }));
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
