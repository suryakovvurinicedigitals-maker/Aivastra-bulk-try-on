/**
 * Shared SQLite store for scripts/bulk-tryon — the single source of truth for
 * run/job history, QA flags, and web-login accounts, used by both the CLI
 * (run.mts) and the web control panel (webapp/server.mts) so the two
 * front-ends can never see different data. One file on disk (bulk-tryon/data/
 * bulk-tryon.db), no separate DB server — this replaced the earlier per-run
 * manifest.jsonl/run-meta.json files plus webapp/{users,flags}.json, which had
 * no protection against a corrupt write under concurrent use. Actual result
 * images still live on disk under output/<run-id>/results/ — only the
 * structured records (who ran what, when, flagged/resolved) live here.
 *
 * Uses node:sqlite (Node's built-in driver, stable without a flag on the Node
 * version this tool runs — 23.4+/24.x) rather than better-sqlite3: the latter
 * needs a native compile with no prebuilt binary yet for newer Node/Windows
 * combinations, which better-sqlite3 needing Visual Studio Build Tools made
 * impractical here. Types come from @types/node's own sqlite.d.ts (present
 * since 22.5+) — no ambient declaration file needed.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url)); // .../scripts/bulk-tryon/lib
const BULK_TRYON_DIR = path.dirname(LIB_DIR); // .../scripts/bulk-tryon
const DB_PATH = process.env.BULK_TRYON_DB_PATH
  ? path.resolve(process.env.BULK_TRYON_DB_PATH)
  : path.join(BULK_TRYON_DIR, 'data', 'bulk-tryon.db');

mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL'); // readers (web UI polling status) don't block the writer (an active batch)
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    run_id      TEXT PRIMARY KEY,
    started_by  TEXT,
    started_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS job_results (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id         TEXT NOT NULL REFERENCES runs(run_id),
    gender         TEXT NOT NULL,
    person_name    TEXT NOT NULL,
    category_slug  TEXT NOT NULL,
    garment_name   TEXT NOT NULL,
    job_id         TEXT,
    status         TEXT NOT NULL,
    error_code     TEXT,
    error          TEXT,
    output_file    TEXT,
    finished_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_job_results_run_id ON job_results(run_id);
  CREATE INDEX IF NOT EXISTS idx_job_results_finished_at ON job_results(finished_at);

  CREATE TABLE IF NOT EXISTS users (
    username       TEXT PRIMARY KEY,
    password_hash  TEXT NOT NULL,
    role           TEXT NOT NULL,
    created_at     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS flags (
    result_id      INTEGER PRIMARY KEY REFERENCES job_results(id),
    reason         TEXT NOT NULL,
    note           TEXT,
    flagged_by     TEXT NOT NULL,
    flagged_at     TEXT NOT NULL,
    resolved_at    TEXT,
    resolved_note  TEXT,
    resolved_by    TEXT
  );
`);

// job_results predates the "how long did generation take?" requirement, so
// existing DBs need this column added on top rather than via CREATE TABLE IF
// NOT EXISTS (which only applies to brand-new tables). Guarded on PRAGMA
// table_info so this is a fast no-op on every startup after the first.
// Nullable: rows written before this migration (and legacy manifest.jsonl
// rows, which never recorded timing) have no duration to backfill.
{
  const jobResultsCols = (db.prepare('PRAGMA table_info(job_results)').all() as { name: string }[]).map((c) => c.name);
  if (!jobResultsCols.includes('duration_ms')) {
    db.exec('ALTER TABLE job_results ADD COLUMN duration_ms INTEGER');
  }
}

// ---- one-time migration of the pre-DB file-based state, if any is found ----
// Both migrations are gated on "the destination table is still empty" so this
// is safe to run on every startup: a second run against an already-migrated
// (or always-fresh) DB is a fast no-op. Legacy files are renamed (never
// deleted) once migrated, so nothing already on disk is lost even if this
// runs against a database that was reset independently.
function migrateLegacyRunHistory(): void {
  const existingCount = (db.prepare('SELECT COUNT(*) AS c FROM job_results').get() as { c: number }).c;
  if (existingCount > 0) return;

  const outputDir = process.env.OUTPUT_DIR ? path.resolve(process.env.OUTPUT_DIR) : path.join(BULK_TRYON_DIR, 'output');
  if (!existsSync(outputDir)) return;
  const runDirs = readdirSync(outputDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  if (runDirs.length === 0) return;

  interface LegacyRow {
    runId: string;
    gender: string;
    personName: string;
    categorySlug: string;
    garmentName: string;
    jobId?: string;
    status: string;
    errorCode?: string;
    error?: string;
    outputFile?: string;
    finishedAt: string;
  }
  const allRows: LegacyRow[] = [];
  const runStartedBy = new Map<string, string | undefined>();

  for (const runId of runDirs) {
    const runDir = path.join(outputDir, runId);
    const manifestPath = path.join(runDir, 'manifest.jsonl');
    if (existsSync(manifestPath)) {
      const lines = readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          allRows.push({ runId, ...JSON.parse(line) });
        } catch {
          // one corrupt line (e.g. a truncated write from an interrupted run) shouldn't abort the whole migration
        }
      }
    }
    const metaPath = path.join(runDir, 'run-meta.json');
    if (existsSync(metaPath)) {
      try {
        runStartedBy.set(runId, JSON.parse(readFileSync(metaPath, 'utf8')).startedBy);
      } catch {
        // ignore a corrupt run-meta.json — startedBy just falls back to unattributed
      }
    }
  }
  if (allRows.length === 0) return;

  // Same order the old web UI's positional result id used (sort ascending by
  // finishedAt) — inserting in this order into an empty autoincrement table
  // means row N gets id=N, so flags.json's old string keys ("167", ...) still
  // point at the right row once migrated below.
  allRows.sort((a, b) => a.finishedAt.localeCompare(b.finishedAt));

  const insertRun = db.prepare('INSERT OR IGNORE INTO runs (run_id, started_by, started_at) VALUES (?, ?, ?)');
  const insertResult = db.prepare(`
    INSERT INTO job_results (run_id, gender, person_name, category_slug, garment_name, job_id, status, error_code, error, output_file, finished_at, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.exec('BEGIN');
  try {
    const now = new Date().toISOString();
    for (const runId of runDirs) insertRun.run(runId, runStartedBy.get(runId) ?? null, now);
    for (const r of allRows) {
      insertResult.run(
        r.runId,
        r.gender,
        r.personName,
        r.categorySlug,
        r.garmentName,
        r.jobId ?? null,
        r.status,
        r.errorCode ?? null,
        r.error ?? null,
        r.outputFile ?? null,
        r.finishedAt,
        null, // legacy manifest.jsonl rows never recorded timing
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  console.log(`bulk-tryon: migrated ${allRows.length} job result(s) across ${runDirs.length} run folder(s) into ${DB_PATH}.`);

  const flagsPath = path.join(BULK_TRYON_DIR, 'webapp', 'flags.json');
  if (existsSync(flagsPath)) {
    try {
      const legacyFlags = JSON.parse(readFileSync(flagsPath, 'utf8')) as Record<
        string,
        { reason: string; note?: string; flaggedBy: string; flaggedAt: string; resolvedAt?: string; resolvedNote?: string; resolvedBy?: string }
      >;
      const insertFlag = db.prepare(`
        INSERT INTO flags (result_id, reason, note, flagged_by, flagged_at, resolved_at, resolved_note, resolved_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      let migrated = 0;
      db.exec('BEGIN');
      try {
        for (const [oldId, f] of Object.entries(legacyFlags)) {
          const resultId = Number(oldId);
          if (!Number.isInteger(resultId) || resultId < 1 || resultId > allRows.length) continue;
          insertFlag.run(resultId, f.reason, f.note ?? null, f.flaggedBy, f.flaggedAt, f.resolvedAt ?? null, f.resolvedNote ?? null, f.resolvedBy ?? null);
          migrated++;
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      console.log(`bulk-tryon: migrated ${migrated} flag(s) from flags.json.`);
      renameSync(flagsPath, `${flagsPath}.migrated`);
    } catch (err) {
      console.warn(`bulk-tryon: could not migrate flags.json — ${err instanceof Error ? err.message : String(err)} (left untouched)`);
    }
  }
}

function migrateLegacyUsers(): void {
  const existingCount = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
  if (existingCount > 0) return;

  const usersPath = path.join(BULK_TRYON_DIR, 'webapp', 'users.json');
  if (!existsSync(usersPath)) return;
  try {
    const legacyUsers = JSON.parse(readFileSync(usersPath, 'utf8')) as {
      username: string;
      passwordHash: string;
      role: string;
      createdAt: string;
    }[];
    const insertUser = db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)');
    db.exec('BEGIN');
    try {
      for (const u of legacyUsers) insertUser.run(u.username, u.passwordHash, u.role, u.createdAt);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    console.log(`bulk-tryon: migrated ${legacyUsers.length} user account(s) from users.json.`);
    renameSync(usersPath, `${usersPath}.migrated`);
  } catch (err) {
    console.warn(`bulk-tryon: could not migrate users.json — ${err instanceof Error ? err.message : String(err)} (left untouched)`);
  }
}

migrateLegacyRunHistory();
migrateLegacyUsers();

// ==================== runs / job_results ====================

export interface JobResultInput {
  gender: string;
  personName: string;
  categorySlug: string;
  garmentName: string;
  jobId?: string;
  status: 'COMPLETED' | 'FAILED' | 'ERROR';
  errorCode?: string;
  error?: string;
  outputFile?: string;
  finishedAt: string;
  /** Wall-clock time the job took to generate (create → poll → download), in milliseconds. Optional/nullable because rows from before this field existed (and migrated legacy manifest.jsonl rows) have no timing data. */
  durationMs?: number;
}

