// ---------- elements ----------
const navLinks = [...document.querySelectorAll('.nav-link')];
const views = [...document.querySelectorAll('.view[data-view]')];

const personGenderEl = document.getElementById('person-gender');
const personInputEl = document.getElementById('person-input');
const personFolderInputEl = document.getElementById('person-folder-input');
const personFolderBtnEl = document.getElementById('person-folder-btn');
const personDropzoneEl = document.getElementById('person-dropzone');
const personStatusEl = document.getElementById('person-status');
const personThumbsEl = document.getElementById('person-thumbs');
const personClearBtn = document.getElementById('person-clear-btn');

const garmentGenderEl = document.getElementById('garment-gender');
const garmentCategoryEl = document.getElementById('garment-category');
const garmentInputEl = document.getElementById('garment-input');
const garmentFolderInputEl = document.getElementById('garment-folder-input');
const garmentFolderBtnEl = document.getElementById('garment-folder-btn');
const garmentDropzoneEl = document.getElementById('garment-dropzone');
const garmentStatusEl = document.getElementById('garment-status');
const garmentThumbsEl = document.getElementById('garment-thumbs');
const garmentClearBtn = document.getElementById('garment-clear-btn');

const planSummaryEl = document.getElementById('plan-summary');
const sidebarBalanceEl = document.getElementById('sidebar-balance');

const selectionSummaryEl = document.getElementById('selection-summary');
const clearSelectionBtn = document.getElementById('clear-selection-btn');

const generateBtn = document.getElementById('generate-btn');
const confirmPanelEl = document.getElementById('confirm-panel');
const confirmTextEl = document.getElementById('confirm-text');
const confirmCancelBtn = document.getElementById('confirm-cancel-btn');
const confirmRunBtn = document.getElementById('confirm-run-btn');

const runBannerEl = document.getElementById('run-banner');
const uploadRunBannerEl = document.getElementById('upload-run-banner');
const filterRunEl = document.getElementById('filter-run');
const filterGenderEl = document.getElementById('filter-gender');
const filterCategoryEl = document.getElementById('filter-category');
const filterStatusEl = document.getElementById('filter-status');
const filterUserEl = document.getElementById('filter-user');
const filterFlaggedEl = document.getElementById('filter-flagged');
const filterFromEl = document.getElementById('filter-from');
const filterToEl = document.getElementById('filter-to');
const filterSearchEl = document.getElementById('filter-search');
const filterApplyBtn = document.getElementById('filter-apply-btn');
const filterClearBtn = document.getElementById('filter-clear-btn');
const resultsMetaEl = document.getElementById('results-meta');
const resultsTbodyEl = document.getElementById('results-tbody');
const resultsPaginationEl = document.getElementById('results-pagination');

const lightboxEl = document.getElementById('lightbox');
const lightboxImgEl = document.getElementById('lightbox-img');
const lightboxCloseBtn = document.getElementById('lightbox-close');
const lightboxDownloadEl = document.getElementById('lightbox-download');

const flagModalOverlayEl = document.getElementById('flag-modal-overlay');
const flagModalTitleEl = document.getElementById('flag-modal-title');
const flagModalSubtitleEl = document.getElementById('flag-modal-subtitle');
const flagReasonGroupEl = document.getElementById('flag-reason-group');
const flagReasonEl = document.getElementById('flag-reason');
const flagNoteEl = document.getElementById('flag-note');
const flagModalErrorEl = document.getElementById('flag-modal-error');
const flagModalCancelBtn = document.getElementById('flag-modal-cancel');
const flagModalUnflagBtn = document.getElementById('flag-modal-unflag');
const flagModalSubmitBtn = document.getElementById('flag-modal-submit');
let flagReasons = [];
let flagModalRowId = null;
let flagModalMode = 'flag'; // 'flag' | 'resolve' — toggles the reason field and what submit does

const sidebarUserEl = document.getElementById('sidebar-user');
const sidebarUsernameEl = document.getElementById('sidebar-username');
const sidebarRoleEl = document.getElementById('sidebar-role');
const logoutBtn = document.getElementById('logout-btn');
const navUsersLink = document.getElementById('nav-users-link');
const createUserForm = document.getElementById('create-user-form');
const newUserUsernameEl = document.getElementById('new-user-username');
const newUserPasswordEl = document.getElementById('new-user-password');
const createUserBtn = document.getElementById('create-user-btn');
const createUserStatusEl = document.getElementById('create-user-status');
const usersTbodyEl = document.getElementById('users-tbody');
const usersActionStatusEl = document.getElementById('users-action-status');

// ---------- auth ----------
let currentUser = null;

async function loadCurrentUser() {
  const res = await fetch('/api/auth/me');
  if (!res.ok) {
    location.href = '/login.html';
    return false;
  }
  currentUser = await res.json();
  sidebarUserEl.hidden = false;
  sidebarUsernameEl.textContent = currentUser.username;
  sidebarRoleEl.textContent = currentUser.role === 'superadmin' ? 'super admin' : 'user';
  navUsersLink.hidden = currentUser.role !== 'superadmin';
  return true;
}

logoutBtn.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.href = '/login.html';
});

// ---------- router ----------
function setView(name) {
  // A non-superadmin can't reach the Users page even by typing the hash
  // directly — the nav link is hidden, but the hash itself is always
  // reachable, so this is the actual enforcement (the server-side 403 on
  // /api/admin/users is the real guard; this just avoids showing a broken page).
  if (name === 'users' && currentUser?.role !== 'superadmin') name = 'upload';
  const target = views.some((v) => v.dataset.view === name) ? name : 'upload';
  for (const v of views) v.hidden = v.dataset.view !== target;
  for (const l of navLinks) l.classList.toggle('active', l.dataset.view === target);
  if (target === 'upload') enterUploadView();
  if (target === 'results') loadResults(false);
  else stopResultsPolling();
  if (target === 'users') loadUsers();
}
window.addEventListener('hashchange', () => setView(location.hash.slice(1)));

