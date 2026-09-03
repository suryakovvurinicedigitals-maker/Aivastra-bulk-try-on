/**
 * Local auth for the bulk-tryon web control panel only — gates this tool's
 * upload/generate/results UI. Completely separate from the main app's auth
 * system; this only protects a local, single-team tool that spends real
 * production credits (see README "Going live").
 *
 * Exactly one super admin, bootstrapped on first run (from
 * SUPERADMIN_USERNAME/SUPERADMIN_PASSWORD if set in .env, otherwise a random
 * password printed once to the console — there is no recovery path for it,
 * only the scrypt hash is ever persisted). The super admin creates every
 * other account; there is no self-registration.
 *
 * SUPERADMIN_PASSWORD stays authoritative after first run too: every startup
 * re-checks it against the stored hash, and if it no longer matches (you
 * edited .env), the stored password is updated to match and every session for
 * that account is invalidated. This means .env always wins on restart — if
 * you instead set a password through the Users page UI, remove or update
 * SUPERADMIN_PASSWORD in .env or the next restart will silently revert it.
 *
 * Users persist to the shared SQLite store (lib/db.mts), which also migrates
 * any pre-existing users.json on first run. Sessions are in-memory only
 * (cleared on restart, same as currentRun in server.mts) — a restart logs
 * everyone out, which is fine for a local tool.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { deleteUserRow, getAllUsersRows, getUserRow, insertUserRow, updateUserPasswordHash, type StoredUser } from '../lib/db.mts';

export type Role = 'superadmin' | 'user';

export interface PublicUser {
  username: string;
  role: Role;
  createdAt: string;
}

export interface Session {
  username: string;
  role: Role;
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hashHex] = stored.split(':');
  if (!salt || !hashHex) return false;
  const candidate = scryptSync(password, salt, 64);
  const actual = Buffer.from(hashHex, 'hex');
  return candidate.length === actual.length && timingSafeEqual(candidate, actual);
}

function toPublic(u: StoredUser): PublicUser {
  return { username: u.username, role: u.role, createdAt: u.createdAt };
}

/**
 * Called once at every server startup. Bootstraps the super admin on first
 * run; on every run after that, re-syncs its password from
 * SUPERADMIN_PASSWORD in .env if that's set and no longer matches what's
 * stored — see the file header for why.
 */
export function ensureSuperAdmin(): void {
  const existing = getAllUsersRows().find((u) => u.role === 'superadmin');

  if (existing) {
    const envPassword = process.env.SUPERADMIN_PASSWORD;
    if (envPassword && !verifyPassword(envPassword, existing.passwordHash)) {
      updateUserPasswordHash(existing.username, hashPassword(envPassword));
      destroySessionsForUser(existing.username);
      console.log(`Super admin password updated from SUPERADMIN_PASSWORD in .env (existing sessions logged out).`);
    }
    return;
  }

  const username = process.env.SUPERADMIN_USERNAME || 'admin';
  const generatedPassword = process.env.SUPERADMIN_PASSWORD || randomBytes(9).toString('base64url');
  insertUserRow({ username, passwordHash: hashPassword(generatedPassword), role: 'superadmin', createdAt: new Date().toISOString() });

  console.log('='.repeat(60));
  console.log('Bootstrapped the super admin account for the bulk-tryon web panel:');
  console.log(`  username: ${username}`);
  if (process.env.SUPERADMIN_PASSWORD) {
    console.log('  password: (from SUPERADMIN_PASSWORD in .env)');
  } else {
    console.log(`  password: ${generatedPassword}`);
    console.log('  (generated — save this now, it will not be shown again)');
  }
  console.log('='.repeat(60));
}

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,40}$/;

export function verifyLogin(username: string, password: string): PublicUser | null {
  const user = getUserRow(username);
  if (!user || !verifyPassword(password, user.passwordHash)) return null;
  return toPublic(user);
}

export function listUsers(): PublicUser[] {
  return getAllUsersRows()
    .map(toPublic)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Always creates a regular 'user' — this is the only account-creation path, which is what keeps "exactly one super admin" true. */
export function createUser(username: string, password: string): { ok: true; user: PublicUser } | { ok: false; error: string } {
  if (!USERNAME_RE.test(username)) {
    return { ok: false, error: 'Username must be 3-40 characters: letters, numbers, "_", ".", "-".' };
  }
  if (password.length < 8) {
    return { ok: false, error: 'Password must be at least 8 characters.' };
  }
  if (getAllUsersRows().some((u) => u.username.toLowerCase() === username.toLowerCase())) {
    return { ok: false, error: 'That username is already taken.' };
  }
  const user: StoredUser = { username, passwordHash: hashPassword(password), role: 'user', createdAt: new Date().toISOString() };
  insertUserRow(user);
  return { ok: true, user: toPublic(user) };
}

export function deleteUser(username: string): { ok: true } | { ok: false; error: string } {
  const target = getUserRow(username);
  if (!target) return { ok: false, error: 'User not found.' };
  if (target.role === 'superadmin') return { ok: false, error: 'Cannot remove the super admin.' };
  deleteUserRow(username);
  return { ok: true };
}

// ---- sessions (in-memory, cleared on restart) ----
const sessions = new Map<string, Session>();

export function createSession(user: PublicUser): string {
  const token = randomBytes(32).toString('hex');
  sessions.set(token, { username: user.username, role: user.role });
  return token;
}

export function getSession(token: string | undefined): Session | null {
  if (!token) return null;
  return sessions.get(token) ?? null;
}

export function destroySession(token: string | undefined): void {
  if (token) sessions.delete(token);
}

function destroySessionsForUser(username: string): void {
  for (const [token, s] of sessions) {
    if (s.username === username) sessions.delete(token);
  }
}

/**
 * Admin-only reset/change — there is no self-service password flow. Covers
 * both cases the Users page needs: omit `newPassword` to generate a random
 * one ("reset"), or pass one to set it explicitly ("change"). Either way the
 * plaintext is returned exactly once, the same one-shot-reveal pattern as the
 * super admin bootstrap in ensureSuperAdmin — there is no recovery path for
 * it afterward, only the hash is persisted. Every existing session for that
 * user is invalidated so a changed password actually locks out whoever had
 * the old one.
 */
export function setPassword(username: string, newPassword?: string): { ok: true; password: string } | { ok: false; error: string } {
  const target = getUserRow(username);
  if (!target) return { ok: false, error: 'User not found.' };

  const password = newPassword && newPassword.length > 0 ? newPassword : randomBytes(9).toString('base64url');
  if (password.length < 8) return { ok: false, error: 'Password must be at least 8 characters.' };

  updateUserPasswordHash(username, hashPassword(password));
  destroySessionsForUser(username);
  return { ok: true, password };
}
