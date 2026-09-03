# Bulk try-on runner

Standalone tool — not part of the aivastra monorepo. It has no code or
database dependency on aivastra: it talks to the public dev API
(`/v1/dev/*`) over plain HTTPS, exactly like any external API consumer would.
It was extracted from `aivastra/scripts/bulk-tryon` on 2026-09-03; see that
repo's history for anything predating the extraction (this repo starts with
no prior git history of its own).

Runs every uploaded garment against every uploaded person photo through the
public dev API, one job per (person × garment) pair. The garment **category
slug** is all that's needed to pick the right ComfyUI workflow — that mapping
already lives server-side in `dev_tryon_categories.workflowTemplateId`
(aivastra Admin → Developer API → Categories), so this script never needs to
know anything about workflows itself.

All input photos, outputs, and the local SQLite store stay under this folder,
gitignored — nothing here gets committed by default.

## Requirements

- Node **≥23.4** — needed for `node:sqlite` (the local run-history/flags/users
  store, `lib/db.mts`) to work without a flag.
- `pnpm install` (or `npm install`) — three devDependencies: `tsx`,
  `typescript`, `@types/node`.

## Setup

```bash
cp .env.example .env
# fill in DEV_API_KEY (see .env.example for how to mint one)
pnpm install
```

## Input layout

```
input/
  people/
    men/person1.jpg
    men/person2.jpg
    women/person1.jpg
  garments/
    men/
      upper/garment.jpg
      lower/garment.jpg
      suits/garment.jpg
    women/
      saree/garment.jpg
      upper/garment.jpg
```

Folder names under `garments/<gender>/` must match your store's actual active
dev-category slugs — check yours with `--dry-run` or the web UI's Upload page,
which lists them live from `GET /v1/dev/categories`. They won't necessarily be
`upper`/`lower`/`saree`/`suits`/`dress`/`general` — that's just this store's set.

- `men` / `women` (or any names you pick) are just folder labels that decide
  which people get matched against which garments subtree — they are **not**
  sent to the API. Dev categories aren't gender-scoped, so this pairing is the
  script's job, not the server's.
- Each `garments/<gender>/<folder>` folder name **must equal an active slug**
  from `GET /v1/dev/categories` (run the script once with `--dry-run` to see
  which of your folders match and which get skipped).
- Multiple images per person or per category folder are fine — every
  combination becomes a separate job.
- Accepted formats: `.jpg`, `.jpeg`, `.png`, `.webp`.

## Running it

```bash
pnpm cli -- --dry-run          # validate input + show the job count/plan, no API calls
pnpm cli -- --limit=3          # smoke-test a handful of jobs before a full run
pnpm cli                        # interactive confirmation, then runs everything
pnpm cli -- --yes               # skip the confirmation prompt (non-interactive use)
pnpm cli -- --resume=<run-id>   # continue an interrupted run, skipping completed pairs
```

The default `DEV_API_BASE_URL` is **production** — every job spends real
merchant credits. The script prints your current balance and estimated
remaining try-ons before asking for confirmation, and stops starting new jobs
the moment it sees an `INSUFFICIENT_CREDITS` response (jobs already in flight
still finish and get recorded).

## Output

```
output/<run-id>/
  results/<gender>/<person>/<category>/<garment>.jpg
  summary.csv                    written once, at the end
```

`<run-id>` defaults to a timestamp. Each job attempt (one row per job, as it
finishes) is recorded in `data/bulk-tryon.db` — a local SQLite store, shared
with the web control panel below — rather than a file under the run folder;
`--resume` reads that DB to skip pairs that already completed, and every
insert lands as its own transaction, so a kill mid-run loses at most the one
job in flight.

The actual job-execution logic (create → poll → download → record) lives in
`lib/batch.mts`, shared between this CLI and the web control panel below — the
two front-ends can never disagree on what "running a job" means.

## Web control panel (upload + generate + browse results)

```bash
pnpm web        # http://localhost:5959
```

Gated by a login (`webapp/auth.mts`) — a bootstrapped super admin (from
`SUPERADMIN_USERNAME`/`SUPERADMIN_PASSWORD` in `.env`, or a generated password
printed once on first run) who can create additional accounts from the Users
page (admin-only, hidden from regular users).

A local single-page app with two sections:

- **Upload** — drag-and-drop person/garment photos *or whole folders* (writes
  straight into `input/`, same layout as above; a folder drop is traversed
  recursively client-side and every image inside is uploaded), a live
  plan/job-count preview, and a **Generate** button that runs the batch
  directly from the browser — same `lib/batch.mts` the CLI uses, with live
  progress (bar, counts, log). Generate only ever runs against what's
  currently **selected** (by default: whatever you just uploaded) — there is
  no "run everything in `input/`" mode from the web UI, unlike the CLI.
- **Results** — a flat, filterable, paginated table across every run, with a
  QA flag workflow (reason + note, resolve, bundle download as a zip of
  inputs+output+metadata) mirroring aivastra's own `/results` review tool.

It's a plain `node:http` server with no framework — `tsx`/`typescript`/
`@types/node` are the only npm dependencies anywhere in this project;
everything else (routing, the ZIP writer, the SQLite store) is hand-rolled.
Static assets live in `webapp/public/`.

**Before putting this on a public URL** (e.g. a subdomain on a VPS): the
login gate covers casual access, but there is no rate limiting or content
moderation, and every account that can log in can hit Generate (which spends
real production credits). At minimum, put it behind Cloudflare Access or an
IP allowlist, and decide where `input/`/`output/`/`data/` actually live if the
deploy target's disk isn't durable — point `INPUT_DIR`/`OUTPUT_DIR`/
`BULK_TRYON_DB_PATH` at persistent storage otherwise.
