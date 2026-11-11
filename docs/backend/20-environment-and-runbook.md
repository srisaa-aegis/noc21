# 2. Environment, Database Bootstrap and the npm Task Catalogue

> This is the design of the environment. The commands **as built and tested** (phase B3) are in
> [`RUNBOOK.md`](./RUNBOOK.md).

Everything in §2.1 was verified on this sandbox.

## 2.1 Sandbox facts

| Fact | Value | Consequence |
|---|---|---|
| OS / user | Ubuntu 24.04, user `model`, no root/sudo | No `service postgresql`; we run our **own cluster** |
| PostgreSQL | 16.15, `initdb`/`pg_ctl`/`postgres`/`psql` on PATH | — |
| Cluster | none initialised, `PGDATA` unset | `initdb` once into the project |
| Port 5432 | free | default, configurable via `PGPORT` |
| Node / npm | 22.21.0 / 10.9.4 | matches Angular 21 |
| Network | npm registry only | no post-install downloads (ADR-001) |
| Chromium | `/opt/pw-browsers/chromium-1194` (Playwright 1.56 line) | browser E2E possible (ADR-007) |

Verified bootstrap (automated by the npm tasks below):

```bash
initdb -D "$PGDATA" -U "$PGSUPERUSER" -E UTF8 --locale=C.UTF-8 --auth-local=trust --auth-host=trust
pg_ctl -D "$PGDATA" -l var/log/postgres.log -o "-p $PGPORT -k $PGSOCKET -c listen_addresses=127.0.0.1" start
psql -h 127.0.0.1 -p $PGPORT -U $PGSUPERUSER -d postgres -c "CREATE ROLE noc LOGIN PASSWORD '…'"
psql … -c "CREATE DATABASE noc OWNER noc"   ;   psql … -c "CREATE DATABASE noc_test OWNER noc"
pg_ctl -D "$PGDATA" -m fast stop
```

Layout (all git-ignored):

```
noc/.pgdata/            cluster (PGDATA), socket dir .pgdata/run
noc/var/storage/        uploaded files (FS_STORAGE_ROOT) — outside any web root
noc/var/backups/        pg_dump files (taken automatically before a demo reset)
noc/var/log/            postgres.log, api.log
noc/backend/.env        from .env.example
```

## 2.2 Configuration (`backend/.env`, validated with Zod at boot)

