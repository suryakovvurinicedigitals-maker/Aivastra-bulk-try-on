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
const navSettingsLink = document.getElementById('nav-settings-link');
const aivastraSettingsForm = document.getElementById('aivastra-settings-form');
const aivastraBaseUrlEl = document.getElementById('aivastra-base-url');
const aivastraApiKeyEl = document.getElementById('aivastra-api-key');
const aivastraKeyStatusEl = document.getElementById('aivastra-key-status');
const aivastraSettingsBtn = document.getElementById('aivastra-settings-btn');
const aivastraTestBtn = document.getElementById('aivastra-test-btn');
const aivastraSettingsStatusEl = document.getElementById('aivastra-settings-status');

const propiclySettingsForm = document.getElementById('propicly-settings-form');
const propiclyBaseUrlEl = document.getElementById('propicly-base-url');
const propiclyApiKeyEl = document.getElementById('propicly-api-key');
const propiclyKeyStatusEl = document.getElementById('propicly-key-status');
const propiclySettingsBtn = document.getElementById('propicly-settings-btn');
const propiclyTestBtn = document.getElementById('propicly-test-btn');
const propiclySettingsStatusEl = document.getElementById('propicly-settings-status');

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
  const isAdmin = currentUser.role === 'superadmin' || currentUser.role === 'admin';
  sidebarRoleEl.textContent = isAdmin ? 'admin' : 'user';
  const avatarEl = document.getElementById('sidebar-avatar');
  if (avatarEl) avatarEl.textContent = (currentUser.username || 'U').charAt(0).toUpperCase();
  if (navUsersLink) navUsersLink.hidden = !isAdmin;
  if (navSettingsLink) navSettingsLink.hidden = !isAdmin;
  return true;
}

logoutBtn.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.href = '/login.html';
});

// ---------- router ----------
function setView(name) {
  // Non-admin users cannot access the Users page or API Setup page
  const isAdmin = currentUser?.role === 'superadmin' || currentUser?.role === 'admin';
  if ((name === 'users' || name === 'settings') && !isAdmin) {
    name = 'upload';
    if (location.hash && location.hash !== '#upload') {
      history.replaceState(null, '', '#upload');
    }
  }
  const target = views.some((v) => v.dataset.view === name) ? name : 'upload';
  for (const v of views) v.hidden = v.dataset.view !== target;
  for (const l of navLinks) l.classList.toggle('active', l.dataset.view === target);
  if (target === 'upload') enterUploadView();
  if (target === 'results') loadResults(false);
  else stopResultsPolling();
  if (target === 'users' && isAdmin) loadUsers();
  if (target === 'settings' && isAdmin) loadApiSettings();
  if (target === 'redchief') window.enterRedchiefView?.();
  if (target === 'catalog') window.enterCatalogView?.();
}
window.addEventListener('hashchange', () => setView(location.hash.slice(1)));

