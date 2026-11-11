# 8. Test Plan, Test Scripts and Run Commands — Revision 2

> The suites are written in the phases they belong to. The **commands** below are final.

## 8.1 Levels

```
 L6  Playwright E2E (browser + API + PostgreSQL + storage)     e2e/
 L5  API smoke journey                                           scripts/smoke.sh
 L4  API journeys (multi-actor, real files)                      backend/tests/e2e
 L3  API contract + authorisation (app.inject)                   backend/tests/integration/routes
 L2  repository / DB integration (real PostgreSQL)               backend/tests/integration/db
 L1  unit: engines, domain, services, frontend units             packages/*/tests, backend/tests/unit, frontend *.spec
 L0  static: tsc, eslint (layering), drizzle-kit check, OpenAPI ↔ frontend type check
 ── PARITY (cross-cutting): API == fixtures; SQL reports == oracle functions; server assess == client assess
```

## 8.2 Commands

| Command | Runs |
|---|---|
| `npm test` | every unit + integration + parity suite in every workspace (no browser) |
| `npm -w packages/rules-engine test` | L1 rules engine (+ `test:cov`) |
| `npm -w packages/workflow-engine test` | L1 workflow engine incl. property tests |
| `npm -w packages/domain test` | L1 NOC domain (the moved frontend specs) |
| `npm -w packages/rules-engine run rules:test -- ../../backend/seed/data/rule-tests` | rule test-case files |
| `npm -w backend run test:unit` | L1 backend, no DB |
| `npm -w backend run test:int` | prepare `noc_test` → L2 + L3 |
| `npm -w backend run test:e2e` | prepare template DB → L4 |
| `npm -w backend run test:parity` | parity suites |
| `npm -w frontend test` | Angular unit/component (Vitest) |
| `npm run test:e2e` | **Playwright**: spins up API (scratch DB `noc_e2e`, temp storage root) + `ng serve`, runs `e2e/specs/**` on Chromium |
| `npm -w e2e run test:headed` / `report` | debugging |
| `npm run smoke` | L5 |
| `npm run ci` | `lint → typecheck → db:check → npm test → test:e2e → build` |

Test database isolation:
- L2/L3 run each test inside `BEGIN … ROLLBACK` on `noc_test`.
- L4 uses per-worker databases cloned from a seeded template.
- L5 uses `noc_smoke`.
- L6 uses `noc_e2e`, re-seeded before each spec file via the **test-only** reseed helper.
  That helper is the same code as `dev:reset-demo`, minus the interactive guard, and only
  runs against a database whose name ends in `_e2e`.
- Suites that need PostgreSQL self-skip with a message when no cluster is running.

Coverage gates:

| Area | Lines | Branches |
|---|---|---|
| rules-engine | 95 % | 90 % |
| workflow-engine | 95 % | 90 % |
| domain | 95 % | 90 % |
| backend services | 90 % | 85 % |
| backend repositories | 85 % | 75 % |
| frontend core/api + cache | 90 % | 85 % |

## 8.3 L1 — Rules engine (`@noc/rules-engine`)

| Group | Cases |
|---|---|
| Decision tree | every operator (`EQ, DEF, GT, GE, LT, LE, BR, BL`) × `n`/`s` dtypes; goto chains; return values; missing variable; `DEF` on undefined; max depth; cycle detection; unknown node → validation problem |
| Legacy conformance | all 16 legacy trees evaluated over the fact tables taken from today's `rule-engine.spec`/`ffe.spec` + a generated grid (site type × height × area × floor type) → **identical** to the current evaluator (golden file produced from the frontend code before the move) |
| Decision table | each operator; FIRST / PRIORITY / COLLECT; aggregation MAX_RANK / MIN / MAX / SUM / LIST; default when no hit; type mismatch → problem; overlap/gap warnings |
| NOC tables | approval level: the 7 legacy rules incl. multiplex-only and `min_inclusive` edges (10 / 15 / 18 m), highest across blocks; renewal: 4 rules, shortest across blocks |
| Parameters | schema validation; missing key; negative rate refused |
| Versioning | published immutability; `effective_from` resolution; `versionsUsed()` |
| Trace | trace lists nodes/rows in order; trace off = no allocation |
| Safety | a 10 000-node tree evaluates < 5 ms; no prototype-pollution via fact names (`__proto__`) |
| Property tests | table with FIRST = first matching row of a brute-force scan; evaluation is pure (same input → same output, no mutation of facts) |

## 8.4 L1 — Workflow engine (`@noc/workflow-engine`)

