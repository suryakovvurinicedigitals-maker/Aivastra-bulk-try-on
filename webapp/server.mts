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
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DevApiError,
  generateCatalog,
  getBalance,
  getCatalogOptions,
  getCatalogueStatus,
  getCategories,
  type CatalogGender,
  type CatalogGenerateBody,
  type CatalogJobStatus,
  type DevApiConfig,
} from '../lib/api-client.mts';
import { runBatch } from '../lib/batch.mts';
import { createLimiter } from '../lib/concurrency.mts';
import { clearFlag, ensureRun, getFlag, getResultRow, insertJobResult, listResults, resolveFlag, setFlag } from '../lib/db.mts';
import { scanInput, type TryonJobSpec } from '../lib/scan-input.mts';
import {
  PropiclyApiError,
  cancelJob as cancelPropiclyJob,
  createRedchiefJob,
  getJob as getPropiclyJob,
  getRedchiefConfig,
  listJobs as listPropiclyJobs,
  type PropiclyApiConfig,
} from '../lib/propicly-client.mts';
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
// These six are `let`, not `const`: the API Setup page (super admin only,
// see applyApiSettings below) updates them in place after a save so the
// change takes effect on the very next request, with no server restart.
// Every route below reads cfg/propiclyCfg fresh at request time (they're
// plain module-scope bindings, not captured into a closure snapshot), so
// reassigning here is sufficient — no getter indirection needed.
let BASE_URL = (process.env.DEV_API_BASE_URL ?? 'https://app.aivastra.com').replace(/\/$/, '');
let API_KEY = process.env.DEV_API_KEY;
let cfg: DevApiConfig | undefined = API_KEY ? { baseUrl: BASE_URL, apiKey: API_KEY } : undefined;
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 2);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 4000);
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS ?? 5 * 60 * 1000);

// RedChief tab (propicly API) — a separate merchant account/host from the
// aivastra BASE_URL/API_KEY above. Never reuse those here: the two flows are
// deliberately isolated so one tab's key/env changes can't affect the other.
let PROPICLY_BASE_URL = (process.env.PROPICLY_API_BASE_URL ?? 'https://app.propicly.com').replace(/\/$/, '');
let PROPICLY_API_KEY = process.env.PROPICLY_API_KEY;
let propiclyCfg: PropiclyApiConfig | undefined = PROPICLY_API_KEY ? { baseUrl: PROPICLY_BASE_URL, apiKey: PROPICLY_API_KEY } : undefined;

// ---- API Setup page: persist key/base-URL edits to .env and apply live ----
const ENV_PATH = path.join(BULK_TRYON_DIR, '.env');

// Rewrites specific KEY=value lines in .env in place, leaving every other
// line (comments, blank lines, unrelated vars) untouched. A key with no
// existing uncommented line is appended at the end rather than silently
// dropped — matches .env.example's documented keys exactly, so this only
// ever fills in or replaces a line the file already anticipates.
function updateEnvFile(updates: Record<string, string>) {
  const raw = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r\n|\n/);
  const remaining = new Map(Object.entries(updates));
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^([A-Z0-9_]+)=/);
    if (match && remaining.has(match[1])) {
      lines[i] = `${match[1]}=${remaining.get(match[1])}`;
      remaining.delete(match[1]);
    }
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (const [key, value] of remaining) lines.push(`${key}=${value}`);
  writeFileSync(ENV_PATH, lines.join(eol) + eol, 'utf8');
}

function apiKeyStatus(key: string | undefined) {
  return { set: Boolean(key), length: key?.length ?? 0 };
}

// target: which of the two fully-isolated flows to update. baseUrl/apiKey
// are optional independently -- an empty/omitted field means "leave this
// one as it is", so a base-URL-only change never forces re-entering the key.
function applyApiSettings(target: 'aivastra' | 'propicly', baseUrl: string | undefined, apiKey: string | undefined) {
  const envUpdates: Record<string, string> = {};
  if (target === 'aivastra') {
    if (baseUrl) {
      BASE_URL = baseUrl.replace(/\/$/, '');
      envUpdates.DEV_API_BASE_URL = BASE_URL;
    }
    if (apiKey) {
      API_KEY = apiKey;
      envUpdates.DEV_API_KEY = apiKey;
    }
    cfg = API_KEY ? { baseUrl: BASE_URL, apiKey: API_KEY } : undefined;
  } else {
    if (baseUrl) {
      PROPICLY_BASE_URL = baseUrl.replace(/\/$/, '');
      envUpdates.PROPICLY_API_BASE_URL = PROPICLY_BASE_URL;
    }
    if (apiKey) {
      PROPICLY_API_KEY = apiKey;
      envUpdates.PROPICLY_API_KEY = apiKey;
    }
    propiclyCfg = PROPICLY_API_KEY ? { baseUrl: PROPICLY_BASE_URL, apiKey: PROPICLY_API_KEY } : undefined;
  }
  if (Object.keys(envUpdates).length > 0) updateEnvFile(envUpdates);
}

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
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
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

// ---- POST /api/results/record validation (see the route below) ----
// 'catalog' is still accepted here for backward compatibility with any
// browser tab that has an old cached catalog.js loaded (no-store means that
// shouldn't linger, but a request mid-flight during a deploy could still
// land) — current catalog.js no longer calls this route at all, since
// runCatalogAggregate now records catalog results itself, server-side, the
// moment each one finishes (see that function's doc comment). RedChief is
// the only source that still genuinely depends on this route.
const RESULT_RECORD_SOURCES = new Set(['redchief', 'catalog']);
const RESULT_RECORD_STATUSES = new Set(['COMPLETED', 'FAILED']);

/** Trimmed, non-empty, length-capped string — used for the free-text labels /api/results/record accepts (product/combo names), which unlike gender/category/run-id aren't restricted to a slug charset. */
function safeResultLabel(v: unknown, maxLen: number): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (trimmed.length === 0 || trimmed.length > maxLen) return null;
  return trimmed;
}

