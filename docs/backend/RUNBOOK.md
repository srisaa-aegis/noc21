# Runbook: set up, run and test (current build: phase B3)

Every command below was run from a clean slate on this machine: `npm run stop; npm run db:stop;
rm -rf .pgdata var`, then `npm run setup` and `npm start`, then the tests.

## 1. Requirements

| Need | Check | Notes |
|---|---|---|
| Node.js ≥ 22.12 | `node -v` | 22.21 here |
| npm ≥ 10 | `npm -v` | |
| PostgreSQL 16 **binaries** (`initdb`, `pg_ctl`, `psql`, `pg_isready`, `pg_dump`, `pg_restore`) on PATH | `which initdb pg_ctl psql pg_dump` | No system service is needed. The project runs its own cluster in `.pgdata/` on port 5432. The `pg_trgm` extension (PostgreSQL contrib, installed with the server packages) is used for search. |
| Chromium (only for `npm run test:e2e`) | `echo $PLAYWRIGHT_BROWSERS_PATH` | Preinstalled here at `/opt/pw-browsers` |

### Running as root

This is supported. PostgreSQL refuses to run as root, so when the scripts detect root they run
`initdb`, `pg_ctl` and `postgres` through `runuser` as an unprivileged owner:

1. whoever already owns `.pgdata/`, otherwise
2. `PG_OS_USER` (set it in `backend/.env`), otherwise
3. the `postgres` OS user that the PostgreSQL packages create.

The scripts hand `.pgdata/`, `var/log/` and `var/run/` to that user. They check that the user can reach the
data directory, and if it can't they say what to change. Clients such as `psql`, the API and the tests connect over TCP,
so they run as anyone.

> If an earlier attempt as root left a half-initialised `.pgdata/` owned by root, remove it
> (`rm -rf .pgdata`) and run `npm run setup` again.

## 2. Fresh setup (one command)

```bash
cd /workspace/noc
npm run setup
```

`npm run setup` runs these steps in order:

1. creates `backend/.env` from `backend/.env.example` if it does not exist (an existing `.env` is kept;
   the settings it lacks are listed — see §8)
2. `npm install` for the workspace root (rules-engine, workflow-engine, noc-domain, backend)
3. `npm --prefix frontend install`
4. `npm run build:packages` (the three libraries, used by the backend and the browser)
5. `npm run db:setup`, which runs `db:init` (initdb into `.pgdata/`), `db:start`, `db:create` (role `noc`,
   databases `noc` and `noc_test`) and `db:migrate` (4 migrations)
6. `npm run db:seed` (master data, rule sets, workflows, 22 accounts, 14 applications
   re-dated to today)

This takes about 4 minutes here (most of it `npm install`). The output ends with:

```
    users                    22
    applications             14
    ...
  ✓ Seed complete in 1.6s.
```

## 3. Running

```bash
npm start          # = npm run dev: PostgreSQL + migrations + API (:3000) + Angular (:4200)
npm run status     # what is running: API, web, PostgreSQL (with pids and owners)
npm run stop       # stops the API and web servers (PostgreSQL keeps running)
npm run db:stop    # stops PostgreSQL as well
```

- `npm start` first checks ports 3000 and 4200. If a server from an earlier run still holds
  one, it refuses, names the process and tells you to run `npm run stop`.
- `npm start` applies pending migrations (`db:migrate`) and rebuilds the three libraries, so a
  pulled change is picked up.
- `Ctrl-C` in the `npm start` terminal also stops both servers.
- Separately: `npm run dev:api` (API only) or `npm run dev:web` (Angular only, proxies `/api`
  to :3000).
- There is **no fixture-only mode any more** (phase B3 removed the mock layer): the portal needs the API.

| URL | What |
|---|---|
| **http://localhost:4200** | **The portal. Open this one.** |
| http://localhost:3000/docs | The API, browsable (OpenAPI 3.1 / Swagger UI; JSON at `/docs/json`); development only |
| http://localhost:3000/health | Liveness |
| http://localhost:3000/ready | Database, **migrations**, cache and storage readiness, plus data versions |
| http://localhost:3000/version | Build info (`"phase":"B3"`) |
| http://localhost:3000/api/v1/... | The REST API (see `50-api-design.md`, `03-api-catalog.md`) |

### Background jobs (scheduler)

With `ENABLE_SCHEDULER=true` (the default in `.env.example`) the API runs three jobs. A
PostgreSQL advisory lock makes sure only one API process runs them. Every run is recorded in
`job_runs`.

