/**
 * Local control panel for scripts/bulk-tryon/ — upload UI + a Generate button
 * that runs the batch directly from the browser, plus a Results browser for
 * past runs. Writes into the same input/ layout run.mts reads and drives the
 * same lib/batch.mts the CLI uses, so the web and CLI paths can't diverge.
 *
 * Zero npm dependencies on purpose (matches the rest of scripts/bulk-tryon/):
 * plain node:http + a hand-rolled static file server. Uploads are sent as a
 * raw request body (fetch(url, { body: file })) rather than multipart/form-data,
 * which sidesteps writing a multipart parser entirely — one file per request.
 *
 * NOT deployment-ready as-is: there is no auth, no rate limiting, and no
 * content moderation, and the Generate button spends real production credits
 * for whoever can reach this page. Fine for local, single-operator use; before
 * putting this on a public URL, add at minimum a shared passphrase gate — see
 * README "Going live" section.
 *
 * Usage: pnpm bulk-tryon:web   (defaults to http://localhost:5959)
 */
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBalance, getCategories, type DevApiConfig } from '../lib/api-client.mts';
import { runBatch } from '../lib/batch.mts';
import { clearFlag, ensureRun, getFlag, getResultRow, listResults, resolveFlag, setFlag } from '../lib/db.mts';
import { scanInput, type TryonJobSpec } from '../lib/scan-input.mts';
import {
  createSession,
  createUser,
  deleteUser,
  destroySession,
  ensureSuperAdmin,
  getSession,
  listUsers,
  setPassword,
  verifyLogin,
  type Session,
} from './auth.mts';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url)); // .../scripts/bulk-tryon/webapp
const BULK_TRYON_DIR = path.dirname(SCRIPT_DIR); // .../scripts/bulk-tryon
const PUBLIC_DIR = path.join(SCRIPT_DIR, 'public');
const INPUT_DIR = process.env.INPUT_DIR ? path.resolve(process.env.INPUT_DIR) : path.join(BULK_TRYON_DIR, 'input');
const OUTPUT_DIR = process.env.OUTPUT_DIR ? path.resolve(process.env.OUTPUT_DIR) : path.join(BULK_TRYON_DIR, 'output');

const PORT = Number(process.env.WEB_PORT ?? 5959);
const BASE_URL = (process.env.DEV_API_BASE_URL ?? 'https://app.aivastra.com').replace(/\/$/, '');
const API_KEY = process.env.DEV_API_KEY;
const cfg: DevApiConfig | undefined = API_KEY ? { baseUrl: BASE_URL, apiKey: API_KEY } : undefined;
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 2);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 4000);
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS ?? 5 * 60 * 1000);

// Used only if the live dev API can't be reached — keeps the upload UI usable
// (category dropdown, plan preview) even when DEV_API_KEY isn't set locally.
const FALLBACK_CATEGORIES = ['upper', 'lower', 'suits', 'saree', 'dress', 'general'];

// Fixed QA flag categories for the Results table's flag modal — mirrors the
// main app's /results tool (apps/api/src/modules/results/routes.ts) verbatim,
// since these two flagging UIs should read the same to anyone using both.
const FLAG_REASONS: { value: string; label: string }[] = [
  { value: 'multiple_body_parts', label: 'Multiple body parts' },
  { value: 'nudity', label: 'Nudity' },
  { value: 'draping_issue', label: 'Draping issue' },
  { value: 'additional_assets', label: 'Additional assets' },
  { value: 'texture_issue', label: 'Texture issue' },
  { value: 'wrong_input_uploaded', label: 'Wrong input/uploaded' },
];
const FLAG_REASON_VALUES = new Set(FLAG_REASONS.map((r) => r.value));

// Flags (and their resolve state) live in the shared SQLite store — lib/db.mts
// — keyed by job_results.id, the autoincrement id listResults()/getResultRow()
// hand out. See db.mts's flags table and getFlag/setFlag/clearFlag/resolveFlag.

// ---- Minimal ZIP writer (STORE method, no compression, no dependency) ----
// Every entry here is already a compressed image or a small JSON file, so
// there's nothing to gain from deflating — and skipping it means no external
// zip library is needed, keeping this tool's zero-npm-dependency rule intact.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function dosDateTime(d: Date): { time: number; date: number } {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}
function buildZip(entries: { name: string; data: Buffer }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const { time, date } = dosDateTime(new Date());

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 filenames
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + size;
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(centralParts);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(centralStart, 16);

  return Buffer.concat([...localParts, centralBuf, end]);
}

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20MB — generous for a phone photo, stops absurd payloads
const MAX_RUN_LOG_LINES = 500; // capped so a big batch can't grow this without bound in memory

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