// ---------- users (super admin) ----------
function userRowHtml(u) {
  const created = new Date(u.createdAt).toLocaleDateString();
  const removeBtn =
    u.role === 'superadmin'
      ? ''
      : `<button type="button" class="btn-danger btn-small remove-user-btn" data-username="${u.username}">Remove</button>`;
  return `
    <tr>
      <td>${u.username}${u.username === currentUser?.username ? ' <span class="empty">(you)</span>' : ''}</td>
      <td><span class="role-badge ${u.role}">${u.role === 'superadmin' ? 'Super admin' : 'User'}</span></td>
      <td>${created}</td>
      <td>
        <div class="pw-reset-row">
          <input type="text" class="pw-reset-input" data-username="${u.username}" placeholder="blank = auto-generate" />
          <button type="button" class="btn-secondary btn-small pw-reset-btn" data-username="${u.username}">Set password</button>
        </div>
      </td>
      <td>${removeBtn}</td>
    </tr>`;
}

async function loadUsers() {
  const res = await fetch('/api/admin/users');
  if (!res.ok) {
    usersTbodyEl.innerHTML = '<tr><td colspan="5" class="empty">Could not load users.</td></tr>';
    return;
  }
  const { users } = await res.json();
  usersTbodyEl.innerHTML = users.map(userRowHtml).join('');
  for (const btn of usersTbodyEl.querySelectorAll('.remove-user-btn')) {
    btn.addEventListener('click', () => removeUser(btn.dataset.username));
  }
  for (const btn of usersTbodyEl.querySelectorAll('.pw-reset-btn')) {
    btn.addEventListener('click', () => resetPassword(btn.dataset.username));
  }
}

// Blank input = server generates a random password ("reset"); a typed value
// = that exact password is set ("change") — same endpoint either way. The
// result is a plaintext shown exactly once, same as the super admin bootstrap
// password — there is no way to view it again after this, so it's on the
// admin to copy it and send it to that person now.
async function resetPassword(username) {
  const inputEl = usersTbodyEl.querySelector(`.pw-reset-input[data-username="${CSS.escape(username)}"]`);
  const newPassword = inputEl?.value.trim() || undefined;
  const action = newPassword ? 'change' : 'generate a new';
  if (!confirm(`This will ${action} password for "${username}" and log them out of any active session. Continue?`)) return;

  usersActionStatusEl.className = 'status';
  usersActionStatusEl.textContent = '';
  const res = await fetch(`/api/admin/users/${encodeURIComponent(username)}/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newPassword }),
  });
  const data = await res.json();
  if (!res.ok) {
    usersActionStatusEl.textContent = data.error || 'Could not set that password.';
    usersActionStatusEl.className = 'status err';
    return;
  }
  if (inputEl) inputEl.value = '';
  usersActionStatusEl.textContent = `New password for "${data.username}": ${data.password} — copy this and send it to them now, it will not be shown again.`;
  usersActionStatusEl.className = 'status ok';
}

async function removeUser(username) {
  if (!confirm(`Remove user "${username}"? They will be logged out immediately.`)) return;
  const res = await fetch(`/api/admin/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    alert(data.error || 'Could not remove that user.');
    return;
  }
  await loadUsers();
}

createUserForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  createUserBtn.disabled = true;
  createUserStatusEl.className = 'status';
  createUserStatusEl.textContent = '';
  try {
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: newUserUsernameEl.value.trim(), password: newUserPasswordEl.value }),
    });
    const data = await res.json();
    if (!res.ok) {
      createUserStatusEl.textContent = data.error || 'Could not create that user.';
      createUserStatusEl.className = 'status err';
      return;
    }
    createUserStatusEl.textContent = `Created "${data.user.username}".`;
    createUserStatusEl.className = 'status ok';
    createUserForm.reset();
    await loadUsers();
  } finally {
    createUserBtn.disabled = false;
  }
});

// ---------- selection ----------
// What Generate actually runs against — always just the items that were
// selected (normally: whatever was just uploaded, auto-added below), never
// the whole input/ library. Scanning the whole library by default is what
// once fired ~340 unwanted production jobs from a 2-person/3-garment upload,
// so there is deliberately no "entire library" mode anymore.
// Persisted so a page reload doesn't silently reset it back to nothing.
const SELECTION_KEY = 'bulkTryonSelection';

function loadSelection() {
  try {
    const v = JSON.parse(localStorage.getItem(SELECTION_KEY));
    if (v && Array.isArray(v.people) && Array.isArray(v.garments)) return v;
  } catch {
    /* corrupt/missing — start fresh */
  }
  return { people: [], garments: [] };
}
const selection = loadSelection();
function saveSelection() {
  localStorage.setItem(SELECTION_KEY, JSON.stringify(selection));
}

function selList(kind) {
  return kind === 'person' ? selection.people : selection.garments;
}
function selMatches(item, kind, gender, category, filename) {
  return item.gender === gender && item.filename === filename && (kind !== 'garment' || item.category === category);
}
function isSelected(kind, gender, category, filename) {
  return selList(kind).some((i) => selMatches(i, kind, gender, category, filename));
}
function addSelected(kind, gender, category, filename) {
  if (isSelected(kind, gender, category, filename)) return;
  selList(kind).push(kind === 'garment' ? { gender, category, filename } : { gender, filename });
  saveSelection();
}
function clearSelection() {
  selection.people.length = 0;
  selection.garments.length = 0;
  saveSelection();
}

// ---------- shared: balance ----------
let currentBalance = null;

async function loadBalance() {
  const res = await fetch('/api/balance');
  const data = await res.json();
  if (!data.available) {
    sidebarBalanceEl.innerHTML = `<b>—</b>DEV_API_KEY not set`;
    currentBalance = null;
    return;
  }
  sidebarBalanceEl.innerHTML = `<b>${data.credits.toLocaleString()}</b>~${data.tryOnsRemaining.toLocaleString()} try-ons left`;
  currentBalance = data;
}

// ---------- upload view ----------
// The <select> ships with a real, working default list in index.html so
// uploads never depend on this fetch succeeding — this only refreshes it with
// the live list when/if it can. A failure here is silently non-fatal.
async function loadCategories() {
  try {
    const res = await fetch('/api/categories');
    const data = await res.json();
    const prevValue = garmentCategoryEl.value;
    garmentCategoryEl.innerHTML = data.categories.map((c) => `<option value="${c}">${c}</option>`).join('');
    if (data.categories.includes(prevValue)) garmentCategoryEl.value = prevValue;
    garmentCategoryEl.title =
      data.source === 'fallback' ? 'Could not reach the live category list — showing a fixed default set.' : '';
  } catch (err) {
    console.error('Could not refresh live categories — keeping the built-in default list.', err);
  }
}

