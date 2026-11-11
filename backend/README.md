# @srisaa/noc-api — Fire NOC Portal backend

Fastify 5 · TypeScript (strict, ESM) · Drizzle ORM · PostgreSQL 16.

Phases **B1**, **B2** and **B3** are implemented:

- **B1:** platform, the complete database model, the seed, the rules engine wiring, the
  reference-data cache, authentication and every read.
- **B2:** the citizen lifecycle on the server (create, save with optimistic locking,
  streaming uploads, payment with the frozen fee, submission through the workflow engine,
  revise, carry forward, rating), the password policy, reset links and the notification
  outbox.
- **B3:** department processing through the workflow engine (`allowed_actions`, every task
  action, the decision with the signed copy), the department queues, administration
  (accounts, officers and hand-over, statuses, audit, application search and delete),
  configuration (rule-set and workflow versions, SLA), the ten reports in SQL with CSV,
  escalations and the job scheduler, and the hardening: authorization matrix, portal ↔ API
  contract test, rate limits, backup / restore, a 300 000-application load test with the
  resulting indexes and queries, OpenAPI at `/docs`, lint, multi-process mode (`API_WORKERS`).

- Design: [`../docs/backend/`](../docs/backend/00-README.md)
- What exists and how it was tested: [`B1-delivery-notes.md`](../docs/backend/B1-delivery-notes.md),
  [`B2-delivery-notes.md`](../docs/backend/B2-delivery-notes.md),
  [`B3-delivery-notes.md`](../docs/backend/B3-delivery-notes.md)
- Set-up, run and credentials: [`RUNBOOK.md`](../docs/backend/RUNBOOK.md); the API: `http://127.0.0.1:3000/docs`

## Layout

```
src/
  config/env.ts          zod-validated configuration (the only reader of process.env)
  plugins/               request id + problem+json errors, context (db/cache/rules), auth, OpenAPI
  db/
    schema/*.ts          the Drizzle model (79 tables)
    migrations/          0000_initial (generated) · 0001_platform (triggers, views) · 0002_b3 · 0003_performance
    seed/                seed inputs, master seed (idempotent) and demo seed
  cache/                 bundle builders + the LISTEN/NOTIFY-driven ReferenceCache
  engines/rules.ts       @srisaa/rules-engine wired to the cache (no DB hit per calculation)
  engines/workflow.ts    @srisaa/workflow-engine: definitions, assignee resolver, wf_* persistence
  repositories/          the only importers of Drizzle (reads + the aggregate writer)
  services/              auth, application reads, citizen lifecycle, documents, department (processing,
                         queues), admin, configuration, reports, escalations
  jobs/                  outbox dispatcher (log driver, SKIP LOCKED), scheduler (escalations, file purge,
                         token clean-up; advisory lock), maintenance
  routes/                auth · reference · applications · files · dept · reports · admin · config · ops
  serializers/           rows → the portal's wire shapes (local ids, legacy dates)
  storage/               StorageProvider port + filesystem driver (S3-compliant design)
scripts/
  pg/                    init-cluster · start · stop · status · create-databases
  db/                    migrate · seed · reset · backup · restore · generate-load · perf-probe
  jobs/run.ts            run a background job by hand
  openapi.ts             write docs/backend/openapi.json
  dev/reset-demo.ts      guarded, development-only demo reset
  test/prepare-test-db.ts
tests/                   unit · integration (incl. authorization matrix, contract, rate limits) · parity
```

## Commands

See `package.json`; the common ones are `npm run dev`, `db:setup`, `db:seed`, `db:reset`,
`db:backup`, `db:restore`, `jobs:run`, `test`, `test:int`, `lint`, `dev:reset-demo`,
`db:load-test-data`, `perf:probe`, `openapi`.