| Job | When | What |
|---|---|---|
| `escalations` | every day at `ESCALATION_HOUR` (09:00 IST) | Reminders for tasks and files past their SLA, to the officers and the issuing authority (N-12) |
| `purge-files` | every day at 02:00 | Deletes stored files unused for `FILE_PURGE_AFTER_DAYS` (30) — replaced or removed draft documents, deleted drafts (B2-9) |
| `cleanup-tokens` | every hour | Deletes expired refresh, reset and download tokens |
| `purge-audit` | every day at 03:00 | Deletes audit entries older than `AUDIT_RETENTION_MONTHS` (3) |

```bash
npm run jobs:run -- list           # the jobs and their last runs
npm run jobs:run -- escalations    # run one now (also purge-files, cleanup-tokens, purge-audit)
npm run jobs:run -- due            # run whatever the scheduler would run now
```

The admin can also preview and send escalations from **Admin → Workbench → Send Escalations**.

### Where e-mails and SMS go

No gateway is configured (decision B2-3). Messages are written to the **API log**, which is the
`[api]` lines of `npm start`:

```
[api] INFO: EMAIL (log driver) {"notification":{"to":"jane@example.com",...},
      "text":"... http://localhost:4200/auth/reset-password?token=...&welcome=1"}
```

## 4. Credentials (seed data)

**Every seeded account's password is `demo`.** It comes from `SEED_DEMO_PASSWORD`.

| Username | Portal | Use it for |
|---|---|---|
| `citizen1` | Citizen | 10 applications of every type and status; new applications, revise #105, occupancy / renewal |
| `citizen2`, `citizen3` | Citizen | Isolation from citizen1 |
| `sai.constructions` | — | **Deactivated** (sign-in is refused) |
| `section.hq` | Dept (Head Office) | **Receives new Head Office submissions** (Section Note, with the "challan verified" tick for challan payments) |
| `dfo.visakhapatnam`, `sfo.officer` | Dept | Inspection Report and Committee Concurrence of Visakhapatnam Head Office files |
| `rfo.officer`, `adfs.officer`, `dfscd.officer`, `dfs.officer` | Dept | The notes of the Head Office chain (RFO → ADFS → DFS-CD → DFS) |
| `dg.officer` | Dept (DG) | **Final decision** on Head Office files (with the signed NOC), bypass / change officer, **Audit** |
| `rfo.southern`, `dfo.officer`, `dfo.guntur`, `dfo.srikakulam`, `sfo.krishna`, `sfo.guntur`, `sfo.srikakulam` | Dept | Regional, district and station files of their jurisdiction (their reports too) |
| `monitor.hq` | Dept (read-only) | Every submitted file and every report |
| `retired.officer` | — | **Deactivated** |
| `admin` | Admin | Accounts, officers and hand-over, application search / delete of drafts never submitted, rules & fees, workflows, SLA, statuses, escalations, audit |

The whole Head Office chain of a new Provisional application of citizen1 at Visakhapatnam is:
`section.hq` ∥ `dfo.visakhapatnam` → `sfo.officer` → `rfo.officer` → `adfs.officer` →
`dfscd.officer` → `dfs.officer` → `dg.officer` (decision).

**New passwords must meet the policy:** at least 10 characters, with upper case, lower case, a digit
and a symbol, and not containing the username (for example `Station#2025`). The demo
passwords keep working until they are changed.

- **Registration** no longer shows a temporary password: the citizen receives a **"set your password"
  link** (24 h, single use — B2-4). Outside production the registration page also shows the link
  (there is no mail server), and the API log has the e-mail.
- **New officers** created by the admin get a **temporary password**, shown once to the admin; it must be
  changed at the first sign-in.
- Five wrong passwords lock an account for 15 minutes. Sessions: citizens are signed out after 1 day
  without activity; officers and admins after 8 idle hours and at most 12 hours after signing in
  (B2-5, B2-6). The lock is cleared by `npm run db:seed` or `npm run dev:reset-demo`.
- With `NODE_ENV=production` (or `SEED_FORCE_PASSWORD_CHANGE=true`) the seeded officers and the admin
  must choose a password at the first sign-in (B2-8).

## 5. Tests

