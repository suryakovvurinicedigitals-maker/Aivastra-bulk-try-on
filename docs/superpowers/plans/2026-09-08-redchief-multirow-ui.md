# RedChief Multi-Row UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the existing single-row RedChief tab UI with a multi-row batch UI — one card per product, each with its own view-photo slots, submitted and tracked (poll/cancel/retry) completely independently of every other row, with results shown inline in that row's card. No separate history/results page, no credits page.

**Architecture:** Pure front-end replacement. The already-shipped backend (`lib/propicly-client.mts`, the five `/api/redchief/*` proxy routes, `PROPICLY_API_KEY`/`PROPICLY_API_BASE_URL`) is reused unchanged — this plan touches only `webapp/public/index.html` (RedChief section), `webapp/public/redchief.js` (full rewrite), and `webapp/public/style.css` (additive + removal of now-dead single-row rules). No new routes, no new env vars, no new npm dependencies.

**Tech Stack:** Same as the rest of this repo — plain vanilla JS (classic script, no modules/bundler), HTML, CSS. `redchief.js` continues to load after `app.js` and may keep calling its global helpers (`wireDropzone`, `filesFromDataTransferItems`, `isImageFile`, `filterImageFiles`) exactly as the single-row UI did.

**Spec:** `docs/superpowers/plans/2026-09-08-redchief-multirow-ui-spec.md` — read it first. It has the exact data model, grouping regex/algorithms, submission state machine, and the token-mapping decision (reuse this app's existing design system; do not introduce the pasted oklch tokens). This plan argues from that spec.

## Global Constraints

- **No backend changes.** Do not touch `lib/propicly-client.mts`, `webapp/server.mts`'s `/api/redchief/*` routes, or any env var. The existing `POST /api/redchief` route accepts JSON `{"views": [...]}` (base64 strings) — keep using it exactly as the single-row UI did; do not switch to multipart.
- **No dedicated Results/history page, no credits/balance page.** The existing unused `GET /api/redchief/jobs` route and its old UI (`GET /api/redchief/jobs` polling table) are being removed from the UI in this work — that backend route itself stays (harmless, unused).
- **Reuse this app's existing design tokens/components** per the spec's token-mapping table — `--bg`, `--panel`, `--text`, `--muted`, `--border`, `--pink`/`--pink-tint`, `--warn`/`--warn-tint`, `--ok`/`--ok-tint`, `--err` (+ new `--err-tint`, filling a gap in an existing pattern), `.panel`, `.btn-primary`/`.btn-secondary`/`.btn-danger`/`.btn-small`, `.link-btn`/`.link-btn.danger`, `.dropzone`, `.status`, `.confirm-panel`/`.confirm-actions`, `.role-badge` (as the status-pill shape to follow). Do not introduce a second, parallel token/color system.
- Zero new npm dependencies. No test suite (this repo has none by design) — verify by `node --check` and manual code tracing; browser automation cannot reach `localhost` in this environment (confirmed throughout this feature's development) — do not attempt it.
- Every row's poll loop is self-contained on that row's own object (`row.pollTimer`/`row.pollToken`) — no module-level shared timer this time, so rows are independent by construction, not by a guard added after the fact.
- Every error is shown on the specific row that produced it (`error.code` + `error.message`), never a page-level toast.
- `redchief.js` stays a single classic-script file (no ES modules), consistent with the rest of this app and the file's own history so far.

---

## File Structure

- **Modify:** `webapp/public/index.html` lines 264-337 (the entire `<!-- ============ REDCHIEF VIEW ============ -->` section) — replaced with new markup: config/workflow-picker panel, bulk-input panel (multi-file dropzone + folder dropzone + add-row button), rows panel (empty container, JS-rendered), footer bar. The old single-slots-grid, single-job-panel, and "Recent RedChief jobs" table markup are all removed.
- **Rewrite:** `webapp/public/redchief.js` — full replacement (all ~503 existing lines superseded) implementing the `TestRow`/`ViewSlot` model, config load + workflow picker, bulk-dropzone prefix-grouping, folder-picker path-grouping + lenient matching, add-row, row-card rendering, per-row submission/poll/cancel/retry.
- **Modify:** `webapp/public/style.css` — add `--err-tint` (light + dark blocks, next to the existing `--ok-tint`/`--warn-tint`/`--pink-tint` definitions), add new RedChief multi-row classes, remove the now-dead single-row-only classes that the old markup used exclusively (`.redchief-slots`, `.redchief-slot`, `.redchief-slot-label` — check each is not reused by the new markup before removing; `.redchief-dropzone`/`.redchief-slot-preview`/`.redchief-result-grid`/`.redchief-result-cell` ARE reused by the new per-row cards, keep those).

---

### Task 1: Markup shell, config load, workflow picker

**Files:**
- Modify: `webapp/public/index.html:264-337` (full replacement of the RedChief section)
- Create (full rewrite, starts here): `webapp/public/redchief.js`

**Interfaces:**
- Produces: module-level state `redchiefConfig` (`{creditCost, workflows}|null`), `redchiefSelectedWorkflowIndex` (`number|null`), `redchiefRows` (`TestRow[]`), `redchiefRowCounter` (`number`), and `redchiefUid(prefix)` — all consumed by Tasks 2-6. Also produces `renderRedchiefRows()` as a forward-declared function (empty body — Task 4 fills it in), called from `applyRedchiefWorkflowSelection` so Task 1 is independently runnable/verifiable before Task 4 lands.

- [ ] **Step 1: Replace the RedChief section markup**

In `webapp/public/index.html`, replace lines 264-337 (from `<!-- ============ REDCHIEF VIEW ============ -->` through its matching closing `</section>`) with:

```html
      <!-- ============ REDCHIEF VIEW ============ -->
      <section class="view" data-view="redchief" hidden>
        <header class="view-header">
          <h1>RedChief</h1>
          <p class="subtitle">Test shoe (or any product) photos through the RedChief multi-view pipeline — one row per product, each tracked independently.</p>
        </header>

        <section class="panel" id="redchief-config-panel">
          <div id="redchief-config-loading">Loading RedChief configuration…</div>
          <div class="status err" id="redchief-config-error" hidden></div>
          <div id="redchief-config-body" hidden>
            <h2>📦 Choose a view count</h2>
            <p class="hint">Costs <strong id="redchief-credit-cost">–</strong> credits per job, however many views you submit.</p>
            <div class="redchief-workflow-picker" id="redchief-workflow-picker"></div>
            <div class="confirm-panel" id="redchief-workflow-switch-confirm" hidden>
              <p id="redchief-workflow-switch-text"></p>
              <div class="confirm-actions">
                <button type="button" id="redchief-workflow-switch-cancel-btn" class="btn-secondary">Cancel</button>
                <button type="button" id="redchief-workflow-switch-confirm-btn" class="btn-danger">Yes, re-label rows</button>
              </div>
            </div>
          </div>
        </section>

        <section class="panel" id="redchief-bulk-panel" hidden>
          <h2>🖼️ Add products</h2>
          <p class="hint">Drop many photos at once (grouped automatically by filename), choose a whole folder of subfolders (one per product), or add a row manually.</p>
          <div class="upload-row">
            <div class="dropzone" id="redchief-bulk-dropzone" tabindex="0">
              <input type="file" id="redchief-bulk-input" accept="image/*" multiple hidden />
              <span class="icon">⬆</span>
              <span>Drag many photos here, or click to choose — grouped into rows by filename (e.g. shoe-front-1.jpg, shoe-left-2.jpg → one row)</span>
            </div>
            <div class="dropzone" id="redchief-folder-dropzone" tabindex="0">
              <input type="file" id="redchief-folder-input" webkitdirectory multiple hidden />
              <span class="icon">⬆</span>
              <span>Or choose a folder of subfolders — one subfolder per product</span>
            </div>
            <button type="button" class="btn-secondary" id="redchief-add-row-btn">+ Add row</button>
          </div>
          <div class="status" id="redchief-bulk-status"></div>
        </section>

        <section class="panel" id="redchief-rows-panel" hidden>
          <h2>🗂️ Products</h2>
          <div class="redchief-rows" id="redchief-rows"></div>
        </section>

        <div class="redchief-footer-bar" id="redchief-footer-bar" hidden>
          <span id="redchief-row-count"></span>
          <button type="button" class="btn-primary" id="redchief-submit-btn" disabled>Create job(s)</button>
        </div>
      </section>
```

- [ ] **Step 2: Write the start of `redchief.js` — state, config load, workflow picker**

Replace the entire contents of `webapp/public/redchief.js` with:

```js
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
```

- [ ] **Step 2: Verify**

Run `node --check webapp/public/redchief.js`. Manually trace: with `redchiefRows = []`, calling `selectRedchiefWorkflow(0)` goes straight to `applyRedchiefWorkflowSelection(0)` (no confirm banner). With a fake row pushed into `redchiefRows` first, calling `selectRedchiefWorkflow(1)` shows the confirm banner instead, and only rebuilds slots after `redchiefWorkflowSwitchConfirmBtn`'s click fires. Confirm every `getElementById` call resolves against an id introduced in Step 1's markup.

Also confirm via curl (server already has a real `PROPICLY_API_KEY` from earlier work) that `GET /api/redchief/config` still returns the expected shape this code parses — login `admin`/`Digitals@2025`.

- [ ] **Step 3: Commit**

```bash
git add webapp/public/index.html webapp/public/redchief.js
git commit -m "feat: RedChief multi-row UI — markup shell, config load, workflow picker"
```

---

### Task 2: Bulk dropzone with filename-prefix grouping

**Files:**
- Modify: `webapp/public/redchief.js` (append)

**Interfaces:**
- Consumes: `redchiefConfig`, `redchiefSelectedWorkflowIndex`, `redchiefRows`, `redchiefRowCounter`, `redchiefUid`, `renderRedchiefRows()` (Task 1). Global `wireDropzone`/`filterImageFiles` from `app.js`.
- Produces: nothing new consumed by later tasks (this task and Task 3 both just push onto `redchiefRows` and call `renderRedchiefRows()`, same as Task 4's "+ Add row").

- [ ] **Step 1: Append the prefix-grouping logic**

```js
// ---------- bulk dropzone: group flat files by filename prefix ----------
const redchiefBulkDropzoneEl = document.getElementById('redchief-bulk-dropzone');
const redchiefBulkInputEl = document.getElementById('redchief-bulk-input');

const REDCHIEF_SUFFIX_RE = /^(.+?)[-_](?:view)?(\d+)$/i;

function redchiefGroupByPrefix(files) {
  const groups = new Map(); // prefix -> [{file, order}]
  for (const file of files) {
    const stem = file.name.replace(/\.[^.]+$/, '');
    const m = stem.match(REDCHIEF_SUFFIX_RE);
    if (m) {
      const key = m[1].toLowerCase();
      const order = Number(m[2]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ file, order });
    } else {
      // No trailing number — its own singleton group, keyed uniquely so it
      // never accidentally merges with another unsuffixed file of the same name.
      groups.set(`${stem}-${redchiefUid('singleton')}`, [{ file, order: 0 }]);
    }
  }
  return [...groups.values()].map((entries) => entries.sort((a, b) => a.order - b.order).map((e) => e.file));
}

function createRedchiefRowsFromFileGroups(groups) {
  const w = redchiefConfig.workflows[redchiefSelectedWorkflowIndex];
  for (const files of groups) {
    const slots = w.viewLabels.map((label, i) => ({
      id: redchiefUid('slot'),
      label,
      file: files[i] ?? null, // extra files beyond inputCount are dropped, not placed elsewhere
      previewUrl: null,
    }));
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
```

Note: `redchiefBulkStatusEl` (already added to the markup in Task 1's Step 1 — `<div class="status" id="redchief-bulk-status"></div>` inside `#redchief-bulk-panel`, right after the `.upload-row` div) is `wireDropzone`'s status element for a drop-read failure (e.g. a corrupt file mid-drop). Do NOT reuse `redchiefConfigErrorEl` for this — that element is toggled `hidden` once config loads successfully, so any later text written to it would be invisible; per-row feedback for a successful-but-partial grouping happens in each row's own card (Task 4), this status line is only for the rare drop-read failure itself.

- [ ] **Step 2: Verify**

`node --check webapp/public/redchief.js`. Manually trace `redchiefGroupByPrefix` against the spec's own example: filenames `shoe-front-1.jpg`, `shoe-left-2.jpg`, `shoe-sole-3.jpg` (all match the regex with prefix `shoe`, orders 1/2/3) plus `redchief-4.jpg` (matches regex too — prefix `redchief`, order 4 — this is INTENTIONALLY still grouped by prefix if it matches the pattern; the spec's own wording "a b redchief-4.jpg with no shared prefix becomes its own singleton row" describes a file whose prefix doesn't match any OTHER file's prefix, which naturally produces a singleton group of one — confirm your trace produces 2 groups: `["shoe-front-1.jpg","shoe-left-2.jpg","shoe-sole-3.jpg"]` sorted by order, and `["redchief-4.jpg"]` alone). Also trace a filename with no trailing number at all (e.g. `random.jpg`) and confirm it becomes its own singleton group via the `else` branch.

- [ ] **Step 3: Commit**

```bash
git add webapp/public/redchief.js
git commit -m "feat: RedChief bulk dropzone with filename-prefix grouping"
```

---

### Task 3: Folder-picker with path grouping + lenient matching

**Files:**
- Modify: `webapp/public/redchief.js` (append)

**Interfaces:**
- Consumes: same as Task 2, plus the global `wireDropzone`.
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Append the folder-grouping and lenient-matching logic**

```js
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
    return { id: redchiefUid('slot'), label, file: match ?? null, previewUrl: null, unmatched: !match };
  });
}

function redchiefGroupByFolder(fileList) {
  const files = filterImageFiles(fileList);
  const withPaths = files.map((f) => ({ file: f, segments: (f.webkitRelativePath || f.name).split('/') }));
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
  if (redchiefSelectedWorkflowIndex === null) return;
  const groups = redchiefGroupByFolder(files);
  createRedchiefRowsFromFolderGroups(groups);
}

wireDropzone(redchiefFolderDropzoneEl, redchiefFolderInputEl, handleRedchiefFolderFiles, redchiefBulkStatusEl);
```

Note on `redchiefGroupByFolder`'s `files` parameter: `wireDropzone`'s `onFiles` callback is already called with a filtered image-file array in most paths (see `app.js`'s `wireDropzone`), but the `<input webkitdirectory>` change-handler path in `app.js` also runs `filterImageFiles` before calling `onFiles` — calling `filterImageFiles` again here is a harmless no-op for already-filtered input, and is the only path (a plain drag-drop of a folder onto this same dropzone) where `onFiles` might receive richer `File` objects that still need filtering. Keep the extra `filterImageFiles` call for safety on both paths.

- [ ] **Step 2: Verify**

`node --check webapp/public/redchief.js`. Manually trace two cases:
1. Flat folder (2-segment paths only): `AllShoes/front.jpg`, `AllShoes/left.jpg` → `redchiefGroupByFolder` returns one group with `label: null` and both files — confirm `createRedchiefRowsFromFolderGroups` assigns it a default `Item N` label.
2. Nested folder: `AllShoes/Shoe1/front.jpg`, `AllShoes/Shoe1/left.jpg`, `AllShoes/Shoe2/front.jpg`, `AllShoes/stray.jpg` → confirm two subfolder groups (`Shoe1`, `Shoe2`) plus one `"Unmatched root files"` group containing `stray.jpg`, and that `redchiefMatchViewLabels` correctly matches `front.jpg`/`left.jpg` against labels like `"Front"`/`"Left"` via the normalized-contains check, leaving any unmatched label's slot `null` rather than guessing.

- [ ] **Step 3: Commit**

```bash
git add webapp/public/redchief.js
git commit -m "feat: RedChief folder-picker grouping with lenient view matching"
```

---

### Task 4: Add-row button and row-card rendering

**Files:**
- Modify: `webapp/public/redchief.js` (replace the Task 1 placeholder `renderRedchiefRows()` with the real implementation; append supporting functions)

**Interfaces:**
- Consumes: `redchiefRows`, `redchiefSelectedWorkflowIndex`, `redchiefConfig`, `redchiefUid`, `redchiefRowCounter` (Task 1).
- Produces: `renderRedchiefRows()` (final version — replaces Task 1's placeholder), `setRedchiefRowSlotFile(rowId, slotId, file)`, `clearRedchiefRowSlotFile(rowId, slotId)`, `removeRedchiefRow(rowId)` — all consumed by Task 5/6's submission and retry logic, and by this task's own event wiring.

- [ ] **Step 1: Replace the placeholder `renderRedchiefRows` and add row-card logic**

Remove the Task 1 placeholder function entirely and replace it with:

```js
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
          <button type="button" class="redchief-slot-clear" title="Clear">×</button>
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
        <span class="icon">⬆</span>
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
        <input type="text" class="redchief-row-label-input" value="${row.label}" />
        <button type="button" class="link-btn danger redchief-row-remove-btn" title="Remove row">×</button>
      </div>
      <div class="redchief-row-slots">${row.slots.map((s) => redchiefRowSlotHtml(row, s)).join('')}</div>
      ${invalid ? `<p class="redchief-validation-msg">${unfilled} view(s) still need an image — click the dashed slot(s) above to fill them in</p>` : ''}
      ${redchiefRowStatusHtml(row)}
    </div>`;
}

// Placeholder — Task 5 replaces this with real status-badge/result/cancel/
// retry markup. Kept as a safe no-op (renders nothing while row is idle) so
// Task 4 is independently verifiable before Task 5 lands.
function redchiefRowStatusHtml(row) {
  return row.status === 'idle' ? '' : `<div class="redchief-row-status">${row.status}</div>`;
}

function renderRedchiefRows() {
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
      dz.addEventListener('click', () => input.click());
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
  if (row && row.pollTimer) clearTimeout(row.pollTimer);
  redchiefRows = redchiefRows.filter((r) => r.id !== rowId);
  renderRedchiefRows();
}

function updateRedchiefSubmitEnabled() {
  const anySubmittable = redchiefRows.some((r) => r.status === 'idle' && redchiefRowUnfilledCount(r) === 0);
  redchiefSubmitBtn.disabled = redchiefSelectedWorkflowIndex === null || redchiefRows.length === 0 || !anySubmittable;
}
```

- [ ] **Step 2: Verify**

`node --check webapp/public/redchief.js`. Manually trace: adding a row via the button with no workflow selected does nothing (button itself is disabled per `renderRedchiefRows`'s `redchiefAddRowBtn.disabled` line, but the click handler's own early-return guard is a second line of defense). Confirm `setRedchiefRowSlotFile` followed by `clearRedchiefRowSlotFile` on the same slot correctly round-trips (`slot.file` back to `null`). Confirm `redchiefRowUnfilledCount` correctly reflects a partially-filled row, and that the validation message text matches the count.

- [ ] **Step 3: Commit**

```bash
git add webapp/public/redchief.js
git commit -m "feat: RedChief add-row button and row-card rendering"
```

---

### Task 5: Submission, per-row polling, status/result display

**Files:**
- Modify: `webapp/public/redchief.js` (replace the Task 4 placeholder `redchiefRowStatusHtml`; append submission/poll logic)

**Interfaces:**
- Consumes: `redchiefFindRow`, `renderRedchiefRows`, `redchiefRows` (Task 4).
- Produces: `redchiefRowStatusHtml(row)` (final version), `submitRedchiefRows()` (wired to the footer button), `pollRedchiefRow(row)` — consumed by Task 6's retry logic.

- [ ] **Step 1: Replace the placeholder status renderer and add submission/polling**

Remove the Task 4 placeholder `redchiefRowStatusHtml` function and replace it with:

```js
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
    body += ` <span class="redchief-cancel-note">${row.cancelNote}</span>`;
  }
  if (row.status === 'FAILED') {
    body += ` <span class="redchief-error-code">${row.error ?? 'unknown error'}</span>`;
    body += ` <button type="button" class="btn-secondary btn-small redchief-row-retry-btn">Retry</button>`;
  }
  if (row.status === 'COMPLETED' && row.resultUrls) {
    body += `<div class="redchief-result-grid">${row.resultUrls
      .map((url) => `<div class="redchief-result-cell"><img src="${url}" data-row="${row.id}" /><a href="${url}" target="_blank" rel="noopener" class="link-btn">Open</a></div>`)
      .join('')}</div>`;
  }
  return `<div class="redchief-row-status">${body}</div>`;
}
```

Then, at the end of `wireRedchiefRowEvents()` (from Task 4), inside the same `for (const card of ...)` loop, add wiring for the new status-area buttons — insert this right after the existing slot-wiring loop, still inside the outer `for` loop body:

```js
    const cancelBtn = card.querySelector('.redchief-row-cancel-btn');
    if (cancelBtn) cancelBtn.addEventListener('click', () => cancelRedchiefRow(rowId));
    const retryBtn = card.querySelector('.redchief-row-retry-btn');
    if (retryBtn) retryBtn.addEventListener('click', () => retryRedchiefRow(rowId));

    for (const img of card.querySelectorAll('.redchief-result-cell img')) {
      img.addEventListener('error', () => refreshRedchiefRowResult(img.dataset.row));
    }
```

(`cancelRedchiefRow`/`retryRedchiefRow`/`refreshRedchiefRowResult` are defined in Task 6 — this task only wires the buttons; clicking them before Task 6 lands would throw, which is expected and resolved by that task, exactly like the single-row UI's earlier `startRedchiefJob`/Task-5 forward-reference pattern.)

Now append the submission and polling logic:

```js
function redchiefFileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

redchiefSubmitBtn.addEventListener('click', submitRedchiefRows);

function submitRedchiefRows() {
  const submittable = redchiefRows.filter((r) => r.status === 'idle' && redchiefRowUnfilledCount(r) === 0);
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
    row.status = 'QUEUED';
    row.error = null;
    pollRedchiefRow(row);
  } catch (err) {
    row.status = 'FAILED';
    row.error = err instanceof Error ? err.message : String(err);
  }
  renderRedchiefRows();
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
        renderRedchiefRows();
        return;
      }
      if (body.status === 'FAILED') {
        row.status = 'FAILED';
        row.error = body.error ?? 'unknown error';
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

async function refreshRedchiefRowResult(rowId) {
  const row = redchiefFindRow(rowId);
  if (!row || row.status !== 'COMPLETED') return;
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
```

Finally, update `updateRedchiefSubmitEnabled` (from Task 4) — no code change needed here, since `redchiefRows.some((r) => r.status === 'idle' && ...)` already correctly re-evaluates after every `renderRedchiefRows()` call, including after rows transition to `submitting`/`QUEUED`/etc. Confirm this in your trace rather than re-writing it.

- [ ] **Step 2: Verify**

`node --check webapp/public/redchief.js`. Manually trace: two rows both `idle` and fully filled — `submitRedchiefRows()` sets both to `submitting` synchronously, then fires both `submitRedchiefRow` calls via `Promise.allSettled` (confirm neither `await`s the other by reading the code, not just by claim). Trace a single row's poll loop reaching `COMPLETED` and confirm `row.pollTimer` is never set again after that (no leaked timer). Trace what happens if `row.pollToken` is manually incremented mid-flight (simulating a future cancel) — confirm the in-flight `.then()`/`.catch()` callback's `token !== row.pollToken` check discards that stale continuation without mutating `row` or calling `renderRedchiefRows()`.

Also confirm via curl (server has a real `PROPICLY_API_KEY`) that `GET /api/redchief/jobs/:id` and `POST /api/redchief` still return exactly the shapes this code parses — no server changes were made, so this should already hold, but confirm rather than assume.

- [ ] **Step 3: Commit**

```bash
git add webapp/public/redchief.js
git commit -m "feat: RedChief per-row submission, independent polling, and result display"
```

---

### Task 6: Cancel and retry per row

**Files:**
- Modify: `webapp/public/redchief.js` (append)

**Interfaces:**
- Consumes: `redchiefFindRow`, `renderRedchiefRows`, `submitRedchiefRow`, `pollRedchiefRow` (Tasks 4-5). Wired to the buttons Task 5 already attached listeners for (`cancelRedchiefRow`, `retryRedchiefRow`, `refreshRedchiefRowResult` — the last one Task 5 already implemented; this task provides the first two).

- [ ] **Step 1: Append cancel and retry**

```js
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
  row.resultUrls = null;
  row.status = 'submitting';
  renderRedchiefRows();
  submitRedchiefRow(row);
}
```

- [ ] **Step 2: Verify**

`node --check webapp/public/redchief.js`. Manually trace: cancelling a `QUEUED` row with a mocked successful response resets every field the "reset to idle" comment promises, while `row.slots` (and therefore the uploaded photos) are untouched — confirm by checking `slots` never appears on the left-hand side of an assignment inside `cancelRedchiefRow`. Trace a `409` response and confirm `row.status` is left as `QUEUED` (not changed) while `row.cancelNote` is set — confirm `redchiefRowStatusHtml` (Task 5) actually renders `cancelNote` when present (re-check that function's `if (row.cancelNote)` branch). Trace `retryRedchiefRow` on a `FAILED` row and confirm it calls `submitRedchiefRow` with the SAME row object (same `slots`, same files) rather than constructing a new one.

- [ ] **Step 3: Commit**

```bash
git add webapp/public/redchief.js
git commit -m "feat: RedChief per-row cancel and retry"
```

---

### Task 7: Styling pass

**Files:**
- Modify: `webapp/public/style.css` — add `--err-tint` to both the light `:root` block and the `@media (prefers-color-scheme: dark)` block; add every new RedChief multi-row class; remove now-dead single-row-only classes.

**Interfaces:**
- Consumes: every class name introduced by Tasks 1, 4, 5 (`redchief-workflow-picker`, `redchief-workflow-card`(`.selected`), `redchief-bulk-panel` uses `.upload-row`/`.dropzone`/`.icon` already styled — no new rules needed there, `redchief-rows`, `redchief-row-card`(`.invalid`), `redchief-row-header`, `redchief-row-index`, `redchief-row-label-input`, `redchief-row-remove-btn` (reuses `.link-btn.danger`, already styled), `redchief-row-slots`, `redchief-slot`, `redchief-slot-label`, `redchief-dropzone` + `.redchief-slot-empty`/`.redchief-slot-filled`/`.redchief-slot-unmatched` modifiers, `redchief-slot-preview`, `redchief-slot-clear`, `redchief-validation-msg`, `redchief-row-status`, `redchief-status-badge` + `.warn`/`.accent`/`.ok`/`.err`/`.muted` modifiers, `redchief-cancel-note`, `redchief-error-code`, `redchief-result-grid`/`redchief-result-cell` (already exist from the single-row work — keep, now reused per-row), `redchief-footer-bar`).

- [ ] **Step 1: Add `--err-tint`**

In `webapp/public/style.css`'s `:root` block, right after `--err: #d64545;`:
```css
  --err-tint: rgba(214, 69, 69, 0.1);
```
In the `@media (prefers-color-scheme: dark)` block, right after `--err: #ff6b6b;`:
```css
    --err-tint: rgba(255, 107, 107, 0.15);
```

- [ ] **Step 2: Remove dead single-row-only rules**

Delete these three existing rules entirely:
```css
.redchief-slots { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 16px; margin-top: 10px; }
.redchief-slot { display: flex; flex-direction: column; gap: 8px; align-items: center; }
.redchief-slot-label { font-size: 0.82rem; font-weight: 650; color: var(--muted); }
```
`.redchief-slots` (plural, the old grid container) has no replacement — the new row-level grid container is a differently-named class (`.redchief-row-slots`, added in Step 3). `.redchief-slot` and `.redchief-slot-label` (singular) ARE reused by the new per-row markup, but with different rule bodies (no `align-items: center`, different gap) — Step 3 below adds complete replacement rules for both under the same selector names, so deleting the old bodies here (rather than leaving them to be silently shadowed by cascade order) avoids two conflicting definitions for the same selector sitting in the file at once. Confirm via grep that no other markup depends on the exact old rule body before deleting (it shouldn't — this class is RedChief-only).

- [ ] **Step 3: Add the new rules**

Append:
```css
/* ---------- RedChief multi-row UI ---------- */
.redchief-workflow-picker { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 10px; }
.redchief-workflow-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 16px;
  border: 1.5px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: var(--text);
}
.redchief-workflow-card strong { font-size: 0.95rem; }
.redchief-workflow-card span { font-size: 0.78rem; color: var(--muted); }
.redchief-workflow-card:hover { border-color: var(--pink); }
.redchief-workflow-card.selected { border-color: var(--pink); background: var(--pink-tint); }
.redchief-workflow-card.selected span { color: var(--pink); }

.redchief-rows { display: flex; flex-direction: column; gap: 16px; margin-top: 10px; }
.redchief-row-card { border: 1px solid var(--border); border-radius: 10px; padding: 16px; background: var(--panel); }
.redchief-row-card.invalid { border-color: var(--err); background: var(--err-tint); }
.redchief-row-header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.redchief-row-index { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); font-weight: 650; }
.redchief-row-label-input { flex: 1; border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 0.88rem; background: var(--bg); color: var(--text); }
.redchief-row-label-input:focus { outline: 2px solid var(--pink); outline-offset: 1px; }
.redchief-row-remove-btn { font-size: 1.1rem; line-height: 1; }

.redchief-row-slots { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 14px; }
.redchief-slot { display: flex; flex-direction: column; gap: 6px; }
.redchief-slot-label { font-size: 0.78rem; font-weight: 650; color: var(--muted); }
.redchief-slot .redchief-dropzone { min-height: 100px; flex-direction: column; position: relative; }
.redchief-slot-unmatched { border-color: var(--err); background: var(--err-tint); color: var(--err); }
.redchief-slot-filled { border-style: solid; padding: 0; overflow: hidden; }
.redchief-slot-preview { width: 100%; height: 100px; object-fit: cover; border-radius: 8px; }
.redchief-slot-clear {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 22px;
  height: 22px;
  border-radius: 999px;
  border: none;
  background: var(--err);
  color: #fff;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}

.redchief-validation-msg { margin: 10px 0 0; font-size: 0.82rem; font-weight: 650; color: var(--err); }

.redchief-row-status { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border); display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.redchief-status-badge { font-size: 0.72rem; font-weight: 700; padding: 3px 10px; border-radius: 999px; text-transform: uppercase; }
.redchief-status-badge.muted { background: var(--border); color: var(--muted); }
.redchief-status-badge.warn { background: var(--warn-tint); color: var(--warn); }
.redchief-status-badge.accent { background: var(--pink-tint); color: var(--pink); }
.redchief-status-badge.ok { background: var(--ok-tint); color: var(--ok); }
.redchief-status-badge.err { background: var(--err-tint); color: var(--err); }
.redchief-cancel-note { font-size: 0.8rem; color: var(--muted); }
.redchief-error-code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.78rem; color: var(--err); }

.redchief-footer-bar {
  position: sticky;
  bottom: 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 20px;
  padding: 14px 20px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
  box-shadow: var(--shadow);
}
.redchief-footer-bar span { font-size: 0.85rem; color: var(--muted); }
```

- [ ] **Step 4: Verify**

Confirm every class the new markup/JS references (list in Interfaces above) has a corresponding rule (or is intentionally left to inherit an already-existing rule like `.dropzone`/`.link-btn.danger`/`.btn-small`). Confirm the diff removed only classes verified (via grep) to be unreferenced anywhere else. Browser rendering can't be checked in this environment — this file-by-file cross-reference is the verification.

- [ ] **Step 5: Commit**

```bash
git add webapp/public/style.css
git commit -m "style: RedChief multi-row UI layout"
```

---

### Task 8: End-to-end live verification

**Files:** none (verification-only)

**Interfaces:** none — exercises the full stack built in Tasks 1-7 against the real, already-configured `PROPICLY_API_KEY`.

- [ ] **Step 1: Confirm the page loads and the workflow picker renders**

`pnpm web`, log in (`admin`/`Digitals@2025`), open the RedChief tab. Since browser automation can't reach `localhost` here, use curl to confirm `GET /api/redchief/config` still returns the real workflows (already proven working in the earlier single-row work; this task's job is to confirm nothing about the UI's assumptions changed, not to re-prove the backend). Read the served `index.html`/`redchief.js` via curl (authenticated) and confirm the new markup/script landed as expected — same technique used throughout this session for prior tasks in this same environment.

- [ ] **Step 2: One real multi-row submission (proves concurrent independence)**

This is the one thing that genuinely differs from the already-proven single-row backend calls: two jobs fired concurrently, each polled independently. Using curl to simulate what the two rows' `submitRedchiefRow` calls would do — POST two separate `/api/redchief` jobs back-to-back (both using the smallest available view-count workflow, one dummy image each) — then poll both `jobId`s in an interleaved loop (not one fully to completion before starting the other) and confirm both eventually reach a terminal state independently, with neither call's timing affecting the other's. This mirrors what `Promise.allSettled` + two independent `pollRedchiefRow` timers do in the browser, without needing actual browser execution.

Report to the user exactly what happened (per `CLAUDE.md`'s "report honestly" rule) — this spends real credits (2x the flat `creditCost`, e.g. 10 credits at 5/job).

- [ ] **Step 3: Cancel one of the two while the other keeps going**

Immediately after creating both jobs in Step 2, cancel the first one (`POST /api/redchief/jobs/:id/cancel`) while the second is still `QUEUED`/`RUNNING` — confirm the cancel succeeds independently and the second job's own poll (from Step 2) is unaffected (still reaches its own terminal state on its own timeline).

- [ ] **Step 4: Commit**

No code changes expected — if Steps 1-3 surface a real bug, fix it, re-verify, and commit the fix with a message describing what was wrong.

---

## Self-Review Notes

- **Spec coverage:** workflow/view-count picker + switch-warning (Task 1), bulk dropzone prefix-grouping (Task 2), folder-picker path-grouping + lenient matching + unmatched-slot styling (Task 3, styled in Task 7), add-row + row-card rendering + validation (Task 4), footer bar + Promise.allSettled submission + independent per-row polling + result display + expired-URL refresh (Task 5), cancel + retry per row (Task 6), full styling reusing existing tokens/components (Task 7), live proof of concurrent independence (Task 8) — every numbered section of the spec maps to a task.
- **Placeholder scan:** the two intentional forward-reference placeholders (`renderRedchiefRows` in Task 1 → completed by Task 4; `redchiefRowStatusHtml` in Task 4 → completed by Task 5; the cancel/retry button wiring in Task 5 referencing Task 6's not-yet-defined functions) are each explicitly called out as such, matching the same pattern the original single-row plan used successfully.
- **Type/interface consistency:** `TestRow`'s exact field names (`id`, `label`, `slots`, `jobId`, `status`, `resultUrls`, `error`, `pollTimer`, `pollToken`) are used identically by every task that touches a row object — no renaming across Tasks 1-6. `ViewSlot`'s fields (`id`, `label`, `file`, `previewUrl`, plus the Task-3-only `unmatched` flag consumed by Task 4's rendering) are likewise consistent.