let currentPlanTotal = 0;

async function loadPlan() {
  selectionSummaryEl.textContent = `${selection.people.length} people, ${selection.garments.length} garment(s) selected`;

  const res = await fetch('/api/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: 'selected', selection }),
  });
  const data = await res.json();
  const chips =
    Object.entries(data.byCategory)
      .map(([slug, n]) => `<span class="chip">${slug} · ${n}</span>`)
      .join('') || `<span class="empty">Upload person and garment photos below to build a plan.</span>`;
  const warnings = data.warnings.length
    ? `<ul class="notes">${data.warnings.map((w) => `<li>${w}</li>`).join('')}</ul>`
    : '';
  planSummaryEl.innerHTML = `
    <div class="total">${data.total}</div>
    <div class="total-label">job(s) would run right now</div>
    <div class="chips">${chips}</div>
    ${warnings}
  `;
  currentPlanTotal = data.total;
  generateBtn.disabled = data.total === 0;
  return data.total;
}

// ---------- uploaded-files preview (with per-item remove) ----------
function inputFileUrl(kind, item) {
  const rel = kind === 'person' ? `people/${item.gender}/${item.filename}` : `garments/${item.gender}/${item.category}/${item.filename}`;
  return `/api/file?path=${encodeURIComponent(rel)}`;
}

function renderUploadThumbs(kind) {
  const containerEl = kind === 'person' ? personThumbsEl : garmentThumbsEl;
  const items = selList(kind);
  if (items.length === 0) {
    containerEl.innerHTML = '';
    return;
  }
  containerEl.innerHTML = items
    .map(
      (item, i) => `
      <div class="upload-thumb">
        <img src="${inputFileUrl(kind, item)}" loading="lazy" title="${item.filename}" />
        <button type="button" class="thumb-remove" data-index="${i}" title="Remove ${item.filename}" aria-label="Remove ${item.filename}">×</button>
      </div>`,
    )
    .join('');
  for (const btn of containerEl.querySelectorAll('.thumb-remove')) {
    btn.addEventListener('click', () => removeUploadedItem(kind, Number(btn.dataset.index)));
  }
}

