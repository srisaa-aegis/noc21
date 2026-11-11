# 7. Development Plan — 3 Phases (Revision 2)

Each phase delivers backend **and** frontend integration, and ends with a browser demo
against the real API, verified by Playwright.

| Phase | Theme | Demo at the end |
|---|---|---|
| **B1** | Platform, schema, **rules engine**, caching, identity, all reads + frontend core integration | Log in as any demo user in the Angular app (http mode). Every dashboard, list, detail, lookup and print page is served by PostgreSQL. Reference data loads from the versioned cache. |
| **B2** | **Workflow engine**, server-side assessment, citizen lifecycle, files, payments, revisions + citizen integration | A citizen completes Apply → Save → Upload real PDFs → Pay → Submit in the browser. The server computes FFE, fee and level. The first workflow task appears for the right officer. |
| **B3** | Department transitions, admin configuration, reports, escalations, hardening, **mock removal** | The whole portal runs with no mock layer. All three manual scripts pass as Playwright suites. |

---

## Phase B1 — Foundation, rules engine, caching, identity, reads

### Backend
1. Workspaces root; create `packages/rules-engine`, `packages/domain` (moving code out of
   `frontend/src/app/core/domain` + `core/models`), `packages/workflow-engine` (empty
   skeleton).
2. **`@noc/rules-engine` complete:**
   - decision tree (legacy-compatible), decision table (hit policies + aggregation),
     parameters;
   - compile/validate/trace;
   - `RuleEngine` facade, test-case runner, JSON Schemas.
   - The legacy trees must produce identical results to the current evaluator over the
     existing `rule-engine.spec` / `ffe.spec` cases.
3. `@noc/domain` re-expressed on the engine: FFE, approval level (table), renewal (table),
   fees and escape limits (parameters), `assess()`.
4. Backend scaffold: env, logging, errors, health/ready, OpenAPI/Swagger, layering lint.
5. PostgreSQL tasks (`db:init/start/stop/status/create/setup`).
6. **Complete schema** (about 70 tables, integer ids, triggers, views) → migration `0001` +
   custom SQL migrations for triggers, partial indexes and views.
7. **Seeder:**
   - reference data (with the `4Q` correction);
   - rule sets (trees verbatim, tables and parameters converted from the config JSON);
   - workflows → `wf_definitions/versions`, SLA, forms, bindings;
   - 22 demo accounts;
   - the 14 demo applications, with workflow instances built from their `workflow` runs
     (tasks, events) and `submitted` revisions for the submitted ones.
   - Commands: `db:seed`, `db:seed:master`.
8. **Caching:** `cache_versions` + triggers + NOTIFY, `ReferenceCache` (warm, compiled rules,
   pre-compressed), `/meta/versions`, `/bundles/*`, `/bootstrap`, `X-Data-Versions` header,
   ETag on lookups.
9. **Auth** (login/refresh/logout/me/register/forgot/reset/change, forced change, lockout,
   rate limits) and authorisation guards.
10. **Reads:** all lookups and rule routes, config GET façades, applications (3 scopes,
    detail, assessment, process log, revisions, certificate facts), `/admin/accounts` GET,
    audit.
11. **Files read path:** `StorageProvider` + `FilesystemStorage` + the storage contract suite;
    download tokens.

### Frontend
12. `ApiClient` (http + mock implementations), endpoints → paths, `ApiError`, interceptors
    (auth/refresh, data versions, request id).
13. `AuthService` on the real API, with the access token in memory and cookie refresh at
    boot.
14. **`ReferenceDataStore`** (IndexedDB, bundles, broadcast), with `LookupService`'s internals
    swapped.
15. Read paths of the citizen dashboard/detail/print, dept dashboard/search/detail (read
    only), admin lists; model changes (§65.4).
16. Playwright harness (`e2e/`), with login, dashboards and print views for each portal.

### Acceptance
- `npm run setup` on a clean clone gives a seeded DB in under 5 minutes. `dev:reset-demo`
  works and its guards refuse unsafe use.
- Parity suite green: all 14 applications, all lookups, all config vs the fixtures (modulo
  the documented diffs).
- Rules parity: every FFE, level, renewal and fee result of the seeded applications equals
  the pre-move frontend implementation.
- Cache: a trigger-driven reload is observed; a returning browser makes 0 reference-data
  requests.
- Playwright B1 suite green; frontend unit/component suite green in both `http` and `mock`
  modes.

**Estimate:** 14–16 engineer-days.

---

## Phase B2 — Workflow engine, assessment, citizen lifecycle

### Backend
1. **`@noc/workflow-engine` complete:**
   - definition model, validation (generic + host validators), reducer commands, queries
     (`allowedActions` …), SLA/due dates, calendar;
   - escalations module, events, in-memory testing kit, Drizzle adapter (`wf_*`).
   - Property-based tests of the invariants.