/** Validates an optional http(s) asset URL (e.g. catalog.js's face/lower/shoe thumbnailUrls) — undefined for anything not a well-formed http(s) URL, rather than a hard 400, since these are cosmetic (a Results-page thumbnail), not required for the job itself to be recorded correctly. */
function safeResultUrl(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Decodes a `data:<mime>;base64,<...>` URI into raw bytes plus a best-effort file extension (falls back to .jpg — every mime this tool ever sends is an image). Throws on anything that doesn't look like a base64 data URI, since a malformed one here would otherwise silently write garbage bytes to disk. */
function decodeDataUrl(dataUrl: string): { bytes: Buffer; ext: string } {
  const m = /^data:([^;,]+);base64,([a-zA-Z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new Error('not a base64 data URI');
  const mime = m[1]!;
  const ext = mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg';
  return { bytes: Buffer.from(m[2]!, 'base64'), ext };
}

/** Writes bytes under OUTPUT_DIR/<source>/ with a filename that's just unique, never meaningful — the DB row (personName/categorySlug/garmentName, or media label) carries the human-readable identity. */
function writeResultMedia(source: string, bytes: Buffer, ext: string): string {
  const outDir = path.join(OUTPUT_DIR, source);
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  writeFileSync(outFile, bytes);
  return outFile;
}

/**
 * Shared by POST /api/results/record (still the only path for RedChief,
 * which has no server-side aggregate loop of its own — every job there is
 * already submitted as its own direct API call, so the "one call starts N
 * jobs" problem runCatalogAggregate exists for doesn't apply to it) and
 * runCatalogAggregate below (which calls this directly, server-side, the
 * instant each look finishes — no longer waiting on the browser to notice
 * and report it, which is what could previously lose a result if the tab
 * was closed or the poll loop just hadn't caught up yet).
 *
 * For COMPLETED, downloads/decodes every input+output image and persists the
 * bytes under OUTPUT_DIR/<source>/ (presigned imageUrls have a ~900s TTL, and
 * RedChief's inputs only ever exist as in-browser File objects — nothing
 * durable to point at later either way); for FAILED, records the row with no
 * media. Throws on a download/decode failure — the two call sites decide how
 * to surface that (a 502 response for the HTTP route, a FAILED status for
 * the aggregate-run job stub).
 *
 * `inputs`/`outputs` are optional (Catalog's caller doesn't send them yet —
 * it has no per-view/per-look media concept of its own, still relies on the
 * legacy single-outputUrl → outputFile path via `imageUrl` for backward
 * compat with the rest of this function and with getResultRow's bundle/zip
 * logic, which reads r.outputFile directly). RedChief's caller sends both.
 */
async function recordResult(input: {
  source: 'redchief' | 'catalog';
  status: 'COMPLETED' | 'FAILED';
  gender: string;
  personName: string;
  categorySlug: string;
  garmentName: string;
  jobId?: string;
  imageUrl?: string;
  // Each input is EITHER a base64 data URI (RedChief's photos, which only
  // ever exist as in-browser File objects — nothing else to point a URL at)
  // OR an http(s) URL this server downloads itself (Catalog's face/pose/
  // background/shoe asset-library thumbnails, which ARE already hosted
  // images — no point round-tripping them through the client as base64).
  // Catalog's garment photo is the one input that's base64 too (the
  // tester's own upload), so both shapes coexist within a single call's
  // `inputs` array.
  inputs?: { label: string; dataUrl?: string; imageUrl?: string }[];
  outputs?: { label?: string; imageUrl: string }[];
  credits?: number;
  startedBy?: string;
  error?: string;
}): Promise<number> {
  let outputFile: string | undefined;
  const media: { kind: 'input' | 'output'; label: string; filePath: string }[] = [];
  if (input.status === 'COMPLETED') {
    for (const inp of input.inputs ?? []) {
      if (inp.dataUrl) {
        const { bytes, ext } = decodeDataUrl(inp.dataUrl);
        media.push({ kind: 'input', label: inp.label, filePath: writeResultMedia(input.source, bytes, ext) });
      } else if (inp.imageUrl) {
        const imgRes = await fetch(inp.imageUrl);
        if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`);
        const bytes = Buffer.from(await imgRes.arrayBuffer());
        media.push({ kind: 'input', label: inp.label, filePath: writeResultMedia(input.source, bytes, '.jpg') });
      }
      // An input with neither is silently skipped — e.g. an optional
      // lower/shoe axis the tester didn't select for this run.
    }
    if (input.outputs && input.outputs.length > 0) {
      for (let i = 0; i < input.outputs.length; i++) {
        const out = input.outputs[i]!;
        const imgRes = await fetch(out.imageUrl);
        if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`);
        const bytes = Buffer.from(await imgRes.arrayBuffer());
        const filePath = writeResultMedia(input.source, bytes, '.jpg');
        media.push({ kind: 'output', label: out.label ?? `Output ${i + 1}`, filePath });
        if (i === 0) outputFile = filePath; // first output doubles as the legacy single-thumbnail/bundle-zip field
      }
    } else if (input.imageUrl) {
      // Legacy single-output path (Catalog today) — unchanged behavior.
      const imgRes = await fetch(input.imageUrl);
      if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`);
      const bytes = Buffer.from(await imgRes.arrayBuffer());
      outputFile = writeResultMedia(input.source, bytes, '.jpg');
    }
  }
  const runId = `${input.source}-batch`; // one shared pseudo-run per source — neither tab has a real "run" concept the way the CLI/Upload-Generate batch does
  ensureRun(runId);
  return insertJobResult(runId, {
    gender: input.gender,
    personName: input.personName,
    categorySlug: input.categorySlug,
    garmentName: input.garmentName,
    jobId: input.jobId,
    status: input.status,
    error: input.status === 'FAILED' ? (input.error ?? 'unknown error') : undefined,
    outputFile,
    finishedAt: new Date().toISOString(),
    source: input.source,
    credits: input.credits,
    startedBy: input.startedBy,
    media: media.length > 0 ? media : undefined,
  });
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

/** Forwards a PropiclyApiError's real status/code/message; anything else becomes a 502 so a network blip to the propicly host never looks like this server's own bug. */
function propiclyErrorResponse(res: http.ServerResponse, err: unknown) {
  if (err instanceof PropiclyApiError) {
    json(res, err.status, { error: { code: err.code, message: err.message } });
    return;
  }
  json(res, 502, { error: { code: 'PROXY_ERROR', message: err instanceof Error ? err.message : String(err) } });
}

/** Same idea as propiclyErrorResponse, for the catalog routes below (which talk to the aivastra host via the DevApiError class instead). */
function devApiErrorResponse(res: http.ServerResponse, err: unknown) {
  if (err instanceof DevApiError) {
    json(res, err.status, { error: { code: err.code, message: err.message } });
    return;
  }
  json(res, 502, { error: { code: 'PROXY_ERROR', message: err instanceof Error ? err.message : String(err) } });
}

const CATALOG_GENDERS = new Set(['men', 'women', 'boys', 'girls']);
const CATALOG_ASPECT_RATIOS = new Set(['1:1', '2:3', '3:4', '4:5']);
const CATALOG_RESOLUTIONS = new Set(['HD', '2K', '4K']);
const CATALOG_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/; // matches the aivastra API's PUBLIC_SLUG

// catalog.js fires one POST /api/catalog/generate per (garment x face x
// lower x shoe) combination, all at once, client-side — a bulk submit from
// even one tester can easily be dozens of calls, and each one's `looks`
// array (up to 12 pose x background pairs) makes the upstream aivastra API
// start ALL of those jobs running concurrently the instant that one call is
// made. So limiting concurrent /api/catalog/generate *calls* alone doesn't
// give "N jobs at a time" — a single call with 12 looks would still blow
// straight past N. catalogGenerateLimit is the shared gate; see
// runCatalogAggregate below for how it's actually used to throttle at the
// per-job level (one look per limited call, slot held until that job
// finishes), which is what makes this genuinely mirror the try-on batch's
// per-job throttling in lib/batch.mts's runBatch. Being a single
// process-wide instance also keeps it fair across every person using the
// panel at once, not just self-throttling within one browser tab.
const CATALOG_CONCURRENCY = Number(process.env.CATALOG_CONCURRENCY ?? 2);
const catalogGenerateLimit = createLimiter(CATALOG_CONCURRENCY);

// ---- Catalog Batch aggregate-run tracking ----
// Each (pose, background) "look" the client selects becomes its own
// single-look upstream generateCatalog call, gated by catalogGenerateLimit
// and held (via polling right here on the server) until that job reaches a
// terminal state — see runCatalogAggregate. The client is unaware of this:
// it still POSTs one `looks` array per run and gets back one
// {catalogueId, jobs} shape, then polls GET /api/catalog/catalogues/:id
// exactly as before (see that route below) — what's actually behind that
// catalogueId is one of these in-memory aggregate runs, not a single real
// upstream catalogue. The real per-look catalogueIds/jobIds from upstream
// are tracked only inside runCatalogAggregate and never exposed to the client.
interface CatalogAggregateJob {
  jobId: string; // our own stable id, assigned up front — never the upstream jobId, which doesn't exist yet until this look is actually submitted
  pose: string;
  background: string;
  // Human-readable labels for this look, supplied by the client at submit
  // time (catalogBatch.options was already loaded there) — falls back to
  // the raw slug if the client didn't send one, so an older/mismatched
  // front-end still works, just with a less pretty Results-page name.
  poseLabel: string;
  backgroundLabel: string;
  // Asset-library thumbnail URLs for this look's pose/background, supplied
  // by the client (catalogBatch.options was already loaded there) — used
  // only for the Results page's dedicated Catalog row (see recordResult's
  // `inputs` in runCatalogAggregate below), never sent upstream. Optional:
  // an older/mismatched front-end that doesn't send these just gets a
  // Results-page row missing those two thumbnails, nothing else breaks.
  poseThumbnailUrl?: string;
  backgroundThumbnailUrl?: string;
  status: CatalogJobStatus;
  // Captured once, from the single poll that first observed COMPLETED —
  // never re-fetched from upstream after that. Known trade-off: the
  // presigned URL is only valid ~900s, so a tester who leaves the Catalog
  // Batch tab open past that and hits catalog.js's onerror-triggered
  // refreshCatalogGarmentRun() will keep getting this same stale URL back
  // (GET below now serves purely from this map, no live upstream re-check).
  // Previously GET proxied straight through to upstream on every call, so
  // that refresh path did get a fresh URL — lost in exchange for not
  // hammering upstream with a re-poll of every already-done job on every
  // subsequent poll of a still-running one. Not a regression for the
  // Results page: recordResult (see runCatalogAggregate) downloads and
  // persists the bytes locally the moment a job finishes, independent of
  // whether the client ever polls again after that.
  imageUrl?: string;
  error?: string;
}
interface CatalogAggregateRun {
  jobs: CatalogAggregateJob[];
  createdAt: number;
  // Labels for the Results-page row each job in this run finishes as — see
  // the comment on runCatalogAggregate for why these are recorded
  // server-side now instead of depending on the browser to report them.
  gender: string;
  personName: string; // the run's face/lower/shoe combo label (catalog.js's run.runLabel) — closest equivalent to try-on's "person"
  garmentLabel: string;
  startedBy: string; // whoever POSTed /api/catalog/generate — every look in this run was submitted by the same user, unlike the shared 'catalog-batch' pseudo-run id itself
  // The garment type slug (e.g. "jacket", "dress") the tester picked to
  // scope the asset pool — used as this run's job_results.categorySlug so
  // Catalog rows are actually filterable/groupable by real category instead
  // of every row sharing the literal string 'catalog' (the original,
  // simplest-possible choice before the Results page grew a dedicated
  // Catalog view). Falls back to 'catalog' when the tester left "— any —"
  // selected, since categorySlug is NOT NULL in the schema.
  categorySlug: string;
  // Face is the "model" for a catalog look — required by the upstream API,
  // so always present. Lower/shoe are optional per-run selections; garment
  // is the tester's own uploaded photo (base64, from `base.garment` at
  // submit time, reused here rather than re-sent) so it never needs
  // uploading a second time just to be recorded.
  faceLabel: string;
  faceThumbnailUrl?: string;
  lowerLabel?: string;
  lowerThumbnailUrl?: string;
  shoeLabel?: string;
  shoeThumbnailUrl?: string;
}
const catalogAggregateRuns = new Map<string, CatalogAggregateRun>();

// Nothing else ever deletes an aggregate run — sweep anything older than 2h
// (generously past POLL_TIMEOUT_MS, so this never removes a run a client
// could still legitimately be polling) on every new generate call, so a
// long-lived server process doesn't accumulate them forever.
const CATALOG_AGGREGATE_TTL_MS = 2 * 60 * 60 * 1000;
function sweepCatalogAggregateRuns() {
  const cutoff = Date.now() - CATALOG_AGGREGATE_TTL_MS;
  for (const [id, run] of catalogAggregateRuns) {
    if (run.createdAt < cutoff) catalogAggregateRuns.delete(id);
  }
}

/**
 * Submits one run's looks to the upstream API one at a time, each gated by
 * catalogGenerateLimit and held until that look's job finishes (or
 * POLL_TIMEOUT_MS elapses) — this is what actually delivers "N jobs at a
 * time, next N once these are done" for Catalog Batch, mirroring runBatch's
 * per-job throttling for the try-on flow. Fire-and-forget from the route
 * handler's point of view: it doesn't await this, it returns the initial
 * all-QUEUED job list immediately and the client's existing poll loop picks
 * up progress as `run.jobs` mutate in place here.
 *
 * Also calls recordResult() itself the instant each look reaches a terminal
 * state — this used to be the client's job (catalog.js POSTing to
 * /api/results/record after noticing a terminal status on its next poll),
 * which meant a result that finished server-side but hadn't been noticed
 * and reported yet was silently lost forever if the tab was closed or the
 * server restarted in that window. Doing it right here, synchronously with
 * the same poll loop that already observes the terminal state, makes each
 * result durable the moment it's known — no dependency on the browser
 * staying open or polling again. catalog.js's own POST to
 * /api/results/record for catalog jobs was removed to match (recording
 * twice would double up the Results page); RedChief still uses that route
 * as-is, since it has no equivalent server-side loop of its own.
 */
// Console-only, no state — lets `pm2 logs` / the dev console show the
// throttle actually working (e.g. "active=2" never climbing past
// CATALOG_CONCURRENCY, and a visible gap between a look finishing and the
// next one starting) without needing to inspect the DB or add a debug UI.
let catalogActiveLooks = 0;

async function runCatalogAggregate(cfg: DevApiConfig, run: CatalogAggregateRun, base: Omit<CatalogGenerateBody, 'looks'>): Promise<void> {
  await Promise.all(
    run.jobs.map((stub) =>
      catalogGenerateLimit(async () => {
        catalogActiveLooks++;
        console.log(`[catalog] submitting look ${stub.jobId} (${stub.pose} x ${stub.background}) — active=${catalogActiveLooks}/${CATALOG_CONCURRENCY}`);
        try {
          const result = await generateCatalog(cfg, { ...base, looks: [{ pose: stub.pose, background: stub.background }] });
          const realJob = result.jobs[0];
          if (!realJob) throw new Error('upstream returned no job for this look');
          stub.status = 'RUNNING';
          // Single-look call, so getCatalogueStatus always comes back with
          // exactly one job — poll it at the same cadence/timeout the
          // try-on flow's runBatch uses, until it reaches a terminal state.
          const deadline = Date.now() + POLL_TIMEOUT_MS;
          for (;;) {
            const status = await getCatalogueStatus(cfg, result.catalogueId);
            const job = status.jobs.find((j) => j.jobId === realJob.jobId) ?? status.jobs[0];
            if (job) {
              stub.status = job.status;
              stub.imageUrl = job.imageUrl;
              stub.error = job.error;
            }
            if (!job || job.status === 'COMPLETED' || job.status === 'FAILED') break;
            if (Date.now() > deadline) {
              stub.status = 'FAILED';
              stub.error = 'poll timeout';
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
          }
        } catch (err) {
          stub.status = 'FAILED';
          stub.error = err instanceof DevApiError ? err.message : err instanceof Error ? err.message : String(err);
        } finally {
          catalogActiveLooks--;
          console.log(`[catalog] finished look ${stub.jobId} — status=${stub.status} active=${catalogActiveLooks}/${CATALOG_CONCURRENCY}`);
          // Persist right here, synchronously with the poll loop's own
          // observation of the terminal state — see this function's doc
          // comment for why. Best-effort: a download failure (COMPLETED
          // only — recordResult fetches imageUrl itself) just gets logged,
          // it can't turn an already-terminal job stub into an error the
          // client would know what to do with at this point.
          if (stub.status === 'COMPLETED' || stub.status === 'FAILED') {
            try {
              // Every axis that was actually part of this job: garment is
              // the tester's own upload (base.garment, already a base64/
              // data-URI string — reused as-is rather than re-fetched),
              // face/lower/shoe are admin-curated asset-library images
              // (hosted thumbnailUrls, downloaded here same as an output),
              // pose/background vary per look. Lower/shoe are only pushed
              // when the tester actually selected one for this run — an
              // unselected optional axis contributes nothing rather than a
              // broken/missing thumbnail entry.
              const inputs: { label: string; dataUrl?: string; imageUrl?: string }[] = [
                { label: 'Face', imageUrl: run.faceThumbnailUrl },
                { label: 'Garment', dataUrl: base.garment },
              ];
              if (stub.poseThumbnailUrl) inputs.push({ label: 'Pose', imageUrl: stub.poseThumbnailUrl });
              if (stub.backgroundThumbnailUrl) inputs.push({ label: 'Background', imageUrl: stub.backgroundThumbnailUrl });
              if (run.shoeThumbnailUrl) inputs.push({ label: 'Shoes', imageUrl: run.shoeThumbnailUrl });
              if (run.lowerThumbnailUrl) inputs.push({ label: 'Lower', imageUrl: run.lowerThumbnailUrl });
              await recordResult({
                source: 'catalog',
                status: stub.status,
                gender: run.gender,
                personName: run.personName,
                categorySlug: run.categorySlug,
                garmentName: `${run.garmentLabel} — ${stub.poseLabel} × ${stub.backgroundLabel}`,
                jobId: stub.jobId,
                inputs,
                outputs: stub.imageUrl ? [{ label: 'Output', imageUrl: stub.imageUrl }] : undefined,
                error: stub.error,
                startedBy: run.startedBy,
              });
            } catch (err) {
              console.error(`[catalog] failed to record result for look ${stub.jobId}:`, err instanceof Error ? err.message : err);
            }
          }
        }
      }),
    ),
  );
}

/** Safe decodeURIComponent for a job-id path segment. A stray `%` (or any
 * other malformed percent-encoding) makes the built-in throw a raw URIError,
 * which would otherwise escape to the outer try/catch as a generic 500
 * instead of the same 400 VALIDATION envelope the regex check right after
 * this produces for every other kind of bad job id. Returns null on failure
 * so callers can fold it into their existing validation branch. */
function decodeJobIdParam(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
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

    // ---- admin: API Setup page (super admin only) ----
    // Never returns a key's plaintext, per CLAUDE.md's secrets discipline --
    // presence + length only, same as every other "is this set" check here.
    if (url.pathname === '/api/admin/api-settings') {
      if (session!.role !== 'superadmin') {
        json(res, 403, { error: 'Super admin only.' });
        return;
      }
      if (req.method === 'GET') {
        json(res, 200, {
          aivastra: { baseUrl: BASE_URL, key: apiKeyStatus(API_KEY) },
          propicly: { baseUrl: PROPICLY_BASE_URL, key: apiKeyStatus(PROPICLY_API_KEY) },
        });
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
        if (body.target !== 'aivastra' && body.target !== 'propicly') {
          json(res, 400, { error: 'target must be "aivastra" or "propicly"' });
          return;
        }
        const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : undefined;
        const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : undefined;
        applyApiSettings(body.target, baseUrl || undefined, apiKey || undefined);
        json(res, 200, {
          aivastra: { baseUrl: BASE_URL, key: apiKeyStatus(API_KEY) },
          propicly: { baseUrl: PROPICLY_BASE_URL, key: apiKeyStatus(PROPICLY_API_KEY) },
        });
        return;
      }
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
      const rawWarnings = body.scope === 'selected' ? [] : scanInput(INPUT_DIR).warnings;
      const warnings = rawWarnings.filter((w: string) => !w.includes('No folders found under'));
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
      const sourceFilter = safeSlug(url.searchParams.get('source'));
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
        source: sourceFilter ?? undefined,
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
          source: r.source,
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
          credits: r.credits ?? null,
          // RedChief (and, later, Catalog) rows carry their own labeled
          // input/output thumbnails instead of the tryon-shaped person/
          // garment/output fields above — see job_result_media in lib/db.mts.
          media: r.media.map((m) => ({
            kind: m.kind,
            label: m.label,
            thumb: `/api/result-file?path=${encodeURIComponent(path.relative(OUTPUT_DIR, m.filePath))}`,
          })),
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
        sources: page_.sources,
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

    // ---- RedChief / Catalog result recording ----
    // Both of those tabs run their submit/poll loop entirely client-side (see
    // redchief.js/catalog.js) and know context (product label, face/lower/
    // shoe/pose/background combo, etc.) this server never sees on its own —
    // unlike the try-on flow, where lib/batch.mts already lives on the
    // server and calls insertJobResult() directly from inside its own poll
    // loop. So the client reports each completed/failed job here once, and
    // the server does the trust-sensitive part: downloading the actual image
    // bytes (rather than storing the presigned URL, which expires in ~900s
    // and would otherwise leave every RedChief/Catalog "result" a broken
    // thumbnail an hour later — see catalog.js/redchief.js's own onerror
    // refetch workaround, which only patches this for the current page load)
    // and writing the job_results row.
    //
    // Dedup is best-effort and client-side only (redchief.js/catalog.js each
    // track a "recorded" Set, mirroring the "refreshed" Sets already used
    // there for thumbnail retries) — a page reload before that Set is
    // populated could in principle record the same completed job twice.
    // Acceptable for a local single-operator testing tool: the worst case is
    // a duplicate *row* in the Results table, never duplicate spend (this
    // route never creates jobs, only records ones that already ran).
    if (req.method === 'POST' && url.pathname === '/api/results/record') {
      let body: Buffer;
      try {
        // RedChief now sends its input images as base64 data URIs too (up to
        // 6 views, same shape/cap as POST /api/redchief's own job-submission
        // route) since those images only ever exist as in-browser File
        // objects — nothing else durable to point a URL at. Catalog's calls
        // stay tiny (labels/URLs only) and are well within this cap too.
        body = await readBodyCapped(req, 90 * 1024 * 1024);
      } catch {
        json(res, 413, { error: { code: 'VALIDATION', message: 'request body too large' } });
        return;
      }
      let parsed: any;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        json(res, 400, { error: { code: 'VALIDATION', message: 'invalid JSON body' } });
        return;
      }

      const source = parsed?.source;
      if (typeof source !== 'string' || !RESULT_RECORD_SOURCES.has(source)) {
        json(res, 400, { error: { code: 'VALIDATION', message: "source must be 'redchief' or 'catalog'" } });
        return;
      }
      const status = parsed?.status;
      if (typeof status !== 'string' || !RESULT_RECORD_STATUSES.has(status)) {
        json(res, 400, { error: { code: 'VALIDATION', message: "status must be 'COMPLETED' or 'FAILED'" } });
        return;
      }
      const gender = safeResultLabel(parsed?.gender, 40) ?? 'n/a';
      const personName = safeResultLabel(parsed?.personName, 200);
      const categorySlug = safeResultLabel(parsed?.categorySlug, 40);
      const garmentName = safeResultLabel(parsed?.garmentName, 200);
      if (!personName || !categorySlug || !garmentName) {
        json(res, 400, { error: { code: 'VALIDATION', message: 'personName, categorySlug, and garmentName are required' } });
        return;
      }
      const jobId = safeResultLabel(parsed?.jobId, 100) ?? undefined;
      const jobError = status === 'FAILED' ? (safeResultLabel(parsed?.error, 500) ?? 'unknown error') : undefined;

      const creditsRaw = parsed?.credits;
      const credits = typeof creditsRaw === 'number' && Number.isFinite(creditsRaw) && creditsRaw >= 0 ? Math.trunc(creditsRaw) : undefined;

      // Legacy single-output shape — still accepted for Catalog (and any
      // stale cached RedChief tab), superseded below by `outputs` when sent.
      let imageUrl: string | undefined;
      if (status === 'COMPLETED' && typeof parsed?.imageUrl === 'string') {
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(parsed.imageUrl);
        } catch {
          json(res, 400, { error: { code: 'VALIDATION', message: 'imageUrl must be a valid URL' } });
          return;
        }
        if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
          json(res, 400, { error: { code: 'VALIDATION', message: 'imageUrl must be http(s)' } });
          return;
        }
        imageUrl = parsedUrl.toString();
      }

      // New multi-input/multi-output shape (RedChief) — each input is a
      // base64 data URI (the browser's only copy of that image), each output
      // an http(s) URL this server downloads itself, same trust boundary as
      // the legacy single imageUrl above.
      let inputs: { label: string; dataUrl?: string; imageUrl?: string }[] | undefined;
      let outputs: { label?: string; imageUrl: string }[] | undefined;
      if (status === 'COMPLETED') {
        if (Array.isArray(parsed?.inputs)) {
          inputs = [];
          for (const raw of parsed.inputs) {
            const label = safeResultLabel(raw?.label, 40);
            if (!label || typeof raw?.dataUrl !== 'string' || !raw.dataUrl.startsWith('data:')) {
              json(res, 400, { error: { code: 'VALIDATION', message: 'each input needs a label and a base64 data URI' } });
              return;
            }
            inputs.push({ label, dataUrl: raw.dataUrl });
          }
        }
        if (Array.isArray(parsed?.outputs)) {
          outputs = [];
          for (const raw of parsed.outputs) {
            let parsedUrl: URL;
            try {
              parsedUrl = new URL(typeof raw?.imageUrl === 'string' ? raw.imageUrl : '');
            } catch {
              json(res, 400, { error: { code: 'VALIDATION', message: 'each output needs a valid imageUrl' } });
              return;
            }
            if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
              json(res, 400, { error: { code: 'VALIDATION', message: 'output imageUrl must be http(s)' } });
              return;
            }
            outputs.push({ label: safeResultLabel(raw?.label, 40) ?? undefined, imageUrl: parsedUrl.toString() });
          }
        }
        if (!imageUrl && (!outputs || outputs.length === 0)) {
          json(res, 400, { error: { code: 'VALIDATION', message: 'imageUrl or outputs is required when status is COMPLETED' } });
          return;
        }
      }

      try {
        const id = await recordResult({
          source: source as 'redchief' | 'catalog',
          status: status as 'COMPLETED' | 'FAILED',
          gender,
          personName,
          categorySlug,
          garmentName,
          jobId,
          imageUrl,
          inputs,
          outputs,
          credits,
          startedBy: session!.username,
          error: jobError,
        });
        json(res, 201, { id });
      } catch (err) {
        json(res, 502, {
          error: { code: 'DOWNLOAD_FAILED', message: `could not download result image: ${err instanceof Error ? err.message : String(err)}` },
        });
      }
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

    // ---- RedChief (propicly API) — separate tab, separate merchant account ----
    // Discovery probe, like /api/balance above: never throws past a 200, so
    // the tab can show a clear "not configured"/"unreachable" state instead
    // of a broken page when PROPICLY_API_KEY is unset or the host is down.
    if (req.method === 'GET' && url.pathname === '/api/redchief/config') {
      if (!propiclyCfg) {
        json(res, 200, { available: false, error: 'PROPICLY_API_KEY is not set on the server.' });
        return;
      }
      try {
        const config = await getRedchiefConfig(propiclyCfg);
        json(res, 200, { available: true, ...config });
      } catch (err) {
        json(res, 200, { available: false, error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/redchief') {
      if (!propiclyCfg) {
        json(res, 400, { error: { code: 'CONFIG_MISSING', message: 'PROPICLY_API_KEY is not set on the server.' } });
        return;
      }
      let body: Buffer;
      try {
        // 6 views * 10MB * ~1.33 base64 inflation, capped comfortably under
        // the upstream API's own 170MB limit for this endpoint.
        body = await readBodyCapped(req, 90 * 1024 * 1024);
      } catch {
        json(res, 413, { error: { code: 'VALIDATION', message: 'request body too large' } });
        return;
      }
      let parsed: any;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        json(res, 400, { error: { code: 'VALIDATION', message: 'invalid JSON body' } });
        return;
      }
      const views = parsed?.views;
      if (!Array.isArray(views) || views.length < 1 || views.length > 6 || !views.every((v: unknown) => typeof v === 'string' && v.length > 0)) {
        json(res, 400, { error: { code: 'VALIDATION', message: 'views must be an array of 1-6 base64/data-URI image strings' } });
        return;
      }
      try {
        const result = await createRedchiefJob(propiclyCfg, views);
        json(res, 202, result);
      } catch (err) {
        propiclyErrorResponse(res, err);
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/redchief/jobs') {
      if (!propiclyCfg) {
        json(res, 400, { error: { code: 'CONFIG_MISSING', message: 'PROPICLY_API_KEY is not set on the server.' } });
        return;
      }
      const page = Number(url.searchParams.get('page') ?? 1);
      const pageSize = Number(url.searchParams.get('pageSize') ?? 25);
      try {
        const list = await listPropiclyJobs(propiclyCfg, page, pageSize);
        json(res, 200, list);
      } catch (err) {
        propiclyErrorResponse(res, err);
      }
      return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/redchief/jobs/') && url.pathname.endsWith('/cancel')) {
      if (!propiclyCfg) {
        json(res, 400, { error: { code: 'CONFIG_MISSING', message: 'PROPICLY_API_KEY is not set on the server.' } });
        return;
      }
      const jobId = decodeJobIdParam(url.pathname.slice('/api/redchief/jobs/'.length, -'/cancel'.length));
      if (jobId === null || !/^[\w-]{1,80}$/.test(jobId)) {
        json(res, 400, { error: { code: 'VALIDATION', message: 'invalid job id' } });
        return;
      }
      try {
        const result = await cancelPropiclyJob(propiclyCfg, jobId);
        json(res, 200, result);
      } catch (err) {
        propiclyErrorResponse(res, err);
      }
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/redchief/jobs/')) {
      if (!propiclyCfg) {
        json(res, 400, { error: { code: 'CONFIG_MISSING', message: 'PROPICLY_API_KEY is not set on the server.' } });
        return;
      }
      const jobId = decodeJobIdParam(url.pathname.slice('/api/redchief/jobs/'.length));
      if (jobId === null || !/^[\w-]{1,80}$/.test(jobId)) {
        json(res, 400, { error: { code: 'VALIDATION', message: 'invalid job id' } });
        return;
      }
      try {
        const job = await getPropiclyJob(propiclyCfg, jobId);
        json(res, 200, job);
      } catch (err) {
        propiclyErrorResponse(res, err);
      }
      return;
    }

    // ---- Catalog Batch (aivastra catalog surface) — separate tab, but the
    // SAME cfg/DEV_API_KEY as Upload/Generate above (see lib/api-client.mts's
    // catalog section header comment for why: same host, same 'full'-scoped
    // key, unlike RedChief's genuinely separate propicly account). ----
    if (req.method === 'GET' && url.pathname === '/api/catalog/options') {
      if (!cfg) {
        json(res, 200, { available: false, error: 'DEV_API_KEY is not set on the server.' });
        return;
      }
      const gender = url.searchParams.get('gender');
      if (!gender || !CATALOG_GENDERS.has(gender)) {
        json(res, 400, { error: { code: 'VALIDATION', message: 'gender must be one of men, women, boys, girls' } });
        return;
      }
      const garmentType = url.searchParams.get('garmentType') ?? undefined;
      if (garmentType && !CATALOG_SLUG_RE.test(garmentType)) {
        json(res, 400, { error: { code: 'VALIDATION', message: 'invalid garmentType' } });
        return;
      }
      try {
        const options = await getCatalogOptions(cfg, gender as CatalogGender, garmentType);
        json(res, 200, { available: true, ...options });
      } catch (err) {
        json(res, 200, { available: false, error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/catalog/generate') {
      if (!cfg) {
        json(res, 400, { error: { code: 'CONFIG_MISSING', message: 'DEV_API_KEY is not set on the server.' } });
        return;
      }
      // Captured into a const so it stays narrowed to DevApiConfig (not
      // DevApiConfig | undefined) inside the catalogGenerateLimit() closure
      // below, which — unlike the rest of this handler — may not actually
      // run until after this request has returned, at which point the
      // module-level `cfg` could in principle have been reassigned by a
      // concurrent Settings-page save.
      const catalogCfg = cfg;
      let body: Buffer;
      try {
        // One garment image, base64-encoded: 10MB * ~1.34 base64 inflation,
        // rounded up generously — same reasoning as RedChief's cap, scaled
        // down since this is a single image per call, not up to six.
        body = await readBodyCapped(req, 20 * 1024 * 1024);
      } catch {
        json(res, 413, { error: { code: 'VALIDATION', message: 'request body too large' } });
        return;
      }
      let parsed: any;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        json(res, 400, { error: { code: 'VALIDATION', message: 'invalid JSON body' } });
        return;
      }

      const {
        garment,
        gender,
        face,
        looks,
        garmentType,
        lower,
        shoe,
        aspectRatio,
        resolution,
        garmentLabel,
        runLabel,
        faceLabel,
        faceThumbnailUrl,
        lowerLabel,
        lowerThumbnailUrl,
        shoeLabel,
        shoeThumbnailUrl,
      } = parsed ?? {};
      if (typeof garment !== 'string' || garment.length === 0) {
        json(res, 400, { error: { code: 'VALIDATION', message: 'garment must be a non-empty base64/data-URI string' } });
        return;
      }
      if (typeof gender !== 'string' || !CATALOG_GENDERS.has(gender)) {
        json(res, 400, { error: { code: 'VALIDATION', message: 'gender must be one of men, women, boys, girls' } });
        return;
      }
      if (typeof face !== 'string' || !CATALOG_SLUG_RE.test(face)) {
        json(res, 400, { error: { code: 'VALIDATION', message: 'face must be a valid asset slug' } });
        return;
      }
      if (
        !Array.isArray(looks) ||
        looks.length < 1 ||
        looks.length > 12 ||
        !looks.every(
          (l: unknown) =>
            l &&
            typeof (l as any).pose === 'string' &&
            typeof (l as any).background === 'string' &&
            CATALOG_SLUG_RE.test((l as any).pose) &&
            CATALOG_SLUG_RE.test((l as any).background),
        )
      ) {
        json(res, 400, { error: { code: 'VALIDATION', message: 'looks must be 1-12 {pose, background} slug pairs' } });
        return;
      }
      // poseLabel/backgroundLabel/garmentLabel/runLabel are optional,
      // human-readable display strings the client already has cached (from
      // its own GET /api/catalog/options call) — used only for the Results
      // page's garmentName column (see runCatalogAggregate's recordResult
      // call), never sent upstream. Free text, not slugs, so validated with
      // safeResultLabel rather than CATALOG_SLUG_RE; falls back to the slug
      // itself if missing/invalid so an older front-end (or a hand-built
      // request) still works, just with a less pretty Results-page label.
      const catalogGarmentLabel = safeResultLabel(garmentLabel, 200) ?? 'Garment';
      const catalogRunLabel = safeResultLabel(runLabel, 200) ?? face;
      // Same "optional, cosmetic, never sent upstream" treatment as
      // poseLabel/backgroundLabel above — see runCatalogAggregate's
      // recordResult call for where these actually get used.
      const catalogFaceLabel = safeResultLabel(faceLabel, 200) ?? face;
      const catalogFaceThumbnailUrl = safeResultUrl(faceThumbnailUrl);
      const catalogLowerLabel = safeResultLabel(lowerLabel, 200) ?? undefined;
      const catalogLowerThumbnailUrl = safeResultUrl(lowerThumbnailUrl);
      const catalogShoeLabel = safeResultLabel(shoeLabel, 200) ?? undefined;
      const catalogShoeThumbnailUrl = safeResultUrl(shoeThumbnailUrl);
      if (garmentType !== undefined && (typeof garmentType !== 'string' || !CATALOG_SLUG_RE.test(garmentType))) {
        json(res, 400, { error: { code: 'VALIDATION', message: 'invalid garmentType' } });
        return;
      }
      if (lower !== undefined && (typeof lower !== 'string' || !CATALOG_SLUG_RE.test(lower))) {
        json(res, 400, { error: { code: 'VALIDATION', message: 'invalid lower' } });
        return;
      }
      if (shoe !== undefined && (typeof shoe !== 'string' || !CATALOG_SLUG_RE.test(shoe))) {
        json(res, 400, { error: { code: 'VALIDATION', message: 'invalid shoe' } });
        return;
      }
      if (typeof aspectRatio !== 'string' || !CATALOG_ASPECT_RATIOS.has(aspectRatio)) {
        json(res, 400, { error: { code: 'VALIDATION', message: 'aspectRatio must be one of 1:1, 2:3, 3:4, 4:5' } });
        return;
      }
      if (typeof resolution !== 'string' || !CATALOG_RESOLUTIONS.has(resolution)) {
        json(res, 400, { error: { code: 'VALIDATION', message: 'resolution must be one of HD, 2K, 4K' } });
        return;
      }

      // Build the aggregate run up front (all jobs QUEUED, none submitted
      // upstream yet) and hand it straight back — runCatalogAggregate (not
      // awaited here) drives the actual submissions at CATALOG_CONCURRENCY
      // at a time in the background; the client's existing poll loop against
      // GET /api/catalog/catalogues/:id watches the same job objects mutate
      // in place as that happens. See the aggregate-run comment block above
      // for why this exists instead of one straight-through generateCatalog
      // call (which would let all of `looks` run at once upstream).
      sweepCatalogAggregateRuns();
      const aggId = randomUUID();
      const run: CatalogAggregateRun = {
        jobs: (
          looks as { pose: string; background: string; poseLabel?: string; backgroundLabel?: string; poseThumbnailUrl?: string; backgroundThumbnailUrl?: string }[]
        ).map((l, i) => ({
          jobId: `${aggId}-${i}`,
          pose: l.pose,
          background: l.background,
          poseLabel: safeResultLabel(l.poseLabel, 200) ?? l.pose,
          backgroundLabel: safeResultLabel(l.backgroundLabel, 200) ?? l.background,
          poseThumbnailUrl: safeResultUrl(l.poseThumbnailUrl),
          backgroundThumbnailUrl: safeResultUrl(l.backgroundThumbnailUrl),
          status: 'QUEUED',
        })),
        createdAt: Date.now(),
        gender,
        personName: catalogRunLabel,
        garmentLabel: catalogGarmentLabel,
        startedBy: session!.username,
        // "— any —" (garmentType left unselected) has nothing real to
        // categorize by — falls back to the literal 'catalog' rather than
        // an empty string, since job_results.category_slug is NOT NULL.
        categorySlug: (garmentType as string) || 'catalog',
        faceLabel: catalogFaceLabel,
        faceThumbnailUrl: catalogFaceThumbnailUrl,
        lowerLabel: catalogLowerLabel,
        lowerThumbnailUrl: catalogLowerThumbnailUrl,
        shoeLabel: catalogShoeLabel,
        shoeThumbnailUrl: catalogShoeThumbnailUrl,
      };
      catalogAggregateRuns.set(aggId, run);
      const base: Omit<CatalogGenerateBody, 'looks'> = {
        garment,
        gender: gender as CatalogGender,
        face,
        garmentType: garmentType || undefined,
        lower: lower || undefined,
        shoe: shoe || undefined,
        aspectRatio: aspectRatio as CatalogGenerateBody['aspectRatio'],
        resolution: resolution as CatalogGenerateBody['resolution'],
      };
      // Fire-and-forget on purpose — errors per look are already caught and
      // recorded onto that look's job stub inside runCatalogAggregate, so
      // there's nothing left for this handler to do with the promise.
      void runCatalogAggregate(catalogCfg, run, base);
      json(res, 202, {
        catalogueId: aggId,
        jobs: run.jobs.map((j) => ({ jobId: j.jobId, pose: j.pose, background: j.background })),
      });
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/catalog/catalogues/')) {
      if (!cfg) {
        json(res, 400, { error: { code: 'CONFIG_MISSING', message: 'DEV_API_KEY is not set on the server.' } });
        return;
      }
      const catalogueId = decodeJobIdParam(url.pathname.slice('/api/catalog/catalogues/'.length));
      if (catalogueId === null || !/^[0-9a-f-]{36}$/i.test(catalogueId)) {
        json(res, 400, { error: { code: 'VALIDATION', message: 'invalid catalogue id' } });
        return;
      }
      // Every id POST /api/catalog/generate hands out is one of our own
      // aggregate runs (see the aggregate-run comment block above), never a
      // real upstream catalogueId directly — so this is served entirely
      // from catalogAggregateRuns, no upstream call needed. A miss here
      // means the run finished sweeping (2h+ old) or the server restarted
      // since it was created — both fine to just report as not found.
      const run = catalogAggregateRuns.get(catalogueId);
      if (!run) {
        json(res, 404, { error: { code: 'NOT_FOUND', message: 'unknown or expired catalogue run' } });
        return;
      }
      json(res, 200, {
        catalogueId,
        jobs: run.jobs.map((j) => ({ jobId: j.jobId, status: j.status, imageUrl: j.imageUrl, error: j.error })),
      });
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
  if (!propiclyCfg) console.log('  (PROPICLY_API_KEY not set — RedChief tab disabled)');
});
