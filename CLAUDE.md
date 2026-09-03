# CLAUDE.md

Guidance for AI coding agents working in this repo.

## What this is

A standalone local tool: a CLI (`run.mts`) and a web control panel
(`webapp/server.mts`) for bulk AI virtual try-on job generation. It has **no
code or database dependency on the aivastra monorepo** — it's a pure HTTP
client to aivastra's public dev API (`https://app.aivastra.com/v1/dev/*`),
exactly like any external API consumer would be. Every job it creates spends
**real production credits** on a real merchant account.

Extracted from `aivastra/scripts/bulk-tryon` on 2026-09-03 with no git history
of its own (that folder was never committed in the aivastra repo). If you need
history predating the extraction, it doesn't exist anywhere — the folder was
untracked there too.

## How to work here

**This spends real money.** Every `/v1/dev/tryon` call the CLI or web UI makes
deducts real credits from a real merchant balance. Never add a code path that
creates jobs without going through the existing confirmation flow (CLI's
`--yes`-gated prompt, or the web UI's confirmed-total check in
`POST /api/run/start`). Don't "test" a change by actually running jobs against
production — use `--dry-run` (CLI) or read the code, and if you truly need to
exercise the live API, ask first.

**Zero npm dependencies beyond the dev toolchain.** `tsx`, `typescript`, and
`@types/node` are the only three `devDependencies` in `package.json` — no
runtime dependencies at all. Routing, the SQLite access layer, the ZIP writer,
even the concurrency limiter are hand-rolled rather than pulled from npm. Keep
it that way; this is a deliberate, repeatedly-reaffirmed design constraint, not
an oversight. If you're tempted to add a package, look for the hand-rolled
equivalent first (e.g. `webapp/server.mts`'s `buildZip()` instead of `adm-zip`,
`lib/concurrency.mts`'s `createLimiter()` instead of `p-limit`).

**Everything is path-relative via `import.meta.url`.** No file hardcodes an
absolute path or assumes a particular parent folder — `SCRIPT_DIR`/
`LIB_DIR`/`BULK_TRYON_DIR` constants are all derived from
`fileURLToPath(import.meta.url)`. Keep new code the same way; this is what let
the whole tool move from `D:\Ai vastra\scripts\bulk-tryon` to its own repo
root with zero code changes.

**Match the code you're editing.** Comment density here is high and
explains the *why* — especially the non-obvious constraint that shaped a
line (a rate limit, a Windows path-length quirk, a decision the user
explicitly overrode a recommendation on). Keep that up; don't strip comments
down to restate the code.

**Secrets discipline.** `.env` holds `DEV_API_KEY` (a live merchant API key)
and the web panel's `SUPERADMIN_PASSWORD`. Never print either in full — if you
need to confirm one is set, report presence/length only.

**Report honestly.** If you ran something against the live API and it
mutated real state (created a job, spent credits), say so plainly. Don't
describe a change as "working" because the code looks right — run it
(`--dry-run` where the live API isn't needed, a real call only when
necessary and low-cost) and report what actually happened.

## Stack

- **Runtime:** Node **≥23.4** (see `package.json` `engines`) — required for
  `node:sqlite` (the local DB driver, `lib/db.mts`) to work without a flag.
  ESM only (`"type": "module"`), `.mts` extensions throughout, run directly
  via `tsx` — nothing here is ever transpiled to `.js` or bundled.
- **DB:** SQLite via Node's built-in `node:sqlite` (`DatabaseSync`), one file
  at `data/bulk-tryon.db` (WAL mode, foreign keys on). Not better-sqlite3 —
  that needs a native compile with no prebuilt binary for newer Node/Windows
  combos yet, which was infeasible here; `node:sqlite` needed zero extra
  tooling. See `lib/db.mts`'s header comment for the full history.
- **Web server:** plain `node:http`, no framework. Uploads are raw request
  bodies (`fetch(url, { body: file })`), not multipart — sidesteps writing a
  multipart parser for the one-file-per-request case this tool actually needs.
- **Auth:** local-only login (`webapp/auth.mts`) — scrypt-hashed passwords,
  in-memory sessions (cleared on restart), one bootstrapped super admin who
  creates every other account. Entirely separate from aivastra's auth system;
  this only gates *this* tool's UI.

## Layout

```
run.mts                  CLI entry point
lib/
  api-client.mts          thin fetch-based client for aivastra's public dev API
  batch.mts                shared job-execution core (create → poll → download → record)
  concurrency.mts          hand-rolled semaphore/limiter
  db.mts                   SQLite store — schema, migration, full query surface
  scan-input.mts           builds the (person × garment) job matrix from input/
webapp/
  server.mts               web control panel — plain node:http, all routes
  auth.mts                 local login/session/user-CRUD, SQLite-backed
  public/                  static assets (index.html, app.js, style.css, login.*)
input/                    gitignored — uploaded person/garment photos
output/                   gitignored — per-run results/ + summary.csv
data/                     gitignored — bulk-tryon.db (+ -wal/-shm sidecars)
```

`lib/batch.mts` is the single source of truth for "what running a job means" —
both `run.mts` (CLI) and `webapp/server.mts` (web UI's Generate button) call
into it, so the two front-ends can never diverge on job-execution behavior.
The same is true of `lib/db.mts`: both front-ends read/write run history, QA
flags, and (web-only) user accounts through it exclusively — no file-based
state remains anywhere in this tool.

## Database (`lib/db.mts`)

Four tables: `runs`, `job_results` (one row per job attempt, autoincrement
`id` — this **is** the id the web UI's Results table and every
`/api/results/:id/*` route use, not a recomputed positional index), `users`,
`flags` (1:1 with `job_results` via `flags.result_id` PK; flagging and
resolving are independent steps — resolving never clears a flag's reason/note,
unflagging clears both).

On first load, if `job_results`/`users` are empty, `db.mts` runs a one-time
migration from the pre-DB file layout (`output/<run>/manifest.jsonl` +
`run-meta.json`, `webapp/users.json`, `webapp/flags.json`) if any of those
files are found — inserting in ascending `finishedAt` order so old flag ids
(which were positional) land on the same autoincrement rows. Migrated legacy
files are renamed to `*.migrated`, never deleted. This logic is now mostly
dead weight for a repo that starts fresh from the DB era, but is left in place
rather than ripped out — harmless (fast no-op once the tables are non-empty)
and it's the record of how the pre-DB history was preserved during the
2026-09-03 SQLite migration.

**Never touch `data/bulk-tryon.db` directly with an ad-hoc tool.** Go through
`lib/db.mts`'s exported functions — they're the only thing that knows the
schema, the WAL/FK pragmas, and the invariants (e.g. `insertJobResult` calls
`ensureRun` defensively because `job_results.run_id` has a foreign key).

## Commands

```bash
pnpm install
cp .env.example .env    # fill in DEV_API_KEY at minimum
pnpm cli -- --dry-run    # validate input + show the plan, no API calls, no credits spent
pnpm cli                  # interactive confirmation, then runs everything in input/
pnpm web                  # http://localhost:5959 — upload + generate + browse/flag results
```

No `build`/`test`/`lint` scripts exist yet — this tool has no test suite. If
you add meaningful logic (especially to `lib/db.mts` or `lib/batch.mts`),
consider whether a lightweight `node:test` suite is warranted rather than
assuming none is expected going forward.

## Deployment

Not yet deployed anywhere — designed to run locally so far. If/when this
moves to a VPS subdomain (e.g. `bulk-tryon.aivastra.com`), see the "Before
putting this on a public URL" section in `README.md` first: the login gate
alone is not sufficient for a public URL, put it behind Cloudflare Access or
an IP allowlist, and confirm the deploy target's Node version is ≥23.4.