| Group | Cases |
|---|---|
| Definition validation | every generic rule + host-validator plumbing; the 12 seeded NOC definitions valid; each NOC rule (status categories, non-decreasing `sort_order`, pre-decision status, required outcomes) |
| Commands | `start`, `saveDraft`, `complete`, `sendBack`, `skip`, `reassign` (+asAdmin), `decide` (terminal / activates on-demand), `reresolveAssignees`, `handover`, `archive` — happy path + every precondition error code & message |
| Parallel stages | stage completes only when all mandatory tasks done/skipped; optional tasks left open become `not_required`; bypass-in-advance cascade |
| Send back | only previous stage with done tasks; new active rows with carried data; siblings reset; effects restored |
| SLA | `due_at` on activation (calendar days, Asia/Kolkata); class SLA for inspection forms; total SLA → `return` removed from allowed outcomes |
| Queries | `allowedActions` for assignee / decider / other / admin on every state; `pendingWith`; `activeStage`; `previousStage` |
| Escalations | overdue by step / class / total; reminder interval suppression; recipients per settings |
| Events | every command emits the documented events in order; replay from `wf_events` rebuilds state |
| **Model-based property tests** | `fast-check` generates random command sequences (10 000 runs) against random valid definitions; asserts the six invariants of `45-engines.md` §45.3 after every step |
| Store adapter (Drizzle) | optimistic `lock_version` conflict; partial unique index (one live instance) |

## 8.5 L1 — Domain, backend services, frontend units

- **Domain:** the moved frontend specs (commonrules 29 functions, FFE, fees incl. penalty
  years, validation messages, certificate, task forms, dates), now over the rules engine.