// ---- in-memory state for the currently (or most recently) triggered run ----
interface RunLogEntry {
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}
interface RunState {
  runId: string;
  status: 'running' | 'done';
  total: number;
  completed: number;
  failed: number;
  startedAt: string;
  finishedAt?: string;
  log: RunLogEntry[];
}
let currentRun: RunState | null = null;

function pushLog(level: RunLogEntry['level'], message: string) {
  if (!currentRun) return;
  currentRun.log.push({ at: new Date().toISOString(), level, message });
  if (currentRun.log.length > MAX_RUN_LOG_LINES) currentRun.log.shift();
}

// Gender/category are folder-name inputs, not free text — keep them to a
// conservative charset so they can never be used to escape INPUT_DIR.
function safeSlug(v: string | null): string | null {
  if (!v || !/^[a-z0-9_-]{1,40}$/i.test(v)) return null;
  return v;
}

function safeFilename(v: string | null): string | null {
  if (!v) return null;
  const base = path.basename(v); // strip any directory components a client might send
  if (!/^[\w .()-]{1,150}$/i.test(base)) return null;
  const ext = path.extname(base).toLowerCase();
  if (!IMAGE_EXT.has(ext)) return null;
  return base;
}

function safeRunId(v: string | null): string | null {
  if (!v || !/^[\w-]{1,80}$/.test(v)) return null;
  return v;
}

// ---- cookies / sessions ----
const SESSION_COOKIE = 'bulk_tryon_session';

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function sessionFromReq(req: http.IncomingMessage): Session | null {
  return getSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
}

function setSessionCookie(res: http.ServerResponse, token: string) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}`);
}

function clearSessionCookie(res: http.ServerResponse) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

function uniqueFilename(dir: string, filename: string): string {
  if (!existsSync(path.join(dir, filename))) return filename;
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${stem}-${stamp}${ext}`;
}

// JobResult only records the garment/person's filename *stem* (no extension —
// see scan-input.mts), so the Results table has to re-find the original input
// file by matching the stem back against what's actually still in input/. If
// it was since deleted (e.g. via the upload page's remove button), this comes
// back null and the table shows a placeholder instead of a broken image.
function findInputFileByStem(dir: string, stem: string): string | null {
  if (!existsSync(dir)) return null;
  return readdirSync(dir).find((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()) && path.basename(f, path.extname(f)) === stem) ?? null;
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': buf.length });
  res.end(buf);
}

async function readBodyCapped(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) throw new Error('PAYLOAD_TOO_LARGE');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const body = await readBodyCapped(req, 256 * 1024); // scope + a selection list, never huge
  if (body.length === 0) return undefined;
  return JSON.parse(body.toString('utf8'));
}

function serveStatic(res: http.ServerResponse, pathname: string) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const full = path.join(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR) || !existsSync(full) || !statSync(full).isFile()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = path.extname(full);
  // This file changes across restarts during active development — never let
  // the browser cache a stale copy of app.js behind a working server.
  res.writeHead(200, { 'Content-Type': STATIC_MIME[ext] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  createReadStream(full).pipe(res);
}

/** Serves a file from within `root` only — guards path traversal for both /api/file and /api/result-file. */
function serveFileWithin(res: http.ServerResponse, root: string, rel: string | null) {
  if (!rel) {
    json(res, 400, { error: 'missing path' });
    return;
  }
  const full = path.resolve(root, rel);
  if (!full.startsWith(root) || !existsSync(full) || !statSync(full).isFile()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = path.extname(full).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME_BY_EXT[ext] ?? 'application/octet-stream' });
  createReadStream(full).pipe(res);
}

// ---- selection scoping ----
// The web UI defaults to running only what the browser explicitly selected
// (normally: whatever it just uploaded) rather than every person x garment
// pairing that has ever landed in input/ — scanInput() alone always computes
// the latter, which is correct for the CLI's "run everything" model but was
// firing hundreds of unwanted production jobs from this UI. `selection` is
// client-supplied but only ever used to *filter down* scanInput's own output,
// so it can't be used to fabricate a job pointing outside input/.
interface SelectionItem {
  gender: string;
  category?: string;
  filename: string;
}
interface Selection {
  people: SelectionItem[];
  garments: SelectionItem[];
}