// Removing an individual thumbnail deletes the file server-side too (not just
// a client-side deselect) — with the Library page gone there's no other UI
// left to manage a file that's on disk but unselected, so "remove" has to
// mean gone for good. This is what lets a bad file from a bulk/folder upload
// get dropped without redoing the whole folder.
async function removeUploadedItem(kind, index) {
  const items = selList(kind);
  const item = items[index];
  if (!item) return;
  const params = new URLSearchParams({ kind, gender: item.gender, filename: item.filename });
  if (kind === 'garment') params.set('category', item.category);
  try {
    const res = await fetch(`/api/upload?${params}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || res.statusText);
    }
  } catch (err) {
    alert(`Could not remove ${item.filename}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  items.splice(index, 1);
  saveSelection();
  renderUploadThumbs(kind);
  await loadPlan();
}

// Wipes every currently-uploaded file for one side (person or garment) —
// disk + selection both — so switching to a different gender/category/workflow
// doesn't require picking through and removing photos one at a time. Deletes
// through the same per-item endpoint as the "×" button, at the same upload
// concurrency, since there's no bulk-delete route and hundreds of one-at-a-time
// sequential DELETEs would be slow for a folder-sized batch.
async function clearUploadedKind(kind) {
  const items = selList(kind);
  if (items.length === 0) return;
  const label = kind === 'person' ? 'person photo(s)' : 'garment photo(s)';
  if (!confirm(`Delete all ${items.length} uploaded ${label} from disk and clear the selection? This cannot be undone.`)) return;

  const statusEl = kind === 'person' ? personStatusEl : garmentStatusEl;
  const toDelete = [...items];
  let done = 0;
  let failed = 0;
  statusEl.className = 'status';
  statusEl.textContent = `Clearing… (0/${toDelete.length})`;

  async function deleteOne(item) {
    const params = new URLSearchParams({ kind, gender: item.gender, filename: item.filename });
    if (kind === 'garment') params.set('category', item.category);
    try {
      const res = await fetch(`/api/upload?${params}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error(res.statusText);
    } catch (err) {
      failed++;
      console.error('Could not delete', item.filename, err);
    }
    done++;
    statusEl.textContent = `Clearing… (${done}/${toDelete.length})`;
  }

  const queue = [...toDelete];
  const workers = Array.from({ length: Math.min(UPLOAD_CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (item) await deleteOne(item);
    }
  });
  await Promise.all(workers);

  items.length = 0;
  saveSelection();
  renderUploadThumbs(kind);
  await loadPlan();
  statusEl.textContent = failed ? `Cleared, but ${failed} file(s) failed to delete.` : `Cleared all ${label}.`;
  statusEl.className = failed ? 'status err' : 'status ok';
}

// ---------- uploads (files + whole folders) ----------
const IMAGE_EXT_RE = /\.(jpe?g|png|webp)$/i;
function isImageFile(file) {
  return IMAGE_EXT_RE.test(file.name);
}
function filterImageFiles(fileList) {
  return [...fileList].filter(isImageFile);
}

// A dropped directory only exposes a FileSystemEntry, not its contents —
// readEntries() must be called repeatedly since Chromium caps each batch at
// ~100 results, so a single call can silently under-report a big folder.
function readAllEntries(reader) {
  return new Promise((resolve, reject) => {
    const all = [];
    function readBatch() {
      reader.readEntries((entries) => {
        if (entries.length === 0) {
          resolve(all);
          return;
        }
        all.push(...entries);
        readBatch();
      }, reject);
    }
    readBatch();
  });
}
function fileFromEntry(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

// One bad entry (a cloud-only OneDrive placeholder that fails to materialize,
// a permission-denied item, a stray desktop.ini/.lnk, a corrupted file) used
// to throw and abort the *entire* traversal via the awaited chain below —
// silently discarding every good file already collected, with zero feedback
// in the UI. A folder with 199 readable photos and 1 bad one produced exactly
// nothing. Now a failure is caught per-entry, recorded in `skipped`, and the
// walk continues so the rest of the folder still uploads.
async function collectFilesFromEntry(entry, out, skipped) {
  if (entry.isFile) {
    try {
      const file = await fileFromEntry(entry);
      if (isImageFile(file)) out.push(file);
    } catch (err) {
      skipped.push({ name: entry.fullPath || entry.name, error: err });
      console.error('Could not read file from dropped folder', entry.fullPath || entry.name, err);
    }
  } else if (entry.isDirectory) {
    let entries;
    try {
      entries = await readAllEntries(entry.createReader());
    } catch (err) {
      skipped.push({ name: entry.fullPath || entry.name, error: err });
      console.error('Could not read folder contents', entry.fullPath || entry.name, err);
      return;
    }
    for (const child of entries) await collectFilesFromEntry(child, out, skipped);
  }
}

// Drag-and-drop of a folder only gives us DataTransferItems (Chromium-only
// API: webkitGetAsEntry); a plain <input webkitdirectory> instead gives a
// flat FileList with the traversal already done for us. Both funnel here so
// the caller doesn't need to know which path produced the files — either way
// every image nested at any depth ends up in the returned array.
async function filesFromDataTransferItems(items) {
  const entries = [...items].map((item) => item.webkitGetAsEntry && item.webkitGetAsEntry()).filter(Boolean);
  if (entries.length === 0) {
    // Fallback for browsers without webkitGetAsEntry — flat files only, no
    // folder traversal possible.
    return { files: [...items].map((item) => item.getAsFile && item.getAsFile()).filter((f) => f && isImageFile(f)), skipped: [] };
  }
  const out = [];
  const skipped = [];
  for (const entry of entries) await collectFilesFromEntry(entry, out, skipped);
  return { files: out, skipped };
}

// Uploads run with a small concurrency cap rather than fully serial — matters
// for a "whole folder" drop of hundreds of images, where one-at-a-time would
// take minutes. Every file still gets its own request/response, so a failure
// in one never drops another from the batch.
const UPLOAD_CONCURRENCY = 4;

async function uploadFiles(files, { kind, gender, category }, statusEl, skippedCount = 0) {
  const skippedNote = skippedCount
    ? ` (${skippedCount} other file(s) in that folder could not be read and were skipped — e.g. cloud-only OneDrive placeholders.)`
    : '';
  if (files.length === 0) {
    statusEl.textContent = skippedCount
      ? `No readable image files found — every file in that folder failed to read.${skippedNote}`
      : 'No image files found (looked for .jpg/.jpeg/.png/.webp).';
    statusEl.className = 'status err';
    return;
  }
  if (kind === 'garment' && !category) {
    statusEl.textContent = 'Pick a category first.';
    statusEl.className = 'status err';
    return;
  }
  let ok = 0;
  let fail = 0;
  let done = 0;
  let lastError = '';
  statusEl.className = 'status';

  async function uploadOne(file) {
    const params = new URLSearchParams({ kind, gender, filename: file.name });
    if (category) params.set('category', category);
    try {
      const res = await fetch(`/api/upload?${params}`, { method: 'POST', body: file });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || res.statusText);
      }
      const { saved } = await res.json();
      addSelected(kind, gender, category, saved); // this run's default scope: just what got uploaded
      ok++;
    } catch (err) {
      fail++;
      lastError = err instanceof Error ? err.message : String(err);
      console.error('Upload failed', file.name, err);
    }
    done++;
    statusEl.textContent = `Uploading… (${done}/${files.length})`;
  }

  const queue = [...files];
  const workers = Array.from({ length: Math.min(UPLOAD_CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const file = queue.shift();
      if (file) await uploadOne(file);
    }
  });
  await Promise.all(workers);

  statusEl.textContent = `Done: ${ok} uploaded${fail ? `, ${fail} failed (${lastError})` : ''}.${skippedNote}`;
  statusEl.className = `status ${fail || skippedCount ? 'err' : 'ok'}`;
  renderUploadThumbs(kind);
  await loadPlan();
}

function wireDropzone(dropzoneEl, inputEl, onFiles, statusEl) {
  dropzoneEl.addEventListener('click', (e) => {
    // inputEl.click() (called here, and by wireFolderPicker's button handler
    // below) doesn't just open the OS dialog — per spec it also dispatches a
    // real, bubbling click event on that input. That synthetic event bubbles
    // straight up to this dropzone and re-enters this same handler, which
    // used to fire inputEl.click() (the FLAT picker) right on top of the
    // folder dialog the user actually asked for — the flat "Open" dialog wins
    // the race, which is why "choose a folder" opened the wrong picker. A
    // real user click can never land ON a hidden <input> (nothing to hit-test
    // on a display:none element), so any click whose target is an <input> is
    // necessarily one of these synthetic echoes — ignore it.
    if (e.target.tagName === 'INPUT') return;
    inputEl.click();
  });
  dropzoneEl.addEventListener('keydown', (e) => {
    // Only handle Enter/Space when the dropzone itself has focus — the
    // "choose a folder" button living inside it is its own focusable control,
    // and keydown bubbles up from it too. Without this check, pressing Enter
    // on that button opened the wrong (flat-file) picker instead of letting
    // the button handle its own click.
    if (e.target !== dropzoneEl) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      inputEl.click();
    }
  });
  inputEl.addEventListener('change', () => {
    const files = filterImageFiles(inputEl.files);
    onFiles(files);
    inputEl.value = '';
  });
  dropzoneEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzoneEl.classList.add('drag');
  });
  dropzoneEl.addEventListener('dragleave', () => dropzoneEl.classList.remove('drag'));
  dropzoneEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropzoneEl.classList.remove('drag');
    try {
      // items-based path handles folders (via webkitGetAsEntry); fall back to
      // the flat files list for browsers/inputs that don't expose items.
      if (e.dataTransfer.items && e.dataTransfer.items.length) {
        const { files, skipped } = await filesFromDataTransferItems(e.dataTransfer.items);
        onFiles(files, skipped.length);
      } else if (e.dataTransfer.files.length) {
        onFiles(filterImageFiles(e.dataTransfer.files), 0);
      }
    } catch (err) {
      // Belt-and-suspenders: collectFilesFromEntry already catches per-file,
      // but anything else that goes wrong here (e.g. the top-level
      // webkitGetAsEntry calls) used to reject silently — no upload, no
      // feedback, looked like the drop just did nothing.
      console.error('Folder drop failed', err);
      if (statusEl) {
        statusEl.textContent = `Could not read that drop: ${err instanceof Error ? err.message : String(err)}`;
        statusEl.className = 'status err';
      }
    }
  });
}

function wireFolderPicker(btnEl, inputEl, onFiles) {
  btnEl.addEventListener('click', (e) => {
    // Stop this from also bubbling up into the dropzone's own click handler
    // (which would open the flat single-file picker on top of this one).
    e.preventDefault();
    e.stopPropagation();
    inputEl.click();
  });
  inputEl.addEventListener('change', () => {
    const files = filterImageFiles(inputEl.files);
    onFiles(files);
    inputEl.value = '';
  });
}

wireDropzone(
  personDropzoneEl,
  personInputEl,
  (files, skippedCount) => uploadFiles(files, { kind: 'person', gender: personGenderEl.value }, personStatusEl, skippedCount),
  personStatusEl,
);
wireFolderPicker(personFolderBtnEl, personFolderInputEl, (files) =>
  uploadFiles(files, { kind: 'person', gender: personGenderEl.value }, personStatusEl),
);

wireDropzone(
  garmentDropzoneEl,
  garmentInputEl,
  (files, skippedCount) =>
    uploadFiles(
      files,
      { kind: 'garment', gender: garmentGenderEl.value, category: garmentCategoryEl.value },
      garmentStatusEl,
      skippedCount,
    ),
  garmentStatusEl,
);
wireFolderPicker(garmentFolderBtnEl, garmentFolderInputEl, (files) =>
  uploadFiles(
    files,
    { kind: 'garment', gender: garmentGenderEl.value, category: garmentCategoryEl.value },
    garmentStatusEl,
  ),
);

// ---------- generate + run-status tracking ----------
// The Upload page deliberately shows no progress bar or job log — that's
// results content, and results live only on the Results page (which polls
// /api/results live while a run is in progress). This just tracks enough to
// keep the Generate button disabled mid-run and refresh the plan/balance once
// it finishes, even if the user never leaves the Upload page.
let pollHandle = null;

// Renders a queued batch's garment categories as chips (same look as the
// Results table's category column) so a wrong-category mistake is visible at
// a glance — and cancellable — before the batch ever starts and spends
// credits. '—' for the (unexpected) case of a queued batch with no garments.
function queuedCategoriesHtml(categories) {
  if (!categories || categories.length === 0) return '<span class="chip">—</span>';
  return categories.map((c) => `<span class="chip">${c}</span>`).join(' ');
}

// Shows/hides the Upload page's own run banner — mirrors the Results page's
// banner (loadResults, below) but also renders the queue (in order, each with
// its own Cancel button), since Generate — where a user decides to queue
// something — lives on this page, not Results.
function renderUploadRunBanner(run, running) {
  const queuedList = (run && run.queued) || [];
  if (!running && queuedList.length === 0) {
    uploadRunBannerEl.hidden = true;
    uploadRunBannerEl.innerHTML = '';
    return;
  }
  uploadRunBannerEl.hidden = false;
  const runningLine = running
    ? `<div>⏳ Run in progress: <b>${run.completed + run.failed} / ${run.total}</b> (${run.completed} completed${run.failed ? `, ${run.failed} failed` : ''})</div>`
    : '';
  const canCancel = currentUser?.role === 'superadmin';
  const queuedLines = queuedList
    .map(
      (q, i) =>
        `<div class="queued-line">🕒 Queued #${i + 1}: <b>${q.total} job(s)</b> — ${queuedCategoriesHtml(q.categories)} (by ${q.queuedBy}) — will start automatically once its turn comes.${canCancel ? ` <button type="button" class="link-btn danger" data-cancel-queue-id="${q.id}">Cancel</button>` : ''}</div>`,
    )
    .join('');
  uploadRunBannerEl.innerHTML = runningLine + queuedLines;
}

// Delegated once, not rebound per render — the banner's innerHTML gets fully
// replaced on every poll tick, so per-button listeners would need rebinding
// each time anyway; delegation on the stable parent avoids that.
uploadRunBannerEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-cancel-queue-id]');
  if (btn) cancelQueuedRun(btn.dataset.cancelQueueId);
});

async function cancelQueuedRun(id) {
  if (!confirm('Cancel this queued batch? It will not start automatically.')) return;
  await fetch(`/api/run/queue/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await pollRunStatus();
}

function renderRunState(run) {
  const running = !!run && run.status === 'running';
  const hasQueued = !!(run && run.queued && run.queued.length > 0);
  // Generate stays clickable while busy now — that's what lets you queue a
  // second, third, etc. batch on top of a running one instead of waiting.
  generateBtn.disabled = currentPlanTotal === 0;
  renderUploadRunBanner(run, running);
  if ((running || hasQueued) && !pollHandle) startPolling();
  if (!running && !hasQueued && pollHandle) {
    stopPolling();
    loadPlan();
    loadBalance();
  }
}

async function pollRunStatus() {
  const res = await fetch('/api/run/status');
  renderRunState(await res.json());
}

function startPolling() {
  if (pollHandle) return;
  pollHandle = setInterval(pollRunStatus, 1500);
}
function stopPolling() {
  clearInterval(pollHandle);
  pollHandle = null;
}

generateBtn.addEventListener('click', async () => {
  // A run already active (or others already queued) doesn't block this — it
  // appends to the queue instead (see /api/run/start on the server), which
  // is what lets an overnight chain of batches run unattended: queue as many
  // as you want, they run one at a time, in the order you queued them.
  const statusRes = await fetch('/api/run/status');
  const status = await statusRes.json();
  renderRunState(status);

  const running = status.status === 'running';
  const queuedCount = (status.queued || []).length;
  const busy = running || queuedCount > 0;
  const balanceNote = currentBalance
    ? `Current balance: <b>${currentBalance.credits.toLocaleString()} credits</b> (~${currentBalance.tryOnsRemaining.toLocaleString()} try-ons).`
    : 'Balance unavailable — could not confirm you have enough credits.';
  confirmTextEl.innerHTML = busy
    ? `Something's already ${running ? 'running' : 'queued'}${queuedCount ? ` (${queuedCount} batch${queuedCount === 1 ? '' : 'es'} waiting)` : ''}. This will <b>queue</b> <b>${currentPlanTotal} job(s)</b> against <b>PRODUCTION</b> to run after the others finish, in order — covering only your <b>selected</b> people × garments. ${balanceNote}`
    : `You're about to create <b>${currentPlanTotal} job(s)</b> against <b>PRODUCTION</b> — this spends real credits, covering only your <b>selected</b> people × garments. ${balanceNote}`;
  confirmPanelEl.hidden = false;
  generateBtn.disabled = true;
});

clearSelectionBtn.addEventListener('click', () => {
  clearSelection();
  loadPlan();
  renderUploadThumbs('person');
  renderUploadThumbs('garment');
});

personClearBtn.addEventListener('click', () => clearUploadedKind('person'));
garmentClearBtn.addEventListener('click', () => clearUploadedKind('garment'));

confirmCancelBtn.addEventListener('click', () => {
  confirmPanelEl.hidden = true;
  generateBtn.disabled = currentPlanTotal === 0;
});

confirmRunBtn.addEventListener('click', async () => {
  confirmRunBtn.disabled = true;
  confirmCancelBtn.disabled = true;
  let data;
  try {
    const res = await fetch('/api/run/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmedTotal: currentPlanTotal, scope: 'selected', selection }),
    });
    data = await res.json();
    if (!res.ok) {
      if (data.error === 'PLAN_CHANGED') {
        alert(`The plan changed since you opened this confirmation (now ${data.actualTotal} job(s)). Refreshing — please review and try again.`);
        await loadPlan();
      } else {
        alert(data.error || 'Could not start the run.');
      }
      confirmPanelEl.hidden = true;
      generateBtn.disabled = currentPlanTotal === 0;
      return;
    }
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err));
    confirmPanelEl.hidden = true;
    generateBtn.disabled = false;
    return;
  } finally {
    confirmRunBtn.disabled = false;
    confirmCancelBtn.disabled = false;
  }
  confirmPanelEl.hidden = true;
  // The server now owns this exact selection (running it now, or holding it
  // queued) — clear it locally so it can't also get folded into whatever
  // gets selected and Generated next, which would silently re-run and
  // re-charge for these same pairs.
  clearSelection();
  renderUploadThumbs('person');
  renderUploadThumbs('garment');
  await pollRunStatus();
  if (!data.queued) {
    // Job-by-job progress lives only on the Results page now — send them
    // there to watch it rather than showing anything in place on Upload.
    // A queued batch has nothing to watch yet, so stay put instead.
    location.hash = '#results';
  }
});