- **Backend services (with repository doubles):** assessment overwrite of derived fields;
  fee freezing and coverage check (N-3); numbering with 5 digits and month rollover;
  aggregate diff-upsert; serialisers (local ids, dates, no `password`, citizen view hides
  officers' notes); authorisation decisions; upload validator; error mapping; download
  tokens (single use, expiry).
- **Frontend units (Vitest):** `HttpApiClient` (param substitution, `ApiError`);
  `authInterceptor` (single-flight refresh under 5 concurrent 401s, replay, logout on refresh
  failure); `dataVersionInterceptor`; `ReferenceDataStore` with `fake-indexeddb` (warm start,
  stale detection, portal-relevant bundles only, logout purge, schema mismatch, broadcast);
  the wizard store replacing local derived values with the server assessment; every feature
  service against `HttpTestingController`.

## 8.6 L2 — Database integration

| Group | Cases |
|---|---|
| Migrations | empty → head; idempotent re-run; `information_schema` == schema modules; every table's PK is `id integer` (except `files.id uuid`) — an explicit test that enforces R2-2 |
| Seed | idempotent (identical counts twice); the `4Q` → 199 correction applied to the station and the officer's stations; identity sequences advanced past the seeded ids |
| Constraints & triggers | one live workflow instance; unique numbers; system statuses protected / single pre-decision; immutable published versions, revisions, events; cascades; restricts |
| **Cache triggers** | a direct SQL update on each bundle's source tables bumps exactly that bundle; NOTIFY received after commit only; rollback bumps nothing |
| Aggregate round-trip | load → serialise → save → reload byte-identical for all 14 seeds |
| Concurrency | concurrent saves → one 409; concurrent submits → distinct numbers; two transitions on one application serialise (FOR UPDATE) |
| Views | `v_application_summary` == `toSummary()`; `v_current_tasks` latest row after a send-back |
| Officer resolution | role + station, active only, lowest id, `all_stations` |
| Storage contract suite | against `FilesystemStorage` (put/get, checksum, atomic visibility, no overwrite, delete, head, 5 MB constant memory, unicode names not in keys); storage root outside served paths |

## 8.7 L3 — API contract & authorisation

For **every route**: 200 with response-schema assertion; 401 without a token; 403 for each
wrong portal/role; 404 for foreign ids; 422 for each documented rule with the **exact
message**; `X-Data-Versions` header present.

| Area | Highlights |
|---|---|
| Auth | login ok/bad/deactivated (exact text)/locked; refresh rotation & reuse revocation; forced password change blocks other routes; register; forgot always 202 |
| Caching | `/meta/versions`; immutable bundle headers; stale version → 302; ETag → 304; br/gzip/identity decode equal; private bundles need dept/admin; second app instance reloads on NOTIFY (two `buildApp()` in one test) |
| Rules | draft → validate → publish; published immutable; evaluate with trace; façades round-trip `DelegationRule[]` / `RenewalRule[]` / `FeeConfig` losslessly |
| Applications | scopes; filters; pagination; save returns server `assessment` and **ignores client-sent fee/level/`reqt`/status**; 409 on stale `If-Match`; carry-forward rules; revisions listed |
| Payment & submit | fee frozen with rule version; rate change after payment does not change the frozen fee; area increase after payment → N-3 behaviour; submit errors[] grouping; number format; workflow started; `submitted` snapshot |
| Files | magic-byte rejection; 413; replace by code; download token one-time & expiring; authz on token issue |
| Dept | `allowed-actions` per role/state; only assignee acts; only decider skips/reassigns; send back previous only; decide without signed copy → 422; `return` after total SLA → 422; reassign wrong role → 422; fire-station change only before any action |
| Admin | non-admin → 403 everywhere; workflow validation messages; version bump; in-process instance keeps its version; statuses: system rows rejected (N-4); hand-over; unassigned tasks list |
| Reports | 10 shapes; filters incl. status category; CSV header & streaming |
| Escalations | preview; send; interval suppression; idempotency key |
| Removed | `POST /admin/demo/reset` → 404 (must not exist) |

## 8.8 L4 — API journeys (real files)

1. P · Head Office end-to-end (section ∥ inspection ∥ committee → RFO → ADFS → DFS-CD → DFS → DG approves with signed copy → certificate facts → rating).
2. Return → revise (instance archived, `archived` snapshot, revision 2) → resubmit → new instance, cycle 2.
3. Send back DFS → DFS-CD; statuses/labels restored.
4. Bypass and reassign by the decider; others 403.
5. District workflow (9 m building → DFO level).
6. P → O (carry-forward) → R; validity from the renewal table.
7. Declaration with an ordered inspection (on-demand stage).
8. Document request → citizen upload → officer sees `U`.
9. Officer deactivation with open tasks → 409 → hand-over → deactivation.
10. Admin publishes a new fee + approval rule: new draft uses them, in-process file unaffected, paid fee frozen.
11. Escalation with a frozen clock: notices, no repeat inside interval.
12. Unassigned task (no officer at station) → flagged and escalated (Q-59).

## 8.9 L6 — Playwright E2E (browser)

Setup: `e2e/playwright.config.ts` → `webServer` entries start the API (`NODE_ENV=test`,
`noc_e2e`, temp `FS_STORAGE_ROOT`) and `ng serve`; Chromium from
`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`; `@playwright/test` pinned to 1.56.x;
storage-state fixtures per demo user; traces/videos on failure.

| Spec | Automates |
|---|---|
| `auth.spec` | login per portal, deactivated refusal, register (temp password), forgot, forced change, change password, logout, session survives reload (refresh cookie) |
| `phase1-*.spec` | `docs/phase-1-manual-test-script.md` (dashboards, dept queues, search, admin accounts & application search/delete) |
| `phase2-*.spec` | `docs/phase-2-manual-test-script.md` (all four application types: save rules, free navigation, block flow, FFE grid, **real PDF upload**, payment, grouped problems dialog, confirmation, acknowledgement, revise, carry-forward, print views, rating) |
| `phase3-*.spec` | `docs/phase-3-manual-test-script.md` A–G (workflow admin, SLA, processing page forms, send back / bypass / reassign, documents & SMS, final decision with live preview + signed copy, reports + CSV, escalations) |
| `journey.spec` | citizen → 7 officers → citizen in one run (multi-context) |
| `cache.spec` | (a) returning user: **zero** reference-data requests (network listener); (b) admin publishes fee in context A → citizen in context B sees the new fee after the next save; (c) two tabs share one bundle fetch |
| `files.spec` | uploaded file downloadable via token; direct guess of a storage path through the web server → 404 |
| `resilience.spec` | API restart mid-session (session recovers via refresh); offline banner with cached reference data |
| `a11y-smoke.spec` | key pages at mobile width without horizontal scroll (existing checklist item 11) |

## 8.10 Parity suites

| Check | Oracle |
|---|---|
| `GET /applications/:id` × 14, every lookup/config route | fixture JSON (+ enumerated allow-list: no `password`, integer ids, `4Q` → 199, `row_version`, file ids) |
| Assessment (FFE, open spaces, level, renewal, fee) per seed + random inputs | pre-move frontend domain code (golden files) and the client bundle evaluation |
| 10 reports | the former `reports.ts` functions, kept in `backend/tests/oracles` |
| Escalations | the former `escalations.ts` |
| Error messages | table of `(route, scenario) → exact string` from today's `assert()` calls |

## 8.11 Non-functional (synthetic 300 000 applications ≈ 3 years at 100 k/yr, 100 virtual users)

| Check | Budget (p95) |
|---|---|
| `GET /bundles/*` (memory, br) | < 20 ms |
| `GET /applications?scope=dept` (page 25) | < 150 ms |
| `GET /applications/:id` (10 blocks) | < 120 ms |
| `PUT /applications/:id` incl. server assessment | < 300 ms |
| `POST …/submit` | < 500 ms |
| Workflow transition | < 200 ms |
| Each report | < 1.5 s |
| 5 MB upload | constant memory, < 1 s local |
| 100 VU mixed workload for 10 min | error rate 0, pool never exhausted |

Tools: `autocannon` scenarios, `scripts/db/generate-load.ts --applications 300000`,
committed `EXPLAIN (ANALYZE)` baselines for the 15 hottest queries re-checked in CI.

## 8.12 Script tests

- `dev:reset-demo`: refuses when `NODE_ENV≠development`, `ALLOW_DEMO_RESET≠true`, remote host,
  protected DB name, non-TTY without both flags; when allowed: backup file created, counts
  restored to seed, refresh tokens revoked, all cache versions bumped.
- `db:setup` idempotent on an existing cluster; `db:status` reports a stopped cluster.

## 8.13 `scripts/smoke.sh` (L5)

Start cluster → `noc_smoke` → migrate → seed → API on a free port with a temp storage root
→ `/ready` → citizen login → create/save/upload/pay → submit (expect 422, then fix) → submit
(expect 11-digit number, status 2) → officer `/dept/tasks` → complete every task → decide
with signed copy → citizen sees status 7 + certificate facts → download via token → tear
down → PASS/FAIL, exit code.