function isValidSelection(v: unknown): v is Selection {
  const isItemList = (list: unknown) =>
    Array.isArray(list) &&
    list.every(
      (i) => i && typeof i.gender === 'string' && typeof i.filename === 'string' && (i.category === undefined || typeof i.category === 'string'),
    );
  return !!v && typeof v === 'object' && isItemList((v as Selection).people) && isItemList((v as Selection).garments);
}

function filterBySelection(jobs: TryonJobSpec[], selection: Selection): TryonJobSpec[] {
  const peopleKeys = new Set(selection.people.map((p) => `${p.gender}|${p.filename}`));
  const garmentKeys = new Set(selection.garments.map((g) => `${g.gender}|${g.category}|${g.filename}`));
  return jobs.filter(
    (j) =>
      peopleKeys.has(`${j.gender}|${path.basename(j.personFile)}`) &&
      garmentKeys.has(`${j.gender}|${j.categorySlug}|${path.basename(j.garmentFile)}`),
  );
}

/** scope 'all' = every job scanInput finds (the CLI's model); 'selected' = only jobs where BOTH the person and the garment are in `selection`. */
async function computeJobs(cfg: DevApiConfig, scope: unknown, selection: unknown): Promise<TryonJobSpec[]> {
  const { jobs: scanned } = scanInput(INPUT_DIR);
  const activeSlugs = new Set((await getCategories(cfg)).map((c) => c.slug));
  const jobs = scanned.filter((j) => activeSlugs.has(j.categorySlug));
  if (scope === 'all') return jobs;
  if (!isValidSelection(selection)) return [];
  return filterBySelection(jobs, selection);
}

// ---- queue: an ordered list of pending batches that auto-start one after
// another, in order, as the current run finishes — the overnight-unattended
// path. Each holds the selection (not the resolved job list), since the
// underlying files must still be on disk and unchanged when its turn comes.
interface QueuedRun {
  id: string;
  selection: Selection;
  confirmedTotal: number;
  queuedBy: string;
  queuedAt: string;
}
let queuedRuns: QueuedRun[] = [];
let nextQueueId = 1;

/** Distinct garment categories in a queued batch's selection, sorted — shown next to each queue entry so a wrong-category mistake (e.g. queued "lower" instead of "upper") is visible and cancellable before it ever starts running and spending credits. */
function queuedCategories(selection: Selection): string[] {
  return [...new Set(selection.garments.map((g) => g.category).filter((c): c is string => Boolean(c)))].sort();
}

/** Actually launches a batch — shared by "start now" and "queued batch's turn arrived". */
function startRun(jobs: TryonJobSpec[], startedBy: string): { runId: string; total: number } {
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(OUTPUT_DIR, runId);
  mkdirSync(runDir, { recursive: true });
  ensureRun(runId, startedBy);

  currentRun = { runId, status: 'running', total: jobs.length, completed: 0, failed: 0, startedAt: new Date().toISOString(), log: [] };
  pushLog('info', `Starting ${jobs.length} job(s) against ${BASE_URL}.`);

  runBatch(cfg!, jobs, runId, runDir, {
    concurrency: CONCURRENCY,
    poll: { intervalMs: POLL_INTERVAL_MS, timeoutMs: POLL_TIMEOUT_MS },
    onEvent: (evt) => {
      if (!currentRun || currentRun.runId !== runId) return;
      if (evt.type === 'credits-exhausted') {
        pushLog('error', 'Out of credits — no further new jobs will be started.');
        return;
      }
      const { result } = evt;
      if (result.status === 'COMPLETED') currentRun.completed++;
      else currentRun.failed++;
      pushLog(
        result.status === 'COMPLETED' ? 'info' : 'warn',
        `[${result.status}] ${result.gender}/${result.personName} + ${result.categorySlug}/${result.garmentName}` +
          (result.error ? ` — ${result.error}` : ''),
      );
    },
  })
    .then(({ completed, failed }) => {
      if (!currentRun || currentRun.runId !== runId) return;
      currentRun.status = 'done';
      currentRun.finishedAt = new Date().toISOString();
      pushLog('info', `Done: ${completed} completed, ${failed} failed.`);
      void tryStartQueuedRun();
    })
    .catch((err) => {
      if (!currentRun || currentRun.runId !== runId) return;
      currentRun.status = 'done';
      currentRun.finishedAt = new Date().toISOString();
      pushLog('error', `Run crashed: ${err instanceof Error ? err.message : String(err)}`);
      void tryStartQueuedRun();
    });

  return { runId, total: jobs.length };
}