async function enterUploadView() {
  renderUploadThumbs('person');
  renderUploadThumbs('garment');
  await Promise.all([loadCategories(), loadPlan(), pollRunStatus()]);
}

// ---------- results view ----------
// A single flat, filterable, paginated table across every run — mirrors the
// admin panel's job table (User/Date/Status/Flag/Job Type/Search filters,
// thumbnail columns) as closely as this tool's actual data supports. This
// tool still has no per-flag or per-credit tracking (no moderation, no
// billing here), so those columns stay out; User comes from who was logged
// in when the run was started (server.mts writes run-meta.json per run).
let resultsState = { run: '', gender: '', category: '', status: '', user: '', q: '', flagged: '', from: '', to: '', page: 1 };

/** `<input type="datetime-local">` gives back a value like "2026-09-04T10:30" with
 * no timezone — the browser means it in local time. `new Date(...)` parses that as
 * local time, and `.toISOString()` converts to the same UTC-string format finished_at
 * is stored in (see batch.mts), so the two sides of the SQL comparison actually agree. */
function datetimeLocalToIso(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}
let resultsPollHandle = null;

// ---------- fullscreen lightbox ----------
function openLightbox(url) {
  lightboxImgEl.src = url;
  lightboxDownloadEl.href = url;
  lightboxEl.hidden = false;
}
function closeLightbox() {
  lightboxEl.hidden = true;
  lightboxImgEl.src = '';
}
lightboxCloseBtn.addEventListener('click', closeLightbox);
lightboxEl.addEventListener('click', (e) => {
  if (e.target === lightboxEl) closeLightbox(); // clicked the dark backdrop, not the image
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !lightboxEl.hidden) closeLightbox();
});