```bash
npm test              # everything: 781 tests (libraries + backend + frontend)
npm run test:packages # rules-engine 58 + workflow-engine 39 + noc-domain 173
npm run test:api      # backend integration + parity (prepares noc_test)
npm run test:web      # Angular: 201 tests
npm run smoke         # API smoke on a throw-away database: citizen → every officer → decision,
                      # registration, reports, admin, backup + restore (57 checks)
npm run test:e2e      # browser suite, all portals, B1–B3 journeys (64 checks). Needs `npm start` running
npm run lint          # ESLint: backend + packages, and the Angular app
npm run typecheck     # every workspace, including the frontend specs
npm run ci            # lint + typecheck + test + smoke
npm run db:check      # migration files consistent with the schema
npm -w @srisaa/workflow-engine run test:deep   # 10 000 random workflow runs (~35 s)
```

The backend total (`npm -w @srisaa/noc-api test`) is 310: integration suites per area, the
**authorization matrix** (every route × anonymous / citizen / officer / admin), the **portal ↔ API
contract** (every catalogue entry is served, every route is used or documented), rate limits,
OpenAPI, and report / aggregate **parity** with the reference implementations in `@srisaa/noc-domain`.

The tests **never touch the development database**. The integration suites use `noc_test`
and refuse any database whose name does not end in `_test`. The smoke test creates and drops
`noc_smoke` and `noc_smoke_restore` and uses a temporary storage root. The browser suite (`test:e2e`)
works on the running development system, so it adds applications, a registered citizen and audit
entries to `noc`; `npm run dev:reset-demo` removes them.

### Performance (B3 hardening)

```bash
npm run db:load-test-data        # noc_load: 21 000 applications (3 years at 7 000/year, ~1 min);
                                 # -- --applications 300000 for the B3 headroom test (~12 min, ~4 GB); --fresh
npm run perf:probe               # against noc_load: every hot screen, EXPLAIN of its SQL, the write path,
                                 # and 100 concurrent users for 20 s; report in var/perf/probe-<time>.md
npm run perf:probe -- --only /dept/monitoring --plans 200   # one screen, with the plans of slow statements
```

Results and budgets: `B3-delivery-notes.md` §4.

## 6. Database tasks

| Command | Effect |
|---|---|
| `npm run db:start` / `db:stop` / `db:status` / `db:logs` | Cluster lifecycle. `db:start` applies `PG_SERVER_OPTIONS` (shared buffers, SSD costs, no JIT). |
| `npm run db:migrate` | Applies pending migrations (`npm start` does it too) |
| `npm run db:seed` | Re-seeds (idempotent; the demo data is re-dated to today, unless `SEED_REDATE=false`) |
| `npm run db:reset` | Drops the schema, then migrates and seeds. It refuses production, non-local and `*prod*` databases. |
| `npm run dev:reset-demo` | **The demo reset** (Q-67). It takes a `pg_dump` backup and moves uploaded files to `var/backups/`. Then it re-seeds, signs everyone out and refreshes the caches. Development settings only; needs a typed confirmation, or `-- --yes --i-understand-this-deletes-data`. |
| `npm run db:backup` | **Backup** of the database (`pg_dump`) and the uploaded files (`tar.gz`) with a manifest (row counts, SHA-256) into `var/backups/<time>/` (or `-- --out <dir>`; `--no-files`) |
| `npm run db:restore -- --from <dir>` | **Restore**: verifies the checksums, asks for the database name (or `--yes`), drops and re-creates the database, restores the files (the current ones are moved aside, never deleted), checks the row counts, signs everyone out. Refuses while the API runs on that database. `--db <name> --storage-root <dir>` restores into another database (a safe way to test a backup). |
| `npm run db:generate` | After editing `backend/src/db/schema/*.ts`, writes a new migration |
| `npm run db:check` | Checks that the migration files are consistent |
| `npm run openapi` | Writes the OpenAPI document to `docs/backend/openapi.json` |

Direct SQL access:

```bash
psql -h 127.0.0.1 -p 5432 -U noc -d noc          # password: noc
psql -h 127.0.0.1 -U noc -d noc -c "select appl_number, status_id, site_name from v_application_summary order by appl_id desc limit 5"
```

## 7. Files on disk

| Path | What | In git? |
|---|---|---|
| `.pgdata/` | The PostgreSQL cluster | no |
| `var/storage/` | Uploaded files, **outside the web root**, with S3-style keys `applications/<shard>/<id>/documents/<uuid>.pdf` | no |
| `var/backups/` | Backups (`db:backup`), and the snapshots taken by the demo reset and by a restore | no |
| `var/perf/` | Performance probe reports | no |
| `var/log/postgres.log` | Database log | no |
| `backend/.env` | Local configuration (created from `.env.example`) | no |
| `backend/seed/data/**` | Seed inputs (also the fixtures of the frontend unit tests) | yes |