export interface JobResultRow extends JobResultInput {
  id: number;
  runId: string;
}

export interface FlagRow {
  resultId: number;
  reason: string;
  note?: string;
  flaggedBy: string;
  flaggedAt: string;
  resolvedAt?: string;
  resolvedNote?: string;
  resolvedBy?: string;
}

function rowToJobResult(r: Record<string, unknown>): JobResultRow {
  return {
    id: Number(r.id),
    runId: String(r.run_id),
    gender: String(r.gender),
    personName: String(r.person_name),
    categorySlug: String(r.category_slug),
    garmentName: String(r.garment_name),
    jobId: (r.job_id as string) ?? undefined,
    status: r.status as JobResultRow['status'],
    errorCode: (r.error_code as string) ?? undefined,
    error: (r.error as string) ?? undefined,
    outputFile: (r.output_file as string) ?? undefined,
    finishedAt: String(r.finished_at),
    durationMs: r.duration_ms != null ? Number(r.duration_ms) : undefined,
  };
}

const ensureRunStmt = db.prepare('INSERT OR IGNORE INTO runs (run_id, started_by, started_at) VALUES (?, ?, ?)');
/** Idempotent — call freely from both the caller that knows startedBy (server.mts/run.mts) and defensively before an insert, since job_results.run_id has a foreign key onto this table. */
export function ensureRun(runId: string, startedBy?: string): void {
  ensureRunStmt.run(runId, startedBy ?? null, new Date().toISOString());
}

