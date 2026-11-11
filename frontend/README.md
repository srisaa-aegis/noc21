# NOC Portal — Angular Frontend

This is the new Angular rewrite of the legacy AngularJS "Fire NOC Portal"
(see `../NOC-base` for the original app and `../docs` for the full
migration plan). Since backend phase B3 it runs **entirely on the NOC backend**
(`../backend`: Fastify + PostgreSQL): every read and every write goes through the
REST catalogue `src/app/core/api/api-endpoints.ts`. The earlier fixture-only mode
(JSON under `public/assets/data`, writes simulated in `localStorage`) was removed;
the JSON moved to the backend's seed.

👉 Start with [`../docs/README.md`](../docs/README.md) for the functional scope, and
[`../docs/backend/RUNBOOK.md`](../docs/backend/RUNBOOK.md) to set up and run the
portal with its backend.

## Requirements

- Node.js. The Angular CLI pinned here (`21.2.24`) needs **Node ^20.19 /
  ^22.12 / >=24**. (Angular's very latest `22.x` line requires Node
  `22.22.3+`; if your Node is older than that but still ≥ 22.12, this
  project's pinned `21.x` toolchain is what lets `npm install` succeed —
  see `docs/04-migration-plan.md` → "Toolchain note".)

## Getting started

From the repository root (the portal needs the API):

```bash
npm run setup      # once: installs, PostgreSQL, migrations, seed
npm start          # PostgreSQL + API (:3000) + this app (:4200, proxies /api to :3000)
```

Or, with the API already running: `npm start` in this folder (`ng serve --proxy-config proxy.conf.json`).

Log in with any of the seeded demo accounts shown as chips on the login
screen (all use password `demo`):

| Username | Portal | Notes |
|---|---|---|
| `citizen1` | Citizen | Mix of draft / submitted / approved / returned / rejected applications of every type |
| `citizen2`, `citizen3` | Citizen | Other citizens (their applications are not visible to citizen1) |
| `sai.constructions` | Citizen | **Deactivated** — login is refused |
| `dg.officer`, `dfs.officer`, `dfscd.officer`, `adfs.officer`, `section.hq` | Department (Head Office, all fire stations) | DG, DFS, DFS-CD, ADFS, Section — Head Office workflow tasks |
| `rfo.officer`, `rfo.southern` | Department | RFO Eastern (districts 1–6) / Southern (7–13) |
| `dfo.visakhapatnam`, `dfo.officer` (Krishna), `dfo.guntur`, `dfo.srikakulam` | Department | DFOs of their district's fire stations |
| `sfo.officer`, `sfo.krishna`, `sfo.guntur`, `sfo.srikakulam` | Department | SFOs of their fire station(s) |
| `monitor.hq` | Department | Monitoring (read-only): every file and the reports |
| `retired.officer` | Department | **Deactivated** |
| `admin` | Admin | Accounts (incl. officers' fire stations), application search & delete, **Rules & Fees**, **Workflows**, **SLA**, **Statuses**, escalations, **Audit** |

The officers of an application are the officers of each role associated with the fire station of the
property.

## Scripts

```bash
npm start          # dev server (proxies /api to the API on :3000)
npm run build      # production build -> dist/noc-portal
npm test           # unit / component tests (Vitest, via `ng test`) against FakeApi
npm run lint       # ESLint (angular-eslint), including an architecture rule
                   # that forbids importing HttpClient outside core/api/**
npm run typecheck  # the app and the specs
npm run fixtures:index   # regenerate src/testing/fixture-index.ts from ../backend/seed/data
npx tsx scripts/generate-api-doc.ts   # print the API traceability matrix (docs/03)
```

## Project layout

```
src/app/core/api/            api-endpoints.ts (the REST catalogue) · ApiClient · HttpBackend · CitizenApi ·
                             interceptors (bearer, silent refresh, data versions) · ReferenceDataStore (bundles
                             cached in IndexedDB) · bundle-keys.ts
src/app/core/auth/           AuthService (sign-in, refresh, register, reset) + route guards
src/app/core/accounts/       Admin account management (AccountsService)
src/app/core/domain/         Re-exports of @srisaa/noc-domain (the same rules the server runs) + UI helpers
src/app/core/lookups/        Reference data and configuration from the cached bundles
src/app/core/models/         Re-exports of the domain model
src/app/layout/              Per-portal chrome (auth/citizen/dept/admin shells)
src/app/features/            Routed feature screens, grouped by portal
src/app/shared/              UI kit, FFE grid, application sheet, workflow stepper, charts, certificates, file links
src/styles/                  Design tokens + shared SCSS (buttons, forms, layout)
src/testing/                 FakeApi (the backend's routes answered from the seed data), session helpers,
                             the fixture index (not in the app build)
scripts/                     Fixture index generator, API doc generator (tsx)
```

See [`../docs/05-architecture.md`](../docs/05-architecture.md) for the
full rationale.

## The API catalogue (the only file that knows a URL)

Every operation the portal performs is an entry of
[`src/app/core/api/api-endpoints.ts`](src/app/core/api/api-endpoints.ts):
`{ id, method, path, legacy, description }`. Feature services call
`ApiClient.get / request / upload / download` with an entry — nothing else may import
`HttpClient` (enforced by `eslint.config.js`). The backend's contract test checks that it
serves every entry; `src/app/core/api/services.contract.spec.ts` checks what each feature
service sends. See [`../docs/03-api-catalog.md`](../docs/03-api-catalog.md).

Reference data, rules and configuration are not fetched entry by entry: they come in
versioned **bundles** cached in IndexedDB and refreshed when any API response says a version
moved (`docs/backend/55-caching.md`).

## Tests

The component and service specs run against **`FakeApi`** (`src/testing/fake-api.ts`): an HTTP
interceptor that answers the backend's routes with route-shaped data built from the seed
(`../backend/seed/data`), records every request, and can be overridden per test
(`api.on(...)`, `api.fail(...)`). Transactions, permissions and calculations are tested against
the real backend (`../backend/tests`) and in the browser (`../e2e/smoke.mjs`).

## What's implemented

See [`../docs/04-migration-plan.md`](../docs/04-migration-plan.md) and
[`../docs/backend/B3-delivery-notes.md`](../docs/backend/B3-delivery-notes.md).

- ✅ **Phase 1** — shell, design system, routing, auth & guards, citizen dashboard, department
  queues & search, admin workbench, account management (CR-1 … CR-3).
- ✅ **Phase 2** — the citizen application lifecycle for Provisional, Occupancy, Renewal and
  Declaration (legacy Save vs Submit, block-wise flow, FFE from the rule trees, documents, payment,
  revise, carry forward, legal formats of the NOCs and letters, rating), Admin Rules & Fees.
- ✅ **Phase 3** — configurable department workflows and SLAs, the processing page (note / report
  forms, send back, bypass, reassign, document requests, SMS, fire station, licensing authority,
  final decision with the signed copy and a live preview), dashboards, the ten reports, escalations.
- ✅ **Backend B1–B3** — all of the above on the server: the server computes, validates and
  transitions; the portal shows what it returns (`allowed_actions` decides the buttons of the
  processing page). Added in B3: the "challan verified" tick, the registration link, the statuses and
  audit pages.

## Browser suite

`npm run test:e2e` (from the repository root, with `npm start` running) drives the portal in
Chromium against the backend: all three portals, registration, the citizen journey, the
department processing through to the decision, reports, statuses, audit and escalations.
