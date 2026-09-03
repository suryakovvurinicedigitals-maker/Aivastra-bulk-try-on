const formEl = document.getElementById('login-form');
const usernameEl = document.getElementById('login-username');
const passwordEl = document.getElementById('login-password');
const statusEl = document.getElementById('login-status');
const submitBtn = document.getElementById('login-submit-btn');

// If a session cookie is already valid, skip the login form entirely.
fetch('/api/auth/me')
  .then((res) => (res.ok ? (location.href = '/') : null))
  .catch(() => {});

formEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  statusEl.textContent = '';
  submitBtn.disabled = true;
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: usernameEl.value, password: passwordEl.value }),
    });
    const data = await res.json();
    if (!res.ok) {
      statusEl.textContent = data.error || 'Could not log in.';
      submitBtn.disabled = false;
      return;
    }
    location.href = '/';
  } catch (err) {
    statusEl.textContent = err instanceof Error ? err.message : String(err);
    submitBtn.disabled = false;
  }
});