// ---------- users (super admin) ----------
function userRowHtml(u) {
  const created = new Date(u.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const isYou = u.username === currentUser?.username;
  const isSuperadmin = u.role === 'superadmin';
  const roleLabel = isSuperadmin ? 'Admin' : 'User';
  const removeBtn =
    isSuperadmin || isYou
      ? '<span class="chip chip-muted">Protected</span>'
      : `<button type="button" class="btn-ghost-danger btn-small remove-user-btn" data-username="${u.username}">Remove</button>`;
  return `
    <tr data-username="${u.username}">
      <td>
        <div class="user-cell">
          <div class="user-avatar">${(u.username || 'U').charAt(0).toUpperCase()}</div>
          <span class="user-name">${u.username}</span>
          ${isYou ? '<span class="chip chip-accent">You</span>' : ''}
        </div>
      </td>
      <td><span class="role-badge ${u.role}">${roleLabel}</span></td>
      <td class="cell-when">${created}</td>
      <td>
        <div class="pw-reset-row">
          <input type="text" class="pw-reset-input" data-username="${u.username}" placeholder="New password (optional)" autocomplete="off" />
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
  const action = newPassword ? 'set the new' : 'generate a temporary';
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
  usersActionStatusEl.innerHTML = `New password for <b>${data.username}</b>: <code>${data.password}</code> — copy and send it to the user now, it will not be shown again.`;
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
    createUserStatusEl.textContent = `User "${data.user.username}" created successfully.`;
    createUserStatusEl.className = 'status ok';
    createUserForm.reset();
    await loadUsers();
  } finally {
    createUserBtn.disabled = false;
  }
});

// ---------- API Setup (super admin) ----------
// Key inputs are always left blank on load/reload -- the server never sends
// a key's plaintext back (see /api/admin/api-settings GET), only whether one
// is set and how long it is. A blank key field on save means "keep it".
// ---------- API Setup (super admin) ----------
function keyStatusText(key) {
  return key && key.set ? `Key set (${key.length} characters). Leave blank to keep it.` : 'No key set yet.';
}

async function loadApiSettings() {
  const res = await fetch('/api/admin/api-settings');
  if (!res.ok) {
    aivastraSettingsStatusEl.textContent = 'Could not load settings.';
    aivastraSettingsStatusEl.className = 'status err';
    return;
  }
  const data = await res.json();
  aivastraBaseUrlEl.value = data.aivastra.baseUrl;
  aivastraKeyStatusEl.textContent = keyStatusText(data.aivastra.key);
  propiclyBaseUrlEl.value = data.propicly.baseUrl;
  propiclyKeyStatusEl.textContent = keyStatusText(data.propicly.key);
}

async function saveApiSettings(target, baseUrlEl, apiKeyEl, keyStatusEl, btn, statusEl) {
  btn.disabled = true;
  statusEl.className = 'status';
  statusEl.textContent = '';
  try {
    const res = await fetch('/api/admin/api-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target, baseUrl: baseUrlEl.value.trim(), apiKey: apiKeyEl.value.trim() }),
    });
    const data = await res.json();
    if (!res.ok) {
      statusEl.textContent = data.error || 'Could not save settings.';
      statusEl.className = 'status err';
      return;
    }
    apiKeyEl.value = '';
    const saved = target === 'aivastra' ? data.aivastra : data.propicly;
    baseUrlEl.value = saved.baseUrl;
    keyStatusEl.textContent = keyStatusText(saved.key);
    statusEl.textContent = 'Saved.';
    statusEl.className = 'status ok';
  } finally {
    btn.disabled = false;
  }
}

async function testApiConnection(target) {
  const isAivastra = target === 'aivastra';
  const testBtn = isAivastra ? aivastraTestBtn : propiclyTestBtn;
  const statusEl = isAivastra ? aivastraSettingsStatusEl : propiclySettingsStatusEl;
  const url = isAivastra ? '/api/balance' : '/api/redchief/config';

  if (testBtn) testBtn.disabled = true;
  statusEl.className = 'status';
  statusEl.textContent = 'Testing connection…';

  try {
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.available === false) {
      const errMsg = data.error || (data.code ? `Error: ${data.code}` : 'Connection failed.');
      statusEl.textContent = `Connection failed: ${errMsg}`;
      statusEl.className = 'status err';
      return;
    }

    if (isAivastra) {
      const credits = typeof data.credits === 'number' ? data.credits : '–';
      const tryOns = typeof data.tryOnsRemaining === 'number' ? data.tryOnsRemaining : '–';
      statusEl.textContent = `Connected: ${credits} credits remaining (${tryOns} try-ons).`;
    } else {
      const cost = typeof data.creditCost === 'number' ? `${data.creditCost} credits/job` : 'ready';
      statusEl.textContent = `Connected: ${cost}.`;
    }
    statusEl.className = 'status ok';
  } catch (err) {
    statusEl.textContent = `Connection error: ${err.message || String(err)}`;
    statusEl.className = 'status err';
  } finally {
    if (testBtn) testBtn.disabled = false;
  }
}

aivastraSettingsForm.addEventListener('submit', (e) => {
  e.preventDefault();
  saveApiSettings('aivastra', aivastraBaseUrlEl, aivastraApiKeyEl, aivastraKeyStatusEl, aivastraSettingsBtn, aivastraSettingsStatusEl);
});

propiclySettingsForm.addEventListener('submit', (e) => {
  e.preventDefault();
  saveApiSettings('propicly', propiclyBaseUrlEl, propiclyApiKeyEl, propiclyKeyStatusEl, propiclySettingsBtn, propiclySettingsStatusEl);
});

if (aivastraTestBtn) {
  aivastraTestBtn.addEventListener('click', () => testApiConnection('aivastra'));
}

if (propiclyTestBtn) {
  propiclyTestBtn.addEventListener('click', () => testApiConnection('propicly'));
}

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
  const topbarCreditsEl = document.getElementById('topbar-credits-val');
  if (!data.available) {
    sidebarBalanceEl.innerHTML = `<b>—</b>DEV_API_KEY not set`;
    if (topbarCreditsEl) topbarCreditsEl.textContent = '— Credits';
    currentBalance = null;
    return;
  }
  sidebarBalanceEl.innerHTML = `<b>${data.credits.toLocaleString()}</b>~${data.tryOnsRemaining.toLocaleString()} try-ons left`;
  if (topbarCreditsEl) topbarCreditsEl.textContent = `${data.credits.toLocaleString()} Credits`;
  currentBalance = data;
}

// ---------- upload view ----------
// The <select> ships with a real, working default list in index.html so
// uploads never depend on this fetch succeeding — this only refreshes it with
// the live list when/if it can. A failure here is silently non-fatal.
function renderGarmentCategoryPills(categories, activeValue) {
  const container = document.getElementById('garment-category-pills');
  if (!container || !categories || !categories.length) return;
  const currentVal = (activeValue || (garmentCategoryEl ? garmentCategoryEl.value : 'upper') || '').toLowerCase();
  container.innerHTML = categories
    .map((c) => {
      const label = c.charAt(0).toUpperCase() + c.slice(1);
      const isActive = c.toLowerCase() === currentVal;
      return `<button type="button" class="segmented-pill ${isActive ? 'active' : ''}" data-value="${c}" role="tab" aria-selected="${isActive ? 'true' : 'false'}">${label}</button>`;
    })
    .join('');
}

async function loadCategories() {
  try {
    const res = await fetch('/api/categories');
    const data = await res.json();
    const prevValue = garmentCategoryEl.value;
    garmentCategoryEl.innerHTML = data.categories.map((c) => `<option value="${c}">${c}</option>`).join('');
    if (data.categories.includes(prevValue)) garmentCategoryEl.value = prevValue;
    renderGarmentCategoryPills(data.categories, garmentCategoryEl.value);
    updateGarmentTagPrompt();
    garmentCategoryEl.title =
      data.source === 'fallback' ? 'Could not reach the live category list — showing a fixed default set.' : '';
  } catch (err) {
    console.error('Could not refresh live categories — keeping the built-in default list.', err);
  }
}

let currentPlanTotal = 0;

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}

async function loadPlan() {
  const peopleCount = selection.people.length;
  const garmentCount = selection.garments.length;

  let data;
  try {
    const res = await fetch('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'selected', selection }),
    });
    data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  } catch (err) {
    planSummaryEl.innerHTML = `<div class="plan-err-note">Could not load plan: ${escapeHtml(err instanceof Error ? err.message : String(err))} — <button type="button" class="link-btn" id="plan-retry-btn">Retry</button></div>`;
    document.getElementById('plan-retry-btn')?.addEventListener('click', () => loadPlan());
    currentPlanTotal = 0;
    generateBtn.disabled = true;
    if (selectionSummaryEl) selectionSummaryEl.textContent = '';
    return 0;
  }

  // Filter out any internal disk-scan folder warnings
  const warnings = (data.warnings || []).filter(
    (w) => !w.includes('No folders found under') && !w.includes('README.md')
  );

  currentPlanTotal = data.total;
  generateBtn.disabled = data.total === 0;

  // Case 1: Nothing uploaded yet
  if (peopleCount === 0 && garmentCount === 0) {
    if (selectionSummaryEl) selectionSummaryEl.textContent = '';
    planSummaryEl.innerHTML = `
      <div class="plan-empty-note">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
        <span>Upload person model and garment photos below to build your execution plan.</span>
      </div>
    `;
    generateBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      <span>Generate Batch</span>
    `;
    return 0;
  }

  // Case 2: Some files uploaded, but total jobs is 0 (mismatch or missing one side)
  if (data.total === 0) {
    if (selectionSummaryEl) {
      selectionSummaryEl.textContent = `${peopleCount} model${peopleCount === 1 ? '' : 's'}, ${garmentCount} garment${garmentCount === 1 ? '' : 's'}`;
    }
    const missingMsg =
      peopleCount === 0
        ? 'Upload at least one person model photo below.'
        : garmentCount === 0
        ? 'Upload at least one garment photo below.'
        : 'No matching gender pairs between selected models and garments.';

    planSummaryEl.innerHTML = `
      <div class="plan-card-active">
        <div class="plan-stats-strip">
          <div class="plan-stat">
            <span class="plan-stat-val">${peopleCount}</span>
            <span class="plan-stat-label">Model${peopleCount === 1 ? '' : 's'}</span>
          </div>
          <span class="plan-stat-sep">&times;</span>
          <div class="plan-stat">
            <span class="plan-stat-val">${garmentCount}</span>
            <span class="plan-stat-label">Garment${garmentCount === 1 ? '' : 's'}</span>
          </div>
          <span class="plan-stat-sep">=</span>
          <div class="plan-stat zero">
            <span class="plan-stat-val">0</span>
            <span class="plan-stat-label">Jobs</span>
          </div>
        </div>
        <div class="plan-hint-note">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <span>${missingMsg}</span>
        </div>
      </div>
    `;
    generateBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      <span>Generate Batch</span>
    `;
    return 0;
  }

  // Case 3: Valid jobs ready to run
  if (selectionSummaryEl) {
    selectionSummaryEl.textContent = `${data.total} job${data.total === 1 ? '' : 's'} ready`;
  }

  const categoryChips = Object.entries(data.byCategory || {})
    .map(([slug, n]) => `<span class="plan-chip">${escapeHtml(slug)} · ${n}</span>`)
    .join('');

  const warningList = warnings.length
    ? `<ul class="plan-notes">${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`
    : '';

  planSummaryEl.innerHTML = `
    <div class="plan-card-active">
      <div class="plan-stats-strip">
        <div class="plan-stat">
          <span class="plan-stat-val">${peopleCount}</span>
          <span class="plan-stat-label">Model${peopleCount === 1 ? '' : 's'}</span>
        </div>
        <span class="plan-stat-sep">&times;</span>
        <div class="plan-stat">
          <span class="plan-stat-val">${garmentCount}</span>
          <span class="plan-stat-label">Garment${garmentCount === 1 ? '' : 's'}</span>
        </div>
        <span class="plan-stat-sep">=</span>
        <div class="plan-stat accent">
          <span class="plan-stat-val">${data.total}</span>
          <span class="plan-stat-label">Job${data.total === 1 ? '' : 's'}</span>
        </div>
        ${categoryChips ? `<div class="plan-chips-wrap">${categoryChips}</div>` : ''}
      </div>
      ${warningList}
    </div>
  `;

  generateBtn.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
    <span>Generate ${data.total} Job${data.total === 1 ? '' : 's'}</span>
  `;

  return data.total;
}

// ---------- uploaded-files preview (with per-item remove) ----------
function inputFileUrl(kind, item) {
  const rel = kind === 'person' ? `people/${item.gender}/${item.filename}` : `garments/${item.gender}/${item.category}/${item.filename}`;
  return `/api/file?path=${encodeURIComponent(rel)}`;
}

function updateClearButtonsVisibility() {
  if (personClearBtn) {
    personClearBtn.hidden = selection.people.length === 0;
  }
  if (garmentClearBtn) {
    garmentClearBtn.hidden = selection.garments.length === 0;
  }
}

function renderUploadThumbs(kind) {
  updateClearButtonsVisibility();
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
        <button type="button" class="thumb-remove" data-index="${i}" title="Remove ${item.filename}" aria-label="Remove ${item.filename}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
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
  const label = kind === 'person' ? 'person model(s)' : 'garment(s)';
  if (!confirm(`Delete all ${items.length} uploaded ${label} from disk? This cannot be undone.`)) return;

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
      if (isImageFile(file)) {
        // Stash the FileSystemEntry's full path — unlike a directory <input>'s
        // File objects, a drag-and-dropped file carries no webkitRelativePath
        // at all — so folder-aware consumers (e.g. the RedChief tab's
        // group-by-subfolder logic) can recover directory structure from a
        // drop the same way they already can from the click-to-pick path.
        file.relPath = (entry.fullPath || '').replace(/^\//, '');
        out.push(file);
      }
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

// ---------- segmented gender & category pill tabs ----------
const personGenderLabelEl = document.getElementById('person-gender-label');
const garmentTagLabelEl = document.getElementById('garment-tag-label');

function wireSegmentedPills(containerId, selectEl, onSelect) {
  const container = document.getElementById(containerId);
  if (!container || !selectEl) return;
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('.segmented-pill');
    if (!btn) return;
    for (const b of container.querySelectorAll('.segmented-pill')) {
      b.classList.remove('active');
      b.setAttribute('aria-selected', 'false');
    }
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    selectEl.value = btn.dataset.value;
    selectEl.dispatchEvent(new Event('change'));
    if (onSelect) onSelect(btn.dataset.value);
  });
}

function updatePersonGenderPrompt() {
  if (!personGenderLabelEl || !personGenderEl) return;
  const val = personGenderEl.value || 'men';
  personGenderLabelEl.textContent = val.charAt(0).toUpperCase() + val.slice(1);
}

function updateGarmentTagPrompt() {
  if (!garmentTagLabelEl || !garmentGenderEl || !garmentCategoryEl) return;
  const g = (garmentGenderEl.value || 'men').charAt(0).toUpperCase() + (garmentGenderEl.value || 'men').slice(1);
  const c = garmentCategoryEl.value || 'upper';
  garmentTagLabelEl.innerHTML = `${g} &bull; ${c}`;
}

wireSegmentedPills('person-gender-pills', personGenderEl, () => {
  updatePersonGenderPrompt();
});

wireSegmentedPills('garment-gender-pills', garmentGenderEl, () => {
  updateGarmentTagPrompt();
});

wireSegmentedPills('garment-category-pills', garmentCategoryEl, () => {
  updateGarmentTagPrompt();
});

if (garmentGenderEl) {
  garmentGenderEl.addEventListener('change', () => {
    const pills = document.querySelectorAll('#garment-gender-pills .segmented-pill');
    for (const b of pills) {
      const isMatch = b.dataset.value.toLowerCase() === (garmentGenderEl.value || '').toLowerCase();
      b.classList.toggle('active', isMatch);
      b.setAttribute('aria-selected', isMatch ? 'true' : 'false');
    }
    updateGarmentTagPrompt();
  });
}

if (garmentCategoryEl) {
  garmentCategoryEl.addEventListener('change', () => {
    const pills = document.querySelectorAll('#garment-category-pills .segmented-pill');
    for (const b of pills) {
      const isMatch = b.dataset.value.toLowerCase() === (garmentCategoryEl.value || '').toLowerCase();
      b.classList.toggle('active', isMatch);
      b.setAttribute('aria-selected', isMatch ? 'true' : 'false');
    }
    updateGarmentTagPrompt();
  });
}

updatePersonGenderPrompt();
updateGarmentTagPrompt();

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
    ? `<div class="run-banner-item in-progress"><span class="run-spinner"></span><span>Run in progress: <b>${run.completed + run.failed} / ${run.total}</b> (${run.completed} completed${run.failed ? `, ${run.failed} failed` : ''})</span></div>`
    : '';
  const canCancel = currentUser?.role === 'superadmin';
  const queuedLines = queuedList
    .map(
      (q, i) =>
        `<div class="run-banner-item queued-line"><span class="queue-badge">#${i + 1}</span><span>Queued: <b>${q.total} job(s)</b> — ${queuedCategoriesHtml(q.categories)} (by ${q.queuedBy}) — will start automatically once turn arrives.</span>${canCancel ? ` <button type="button" class="link-btn danger" data-cancel-queue-id="${q.id}">Cancel</button>` : ''}</div>`,
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

personClearBtn?.addEventListener('click', () => clearUploadedKind('person'));
garmentClearBtn?.addEventListener('click', () => clearUploadedKind('garment'));

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
// Persisted the same way `selection` is (see SELECTION_KEY above) — a plain
// browser refresh used to always snap the Results page back to page 1 with
// every filter cleared, which made it hard to get back to a specific result
// you'd already filtered/paged down to. Restoring from localStorage means a
// refresh (or reopening the tab later) lands back exactly where you left off.
const RESULTS_STATE_KEY = 'bulkTryonResultsState';
const DEFAULT_RESULTS_STATE = { run: '', source: '', gender: '', category: '', status: '', user: '', q: '', flagged: '', from: '', to: '', page: 1 };

function loadResultsState() {
  try {
    const v = JSON.parse(localStorage.getItem(RESULTS_STATE_KEY));
    if (v && typeof v === 'object') return { ...DEFAULT_RESULTS_STATE, ...v };
  } catch {
    /* corrupt/missing — start fresh */
  }
  return { ...DEFAULT_RESULTS_STATE };
}
function saveResultsState() {
  localStorage.setItem(RESULTS_STATE_KEY, JSON.stringify(resultsState));
}

let resultsState = loadResultsState();
// The Run/Gender/Category/User dropdowns get their restored value applied by
// fillSelectPreserving (below) once /api/results returns the real option
// lists — but the plain inputs (Status, Search, Flag, the two date pickers)
// are never rebuilt, so nothing else would ever put the restored value back
// into their DOM elements. Do that once, up front, before the first fetch.
filterStatusEl.value = resultsState.status;
filterSearchEl.value = resultsState.q;
filterFlaggedEl.value = resultsState.flagged;
filterFromEl.value = resultsState.from;
filterToEl.value = resultsState.to;

// ---------- results view: source tabs ----------
// Deliberately its own click-to-apply control, separate from the rest of
// the filter bar's Apply/Clear gate below — Try-On, RedChief, and Catalog
// produce differently-shaped results (single person+garment; face/lower/
// shoe/pose/background combos; multi-angle inputs), so switching between
// them is the single most common thing to do on this page and shouldn't
// need an extra click to take effect.
const sourceTabEls = [...document.querySelectorAll('.source-tab')];
const resultsTheadDefaultEl = document.getElementById('results-thead-default');
const resultsTheadRedchiefEl = document.getElementById('results-thead-redchief');
const resultsTheadCatalogEl = document.getElementById('results-thead-catalog');
function setActiveSourceTab(source) {
  for (const btn of sourceTabEls) {
    const active = btn.dataset.source === source;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  }
  resultsTheadDefaultEl.hidden = source === 'redchief' || source === 'catalog';
  resultsTheadRedchiefEl.hidden = source !== 'redchief';
  resultsTheadCatalogEl.hidden = source !== 'catalog';
  if (filterCategoryEl) {
    filterCategoryEl.hidden = source === 'redchief';
    if (filterCategoryEl._customSelect) filterCategoryEl._customSelect.wrap.hidden = source === 'redchief';
  }
  if (filterGenderEl) {
    filterGenderEl.hidden = source === 'redchief';
    if (filterGenderEl._customSelect) filterGenderEl._customSelect.wrap.hidden = source === 'redchief';
  }
}
setActiveSourceTab(resultsState.source); // reflect whatever was restored from localStorage before the first fetch
for (const btn of sourceTabEls) {
  btn.addEventListener('click', () => {
    if (btn.dataset.source === resultsState.source) return; // already showing this source
    resultsState.source = btn.dataset.source;
    setActiveSourceTab(resultsState.source);
    loadResults(true);
  });
}

// ============================================================================
// Custom Select & Calendar Components
// ============================================================================

function closeAllPopups() {
  document.querySelectorAll('.custom-select-wrap.open').forEach((w) => {
    w.classList.remove('open');
    const m = w.querySelector('.custom-select-menu');
    if (m) m.hidden = true;
    const t = w.querySelector('.custom-select-trigger');
    if (t) t.setAttribute('aria-expanded', 'false');
  });

  const dateWrap = document.getElementById('results-datepicker-wrap');
  if (dateWrap) {
    dateWrap.classList.remove('open');
    const popover = document.getElementById('custom-datepicker-popover');
    if (popover) popover.hidden = true;
    const trigger = document.getElementById('custom-date-trigger');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  }
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.custom-select-wrap') && !e.target.closest('.custom-datepicker-wrap')) {
    closeAllPopups();
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeAllPopups();
  }
});

function initCustomSelect(selectEl) {
  if (!selectEl || selectEl.dataset.customSelectInit) return;
  selectEl.dataset.customSelectInit = 'true';
  selectEl.classList.add('custom-select-native');

  const wrap = document.createElement('div');
  wrap.className = 'custom-select-wrap';
  if (selectEl.id) wrap.id = `${selectEl.id}-custom-wrap`;
  if (selectEl.hidden) wrap.hidden = true;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'custom-select-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  if (selectEl.getAttribute('aria-label')) {
    trigger.setAttribute('aria-label', selectEl.getAttribute('aria-label'));
  }

  const labelSpan = document.createElement('span');
  labelSpan.className = 'custom-select-label';

  const chevron = document.createElement('span');
  chevron.className = 'custom-select-chevron-icon';
  chevron.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;

  trigger.appendChild(labelSpan);
  trigger.appendChild(chevron);

  const menu = document.createElement('div');
  menu.className = 'custom-select-menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;

  selectEl.parentNode.insertBefore(wrap, selectEl);
  wrap.appendChild(trigger);
  wrap.appendChild(menu);
  wrap.appendChild(selectEl);

  function syncOptions() {
    menu.innerHTML = '';
    const selectedOption = selectEl.options[selectEl.selectedIndex] || selectEl.options[0];
    labelSpan.textContent = selectedOption ? selectedOption.textContent : (selectEl.getAttribute('aria-label') || 'Select');

    for (let i = 0; i < selectEl.options.length; i++) {
      const opt = selectEl.options[i];
      const item = document.createElement('div');
      item.className = 'custom-select-item';
      item.tabIndex = -1;
      if (opt.value === selectEl.value) {
        item.classList.add('selected');
        item.setAttribute('aria-selected', 'true');
      }
      item.dataset.value = opt.value;

      const itemText = document.createElement('span');
      itemText.className = 'custom-select-item-text';
      itemText.textContent = opt.textContent;
      item.appendChild(itemText);

      const check = document.createElement('span');
      check.className = 'custom-select-check';
      check.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
      item.appendChild(check);

      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const changed = selectEl.value !== opt.value;
        selectEl.value = opt.value;
        closeMenu();
        syncOptions();
        if (changed) {
          selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });

      menu.appendChild(item);
    }
  }

  function openMenu() {
    const isCurrentlyOpen = wrap.classList.contains('open');
    closeAllPopups();
    if (isCurrentlyOpen) return;

    menu.hidden = false;
    wrap.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');

    // Prevent menu horizontal overflow
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth - 12) {
      menu.style.left = 'auto';
      menu.style.right = '0';
    } else {
      menu.style.left = '0';
      menu.style.right = 'auto';
    }

    const selItem = menu.querySelector('.custom-select-item.selected');
    if (selItem) selItem.scrollIntoView({ block: 'nearest' });
  }

  function closeMenu() {
    menu.hidden = true;
    wrap.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
  }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (wrap.classList.contains('open')) {
      closeMenu();
    } else {
      openMenu();
    }
  });

  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (menu.hidden) {
        openMenu();
        const selItem = menu.querySelector('.custom-select-item.selected') || menu.querySelector('.custom-select-item');
        if (selItem) selItem.focus();
      }
    }
  });

  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('.custom-select-item')];
    const currentIndex = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const nextIndex = (currentIndex + 1) % items.length;
      items[nextIndex]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prevIndex = (currentIndex - 1 + items.length) % items.length;
      items[prevIndex]?.focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (document.activeElement && document.activeElement.classList.contains('custom-select-item')) {
        document.activeElement.click();
        trigger.focus();
      }
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      closeMenu();
      trigger.focus();
    }
  });

  // Intercept value property updates on selectEl
  const origDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  if (origDesc) {
    Object.defineProperty(selectEl, 'value', {
      get() {
        return origDesc.get.call(this);
      },
      set(v) {
        origDesc.set.call(this, v);
        syncOptions();
      },
      configurable: true,
    });
  }

  selectEl.addEventListener('change', syncOptions);

  const observer = new MutationObserver(() => {
    wrap.hidden = selectEl.hidden;
    syncOptions();
  });
  observer.observe(selectEl, { childList: true, attributes: true, attributeFilter: ['hidden'] });

  syncOptions();

  selectEl._customSelect = {
    sync: syncOptions,
    close: closeMenu,
    wrap,
  };
}