| Variable | Dev default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | |
| `HOST` / `PORT` / `API_PREFIX` | `127.0.0.1` / `3000` / `/api/v1` | |
| `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE` | `127.0.0.1`/`5432`/`noc`/`noc`/`noc` | |
| `DATABASE_URL` / `TEST_DATABASE_URL` | derived | Drizzle / tests |
| `PGDATA` / `PGSOCKET` / `PGSUPERUSER` | `../.pgdata` / `../.pgdata/run` / `postgres` | local cluster |
| `DB_POOL_MAX` / `DB_STATEMENT_TIMEOUT_MS` | `20` / `15000` | sized for 100 concurrent users |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | dev literals (boot fails in prod if default) | |
| `ACCESS_TOKEN_TTL` / `REFRESH_TOKEN_TTL` | `15m` / `30d` | |
| `COOKIE_SECURE` / `COOKIE_SAMESITE` | `false` / `lax` | |
| `CORS_ORIGINS` | `http://localhost:4200` | |
| `STORAGE_DRIVER` | `fs` | only `fs` exists; other values reserved |
| `FS_STORAGE_ROOT` | `../var/storage` | **never under a served directory**; boot check refuses a path inside the Angular `dist/` or `public/` |
| `DOWNLOAD_LINK_TTL_SECONDS` | `120` | one-time file download tokens |
| `UPLOAD_MAX_BYTES` / `UPLOAD_MAX_PER_APPLICATION_BYTES` | `5242880` / `104857600` | |
| `UPLOAD_ALLOWED_MIME` | `application/pdf,image/jpeg,image/png` | |
| `API_DATE_FORMAT` | `legacy` | `legacy` \| `iso` |
| `APP_TIMEZONE` | `Asia/Kolkata` | |
| `CACHE_POLL_INTERVAL_MS` | `60000` | fallback poll if a NOTIFY is missed (`55-caching.md`) |
| `SMS_DRIVER` / `MAIL_DRIVER` | `log` | |
| `ENABLE_SCHEDULER` | `false` in dev, `true` in prod | |
| `ENABLE_DOCS` | `true` in dev | Swagger UI |
| `ALLOW_DEMO_RESET` | `false` (set `true` in a developer's own `.env`) | one of the guards of the reset script (§2.4) |
| `SEED_DEMO_PASSWORD` | `demo` | |
| `LOG_LEVEL` | `debug` | |

*Reserved, not implemented (future S3 driver):* `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`,
`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`.

## 2.3 npm task catalogue (specification — nothing created yet)

### Root `package.json` (workspaces: `packages/*`, `backend`, `frontend`, `e2e`)

| Script | Runs | Purpose |
|---|---|---|
| `setup` | `npm install && npm run db:setup && npm run db:seed` | clone → running, seeded DB |
| `db:setup` / `db:start` / `db:stop` / `db:status` / `db:logs` | `npm -w backend run …` | cluster lifecycle |
| `db:seed` / `db:migrate` | `npm -w backend run …` | |
| `dev` | `concurrently` API (:3000) + Angular (:4200, proxied to the API) | day-to-day |
| `dev:api` / `dev:web` | one side only | |
| `dev:reset-demo` | `npm -w backend run dev:reset-demo` | **guarded CLI demo reset (§2.4)** |
| `build` | engines → domain → backend → frontend | |
| `test` | all unit + integration suites of all workspaces | |
| `test:e2e` | `npm -w e2e run test` | Playwright, full stack |
| `lint` / `typecheck` / `ci` | fan-out | |
| `smoke` | `bash scripts/smoke.sh` | API-level journey on a scratch DB |

### `packages/rules-engine`, `packages/workflow-engine`, `packages/domain`

| Script | Runs |
|---|---|
| `build` | `tsc -p tsconfig.build.json` (ESM + `.d.ts`) |
| `test` / `test:cov` | `vitest run` / with coverage thresholds |
| `typecheck` / `lint` | |
| `rules:test` (rules-engine) | `tsx bin/rules-test.ts <dir>` — runs rule test-case files (given facts → expected) |

### `backend/package.json`

| Script | Runs | Notes |
|---|---|---|
| `dev` | `tsx watch --env-file=.env src/main.ts` | |
| `start` | `node --env-file=.env dist/main.js` | |
| `build` / `typecheck` / `lint` | | |
| `db:init` | `tsx scripts/pg/init-cluster.ts` | `initdb` if `$PGDATA` is missing; idempotent |
| `db:start` / `db:stop` / `db:status` | `tsx scripts/pg/{start,stop,status}.ts` | `pg_ctl` + `pg_isready` wait loop |
| `db:create` | `tsx scripts/pg/create-databases.ts` | role `noc`; DBs `noc`, `noc_test`; idempotent |
| `db:setup` | init → start → create → migrate | |
| `db:generate` | `drizzle-kit generate` | new SQL migration from the schema diff |
| `db:migrate` | `tsx scripts/db/migrate.ts` | advisory-locked programmatic migrator; then the data-migration step |
| `db:check` | `drizzle-kit check` | CI drift gate |
| `db:push` | `drizzle-kit push` | dev only; refused in CI/prod |
| `db:studio` | `drizzle-kit studio` | optional |
| `db:seed` | `tsx scripts/db/seed.ts` | idempotent: master + rules + config + demo accounts + demo applications |
| `db:seed:master` | `tsx scripts/db/seed.ts --only=master` | reference data, rules and config only; safe for any environment |
| `db:dump` / `db:restore` | `pg_dump -Fc` / `pg_restore` wrappers → `var/backups/` | |
| `dev:reset-demo` | `tsx scripts/dev/reset-demo.ts` | §2.4 |
| `openapi` | `tsx scripts/openapi.ts` (writes `../docs/backend/openapi.json`) | |
| `test` | `vitest run` | integration suites self-skip with a message if no cluster |
| `test:unit` / `test:int` / `test:parity` / `test:cov` / `test:watch` | see `80-test-plan.md` | |
| `ci` | `lint && typecheck && db:check && test` | |

### `frontend/package.json` (changes)

| Script | Runs |
|---|---|
| `start` | `ng serve --proxy-config proxy.conf.json` (`/api` → `http://127.0.0.1:3000`) |
| `start:mock` | `ng serve --configuration mock` — the fixture mode, kept until the end of Phase 3 and then removed |
| `test` | `ng test` (Vitest) — unchanged command |

### `e2e/package.json`

| Script | Runs |
|---|---|
| `test` | `playwright test` (the config starts the API on a scratch DB plus `ng serve`, or serves a production build) |
| `test:headed` / `test:ui` | debugging |
| `report` | `playwright show-report` |

## 2.4 Demo reset — command line only, development only (Q-67)

There is **no API endpoint and no Admin UI button**. The frontend's "Reset demo data" button
and `MockPersistenceService.resetAll()` are removed during the integration.

`npm run dev:reset-demo` runs `backend/scripts/dev/reset-demo.ts`. It must be run from a shell
**on the host**, which is what "physical access" means here. It refuses to run unless
**all** of these guards pass:

1. `NODE_ENV === 'development'`.
2. `ALLOW_DEMO_RESET=true` in the local `.env`.
3. The database host is local: a unix socket, `localhost` or `127.0.0.1`. Remote hosts are
   always refused.
4. The database name is not on a protected list (for example `noc_prod*`).
5. It runs in an interactive TTY and the operator types the database name to confirm.
   In CI the only bypass is `--yes --i-understand-this-deletes-data`, and the other guards
   still apply.

What it does, in order:

1. `pg_dump -Fc` to `var/backups/pre-reset-<timestamp>.dump`.
2. Truncates all tables except the migration journal, in one transaction.
3. Re-seeds everything.
4. Moves the demo storage objects to `var/backups/storage-<timestamp>/` (not deleted).
5. Revokes every refresh token, so all users log in again.
6. Bumps every cache version and sends `NOTIFY`, so running API processes and open browsers
   refresh their reference data.
7. Prints a summary: row counts per table and the backup paths.

`db:reset` (drop the schema, migrate, seed) stays as a lower-level developer task with the
same guards.

## 2.5 First five minutes

```bash
cp backend/.env.example backend/.env
npm run setup          # install, initdb, start, create, migrate, seed
npm run dev            # API :3000 (/docs), Angular :4200
# log in as citizen1 / demo (or dg.officer, admin, …)
npm run test:e2e       # optional: full browser journey
```

## 2.6 CI and production notes

- CI uses the same `db:init/start/create/migrate` sequence, so Docker is not required.
  Playwright runs against the preinstalled Chromium.
- Production runs only `db:migrate` and `db:seed:master` on deploy. It never runs `db:reset`,
  `dev:reset-demo` or `db:push`.
- Migrations are forward-only, immutable once merged, and applied under an advisory lock.