// Delegated once on the table body (survives every innerHTML re-render from
// loadResults/pagination) — a click on a .media-box opens the lightbox with
// its full-size image; a click on the download button inside it is left
// alone so the native <a download> just does its thing.
resultsTbodyEl.addEventListener('click', (e) => {
  if (e.target.closest('.dl-btn') || e.target.closest('.bundle-link')) return;
  const resolveEl = e.target.closest('[data-resolve-btn]');
  if (resolveEl) {
    openResolveModal(resolveEl.dataset.resolveBtn);
    return;
  }
  const flagEl = e.target.closest('[data-flag-btn]');
  if (flagEl) {
    openFlagModal(flagEl.dataset.flagBtn, flagEl.dataset.flagReason, flagEl.dataset.flagNote);
    return;
  }
  const box = e.target.closest('.media-box');
  if (box?.dataset.full) openLightbox(box.dataset.full);
});

function formatRunId(runId) {
  // runIds are ISO timestamps with : and . replaced by - (see run.mts / server.mts)
  const m = runId.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  return m ? `${m[1]} ${m[2]}:${m[3]}:${m[4]}` : runId;
}

function fillSelectPreserving(selectEl, values, current, allLabel, formatter) {
  const opts = [`<option value="">${allLabel}</option>`, ...values.map((v) => `<option value="${v}">${formatter ? formatter(v) : v}</option>`)];
  selectEl.innerHTML = opts.join('');
  selectEl.value = current;
}

// A big clickable portrait thumbnail with a hover-revealed download button.
// Click anywhere on the image opens the fullscreen lightbox (wired via event
// delegation on the table body, see wireResultsTable below); the download
// button stops that click from bubbling so it can do its own thing.
function mediaBoxHtml(url, extraClass) {
  if (!url) return '<div class="thumb-missing">—</div>';
  return `
    <div class="media-box${extraClass ? ` ${extraClass}` : ''}" data-full="${url}">
      <img src="${url}" loading="lazy" />
      <a class="dl-btn" href="${url}" download title="Download">⬇</a>
    </div>`;
}