/** Called whenever a run finishes (success or crash) — if a batch is waiting, its turn has arrived. Re-resolves the plan fresh (files may have changed since it was queued) rather than trusting the count confirmed at queue time. Pops from the front (FIFO) so batches start in the order they were queued. */
async function tryStartQueuedRun(): Promise<void> {
  if (queuedRuns.length === 0 || currentRun?.status === 'running' || !cfg) return;
  const pending = queuedRuns.shift()!;
  const jobs = await computeJobs(cfg, 'selected', pending.selection);
  if (jobs.length === 0) {
    console.warn(`Queued run from ${pending.queuedBy} skipped — nothing left to run (inputs may have been cleared or its categories disabled).`);
    void tryStartQueuedRun(); // don't let one stale entry stall everything queued behind it
    return;
  }
  if (jobs.length !== pending.confirmedTotal) {
    console.warn(
      `Queued run from ${pending.queuedBy}: plan changed since queuing (confirmed ${pending.confirmedTotal}, now ${jobs.length}) — running the current plan anyway.`,
    );
  }
  startRun(jobs, pending.queuedBy);
}

/** Same id → row resolution as /api/results' per-page mapping, but for a single id (plus resolved absolute input/output file paths) — used by the resolve/bundle routes, which need the actual files, not just a listing. */
function resolveResultRowById(id: number): {
  id: number;
  runId: string;
  gender: string;
  personName: string;
  categorySlug: string;
  garmentName: string;
  status: string;
  finishedAt: string;
  personFile: string | null;
  garmentFile: string | null;
  outputFile: string | null;
} | null {
  const r = getResultRow(id);
  if (!r) return null;

  const personDir = path.join(INPUT_DIR, 'people', r.gender);
  const garmentDir = path.join(INPUT_DIR, 'garments', r.gender, r.categorySlug);
  const personStem = findInputFileByStem(personDir, r.personName);
  const garmentStem = findInputFileByStem(garmentDir, r.garmentName);

  return {
    id: r.id,
    runId: r.runId,
    gender: r.gender,
    personName: r.personName,
    categorySlug: r.categorySlug,
    garmentName: r.garmentName,
    status: r.status,
    finishedAt: r.finishedAt,
    personFile: personStem ? path.join(personDir, personStem) : null,
    garmentFile: garmentStem ? path.join(garmentDir, garmentStem) : null,
    outputFile: r.outputFile ?? null,
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

    // ---- auth ----
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      let body: any;
      try {
        body = (await readJsonBody(req)) ?? {};
      } catch {
        json(res, 400, { error: 'invalid request body' });
        return;
      }
      const user =
        typeof body.username === 'string' && typeof body.password === 'string' ? verifyLogin(body.username, body.password) : null;
      if (!user) {
        json(res, 401, { error: 'Invalid username or password.' });
        return;
      }
      setSessionCookie(res, createSession(user));
      json(res, 200, { username: user.username, role: user.role });
      return;
    }

    const session = sessionFromReq(req);

    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      destroySession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
      clearSessionCookie(res);
      json(res, 200, { loggedOut: true });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/auth/me') {
      if (!session) {
        json(res, 401, { error: 'not logged in' });
        return;
      }
      json(res, 200, { username: session.username, role: session.role });
      return;
    }

    // Every other /api/* route needs a session; the SPA shell itself
    // redirects to the login page rather than 401ing (static assets like
    // style.css/app.js/login.html stay ungated — nothing sensitive in them).
    if (url.pathname.startsWith('/api/')) {
      if (!session) {
        json(res, 401, { error: 'AUTH_REQUIRED' });
        return;
      }
    } else if (url.pathname === '/' || url.pathname === '/index.html') {
      if (!session) {
        res.writeHead(302, { Location: '/login.html' });
        res.end();
        return;
      }
    }

    // ---- admin: user management (super admin only) ----
    if (url.pathname === '/api/admin/users') {
      if (session!.role !== 'superadmin') {
        json(res, 403, { error: 'Super admin only.' });
        return;
      }
      if (req.method === 'GET') {
        json(res, 200, { users: listUsers() });
        return;
      }
      if (req.method === 'POST') {
        let body: any;
        try {
          body = (await readJsonBody(req)) ?? {};
        } catch {
          json(res, 400, { error: 'invalid request body' });
          return;
        }
        const result = createUser(String(body.username ?? ''), String(body.password ?? ''));
        if (!result.ok) {
          json(res, 400, { error: result.error });
          return;
        }
        json(res, 201, { user: result.user });
        return;
      }
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/admin/users/') && url.pathname.endsWith('/reset-password')) {
      if (session!.role !== 'superadmin') {
        json(res, 403, { error: 'Super admin only.' });
        return;
      }
      const username = decodeURIComponent(url.pathname.slice('/api/admin/users/'.length, -'/reset-password'.length));
      let body: any;
      try {
        body = (await readJsonBody(req)) ?? {};
      } catch {
        json(res, 400, { error: 'invalid request body' });
        return;
      }
      // Omitted/empty newPassword = "reset" (server generates one); a
      // non-empty value = "change" (admin picks it) — same endpoint either way.
      const newPassword = typeof body.newPassword === 'string' && body.newPassword.length > 0 ? body.newPassword : undefined;
      const result = setPassword(username, newPassword);
      if (!result.ok) {
        json(res, 400, { error: result.error });
        return;
      }
      json(res, 200, { username, password: result.password });
      return;
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/admin/users/')) {
      if (session!.role !== 'superadmin') {
        json(res, 403, { error: 'Super admin only.' });
        return;
      }
      const username = decodeURIComponent(url.pathname.slice('/api/admin/users/'.length));
      const result = deleteUser(username);
      if (!result.ok) {
        json(res, 400, { error: result.error });
        return;
      }
      json(res, 200, { deleted: true });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/categories') {
      if (cfg) {
        try {
          const cats = await getCategories(cfg);
          json(res, 200, { categories: cats.map((c) => c.slug), source: 'live' });
          return;
        } catch {
          // Dev API briefly unreachable — fall through to the fallback list
          // rather than breaking the review UI over it.
        }
      }
      json(res, 200, { categories: FALLBACK_CATEGORIES, source: 'fallback' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/balance') {
      if (!cfg) {
        json(res, 200, { available: false });
        return;
      }
      try {
        const balance = await getBalance(cfg);
        json(res, 200, { available: true, ...balance });
      } catch (err) {
        json(res, 200, { available: false, error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // Mirrors the plan summary run.mts prints under --dry-run, so the review
    // UI shows the same job count before anyone touches the CLI. POST (not
    // GET) because the request carries the browser's selection — see
    // "selection scoping" above. scope defaults to 'selected' (never 'all')
    // so a client that forgets to send a body gets zero jobs, not everything.
    if (req.method === 'POST' && url.pathname === '/api/plan') {
      let body: any;
      try {
        body = (await readJsonBody(req)) ?? {};
      } catch {
        json(res, 400, { error: 'invalid request body' });
        return;
      }
      const { warnings } = scanInput(INPUT_DIR);
      const counted = cfg ? await computeJobs(cfg, body.scope, body.selection) : [];
      const byCategory: Record<string, number> = {};
      for (const j of counted) byCategory[j.categorySlug] = (byCategory[j.categorySlug] ?? 0) + 1;
      json(res, 200, { total: counted.length, byCategory, warnings });
      return;
    }

    // Serves an already-uploaded input file back to the browser — used for
    // the upload page's thumbnail previews and the Results table's input
    // (person/garment) thumbnails, both scoped to INPUT_DIR only.
    if (req.method === 'GET' && url.pathname === '/api/file') {
      serveFileWithin(res, INPUT_DIR, url.searchParams.get('path'));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/upload') {
      const kind = url.searchParams.get('kind');
      const gender = safeSlug(url.searchParams.get('gender'));
      const filename = safeFilename(url.searchParams.get('filename'));
      if (!gender || !filename) {
        json(res, 400, { error: 'invalid gender or filename' });
        return;
      }

      let dir: string;
      if (kind === 'person') {
        dir = path.join(INPUT_DIR, 'people', gender);
      } else if (kind === 'garment') {
        const category = safeSlug(url.searchParams.get('category'));
        if (!category) {
          json(res, 400, { error: 'invalid category' });
          return;
        }
        dir = path.join(INPUT_DIR, 'garments', gender, category);
      } else {
        json(res, 400, { error: 'kind must be person or garment' });
        return;
      }

      let body: Buffer;
      try {
        body = await readBodyCapped(req, MAX_UPLOAD_BYTES);
      } catch {
        json(res, 413, { error: 'file too large (20MB max)' });
        return;
      }
      if (body.length === 0) {
        json(res, 400, { error: 'empty file' });
        return;
      }

      mkdirSync(dir, { recursive: true });
      const finalName = uniqueFilename(dir, filename);
      writeFileSync(path.join(dir, finalName), body);
      json(res, 200, { saved: finalName });
      return;
    }

    // Removes a single previously-uploaded file — the upload page's per-thumbnail
    // "×" button, so a bad file from a bulk/folder upload can be dropped without
    // clearing and re-picking the whole folder. Deletes from disk (not just the
    // browser's selection) since there's no other UI left to manage files that
    // are on disk but unselected — see index.html's removal of the Library page.
    if (req.method === 'DELETE' && url.pathname === '/api/upload') {
      const kind = url.searchParams.get('kind');
      const gender = safeSlug(url.searchParams.get('gender'));
      const filename = safeFilename(url.searchParams.get('filename'));
      if (!gender || !filename) {
        json(res, 400, { error: 'invalid gender or filename' });
        return;
      }

      let dir: string;
      if (kind === 'person') {
        dir = path.join(INPUT_DIR, 'people', gender);
      } else if (kind === 'garment') {
        const category = safeSlug(url.searchParams.get('category'));
        if (!category) {
          json(res, 400, { error: 'invalid category' });
          return;
        }
        dir = path.join(INPUT_DIR, 'garments', gender, category);
      } else {
        json(res, 400, { error: 'kind must be person or garment' });
        return;
      }

      const full = path.join(dir, filename);
      if (!full.startsWith(dir) || !existsSync(full)) {
        json(res, 404, { error: 'file not found' });
        return;
      }
      unlinkSync(full);
      json(res, 200, { deleted: true });
      return;
    }

    // ---- Generate: kicks off a batch run against the browser's selection
    //      (or, if scope:'all', everything in input/) ----
    // Requires the browser to send back the job count it showed the user in
    // the confirmation prompt (confirmedTotal) — if the plan has since
    // changed (someone uploaded more, or another tab already started a run),
    // this refuses rather than silently running a different-sized batch than
    // what was confirmed. If a run is already active (or others are already
    // queued), this doesn't reject — it appends to the queue to auto-start in
    // order as each prior batch finishes (see tryStartQueuedRun), which is
    // what makes an overnight chain of batches possible without anyone
    // re-clicking Generate at 2am.
    if (req.method === 'POST' && url.pathname === '/api/run/start') {
      if (!cfg) {
        json(res, 400, { error: 'DEV_API_KEY is not set on the server — cannot create jobs.' });
        return;
      }

      let payload: any;
      try {
        payload = (await readJsonBody(req)) ?? {};
      } catch {
        json(res, 400, { error: 'invalid request body' });
        return;
      }
      const confirmedTotal = payload.confirmedTotal;

      const jobs = await computeJobs(cfg, payload.scope, payload.selection);
      if (jobs.length === 0) {
        json(res, 400, {
          error: 'Nothing to run — upload at least one person and one matching garment category first.',
        });
        return;
      }
      if (typeof confirmedTotal !== 'number' || confirmedTotal !== jobs.length) {
        json(res, 409, { error: 'PLAN_CHANGED', actualTotal: jobs.length });
        return;
      }

      if (currentRun?.status === 'running' || queuedRuns.length > 0) {
        if (!isValidSelection(payload.selection)) {
          json(res, 400, { error: 'invalid selection' });
          return;
        }
        const id = String(nextQueueId++);
        queuedRuns.push({ id, selection: payload.selection, confirmedTotal, queuedBy: session!.username, queuedAt: new Date().toISOString() });
        json(res, 202, { queued: true, position: queuedRuns.length, total: confirmedTotal });
        return;
      }

      const { runId, total } = startRun(jobs, session!.username);
      json(res, 202, { queued: false, runId, total });
      return;
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/run/queue/')) {
      if (session!.role !== 'superadmin') {
        json(res, 403, { error: 'Super admin only.' });
        return;
      }
      const id = decodeURIComponent(url.pathname.slice('/api/run/queue/'.length));
      const idx = queuedRuns.findIndex((q) => q.id === id);
      if (idx === -1) {
        json(res, 404, { error: 'Not found in queue — it may have already started.' });
        return;
      }
      queuedRuns.splice(idx, 1);
      json(res, 200, { cancelled: true });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/run/status') {
      json(res, 200, {
        ...(currentRun ?? { status: 'idle' }),
        queued: queuedRuns.map((q) => ({
          id: q.id,
          total: q.confirmedTotal,
          queuedBy: q.queuedBy,
          queuedAt: q.queuedAt,
          categories: queuedCategories(q.selection),
        })),
      });
      return;
    }

    // ---- Results: a single flat, filterable, paginated table across every
    //      run (including the currently in-progress one, since job_results
    //      rows land in the DB as each job finishes). Replaces the old per-run
    //      tree browser — the web UI has no per-run drilldown anymore, just
    //      a "Run" filter alongside gender/category/status/search, mirroring
    //      the admin panel's job table layout. Backed by lib/db.mts's
    //      listResults(), a single SQL query with the flag LEFT JOINed in —
    //      newest-first comes for free from the id index, no re-sort needed.
    if (req.method === 'GET' && url.pathname === '/api/results') {
      const runFilter = safeRunId(url.searchParams.get('run'));
      const genderFilter = safeSlug(url.searchParams.get('gender'));
      const categoryFilter = safeSlug(url.searchParams.get('category'));
      const statusFilter = url.searchParams.get('status');
      const userFilter = (url.searchParams.get('user') ?? '').trim();
      const q = (url.searchParams.get('q') ?? '').trim();
      const flaggedFilter = url.searchParams.get('flagged'); // '' | '1' (flagged, unresolved) | 'resolved'
      // The client sends datetime-local values already converted to full ISO
      // UTC strings (see app.js), matching how finished_at is stored — but
      // validate here too rather than trusting the query string, since an
      // unparseable value would otherwise become a silently-wrong string
      // comparison in SQL instead of a no-op.
      const dateFromRaw = url.searchParams.get('from');
      const dateToRaw = url.searchParams.get('to');
      const dateFrom = dateFromRaw && !Number.isNaN(Date.parse(dateFromRaw)) ? dateFromRaw : undefined;
      const dateTo = dateToRaw && !Number.isNaN(Date.parse(dateToRaw)) ? dateToRaw : undefined;
      const page = Math.max(1, Math.trunc(Number(url.searchParams.get('page'))) || 1);
      const pageSize = Math.min(100, Math.max(1, Math.trunc(Number(url.searchParams.get('pageSize'))) || 25));

      const page_ = listResults({
        runId: runFilter ?? undefined,
        gender: genderFilter ?? undefined,
        categorySlug: categoryFilter ?? undefined,
        status: statusFilter || undefined,
        startedBy: userFilter || undefined,
        q: q || undefined,
        flagMode: flaggedFilter === '1' || flaggedFilter === 'resolved' ? flaggedFilter : undefined,
        dateFrom,
        dateTo,
        page,
        pageSize,
      });

      const rows = page_.rows.map((r) => {
        const personDir = path.join(INPUT_DIR, 'people', r.gender);
        const garmentDir = path.join(INPUT_DIR, 'garments', r.gender, r.categorySlug);
        const personFile = findInputFileByStem(personDir, r.personName);
        const garmentFile = findInputFileByStem(garmentDir, r.garmentName);
        return {
          id: r.id,
          runId: r.runId,
          startedBy: r.startedBy,
          gender: r.gender,
          personName: r.personName,
          categorySlug: r.categorySlug,
          garmentName: r.garmentName,
          status: r.status,
          error: r.error,
          finishedAt: r.finishedAt,
          durationMs: r.durationMs ?? null,
          personThumb: personFile ? `/api/file?path=${encodeURIComponent(path.relative(INPUT_DIR, path.join(personDir, personFile)))}` : null,
          garmentThumb: garmentFile ? `/api/file?path=${encodeURIComponent(path.relative(INPUT_DIR, path.join(garmentDir, garmentFile)))}` : null,
          outputThumb: r.outputFile ? `/api/result-file?path=${encodeURIComponent(path.relative(OUTPUT_DIR, r.outputFile))}` : null,
          flag: r.flag,
        };
      });

      json(res, 200, {
        total: page_.total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(page_.total / pageSize)),
        rows,
        runs: page_.runs,
        genders: page_.genders,
        categories: page_.categories,
        users: page_.users,
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/results/flag-reasons') {
      json(res, 200, { reasons: FLAG_REASONS });
      return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/results/') && url.pathname.endsWith('/flag')) {
      const id = Number(decodeURIComponent(url.pathname.slice('/api/results/'.length, -'/flag'.length)));
      if (!Number.isInteger(id) || !getResultRow(id)) {
        json(res, 404, { error: 'Result not found.' });
        return;
      }
      let body: any;
      try {
        body = (await readJsonBody(req)) ?? {};
      } catch {
        json(res, 400, { error: 'invalid request body' });
        return;
      }
      const reason = typeof body.reason === 'string' ? body.reason : '';
      if (!FLAG_REASON_VALUES.has(reason)) {
        json(res, 400, { error: 'Invalid reason.' });
        return;
      }
      const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : undefined;
      // Re-flagging an already-flagged (and possibly resolved) job updates the
      // reason/note but leaves resolvedAt/resolvedNote/resolvedBy alone — same
      // split as the main app's /results tool, where flag and resolve are
      // independent fields (setFlag's ON CONFLICT UPDATE only touches those
      // columns). Unflagging (below) is what clears both together.
      const flag = setFlag(id, reason, note, session!.username);
      json(res, 200, { flag });
      return;
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/results/') && url.pathname.endsWith('/flag')) {
      const id = Number(decodeURIComponent(url.pathname.slice('/api/results/'.length, -'/flag'.length)));
      if (!Number.isInteger(id) || !clearFlag(id)) {
        json(res, 404, { error: 'Not flagged.' });
        return;
      }
      json(res, 200, { flag: null });
      return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/results/') && url.pathname.endsWith('/resolve')) {
      const id = Number(decodeURIComponent(url.pathname.slice('/api/results/'.length, -'/resolve'.length)));
      if (!Number.isInteger(id)) {
        json(res, 404, { error: 'Result not found.' });
        return;
      }
      const existing = getFlag(id);
      if (!existing) {
        json(res, 400, { error: 'Job is not flagged.' });
        return;
      }
      if (existing.resolvedAt) {
        json(res, 400, { error: 'Job is already resolved.' });
        return;
      }
      let body: any;
      try {
        body = (await readJsonBody(req)) ?? {};
      } catch {
        json(res, 400, { error: 'invalid request body' });
        return;
      }
      const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : undefined;
      const flag = resolveFlag(id, note, session!.username);
      json(res, 200, { flag });
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/results/') && url.pathname.endsWith('/bundle')) {
      const id = Number(decodeURIComponent(url.pathname.slice('/api/results/'.length, -'/bundle'.length)));
      const flag = Number.isInteger(id) ? getFlag(id) : null;
      if (!flag) {
        json(res, 400, { error: 'Only flagged jobs can be downloaded as a bundle.' });
        return;
      }
      const row = resolveResultRowById(id);
      if (!row) {
        json(res, 404, { error: 'Result not found.' });
        return;
      }

      // Fixed names (not the original basenames) so person/garment can never
      // collide inside the inputs/ folder even if they happen to share a
      // filename — mirrors the main app's bundle route (addKey('inputs', 'garment', ...)).
      const entries: { name: string; data: Buffer }[] = [];
      const addFile = (entryPath: string, filePath: string | null) => {
        if (!filePath || !existsSync(filePath)) return;
        entries.push({ name: `${entryPath}${path.extname(filePath)}`, data: readFileSync(filePath) });
      };
      addFile('inputs/person', row.personFile);
      addFile('inputs/garment', row.garmentFile);
      addFile('output/output', row.outputFile);
      entries.push({
        name: 'metadata.json',
        data: Buffer.from(
          JSON.stringify(
            {
              id: row.id,
              runId: row.runId,
              gender: row.gender,
              personName: row.personName,
              categorySlug: row.categorySlug,
              garmentName: row.garmentName,
              status: row.status,
              finishedAt: row.finishedAt,
              flagReason: flag.reason,
              flagNote: flag.note,
              flaggedBy: flag.flaggedBy,
              flaggedAt: flag.flaggedAt,
              resolvedAt: flag.resolvedAt,
              resolvedNote: flag.resolvedNote,
              resolvedBy: flag.resolvedBy,
            },
            null,
            2,
          ),
        ),
      });

      const zip = buildZip(entries);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="job-${id}-bundle.zip"`,
        'Content-Length': zip.length,
      });
      res.end(zip);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/result-file') {
      serveFileWithin(res, OUTPUT_DIR, url.searchParams.get('path'));
      return;
    }

    serveStatic(res, url.pathname);
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

ensureSuperAdmin();

server.listen(PORT, () => {
  console.log(`Bulk try-on control panel: http://localhost:${PORT}`);
  console.log(`Input:  ${INPUT_DIR}`);
  console.log(`Output: ${OUTPUT_DIR}`);
  if (!cfg) console.log('  (DEV_API_KEY not set — category list falls back to a hardcoded default, Generate disabled)');
});