2. NOC binding: event sink (status, label, reviewer, process log, outbox), assignee resolver
   (station association), SLA policy, NOC validators.
3. **Aggregate write path:** create / save (diff-upsert, `If-Match`, **server `assess()`
   overwrites derived fields**, assessment stored) / delete; carry-forward O and R.
4. **Submission:**
   - re-assess;
   - undertakings check;
   - fee coverage against the frozen payment (N-3);
   - atomic number (5-digit, N-2);
   - level;
   - **workflow `start`**;
   - `submitted` revision snapshot;
   - notifications.
   Also: revise (archive the instance + `archived` snapshot).
5. Uploads (multipart streaming, magic-byte checks, replace by code, quotas), requested
   document responses.
6. Payments (online simulation + challan, idempotent, **fee frozen** with its rule version).
7. Certificate facts, feedback, outbox + `log` driver.
8. `POST /assessments`, `POST /rules/sets/:code/evaluate`.

### Frontend
9. `ApplicationsService` and the wizard store on the real API; server assessment replaces
   the client values after every save; real file upload with progress; payment; submit with
   server `errors[]`; revise; carry-forward; requested-document upload; rating.
10. Revision history view on the application detail; 409 handling; forced password change.

### Acceptance
- Playwright: the phase-2 manual script (citizen journeys for P, O-from-P, R-from-O and D).
  Uploaded PDFs exist under `var/storage/applications/<shard>/<id>/…` and are downloadable
  through tokens. No file is reachable through the web server.
- Concurrency: parallel submits get distinct numbers; parallel saves give one `409`.
- Client/server assessment equality for all seeds and for randomised block inputs
  (property test, same rule versions).
- Workflow engine: 95 % coverage, invariants hold over 10 000 random command sequences.

**Estimate:** 16–18 engineer-days.

---

## Phase B3 — Department, admin, reports, escalations, cut-over

### Backend
1. Department transitions through the engine: save, submit (with server-side form
   validation), send back, skip, reassign, decide (SLA-restricted outcomes, signed copy,
   `decided` revision), decision preview, change fire station (`reresolveAssignees`),
   licensing authority, document requests, department uploads, SMS, `allowed-actions`,
   `/dept/tasks`, `/dept/monitoring`, feedback summary.
2. Admin:
   - rule-set drafting and publishing (fees, approval level, renewal) via the façades and the
     generic routes;
   - workflow save/validate/simulate/versions/usage/restore;
   - SLA;
   - statuses (if N-4);
   - accounts and stations;
   - deactivation hand-over;
   - unassigned tasks;
   - application search and delete;
   - audit.
3. Ten reports in SQL + CSV streaming; the old client functions serve as the test oracles.
4. Escalations: preview, send, log, scheduled job; the other jobs (§6.7).
5. Hardening:
   - authorisation matrix;
   - `EXPLAIN` review on a **300 000-application** synthetic dataset (3 years);
   - rate limits;
   - backup/restore scripts;
   - deployment guide.

### Frontend
6. Dept processing page on `allowed_actions`; all task forms post to the API; decision
   preview through the server; reports from the API with server CSV; admin rules, workflows,
   SLA, accounts and escalations on the API; Workbench reset button removed.
7. **Delete** `MockApiClient`, `MockPersistenceService`, the `mock` configuration, and the
   moved/deleted domain files; fixtures kept only for tests and seeds.

### Acceptance
- Playwright: phase-1 and phase-3 manual scripts (sections A–G), plus the multi-actor
  journey. Also covered: send back, bypass, reassign, return + revise, Declaration
  inspection, officer hand-over, an admin fee change reaching an open citizen session (cache
  test), and escalations with a frozen clock.
- Report parity with the oracle functions over the seed and the synthetic dataset.
- Performance budgets of `80-test-plan.md` §8.5 met at 300 k applications.
- `grep` gate: no `localStorage` data access and no `MockPersistence` left in `frontend/src`.

**Estimate:** 18–20 engineer-days.

---

## Totals, team, dependencies

About **48–54 engineer-days**: roughly 5–6 weeks with two engineers (one data/engines, one
API/frontend), or 10–11 weeks with one.

- The B1 schema freeze gates B2/B3.
- The rules engine (B1) gates assessment (B2).
- The workflow engine (B2) gates department work (B3).
- The frontend stream follows the OpenAPI spec published at each phase start.

**Removed from scope in Revision 2:** the S3 driver and related work (R2-1), the legacy
data/uploads import (Q-6), and the demo-reset API and UI (Q-67).

**Definition of done (every PR):** lint, typecheck, `db:check`, unit + integration + parity
green, and the affected Playwright specs green; OpenAPI regenerated; migration reviewed; docs
updated.