let customDatePicker = null;

function initCustomDatePicker() {
  const wrap = document.getElementById('results-datepicker-wrap');
  const trigger = document.getElementById('custom-date-trigger');
  const popover = document.getElementById('custom-datepicker-popover');
  const label = document.getElementById('custom-date-label');
  const clearBtn = document.getElementById('custom-date-clear-btn');
  const monthTitle = document.getElementById('cal-month-title');
  const daysGrid = document.getElementById('cal-days-grid');
  const selectionDisplay = document.getElementById('cal-selection-display');
  const prevBtn = document.getElementById('cal-prev-btn');
  const nextBtn = document.getElementById('cal-next-btn');
  const footerClearBtn = document.getElementById('cal-footer-clear');
  const footerApplyBtn = document.getElementById('cal-footer-apply');
  const presetBtns = wrap ? wrap.querySelectorAll('.datepicker-preset') : [];

  if (!wrap || !trigger || !popover || !filterFromEl || !filterToEl) return;

  const now = new Date();
  let calState = {
    start: filterFromEl.value || null,
    end: filterToEl.value || null,
    viewYear: now.getFullYear(),
    viewMonth: now.getMonth(),
    hoverDate: null,
  };

  if (calState.start) {
    const [y, m] = calState.start.split('-').map(Number);
    if (y && m) {
      calState.viewYear = y;
      calState.viewMonth = m - 1;
    }
  }

  function toIsoDate(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function formatDisplayDate(dateStr, includeYear = true) {
    if (!dateStr) return '';
    const [y, m, d] = dateStr.split('-').map(Number);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return includeYear ? `${months[m - 1]} ${d}, ${y}` : `${months[m - 1]} ${d}`;
  }

  function updateTriggerLabel() {
    if (!calState.start && !calState.end) {
      label.textContent = 'Date range';
      trigger.classList.remove('has-range');
      clearBtn.hidden = true;
      selectionDisplay.textContent = 'Select date or range';
    } else if (calState.start && !calState.end) {
      label.textContent = `From ${formatDisplayDate(calState.start)}`;
      trigger.classList.add('has-range');
      clearBtn.hidden = false;
      selectionDisplay.textContent = `${formatDisplayDate(calState.start)} – Select end date`;
    } else if (calState.start && calState.end) {
      trigger.classList.add('has-range');
      clearBtn.hidden = false;
      if (calState.start === calState.end) {
        const text = formatDisplayDate(calState.start);
        label.textContent = text;
        selectionDisplay.textContent = text;
      } else {
        const [y1] = calState.start.split('-');
        const [y2] = calState.end.split('-');
        const text = y1 === y2
          ? `${formatDisplayDate(calState.start, false)} – ${formatDisplayDate(calState.end, true)}`
          : `${formatDisplayDate(calState.start, true)} – ${formatDisplayDate(calState.end, true)}`;
        label.textContent = text;
        selectionDisplay.textContent = text;
      }
    }
    updatePresetHighlight();
  }

  function updatePresetHighlight() {
    const today = toIsoDate(new Date());
    const yesterday = toIsoDate(new Date(Date.now() - 86400000));
    const last7Start = toIsoDate(new Date(Date.now() - 6 * 86400000));
    const last30Start = toIsoDate(new Date(Date.now() - 29 * 86400000));
    const thisMonthStart = toIsoDate(new Date(now.getFullYear(), now.getMonth(), 1));

    presetBtns.forEach((btn) => {
      const p = btn.dataset.preset;
      let active = false;
      if (p === 'today' && calState.start === today && calState.end === today) active = true;
      if (p === 'yesterday' && calState.start === yesterday && calState.end === yesterday) active = true;
      if (p === 'last7' && calState.start === last7Start && calState.end === today) active = true;
      if (p === 'last30' && calState.start === last30Start && calState.end === today) active = true;
      if (p === 'thisMonth' && calState.start === thisMonthStart && calState.end === today) active = true;
      btn.classList.toggle('active', active);
    });
  }

  function renderCalendar() {
    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];
    monthTitle.textContent = `${monthNames[calState.viewMonth]} ${calState.viewYear}`;

    daysGrid.innerHTML = '';

    const firstDayIndex = new Date(calState.viewYear, calState.viewMonth, 1).getDay();
    const daysInMonth = new Date(calState.viewYear, calState.viewMonth + 1, 0).getDate();
    const prevDaysInMonth = new Date(calState.viewYear, calState.viewMonth, 0).getDate();

    const todayStr = toIsoDate(new Date());

    // Fill days from previous month
    for (let i = firstDayIndex - 1; i >= 0; i--) {
      const dayNum = prevDaysInMonth - i;
      const prevMonth = calState.viewMonth === 0 ? 11 : calState.viewMonth - 1;
      const prevYear = calState.viewMonth === 0 ? calState.viewYear - 1 : calState.viewYear;
      const dateStr = `${prevYear}-${String(prevMonth + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
      createDayButton(dayNum, dateStr, true);
    }

    // Fill days of current month
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${calState.viewYear}-${String(calState.viewMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      createDayButton(d, dateStr, false);
    }

    // Fill days into next month to complete the 7-col grid
    const totalRendered = firstDayIndex + daysInMonth;
    const remaining = (totalRendered % 7 === 0) ? 0 : 7 - (totalRendered % 7);
    for (let n = 1; n <= remaining; n++) {
      const nextMonth = calState.viewMonth === 11 ? 0 : calState.viewMonth + 1;
      const nextYear = calState.viewMonth === 11 ? calState.viewYear + 1 : calState.viewYear;
      const dateStr = `${nextYear}-${String(nextMonth + 1).padStart(2, '0')}-${String(n).padStart(2, '0')}`;
      createDayButton(n, dateStr, true);
    }

    function createDayButton(dayNum, dateStr, isOutside) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'datepicker-day';
      btn.textContent = String(dayNum);
      btn.dataset.date = dateStr;

      if (isOutside) btn.classList.add('outside-month');
      if (dateStr === todayStr) btn.classList.add('is-today');

      const isStart = calState.start && dateStr === calState.start;
      const isEnd = calState.end && dateStr === calState.end;
      const isSingleDay = calState.start && calState.end && calState.start === calState.end && isStart;

      if (isSingleDay) {
        btn.classList.add('single-day', 'range-start', 'range-end');
      } else {
        if (isStart) btn.classList.add('range-start');
        if (isEnd) btn.classList.add('range-end');
      }

      if (calState.start && calState.end && dateStr > calState.start && dateStr < calState.end) {
        btn.classList.add('in-range');
      } else if (calState.start && !calState.end && calState.hoverDate && dateStr > calState.start && dateStr <= calState.hoverDate) {
        btn.classList.add('in-range-preview');
      }

      btn.addEventListener('mouseenter', () => {
        if (calState.start && !calState.end && dateStr >= calState.start) {
          calState.hoverDate = dateStr;
          daysGrid.querySelectorAll('.datepicker-day').forEach((dBtn) => {
            const dStr = dBtn.dataset.date;
            if (dStr && dStr > calState.start && dStr <= calState.hoverDate) {
              dBtn.classList.add('in-range-preview');
            } else {
              dBtn.classList.remove('in-range-preview');
            }
          });
        }
      });

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isOutside) {
          const [y, m] = dateStr.split('-').map(Number);
          calState.viewYear = y;
          calState.viewMonth = m - 1;
        }
        handleDayClick(dateStr);
      });

      daysGrid.appendChild(btn);
    }
  }

  function handleDayClick(dateStr) {
    if (!calState.start || (calState.start && calState.end)) {
      calState.start = dateStr;
      calState.end = null;
      calState.hoverDate = null;
      updateTriggerLabel();
      renderCalendar();
    } else {
      if (dateStr < calState.start) {
        calState.start = dateStr;
        calState.end = null;
        calState.hoverDate = null;
        updateTriggerLabel();
        renderCalendar();
      } else {
        calState.end = dateStr;
        calState.hoverDate = null;
        commitRange(calState.start, calState.end);
      }
    }
  }

  function commitRange(start, end) {
    calState.start = start;
    calState.end = end;
    filterFromEl.value = start || '';
    filterToEl.value = end || '';
    updateTriggerLabel();
    closePopover();
    applyResultsFilters();
  }

  function clearRange(triggerFetch = true) {
    calState.start = null;
    calState.end = null;
    calState.hoverDate = null;
    filterFromEl.value = '';
    filterToEl.value = '';
    updateTriggerLabel();
    closePopover();
    if (triggerFetch) {
      applyResultsFilters();
    }
  }

  function openPopover() {
    const isCurrentlyOpen = wrap.classList.contains('open');
    closeAllPopups();
    if (isCurrentlyOpen) return;

    if (calState.start) {
      const [y, m] = calState.start.split('-').map(Number);
      calState.viewYear = y;
      calState.viewMonth = m - 1;
    } else {
      const n = new Date();
      calState.viewYear = n.getFullYear();
      calState.viewMonth = n.getMonth();
    }

    renderCalendar();
    updateTriggerLabel();
    popover.hidden = false;
    wrap.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');

    const rect = popover.getBoundingClientRect();
    if (rect.right > window.innerWidth - 12) {
      popover.style.left = 'auto';
      popover.style.right = '0';
    } else {
      popover.style.left = '0';
      popover.style.right = 'auto';
    }
  }

  function closePopover() {
    popover.hidden = true;
    wrap.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
  }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (wrap.classList.contains('open')) {
      closePopover();
    } else {
      openPopover();
    }
  });

  clearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    clearRange(true);
  });

  prevBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (calState.viewMonth === 0) {
      calState.viewMonth = 11;
      calState.viewYear -= 1;
    } else {
      calState.viewMonth -= 1;
    }
    renderCalendar();
  });

  nextBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (calState.viewMonth === 11) {
      calState.viewMonth = 0;
      calState.viewYear += 1;
    } else {
      calState.viewMonth += 1;
    }
    renderCalendar();
  });

  footerClearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    clearRange(true);
  });

  footerApplyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (calState.start) {
      const end = calState.end || calState.start;
      commitRange(calState.start, end);
    } else {
      closePopover();
    }
  });

  presetBtns.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = btn.dataset.preset;
      const today = new Date();
      let startStr = '';
      let endStr = '';

      if (p === 'today') {
        startStr = toIsoDate(today);
        endStr = startStr;
      } else if (p === 'yesterday') {
        const y = new Date(Date.now() - 86400000);
        startStr = toIsoDate(y);
        endStr = startStr;
      } else if (p === 'last7') {
        endStr = toIsoDate(today);
        startStr = toIsoDate(new Date(Date.now() - 6 * 86400000));
      } else if (p === 'last30') {
        endStr = toIsoDate(today);
        startStr = toIsoDate(new Date(Date.now() - 29 * 86400000));
      } else if (p === 'thisMonth') {
        startStr = toIsoDate(new Date(today.getFullYear(), today.getMonth(), 1));
        endStr = toIsoDate(today);
      }

      if (startStr && endStr) {
        const [y, m] = startStr.split('-').map(Number);
        calState.viewYear = y;
        calState.viewMonth = m - 1;
        commitRange(startStr, endStr);
      }
    });
  });

  if (filterFromEl.value) calState.start = filterFromEl.value;
  if (filterToEl.value) calState.end = filterToEl.value;
  updateTriggerLabel();

  customDatePicker = {
    clear: clearRange,
    setRange: commitRange,
    syncFromInputs() {
      calState.start = filterFromEl.value || null;
      calState.end = filterToEl.value || null;
      updateTriggerLabel();
    },
  };
}

// Initialize custom selects and datepicker on results page
[filterStatusEl, filterRunEl, filterCategoryEl, filterFlaggedEl, filterGenderEl, filterUserEl, flagReasonEl].forEach((el) => {
  if (el) initCustomSelect(el);
});
initCustomDatePicker();

function dateToIso(value, isEndOfDay = false) {
  if (!value) return '';
  if (value.includes('T')) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString();
  }
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return '';
  const date = isEndOfDay
    ? new Date(y, m - 1, d, 23, 59, 59, 999)
    : new Date(y, m - 1, d, 0, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}
let resultsPollHandle = null;

// Job ids currently mid-retry — checked by retryBtnHtml on every render (not
// just the one that fired the click) so the button stays disabled/"Retrying…"
// even if loadResults' background poll (see the run-banner interval further
// down) re-renders the whole table body while the retry's fetch is still in
// flight. Cleared in handleRetryClick's finally block regardless of outcome.
const retryingIds = new Set();

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
  const retryEl = e.target.closest('[data-retry-btn]');
  if (retryEl && !retryEl.disabled) {
    handleRetryClick(Number(retryEl.dataset.retryBtn));
    return;
  }
  const box = e.target.closest('.media-box');
  if (box?.dataset.full) openLightbox(box.dataset.full);
});

// Fires a failed/errored job right back through the same upstream API that
// created it — see webapp/server.mts's POST /api/results/:id/retry for the
// per-source (Try-On/RedChief/Catalog) details. This is the one point in the
// Results page UI that spends real credits, so — per CLAUDE.md's "never
// create jobs without going through the existing confirmation flow" — it's
// gated on an explicit confirm() naming that cost, exactly like Upload's
// Generate button and Catalog Batch's confirmed-total check.
async function handleRetryClick(id) {
  if (retryingIds.has(id)) return; // already in flight — the button should already be disabled, but don't double-fire on a stale click
  if (!confirm('Retry this job? This resubmits it to the live API and spends real credits, same as the original run.')) return;
  retryingIds.add(id);
  loadResults(false); // re-render now so the button flips to "Retrying…" immediately, not just after the request resolves
  try {
    const res = await fetch(`/api/results/${id}/retry`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      alert(`Retry failed: ${data.error?.message || 'Unknown error'}`);
    } else if (data.status !== 'COMPLETED') {
      alert(`Retry ran but did not complete (status: ${data.status})${data.error ? `\n${data.error}` : ''}`);
    }
  } catch (err) {
    alert(`Retry failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    retryingIds.delete(id);
    loadResults(false); // pick up the new row (and its outcome) regardless of success/failure
  }
}

function formatRunId(runId) {
  // runIds are ISO timestamps with : and . replaced by - (see run.mts / server.mts)
  const m = runId.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  return m ? `${m[1]} ${m[2]}:${m[3]}:${m[4]}` : runId;
}

function fillSelectPreserving(selectEl, values, current, allLabel, formatter) {
  if (!selectEl) return;
  const pending = selectEl.value;
  const opts = [`<option value="">${allLabel}</option>`, ...values.map((v) => `<option value="${v}">${formatter ? formatter(v) : v}</option>`)];
  selectEl.innerHTML = opts.join('');
  selectEl.value = pending || current;
  if (selectEl._customSelect) selectEl._customSelect.sync();
}

// A big clickable portrait thumbnail with a hover-revealed download button.
// Click anywhere on the image opens the fullscreen lightbox (wired via event
// delegation on the table body, see wireResultsTable below); the download
// button stops that click from bubbling so it can do its own thing.
function mediaBoxHtml(url, extraClass) {
  if (!url) return '<div class="thumb-missing">No image</div>';
  return `
    <div class="media-box${extraClass ? ` ${extraClass}` : ''}" data-full="${url}">
      <img src="${url}" loading="lazy" />
      <a class="dl-btn" href="${url}" download title="Download image" aria-label="Download image">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      </a>
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

const SOURCE_LABEL = { tryon: 'Try-On', redchief: 'RedChief', catalog: 'Catalog' };

// Sits next to the status badge on FAILED/ERROR rows across all three
// per-source row layouts — never shown on COMPLETED rows (nothing to retry).
// `row.retryable` mirrors the server's own status !== 'COMPLETED' check (see
// GET /api/results in server.mts) rather than re-deriving it here, so the two
// never drift; the server re-validates per-source retryability for real (was
// the original input ever persisted? is retry_payload present?) only when the
// button is actually clicked, since that requires a DB lookup this list
// response doesn't do per row.
function retryBtnHtml(row) {
  if (!row.retryable) return '';
  const busy = retryingIds.has(row.id);
  return `<button type="button" class="btn-secondary btn-small retry-btn" data-retry-btn="${row.id}" ${busy ? 'disabled' : ''}>${busy ? 'Retrying…' : 'Retry'}</button>`;
}

// A small labeled thumbnail for the RedChief table's Inputs/Output cells —
// same click-to-lightbox/download behavior as mediaBoxHtml (delegated on
// resultsTbodyEl, see wireResultsTable below), just laid out with its label
// underneath instead of beside it, since a row can carry 1-6 of these.
function mediaChipHtml(item) {
  return `
    <div class="media-box media-chip" data-full="${item.thumb}">
      <img src="${item.thumb}" loading="lazy" />
      <a class="dl-btn" href="${item.thumb}" download title="Download">⬇</a>
      <span class="media-chip-label">${item.label}</span>
    </div>`;
}

/**
 * RedChief's dedicated row layout, matching the shared mockup: ID (plus the
 * row's 1-based position within the current page, since the mockup shows
 * both), User, every input thumbnail labeled by view, every output
 * thumbnail, flat per-job credit cost, When, and QA/Flag — no
 * person/garment/category columns, which don't mean anything for a job that
 * can take 1-6 differently-angled inputs.
 */
function redchiefResultRowHtml(row, position) {
  const statusClass = row.status === 'COMPLETED' ? 'ok' : 'err';
  const statusLabel = row.status === 'COMPLETED' ? 'Completed' : row.status === 'FAILED' ? 'Failed' : 'Error';
  const when = new Date(row.finishedAt).toLocaleString();
  const errTitle = row.error ? ` title="${row.error.replace(/"/g, '&quot;')}"` : '';
  const rowClass = row.flag?.resolvedAt ? 'resolved-row' : row.flag ? 'flagged-row' : '';
  const inputs = row.media.filter((m) => m.kind === 'input');
  const outputs = row.media.filter((m) => m.kind === 'output');
  return `
    <tr${rowClass ? ` class="${rowClass}"` : ''}>
      <td class="cell-id">${row.id}<br /><span class="cell-position">#${position}</span></td>
      <td class="cell-when">${row.startedBy || '—'}</td>
      <td><div class="media-chip-row">${inputs.length ? inputs.map(mediaChipHtml).join('') : '<div class="thumb-missing">—</div>'}</div></td>
      <td><div class="media-chip-row">${outputs.length ? outputs.map(mediaChipHtml).join('') : '<div class="thumb-missing">—</div>'}</div></td>
      <td class="cell-when">${row.credits != null ? row.credits : '—'}</td>
      <td><span class="badge ${statusClass}"${errTitle}>${statusLabel}</span> ${retryBtnHtml(row)}</td>
      <td class="cell-when">${when}</td>
      <td class="cell-flag">${flagCellHtml(row)}</td>
    </tr>`;
}