## 8. Configuration notes

`backend/.env.example` lists every setting with the decisions behind it. The important B3 ones:

| Setting | Default | Why |
|---|---|---|
| `UPLOAD_MAX_BYTES` / `UPLOAD_MAX_PER_APPLICATION_BYTES` / `UPLOAD_ALLOWED_MIME` | 10 MB / 250 MB / `application/pdf` | B2-10 |
| `FILE_PURGE_AFTER_DAYS` | 30 | B2-9 |
| `CITIZEN_IDLE_TIMEOUT_HOURS` / `STAFF_IDLE_TIMEOUT_HOURS` / `STAFF_ABSOLUTE_HOURS` | 24 / 8 / 12 | B2-5, B2-6 |
| `RESET_LINK_MINUTES` / `SET_PASSWORD_LINK_HOURS` | 60 / 24 | B2-7, B2-4 |
| `RATE_LIMIT_LOGIN_PER_MINUTE` / `RATE_LIMIT_GLOBAL_PER_MINUTE` | 10 / 300 built in; 100 / 3000 in the demo `.env` | The browser suite signs in ~30 times a minute from one address |
| `ENABLE_SCHEDULER`, `ESCALATION_HOUR` | true, 9 | §3 |
| `ENABLE_DOCS` | unset: on in development, off in production | `/docs` (B3-13) |
| `TRUST_PROXY` | false | No reverse proxy (B3-12): the connection's address is the client's |
| `AUDIT_RETENTION_MONTHS` | 3 | Audit entries are purged after 3 months (B3-8) |
| `PG_SERVER_OPTIONS` | 512 MB shared buffers, SSD costs, JIT off | Local cluster sizing (restart the cluster to change) |

If your `backend/.env` was created before B3, `npm start` lists the settings it lacks; the built-in
defaults (the decisions above) apply to those. **An older `.env` may still say `UPLOAD_MAX_BYTES=5242880`
and allow JPEG/PNG** — copy `.env.example` over it, or fix those two lines.

### Production checklist (deployment-independent, B2-14)

`NODE_ENV=production`; new `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`; `COOKIE_SECURE=true`;
`CORS_ORIGINS` and `PORTAL_URL` set to the public address; the built-in rate limits (remove the demo
overrides); `ENABLE_DOCS` removed (off in production) and `TRUST_PROXY=false` (no proxy); `ENABLE_SCHEDULER=true` on the API instances (the
lock allows several); `FS_STORAGE_ROOT` on a dedicated volume outside any web root, included in the
backups; `npm run db:migrate` before starting a new version; a nightly `npm run db:backup` (or `pg_dump` +
WAL archiving and a file-level backup of the storage root) and a periodic `db:restore --db <scratch>` to
prove the backups; the Angular production build (`npm --prefix frontend run build`) served by a web
server that serves it and forwards `/api` to the API on the same host (a plain pass-through; the API sees
the client's own address only if it is exposed directly — otherwise set `TRUST_PROXY=true`).

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| `npm start` says port 3000 or 4200 is in use | `npm run stop`. If the process belongs to another user, stop it as that user or as root. |
| `pg_ctl: cannot be run as root` | You are on an old checkout. Pull; the scripts use `runuser`. |
| `db:init` says the directory is not empty | `rm -rf .pgdata`, then `npm run setup` |
| `/ready` reports `database: false` | `npm run db:start`, then check `var/log/postgres.log` |
| `/ready` reports `migrations: false` | `npm run db:migrate` (the API log also says so at start) |
| The portal says "cannot reach the server" | The API is not running. Check `npm run status`. |
| Sign-in says the account is locked | Wait 15 minutes or run `npm run db:seed` |
| Sign-in answers "Too many attempts" | The per-address sign-in limit (`RATE_LIMIT_LOGIN_PER_MINUTE`); wait a minute |
| After changing a library in `packages/`, the browser still runs the old code | Restart `npm start` (it rebuilds the packages). The dev server no longer pre-bundles `@srisaa/*`, so a stale `frontend/.angular/cache` cannot serve old code; delete it if in doubt. |
| `npm install` fails with `Cannot read properties of null (reading 'edgesOut')` | Run npm from the repository root. `.npmrc` sets `legacy-peer-deps=true`. |
