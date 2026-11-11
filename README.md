# NOC Portal — AngularJS → Angular Migration

This repository contains:

| Path | What it is |
|---|---|
| [`NOC-base/`](./NOC-base) | The **original** AngularJS (1.x) application — Fire Department NOC portal for citizens/builders, department staff and admins. Kept as-is for reference. |
| [`docs/`](./docs) | The **migration plan**: functional scope, domain model, API catalog, 3-phase delivery plan, architecture, and per-phase manual QA scripts. **Start here.** |
| [`frontend/`](./frontend) | The **new Angular application** (Phases 1, 2 and 3 fully implemented). Since backend phase B3 it runs entirely on the backend: every read and every write goes through the REST catalogue (`src/app/core/api/api-endpoints.ts`). |
| [`packages/`](./packages) | Reusable libraries: **`@srisaa/rules-engine`** (a generic, versioned rules engine), **`@srisaa/workflow-engine`** (a generic, versioned workflow engine) and **`@srisaa/noc-domain`** (the Fire-NOC business rules and workflow bindings, shared by the backend and the browser). |
| [`backend/`](./backend) | The **backend engine**: Fastify + Drizzle ORM + PostgreSQL, with the database model, migrations and seed. Phases B1 (platform, identity, caching, all reads), B2 (the citizen lifecycle) and B3 (department processing, administration, reports, escalations, jobs, hardening) are delivered. |

## Quick start (portal + backend)

```bash
npm run setup          # creates backend/.env, installs, initialises PostgreSQL, migrates and seeds (works as root too)
npm start              # PostgreSQL + migrations + API on :3000 + Angular on :4200
# open http://localhost:4200 and sign in as citizen1 / demo  (or section.hq, dg.officer, admin, …)
# the API is browsable at http://localhost:3000/docs
npm run status         # what is running
npm run stop           # stop the API and web servers
npm test               # every automated test; npm run smoke and npm run test:e2e for the journeys
```

See [`docs/backend/RUNBOOK.md`](docs/backend/RUNBOOK.md) for the full runbook,
credentials and test commands, and [`frontend/README.md`](./frontend/README.md) for the Angular app.

## Why this structure

The brief asked for three things, mapped 1:1 onto this repo:

1. **"Define a scope / functionality and a UI migration plan, in 2-3
   phases, each with a verifiable deliverable."** → [`docs/01-functional-scope.md`](docs/01-functional-scope.md)
   through [`docs/04-migration-plan.md`](docs/04-migration-plan.md).
2. **"Create a shell for the project with an Angular frontend accessing
   JSON files directly but using a list of API points as a separate file
   thru which all the JSONs are accessed."** →
   [`frontend/src/app/core/api/api-endpoints.ts`](frontend/src/app/core/api/api-endpoints.ts)
   is that file; [`docs/03-api-catalog.md`](docs/03-api-catalog.md)
   documents every entry in it and how it maps back to the legacy
   `*.aspx` endpoints. (The JSON files are now the backend's seed: since
   backend phase B3 every entry of that list is a REST route of the backend.)
3. **A working, polished UI**, not just a diagram — Phase 1 (auth,
   dashboards, department queues, admin incl. account management and
   application search & delete), Phase 2 (the complete citizen
   application lifecycle) and Phase 3 (admin-configurable department
   workflows and SLAs, officer fire-station association, the full department
   processing page — note/report forms, final decision with a live NOC/letter
   preview, send back / bypass / reassign, document requests, SMS, fire
   station and licensing authority — department dashboards, reports and
   escalations) are all implemented and verified end to end, citizen through
   department back to citizen — now against the real backend (781 automated
   tests, an API smoke test and a browser suite).