/**
 * Catalog's dedicated row layout: fixed Face/Garment/Pose/Background/Shoes
 * columns (each a single thumbnail, picked out of row.media by label — see
 * runCatalogAggregate's recordResult call in server.mts for where those
 * labels come from) instead of RedChief's flexible N-chip Inputs cell, since
 * Catalog's axes are fixed and always mean the same thing. Lower is
 * intentionally not its own column here (not in the shared mockup) even
 * though it's captured in row.media when selected — can be added if needed.
 *
 * Shows Duration instead of RedChief's flat Credits column: the aivastra dev
 * API has no per-job catalog credit figure to read (it's resolution-dependent
 * and set by admin config — see catalog.js's own submit-confirmation text),
 * but wall-clock generate time is easy to measure server-side and more useful
 * here anyway — see runCatalogAggregate/the retry route's catalog branch in
 * server.mts for where durationMs is actually timed.
 */
function catalogResultRowHtml(row, position) {
  const statusClass = row.status === 'COMPLETED' ? 'ok' : 'err';
  const statusLabel = row.status === 'COMPLETED' ? 'Completed' : row.status === 'FAILED' ? 'Failed' : 'Error';
  const when = new Date(row.finishedAt).toLocaleString();
  const errTitle = row.error ? ` title="${row.error.replace(/"/g, '&quot;')}"` : '';
  const rowClass = row.flag?.resolvedAt ? 'resolved-row' : row.flag ? 'flagged-row' : '';
  const byLabel = (label) => row.media.find((m) => m.kind === 'input' && m.label === label);
  const output = row.media.find((m) => m.kind === 'output');
  const cell = (item) => `<td>${item ? mediaChipHtml(item) : '<div class="thumb-missing">—</div>'}</td>`;
  return `
    <tr${rowClass ? ` class="${rowClass}"` : ''}>
      <td class="cell-id">${row.id}<br /><span class="cell-position">#${position}</span></td>
      <td class="cell-when">${row.startedBy || '—'}</td>
      ${cell(byLabel('Face'))}
      ${cell(byLabel('Garment'))}
      ${cell(byLabel('Pose'))}
      ${cell(byLabel('Background'))}
      ${cell(byLabel('Shoes'))}
      ${cell(output)}
      <td class="cell-when">${formatDuration(row.durationMs)}</td>
      <td><span class="badge ${statusClass}"${errTitle}>${statusLabel}</span> ${retryBtnHtml(row)}</td>
      <td class="cell-when">${when}</td>
      <td class="cell-flag">${flagCellHtml(row)}</td>
    </tr>`;
}