const runMetaStmt = db.prepare('SELECT started_by FROM runs WHERE run_id = ?');
export function getRunMeta(runId: string): { startedBy?: string } {
  const row = runMetaStmt.get(runId) as { started_by: string | null } | undefined;
  return row?.started_by ? { startedBy: row.started_by } : {};
}

const insertJobResultStmt = db.prepare(`
  INSERT INTO job_results (run_id, gender, person_name, category_slug, garment_name, job_id, status, error_code, error, output_file, finished_at, duration_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
export function insertJobResult(runId: string, r: JobResultInput): number {
  ensureRun(runId); // no-op if already inserted with a startedBy
  const info = insertJobResultStmt.run(
    runId,
    r.gender,
    r.personName,
    r.categorySlug,
    r.garmentName,
    r.jobId ?? null,
    r.status,
    r.errorCode ?? null,
    r.error ?? null,
    r.outputFile ?? null,
    r.finishedAt,
    r.durationMs ?? null,
  );
  return Number(info.lastInsertRowid);
}

const completedKeysForRunStmt = db.prepare(
  "SELECT gender, person_name, category_slug, garment_name FROM job_results WHERE run_id = ? AND status = 'COMPLETED'",
);
/** For --resume: which (gender/person/category/garment) keys already succeeded in this run, so the CLI can skip them. */
export function getCompletedKeysForRun(runId: string): Set<string> {
  const rows = completedKeysForRunStmt.all(runId) as { gender: string; person_name: string; category_slug: string; garment_name: string }[];
  return new Set(rows.map((r) => `${r.gender}/${r.person_name}/${r.category_slug}/${r.garment_name}`));
}

const runRowsStmt = db.prepare('SELECT * FROM job_results WHERE run_id = ? ORDER BY id');
/** All rows for one run, in insertion order — used for the CLI's summary.csv. */
export function getRunRows(runId: string): JobResultRow[] {
  return (runRowsStmt.all(runId) as Record<string, unknown>[]).map(rowToJobResult);
}

const resultByIdStmt = db.prepare('SELECT * FROM job_results WHERE id = ?');
export function getResultRow(id: number): JobResultRow | null {
  const row = resultByIdStmt.get(id) as Record<string, unknown> | undefined;
  return row ? rowToJobResult(row) : null;
}

export interface ResultFilters {
  runId?: string;
  gender?: string;
  categorySlug?: string;
  status?: string;
  startedBy?: string;
  q?: string;
  flagMode?: '1' | 'resolved'; // '1' = flagged and not yet resolved
  page: number;
  pageSize: number;
}

export interface ResultRowWithFlag extends JobResultRow {
  startedBy: string | null;
  flag: FlagRow | null;
}

export interface ResultsPage {
  rows: ResultRowWithFlag[];
  total: number;
  runs: string[];
  genders: string[];
  categories: string[];
  users: string[];
}

/** The Results table's single query — filter + paginate over every run, newest first, with each row's flag (if any) attached via a LEFT JOIN. Replaces the old collect-every-manifest-line-then-sort-in-JS approach entirely. */
export function listResults(f: ResultFilters): ResultsPage {
  const where: string[] = [];
  const params: Record<string, string | number> = {};
  if (f.runId) {
    where.push('jr.run_id = @runId');
    params.runId = f.runId;
  }
  if (f.gender) {
    where.push('jr.gender = @gender');
    params.gender = f.gender;
  }
  if (f.categorySlug) {
    where.push('jr.category_slug = @categorySlug');
    params.categorySlug = f.categorySlug;
  }
  if (f.status) {
    where.push('jr.status = @status');
    params.status = f.status;
  }
  if (f.startedBy) {
    where.push('r.started_by = @startedBy');
    params.startedBy = f.startedBy;
  }
  if (f.q) {
    where.push('(jr.person_name LIKE @q OR jr.garment_name LIKE @q)');
    params.q = `%${f.q}%`;
  }
  if (f.flagMode === '1') where.push('(fl.result_id IS NOT NULL AND fl.resolved_at IS NULL)');
  else if (f.flagMode === 'resolved') where.push('fl.resolved_at IS NOT NULL');
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const fromSql = `
    FROM job_results jr
    LEFT JOIN runs r ON r.run_id = jr.run_id
    LEFT JOIN flags fl ON fl.result_id = jr.id
    ${whereSql}
  `;

  const total = (db.prepare(`SELECT COUNT(*) AS c ${fromSql}`).get(params) as { c: number }).c;

  const pageParams = { ...params, limit: f.pageSize, offset: (f.page - 1) * f.pageSize };
  const rows = db
    .prepare(
      `
      SELECT jr.*, r.started_by AS started_by,
        fl.reason AS flag_reason, fl.note AS flag_note, fl.flagged_by AS flag_flagged_by, fl.flagged_at AS flag_flagged_at,
        fl.resolved_at AS flag_resolved_at, fl.resolved_note AS flag_resolved_note, fl.resolved_by AS flag_resolved_by
      ${fromSql}
      ORDER BY jr.id DESC
      LIMIT @limit OFFSET @offset
    `,
    )
    .all(pageParams) as Record<string, unknown>[];

  const resultRows: ResultRowWithFlag[] = rows.map((r) => ({
    ...rowToJobResult(r),
    startedBy: (r.started_by as string) ?? null,
    flag: r.flag_reason
      ? {
          resultId: Number(r.id),
          reason: String(r.flag_reason),
          note: (r.flag_note as string) ?? undefined,
          flaggedBy: String(r.flag_flagged_by),
          flaggedAt: String(r.flag_flagged_at),
          resolvedAt: (r.flag_resolved_at as string) ?? undefined,
          resolvedNote: (r.flag_resolved_note as string) ?? undefined,
          resolvedBy: (r.flag_resolved_by as string) ?? undefined,
        }
      : null,
  }));

  // Filter-dropdown universes are drawn from the whole table, not the current
  // filtered/paginated view — same behavior as before this migration.
  const runs = (db.prepare('SELECT DISTINCT run_id FROM job_results').all() as { run_id: string }[]).map((r) => r.run_id).sort().reverse();
  const genders = (db.prepare('SELECT DISTINCT gender FROM job_results').all() as { gender: string }[]).map((r) => r.gender).sort();
  const categories = (db.prepare('SELECT DISTINCT category_slug FROM job_results').all() as { category_slug: string }[])
    .map((r) => r.category_slug)
    .sort();
  const users = (db.prepare('SELECT DISTINCT started_by FROM runs WHERE started_by IS NOT NULL').all() as { started_by: string }[])
    .map((r) => r.started_by)
    .sort();

  return { rows: resultRows, total, runs, genders, categories, users };
}

// ==================== flags ====================

const getFlagStmt = db.prepare('SELECT * FROM flags WHERE result_id = ?');
function rowToFlag(r: Record<string, unknown>): FlagRow {
  return {
    resultId: Number(r.result_id),
    reason: String(r.reason),
    note: (r.note as string) ?? undefined,
    flaggedBy: String(r.flagged_by),
    flaggedAt: String(r.flagged_at),
    resolvedAt: (r.resolved_at as string) ?? undefined,
    resolvedNote: (r.resolved_note as string) ?? undefined,
    resolvedBy: (r.resolved_by as string) ?? undefined,
  };
}
export function getFlag(resultId: number): FlagRow | null {
  const row = getFlagStmt.get(resultId) as Record<string, unknown> | undefined;
  return row ? rowToFlag(row) : null;
}

const upsertFlagStmt = db.prepare(`
  INSERT INTO flags (result_id, reason, note, flagged_by, flagged_at)
  VALUES (@resultId, @reason, @note, @flaggedBy, @flaggedAt)
  ON CONFLICT(result_id) DO UPDATE SET reason = excluded.reason, note = excluded.note, flagged_by = excluded.flagged_by, flagged_at = excluded.flagged_at
`);
/** Flag, or update an existing flag's reason/note. Re-flagging an already-resolved job leaves resolved_at/resolved_note/resolved_by untouched — those columns aren't in the UPDATE SET, matching the main app's /results tool where flag and resolve are independent. */
export function setFlag(resultId: number, reason: string, note: string | undefined, flaggedBy: string): FlagRow {
  upsertFlagStmt.run({ resultId, reason, note: note ?? null, flaggedBy, flaggedAt: new Date().toISOString() });
  return getFlag(resultId)!;
}

const deleteFlagStmt = db.prepare('DELETE FROM flags WHERE result_id = ?');
/** Unflagging clears resolved state too (there's no "resolved but not flagged" state) — deleting the row does that in one step. */
export function clearFlag(resultId: number): boolean {
  return deleteFlagStmt.run(resultId).changes > 0;
}

const resolveFlagStmt = db.prepare(
  'UPDATE flags SET resolved_at = ?, resolved_note = ?, resolved_by = ? WHERE result_id = ? AND resolved_at IS NULL',
);
/** Returns null if the job isn't flagged at all, or is already resolved — the caller turns that into the right 400. */
export function resolveFlag(resultId: number, note: string | undefined, resolvedBy: string): FlagRow | null {
  const info = resolveFlagStmt.run(new Date().toISOString(), note ?? null, resolvedBy, resultId);
  if (info.changes === 0) return null;
  return getFlag(resultId);
}

// ==================== users ====================

export interface StoredUser {
  username: string;
  passwordHash: string;
  role: 'superadmin' | 'user';
  createdAt: string;
}
function rowToUser(r: Record<string, unknown>): StoredUser {
  return { username: String(r.username), passwordHash: String(r.password_hash), role: r.role as StoredUser['role'], createdAt: String(r.created_at) };
}

const allUsersStmt = db.prepare('SELECT * FROM users ORDER BY created_at');
export function getAllUsersRows(): StoredUser[] {
  return (allUsersStmt.all() as Record<string, unknown>[]).map(rowToUser);
}

const userByNameStmt = db.prepare('SELECT * FROM users WHERE username = ?');
export function getUserRow(username: string): StoredUser | null {
  const row = userByNameStmt.get(username) as Record<string, unknown> | undefined;
  return row ? rowToUser(row) : null;
}

const insertUserStmt = db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)');
export function insertUserRow(u: StoredUser): void {
  insertUserStmt.run(u.username, u.passwordHash, u.role, u.createdAt);
}

const updatePasswordStmt = db.prepare('UPDATE users SET password_hash = ? WHERE username = ?');
export function updateUserPasswordHash(username: string, passwordHash: string): void {
  updatePasswordStmt.run(passwordHash, username);
}

const deleteUserStmt = db.prepare('DELETE FROM users WHERE username = ?');
export function deleteUserRow(username: string): boolean {
  return deleteUserStmt.run(username).changes > 0;
}