// Job duration as shown in the Results table: seconds under a minute (one
// decimal, e.g. "12.4s"), minutes+seconds beyond that (e.g. "1m 03s"). Rows
// with no recorded duration (pre-migration or migrated-legacy jobs) show "—"
// rather than a misleading 0s.
function formatDuration(durationMs) {
  if (durationMs == null) return '—';
  const totalSeconds = durationMs / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function resultRowHtml(row) {
  const statusClass = row.status === 'COMPLETED' ? 'ok' : 'err';
  const statusLabel = row.status === 'COMPLETED' ? 'Completed' : row.status === 'FAILED' ? 'Failed' : 'Error';
  const when = new Date(row.finishedAt).toLocaleString();
  const duration = formatDuration(row.durationMs);
  const errTitle = row.error ? ` title="${row.error.replace(/"/g, '&quot;')}"` : '';
  const rowClass = row.flag?.resolvedAt ? 'resolved-row' : row.flag ? 'flagged-row' : '';
  return `
    <tr${rowClass ? ` class="${rowClass}"` : ''}>
      <td class="cell-id">${row.id}</td>
      <td class="cell-when">${row.startedBy || '—'}</td>
      <td>
        <div class="cell-thumb">
          ${mediaBoxHtml(row.personThumb)}
          <span>${row.personName}</span>
        </div>
      </td>
      <td>
        <div class="cell-thumb">
          ${mediaBoxHtml(row.garmentThumb)}
          <span>${row.garmentName}</span>
        </div>
      </td>
      <td><span class="chip">${row.categorySlug}</span></td>
      <td>${mediaBoxHtml(row.outputThumb, 'output-thumb-box')}</td>
      <td><span class="badge ${statusClass}"${errTitle}>${statusLabel}</span></td>
      <td class="cell-when">${when}</td>
      <td class="cell-when">${duration}</td>
      <td class="cell-flag">${flagCellHtml(row)}</td>
    </tr>`;
}

function flagReasonLabel(value) {
  return flagReasons.find((r) => r.value === value)?.label || value;
}

// Mirrors the main app's renderFlagCell (apps/api/src/modules/results/routes.ts)
// so the two flagging UIs read the same: unflagged rows just get a Flag
// button; flagged rows get a reason badge (click to edit/unflag), an optional
// note, a bundle-download link, and — while still unresolved — a Mark
// resolved button.
function flagCellHtml(row) {
  if (!row.flag) {
    return `<button type="button" class="flag-btn" data-flag-btn="${row.id}">⚑ Flag</button>`;
  }
  const resolved = Boolean(row.flag.resolvedAt);
  const note = row.flag.note ? `<span class="flag-note">${row.flag.note.replace(/"/g, '&quot;')}</span>` : '';
  const resolvedNote = resolved && row.flag.resolvedNote
    ? `<span class="flag-note resolved-note">Resolved: ${row.flag.resolvedNote.replace(/"/g, '&quot;')}</span>`
    : '';
  const resolveBtn = resolved ? '' : `<button type="button" class="flag-btn resolve-btn" data-resolve-btn="${row.id}">Mark resolved</button>`;
  return `
    <div class="flag-cell">
      <button type="button" class="flag-btn ${resolved ? 'resolved-active' : 'active'}" data-flag-btn="${row.id}" data-flag-reason="${row.flag.reason}" data-flag-note="${row.flag.note || ''}">
        ⚑ ${resolved ? 'Resolved' : 'Flagged'}
      </button>
      <span class="flag-badge${resolved ? ' resolved' : ''}" title="${flagReasonLabel(row.flag.reason)}">${flagReasonLabel(row.flag.reason)}</span>
      ${note}
      ${resolvedNote}
      <a class="bundle-link" href="/api/results/${row.id}/bundle">Download bundle</a>
      ${resolveBtn}
    </div>`;
}

function renderPagination(page, totalPages) {
  if (totalPages <= 1) {
    resultsPaginationEl.innerHTML = '';
    return;
  }
  resultsPaginationEl.innerHTML = `
    <button id="page-prev-btn" class="btn-secondary btn-small" ${page <= 1 ? 'disabled' : ''}>Prev</button>
    <span>Page ${page} of ${totalPages}</span>
    <button id="page-next-btn" class="btn-secondary btn-small" ${page >= totalPages ? 'disabled' : ''}>Next</button>
  `;
  document.getElementById('page-prev-btn')?.addEventListener('click', () => {
    resultsState.page = Math.max(1, resultsState.page - 1);
    loadResults(false);
  });
  document.getElementById('page-next-btn')?.addEventListener('click', () => {
    resultsState.page += 1;
    loadResults(false);
  });
}

async function loadResults(resetPage) {
  if (resetPage) resultsState.page = 1;
  const params = new URLSearchParams();
  if (resultsState.run) params.set('run', resultsState.run);
  if (resultsState.gender) params.set('gender', resultsState.gender);
  if (resultsState.category) params.set('category', resultsState.category);
  if (resultsState.status) params.set('status', resultsState.status);
  if (resultsState.user) params.set('user', resultsState.user);
  if (resultsState.q) params.set('q', resultsState.q);
  if (resultsState.flagged) params.set('flagged', resultsState.flagged);
  if (resultsState.from) params.set('from', datetimeLocalToIso(resultsState.from));
  if (resultsState.to) params.set('to', datetimeLocalToIso(resultsState.to));
  params.set('page', String(resultsState.page));
  params.set('pageSize', '25');

  const res = await fetch(`/api/results?${params}`);
  const data = await res.json();

  fillSelectPreserving(filterRunEl, data.runs, resultsState.run, 'All runs', formatRunId);
  fillSelectPreserving(filterGenderEl, data.genders, resultsState.gender, 'All');
  fillSelectPreserving(filterCategoryEl, data.categories, resultsState.category, 'All');
  fillSelectPreserving(filterUserEl, data.users, resultsState.user, 'All');

  resultsTbodyEl.innerHTML =
    data.rows.length === 0
      ? '<tr><td colspan="10" class="empty">No results yet — run a batch from the Upload page.</td></tr>'
      : data.rows.map(resultRowHtml).join('');

  resultsMetaEl.textContent = `${data.total.toLocaleString()} output(s) — page ${data.page} of ${data.totalPages}`;
  renderPagination(data.page, data.totalPages);

  // Keep the table (and this banner) live while a run is actively in
  // progress, so results stream in as they complete without the user needing
  // to hit Apply — this is the only place run progress is shown anywhere in
  // the app now.
  const statusRes = await fetch('/api/run/status');
  const status = await statusRes.json();
  const running = status.status === 'running';
  const queuedList = status.queued || [];
  if (running || queuedList.length > 0) {
    runBannerEl.hidden = false;
    const runningLine = running
      ? `<div>⏳ Run in progress: <b>${status.completed + status.failed} / ${status.total}</b> (${status.completed} completed${status.failed ? `, ${status.failed} failed` : ''})</div>`
      : '';
    // Read-only here — cancelling a queued batch happens from the Upload
    // page's banner, where Generate/Queue is actually decided.
    const queuedLines = queuedList
      .map(
        (q, i) =>
          `<div class="queued-line">🕒 Queued #${i + 1}: <b>${q.total} job(s)</b> — ${queuedCategoriesHtml(q.categories)} (by ${q.queuedBy}) — will start automatically.</div>`,
      )
      .join('');
    runBannerEl.innerHTML = runningLine + queuedLines;
    if (!resultsPollHandle) resultsPollHandle = setInterval(() => loadResults(false), 3000);
  } else {
    runBannerEl.hidden = true;
    stopResultsPolling();
  }
}

function stopResultsPolling() {
  if (resultsPollHandle) clearInterval(resultsPollHandle);
  resultsPollHandle = null;
}

filterApplyBtn.addEventListener('click', () => {
  resultsState.run = filterRunEl.value;
  resultsState.gender = filterGenderEl.value;
  resultsState.category = filterCategoryEl.value;
  resultsState.status = filterStatusEl.value;
  resultsState.user = filterUserEl.value;
  resultsState.q = filterSearchEl.value.trim();
  resultsState.flagged = filterFlaggedEl.value;
  resultsState.from = filterFromEl.value;
  resultsState.to = filterToEl.value;
  loadResults(true);
});
filterClearBtn.addEventListener('click', () => {
  filterStatusEl.value = '';
  filterSearchEl.value = '';
  filterFlaggedEl.value = '';
  filterFromEl.value = '';
  filterToEl.value = '';
  resultsState = { run: '', gender: '', category: '', status: '', user: '', q: '', flagged: '', from: '', to: '', page: 1 };
  loadResults(true);
});
filterSearchEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') filterApplyBtn.click();
});