function resultRowHtml(row, position) {
  if (row.source === 'redchief') return redchiefResultRowHtml(row, position);
  if (row.source === 'catalog') return catalogResultRowHtml(row, position);
  const statusClass = row.status === 'COMPLETED' ? 'ok' : 'err';
  const statusLabel = row.status === 'COMPLETED' ? 'Completed' : row.status === 'FAILED' ? 'Failed' : 'Error';
  const when = new Date(row.finishedAt).toLocaleString();
  const duration = formatDuration(row.durationMs);
  const errTitle = row.error ? ` title="${row.error.replace(/"/g, '&quot;')}"` : '';
  const rowClass = row.flag?.resolvedAt ? 'resolved-row' : row.flag ? 'flagged-row' : '';
  const sourceLabel = SOURCE_LABEL[row.source] || row.source;
  return `
    <tr${rowClass ? ` class="${rowClass}"` : ''}>
      <td class="cell-id">${row.id}</td>
      <td><span class="badge source-${row.source}">${sourceLabel}</span></td>
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
      <td><span class="badge ${statusClass}"${errTitle}>${statusLabel}</span> ${retryBtnHtml(row)}</td>
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
const FLAG_ICON_SVG = `<svg class="flag-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>`;
const CHECK_ICON_SVG = `<svg class="check-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

function flagCellHtml(row) {
  if (!row.flag) {
    return `<button type="button" class="flag-btn" data-flag-btn="${row.id}">${FLAG_ICON_SVG}<span>Flag</span></button>`;
  }
  const resolved = Boolean(row.flag.resolvedAt);
  const note = row.flag.note ? `<span class="flag-note">${row.flag.note.replace(/"/g, '&quot;')}</span>` : '';
  const resolvedNote = resolved && row.flag.resolvedNote
    ? `<span class="flag-note resolved-note">Resolved: ${row.flag.resolvedNote.replace(/"/g, '&quot;')}</span>`
    : '';
  const resolveBtn = resolved ? '' : `<button type="button" class="flag-btn resolve-btn" data-resolve-btn="${row.id}">${CHECK_ICON_SVG}<span>Mark resolved</span></button>`;
  return `
    <div class="flag-cell">
      <button type="button" class="flag-btn ${resolved ? 'resolved-active' : 'active'}" data-flag-btn="${row.id}" data-flag-reason="${row.flag.reason}" data-flag-note="${row.flag.note || ''}">
        ${resolved ? CHECK_ICON_SVG : FLAG_ICON_SVG}
        <span>${resolved ? 'Resolved' : 'Flagged'}</span>
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
  // Single choke point for every caller (Apply, Clear, Prev/Next, the
  // in-progress-run poll) so a refresh always resumes at whatever filters/
  // page were last actually in effect, not just whatever the Apply button
  // happened to save.
  saveResultsState();
  const params = new URLSearchParams();
  if (resultsState.run) params.set('run', resultsState.run);
  if (resultsState.source) params.set('source', resultsState.source);
  if (resultsState.gender) params.set('gender', resultsState.gender);
  if (resultsState.category) params.set('category', resultsState.category);
  if (resultsState.status) params.set('status', resultsState.status);
  if (resultsState.user) params.set('user', resultsState.user);
  if (resultsState.q) params.set('q', resultsState.q);
  if (resultsState.flagged) params.set('flagged', resultsState.flagged);
  if (resultsState.from) params.set('from', dateToIso(resultsState.from, false));
  if (resultsState.to) params.set('to', dateToIso(resultsState.to, true));
  params.set('page', String(resultsState.page));
  params.set('pageSize', '25');

  const res = await fetch(`/api/results?${params}`);
  const data = await res.json();

  fillSelectPreserving(filterRunEl, data.runs, resultsState.run, 'All runs', formatRunId);
  fillSelectPreserving(filterGenderEl, data.genders, resultsState.gender, 'All genders');
  fillSelectPreserving(filterCategoryEl, data.categories, resultsState.category, 'All categories');
  fillSelectPreserving(filterUserEl, data.users, resultsState.user, 'All users');

  const colCount = resultsState.source === 'redchief' ? 8 : resultsState.source === 'catalog' ? 12 : 11;
  resultsTbodyEl.innerHTML =
    data.rows.length === 0
      ? `<tr><td colspan="${colCount}" class="empty">No results yet — run a batch from Upload, RedChief, or Catalog Batch.</td></tr>`
      : data.rows.map((row, i) => resultRowHtml(row, (resultsState.page - 1) * 25 + i + 1)).join('');

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
      ? `<div class="run-banner-item in-progress"><span class="run-spinner"></span><span>Run in progress: <b>${status.completed + status.failed} / ${status.total}</b> (${status.completed} completed${status.failed ? `, ${status.failed} failed` : ''})</span></div>`
      : '';
    // Read-only here — cancelling a queued batch happens from the Upload
    // page's banner, where Generate/Queue is actually decided.
    const queuedLines = queuedList
      .map(
        (q, i) =>
          `<div class="run-banner-item queued-line"><span class="queue-badge">#${i + 1}</span><span>Queued: <b>${q.total} job(s)</b> — ${queuedCategoriesHtml(q.categories)} (by ${q.queuedBy}) — will start automatically.</span></div>`,
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

function applyResultsFilters() {
  resultsState.run = filterRunEl.value;
  resultsState.gender = filterGenderEl ? filterGenderEl.value : '';
  resultsState.category = filterCategoryEl ? filterCategoryEl.value : '';
  resultsState.status = filterStatusEl.value;
  resultsState.user = filterUserEl ? filterUserEl.value : '';
  resultsState.q = filterSearchEl.value.trim();
  resultsState.flagged = filterFlaggedEl.value;
  resultsState.from = filterFromEl.value;
  resultsState.to = filterToEl.value;
  loadResults(true);
}

// Auto-apply immediately when any dropdown or date filter changes
filterRunEl.addEventListener('change', applyResultsFilters);
filterGenderEl?.addEventListener('change', applyResultsFilters);
filterCategoryEl?.addEventListener('change', applyResultsFilters);
filterStatusEl.addEventListener('change', applyResultsFilters);
filterUserEl?.addEventListener('change', applyResultsFilters);
filterFlaggedEl.addEventListener('change', applyResultsFilters);
filterFromEl.addEventListener('change', applyResultsFilters);
filterToEl.addEventListener('change', applyResultsFilters);

let searchDebounceTimer = null;
filterSearchEl.addEventListener('input', () => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(applyResultsFilters, 300);
});
filterSearchEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    clearTimeout(searchDebounceTimer);
    applyResultsFilters();
  }
});

