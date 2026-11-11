# NOC Portal — Backend Engine: Design & Delivery Plan

> **Status: Revision 2 design. Phases B1, B2 and B3 delivered — the portal runs entirely on the backend.**
> **B1** covers the platform, database, rules engine, caching, identity, all reads and the Angular
> integration. **B2** covers the generic workflow engine, the whole citizen lifecycle on the server
> (create, save, upload, pay, submit, revise, carry forward, rate), the password policy,
> reset links and forced password change. **B3** covers department processing, administration and
> configuration, the ten reports and the escalations on the server, the jobs, the removal of the
> mock layer, and the hardening (authorization matrix, rate limits, backup / restore, a
> 300 000-application load test, OpenAPI, lint).
> See [`B1-delivery-notes.md`](./B1-delivery-notes.md), [`B2-delivery-notes.md`](./B2-delivery-notes.md),
> [`B3-delivery-notes.md`](./B3-delivery-notes.md) and **[`RUNBOOK.md`](./RUNBOOK.md)** (setup, run, credentials, tests).

## Read in this order

| # | Document | What it answers |
|---|---|---|
| 1 | [`10-techstack.md`](./10-techstack.md) | The stack and ORM, with what was verified in this sandbox (Prisma unusable here, Drizzle and Playwright usable). |
| 2 | [`20-environment-and-runbook.md`](./20-environment-and-runbook.md) | Starting PostgreSQL in the sandbox, creating/migrating/seeding the database, every npm task, and the dev-only demo-reset script. |
| 3 | [`30-frontend-api-requirements.md`](./30-frontend-api-requirements.md) | What the Angular app needs, screen by screen and field by field. |
| 4 | [`40-data-model.md`](./40-data-model.md) | The database: integer `id` keys everywhere, the aggregate, revisions, statuses, engine tables, sizing for 100 000 applications/year. |
| 5 | [`45-engines.md`](./45-engines.md) | **The Rules Engine and the Workflow Engine as independent, reusable libraries**, and how the NOC application binds to them. |
| 6 | [`50-api-design.md`](./50-api-design.md) | The REST contract. |
| 7 | [`55-caching.md`](./55-caching.md) | **The caching strategy** for lookups, master data, rules and configuration, across PostgreSQL, the API and the browser. |
| 8 | [`60-architecture.md`](./60-architecture.md) | Layering, storage (S3-compliant design, filesystem driver), jobs, security, observability. |
| 9 | [`65-frontend-integration.md`](./65-frontend-integration.md) | **Frontend ↔ backend integration (in scope)**: what changes in the Angular app, service by service. |
| 10 | [`70-delivery-plan.md`](./70-delivery-plan.md) | The 3-phase plan, now including the engines and the frontend integration. |
| 11 | [`80-test-plan.md`](./80-test-plan.md) | Test levels, suites, cases, Playwright E2E, and the run commands. |
| 12 | [`90-open-questions.md`](./90-open-questions.md) | Your answers as recorded decisions, and the remaining follow-up questions (§9.5: raised by B3). |

Delivered phases: [`B1-delivery-notes.md`](./B1-delivery-notes.md) ·
[`B2-delivery-notes.md`](./B2-delivery-notes.md) · [`B3-delivery-notes.md`](./B3-delivery-notes.md)
(performance report: [`B3-performance-probe.md`](./B3-performance-probe.md)) · runbook:
[`RUNBOOK.md`](./RUNBOOK.md) · API: [`openapi.json`](./openapi.json) (served at `/docs`).

Appendix: [`A1-legacy-traceability.md`](./A1-legacy-traceability.md).

## Summary

A **Node 22 / TypeScript 5.9 Fastify 5 service** with **Drizzle ORM** over **PostgreSQL 16**,
in an npm-workspaces monorepo with three libraries:

- **`@noc/rules-engine`** — a generic, versioned rules engine (decision trees in the legacy
  `.rule` format, decision tables, parameter sets, explain traces). No NOC knowledge.
- **`@noc/workflow-engine`** — a generic, versioned workflow engine (sequential stages of
  parallel tasks, a final decision, send back, bypass, reassign, on-demand stages, SLA due
  dates, events), with storage, assignment, clock and permissions as pluggable ports.
  No NOC knowledge.
- **`@noc/domain`** — the NOC-specific rules (NBC `commonrules`, FFE grid, fees, approval
  level, renewal period, validation, certificate facts) expressed on top of the rules engine,
  and the NOC bindings of the workflow engine.

**The server is the source of truth**: every rule-based calculation is done by the backend
on save and submit and its result replaces the browser's; **every workflow transition runs
only in the backend**. The browser keeps its live calculations for instant feedback, using the
same library code.

All data is in PostgreSQL, every table keyed by an integer `id` (uploaded files use UUIDs).
Uploaded binaries live in a filesystem storage root **outside the web root** behind a
`StorageProvider` port designed to be S3-compliant; the S3 driver itself is not built now.

Reference data, rules and configuration are served as **versioned bundles**: invalidated in
PostgreSQL by triggers and `LISTEN/NOTIFY`, held pre-serialised and pre-compressed in the API,
served with immutable URLs and ETags, and kept by the browser in IndexedDB until a version
change is signalled on any API response.

The **Angular app is integrated** with the backend phase by phase, and the mock persistence
layer is deleted at the end of Phase 3. Browser E2E uses Playwright with the Chromium already
installed in this sandbox.

## Revision 2 — what changed from Revision 1

| # | Change | Where |
|---|---|---|
| R2-1 | **S3 driver dropped from scope.** The storage port, key scheme and metadata stay S3-compliant, and a storage contract test suite is specified for a future driver. | 10, 20, 60, 70 |
| R2-2 | **Every table has `id integer` as its primary key** (identity column), including fire stations, roles, statuses, application types and junction tables. Natural codes become unique columns. Uploaded files keep UUIDs. The fire station `"4Q"` is treated as a data error and corrected in the seed. | 40 |
| R2-3 | **Caching strategy** for lookups, master data, rules and configuration. | 55 (new), 50, 65 |
| R2-4 | **Rules Engine and Workflow Engine are independent libraries.** All rule calculations and all workflow transitions happen in the backend. | 45 (new), 40, 50, 60 |
| R2-5 | **Frontend integration is in scope.** | 65 (new), 70, 80 |
| R2-6 | No legacy database and no legacy uploads import (Q-6). | 20, 60, A1 |
| R2-7 | Sizing raised to **100 000 applications/year, 100 concurrent users**. The FFE grid moves to JSONB per equipment item, file keys are sharded, and the 4-digit application number is flagged as an overflow risk. | 40, 60, 90 |
| R2-8 | **Application revisions are retained as immutable snapshots** (Q-39). | 40 |
| R2-9 | **Fee frozen at payment** (Q-57). | 40, 45, 50 |
| R2-10 | **Statuses 1, 2, 7, 8 and 9 are fixed system statuses**; 3–6 are configurable in-process statuses. No code hard-codes 3–6. | 40, 45 |
| R2-11 | **Demo reset removed from the API and the Admin UI.** It is now a guarded command-line script for development only. | 20, 50, 65 |