// ---------- flag modal ----------
async function loadFlagReasons() {
  const res = await fetch('/api/results/flag-reasons');
  const data = await res.json();
  flagReasons = data.reasons || [];
  flagReasonEl.innerHTML = flagReasons.map((r) => `<option value="${r.value}">${r.label}</option>`).join('');
}

function openFlagModal(rowId, currentReason, currentNote) {
  flagModalRowId = rowId;
  flagModalMode = 'flag';
  flagModalErrorEl.hidden = true;
  flagModalErrorEl.textContent = '';
  flagReasonGroupEl.hidden = false;
  if (currentReason) {
    flagModalTitleEl.textContent = 'Update flag';
    flagModalSubtitleEl.textContent = `Update why job #${rowId} is flagged, or unflag it.`;
    flagReasonEl.value = currentReason;
    flagNoteEl.value = currentNote || '';
    flagModalUnflagBtn.hidden = false;
    flagModalSubmitBtn.textContent = 'Update';
  } else {
    flagModalTitleEl.textContent = 'Flag job';
    flagModalSubtitleEl.textContent = `Mark job #${rowId} for later review.`;
    flagReasonEl.value = flagReasons[0]?.value || '';
    flagNoteEl.value = '';
    flagModalUnflagBtn.hidden = true;
    flagModalSubmitBtn.textContent = 'Flag job';
  }
  flagModalOverlayEl.hidden = false;
}

// A job must already be flagged to resolve it — the button that opens this
// only ever renders on flagged, unresolved rows (see flagCellHtml).
function openResolveModal(rowId) {
  flagModalRowId = rowId;
  flagModalMode = 'resolve';
  flagModalErrorEl.hidden = true;
  flagModalErrorEl.textContent = '';
  flagReasonGroupEl.hidden = true;
  flagModalTitleEl.textContent = 'Mark resolved';
  flagModalSubtitleEl.textContent = `Add a note on how job #${rowId} was resolved.`;
  flagNoteEl.value = '';
  flagModalUnflagBtn.hidden = true;
  flagModalSubmitBtn.textContent = 'Mark resolved';
  flagModalOverlayEl.hidden = false;
}

function closeFlagModal() {
  flagModalOverlayEl.hidden = true;
  flagModalRowId = null;
}

async function submitFlag(unflag) {
  if (!flagModalRowId) return;
  flagModalErrorEl.hidden = true;
  const url = `/api/results/${encodeURIComponent(flagModalRowId)}/flag`;
  const res = unflag
    ? await fetch(url, { method: 'DELETE' })
    : await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: flagReasonEl.value, note: flagNoteEl.value.trim() }),
      });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    flagModalErrorEl.textContent = data.error || 'Something went wrong.';
    flagModalErrorEl.hidden = false;
    return;
  }
  closeFlagModal();
  loadResults(false);
}

async function submitResolve() {
  if (!flagModalRowId) return;
  flagModalErrorEl.hidden = true;
  const res = await fetch(`/api/results/${encodeURIComponent(flagModalRowId)}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: flagNoteEl.value.trim() }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    flagModalErrorEl.textContent = data.error || 'Something went wrong.';
    flagModalErrorEl.hidden = false;
    return;
  }
  closeFlagModal();
  loadResults(false);
}

flagModalCancelBtn.addEventListener('click', closeFlagModal);
flagModalSubmitBtn.addEventListener('click', () => (flagModalMode === 'resolve' ? submitResolve() : submitFlag(false)));
flagModalUnflagBtn.addEventListener('click', () => submitFlag(true));
flagModalOverlayEl.addEventListener('click', (e) => {
  if (e.target === flagModalOverlayEl) closeFlagModal();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !flagModalOverlayEl.hidden) closeFlagModal();
});

// ---------- boot ----------
(async () => {
  if (!(await loadCurrentUser())) return; // redirected to /login.html
  loadBalance();
  loadFlagReasons();
  setView(location.hash.slice(1) || 'upload');
})();