if (filterApplyBtn) filterApplyBtn.addEventListener('click', applyResultsFilters);

filterClearBtn.addEventListener('click', () => {
  filterRunEl.value = '';
  if (filterGenderEl) filterGenderEl.value = '';
  if (filterCategoryEl) filterCategoryEl.value = '';
  filterStatusEl.value = '';
  if (filterUserEl) filterUserEl.value = '';
  filterSearchEl.value = '';
  filterFlaggedEl.value = '';
  filterFromEl.value = '';
  filterToEl.value = '';
  if (customDatePicker) customDatePicker.clear(false);
  [filterRunEl, filterGenderEl, filterCategoryEl, filterStatusEl, filterUserEl, filterFlaggedEl].forEach((el) => {
    if (el && el._customSelect) el._customSelect.sync();
  });
  resultsState = { run: '', source: resultsState.source, gender: '', category: '', status: '', user: '', q: '', flagged: '', from: '', to: '', page: 1 };
  loadResults(true);
});

// ---------- flag modal ----------
async function loadFlagReasons() {
  const res = await fetch('/api/results/flag-reasons');
  const data = await res.json();
  flagReasons = data.reasons || [];
  flagReasonEl.innerHTML = flagReasons.map((r) => `<option value="${r.value}">${r.label}</option>`).join('');
  if (flagReasonEl._customSelect) flagReasonEl._customSelect.sync();
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
  if (flagReasonEl._customSelect) flagReasonEl._customSelect.sync();
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
