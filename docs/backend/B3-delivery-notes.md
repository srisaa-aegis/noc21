# Phase B3 — Delivery Notes

**Status: delivered and running.** The whole portal now runs on the backend, with **no mock
layer**: a citizen applies, every officer of the workflow processes the file in the department
portal, the issuing authority decides with the signed NOC, the citizen prints the certificate and
rates the service; the administrator manages accounts, officers, rules, workflows, SLA, statuses
and escalations and reads the audit trail; reports are computed on the server. The phase also
delivers the hardening of the plan: authorization matrix, rate limits, backup and restore, a
300 000-application load test with the resulting query work, OpenAPI documentation and lint.

See [`RUNBOOK.md`](./RUNBOOK.md) for setup, running, credentials and tests.
The questions this phase raised are answered; §8 lists what changed with the answers.

---

## 1. Your decisions (B2-1 … B2-15) and how they were applied

| Ref | Decision | Applied as |
|---|---|---|
| B2-1 | Challan accepted at once, verified by the department | The payment is recorded as paid. The **Section Note** (or, in workflows without one, the first task of the first stage) shows a **"Challan verified"** tick with the challan number, date and bank; the server refuses to submit that task until it is ticked (`challanVerificationRequired` in `@srisaa/noc-domain`, enforced in `dept.service.ts`). |
| B2-2 | Keep the PayU simulation | Unchanged (`PAYU…` reference, idempotent). |
| B2-3 | No SMS / e-mail gateway | The `log` driver stays; new templates: registration link, document requested, department message, escalation. |
| B2-4 | Registration sends a "set your password" link | No temporary password any more. The link (purpose `set`, 24 h, single use) is e-mailed; outside production the registration page also shows it. The reset-password page welcomes a new citizen (`&welcome=1`) and the sign-in page confirms the password is set. |
| B2-5 | Citizens: 1 day idle | `CITIZEN_IDLE_TIMEOUT_HOURS=24` (sliding, on refresh). |
| B2-6 | Officers and admins: 12 h absolute | `STAFF_ABSOLUTE_HOURS=12`, in addition to 8 h idle. |
| B2-7 | Reset links 1 h, single use | `RESET_LINK_MINUTES=60`. |
| B2-8 | Production seed forces a password change | `SEED_FORCE_PASSWORD_CHANGE` defaults to true in production (officers and admin), false for the demo. |
| B2-9 | Purge unused files after 30 days | Job `purge-files` (daily 02:00): files of replaced / removed documents and of deleted drafts, 30 days after they stopped being used (`FILE_PURGE_AFTER_DAYS`). |
| B2-10 | 10 MB / 250 MB, PDF only | Server limits, the portal's checks and texts. |
| B2-11 | No malware scanning | Not built. |
| B2-12 | Revision keeps its number | As implemented in B2. |
| B2-13 | No department confirmation of a Declaration's level | Not built. |
| B2-14 | Deployment-independent, focus on the sandbox | A production checklist is in the runbook (§8); no container files. |
| B2-15 | B3 all together | This delivery. |

## 2. What was built

### 2.1 Department processing (server)

Every transition runs in the workflow engine on the server, inside one transaction with the
process log, the audit entry and the notifications; the response is the processing page's view:
the application, **`allowed_actions`** (what this officer may do now) and the parent NOC.

| Endpoint | What it does |
|---|---|
| `GET /dept/applications/:id` | The processing page. `allowed_actions`: per open task of the officer (save, submit, send back, decide, request documents, challan check), the decision outcomes (no "return" once the processing SLA is crossed), skip / reassign (issuing authority) with the candidate officers, upload, SMS, change fire station (Submitted only), licensing authority (final stage). |
| `POST /dept/applications/:id/tasks/:n/save` · `/submit` | The note / report of a task as a draft, or submitted — with **server-side form validation** (the same messages as the portal) and the challan check. |
| `…/send-back` · `/skip` · `/reassign` | Send back to the previous stage with comments; the issuing authority bypasses an officer or changes who a task is assigned to. |
| `…/signed-copy` · `/decision-preview` · `/decide` | Upload the signed NOC / letter (mandatory), the live preview of the document the citizen will receive, and the decision (approve / return / reject / order an inspection). Validity comes from the renewal rule version recorded at submission (N-11); a `decided` revision snapshot is kept (Q-39); the citizen is told by SMS and e-mail. |
| `POST /dept/applications/:id/document-requests` · `/dept-documents` · `/sms` | Request a document from the applicant, upload a department document, send an SMS. |
| `PUT /dept/applications/:id/fire-station` · `/licensing-authority` | Change the fire station (re-resolves every officer) and the licensing authority. |
| `GET /dept/tasks` | **My tasks**, oldest first, filtered on the server (type, level, text), with the counts per task and the number past the SLA; at most `limit` rows (default 200). |
| `GET /dept/monitoring` | The files the officer may follow, paged and filtered on the server, with the stage chips and the KPIs. |
| `GET /dept/feedback-summary` | The citizens' ratings panel. |

### 2.2 Reports and escalations

- The **ten reports** (pendency, statistics, consolidated, applications, overdue, SMS, feedback,
  challan, district-wise, level-wise) are SQL over the database, `GET /dept/reports/:id`, with
  `format=csv` for the export. Their results equal the reference implementations in
  `@srisaa/noc-domain` (100 parity tests over the seed). Long lists are shortened on screen (the 500
  longest-pending files per type, the 5 000 most recent SMS / ratings); the totals and the CSV cover
  everything.
- **Escalations**: `GET /admin/escalations/preview` (everything past its SLA and what is due a
  reminder now), `POST /admin/escalations/send` (one run: notices, reminder marks, one e-mail per
  recipient), `GET /admin/escalations/log`; the daily job sends them at 09:00 IST (N-12).
- **Jobs** (`jobs/scheduler.ts`): escalations, file purge, token clean-up; a transaction-scoped
  advisory lock lets exactly one API process run them; every run is in `job_runs`;
  `npm run jobs:run -- <job|due|list>` runs them by hand.

### 2.3 Administration and configuration

| Area | Endpoints |
|---|---|
| Accounts | `GET /admin/accounts` (server search, paging, citizen profile fields), `POST /admin/accounts/dept` (new officer with a **temporary password**), `PUT …/:id/dept` (role, district, fire stations), `PUT …/:id/profile`, `POST …/:id/password` (set or issue a temporary one), `PUT …/:id/active` (deactivation is refused while the officer has open tasks: 409), `GET …/:id/open-tasks`, `POST …/:id/handover` |
| Tasks nobody could take (Q-59) | `GET /admin/unassigned-tasks`, `POST /admin/applications/:id/tasks/:n/reassign` |
| Applications | `GET /applications?scope=all` (drafts too, sorted by idle days), `DELETE /admin/applications` (soft delete of drafts never submitted — §8) |
| **Statuses (N-4)** | `GET /admin/statuses` (with their use by files, history and workflows), add / rename / re-order / (de)activate in-process statuses, remove one never used; statuses 1, 2, 7, 8, 9 are fixed |
| **Audit** | `GET /audit` (newest first, by kind of record, record id, action prefix; paged) — and a new **Admin → Audit** page (also **Department → Audit** for the DG; kept 3 months — §8) |
| Rules & fees | `PUT /config/fees` · `/delegation-rules` · `/renewal-rules` publish a new immutable rule-set version (a paid fee stays frozen with its version, Q-57); `GET /config/rules/:code/versions`; `POST /rules/sets/:code/evaluate` |
| Workflows and SLA | `PUT /config/workflows/:code` (validated, with the whole set; files in process keep their version), `GET …/defaults`, `…/usage`, `…/:code/versions`, `POST …/validate`, `…/simulate`, `…/:code/restore/:version`; `PUT /config/sla` |

### 2.4 Identity and files

- Registration with the "set your password" link (B2-4); session limits (B2-5, B2-6); reset links
  (B2-7); forced change for the production seed (B2-8).
- **Rate limits** per client address: sign-in, registration, forgot / reset password share a small
  budget (`RATE_LIMIT_LOGIN_PER_MINUTE`, 10 built in), everything else a general one (300).
- Uploads: 10 MB per file, 250 MB per application, PDF only (B2-10); purge after 30 days (B2-9).
- The citizen lifecycle writes (`POST/PUT/DELETE /applications…`) now require the citizen portal:
  an officer or admin token gets **403** before any validation (before: 400 / 404 / 406).

### 2.5 Data model and ids

- **Integer ids on both sides** (the carry-over D-B2-1): roles, fire stations, workflow definitions,
  tasks and accounts are numbers in the API and in the portal (`role_id`, `fire_station_id`,
  `fire_station_ids`, `definition_code` for the workflow's code).
- Migrations: `0002_b3` (purpose of a password token) and **`0003_performance`** (below).
- The seed is the single source of the demo data (`backend/seed/data`); the frontend's
  `public/assets/data` was deleted. Fire station "4Q" is removed from the seed inputs (N-1).

### 2.6 The portal (frontend)

- **The mock layer is gone** (the carry-overs D-B2-2 … D-B2-4): `MockPersistenceService`, the
  `/portal/*` transition routes (backend and frontend), the fixture-backed HTTP routes, the `mock`
  environment and `start:mock`, the JSON fixtures under `public/assets`. A grep gate is green: no
  `localStorage` data access, no `MockPersistence` in `frontend/src/app`.
- `api-endpoints.ts` is a **REST catalogue** (117 operations, `docs/03-api-catalog.md`);
  `ApiClient` substitutes the parameters; every feature service calls it.
- Department: dashboard (server queues, counts, "the N oldest of M tasks"), processing page on
  `allowed_actions` (every form posts to the API, the challan tick, file links), final decision with
  the server preview and the signed-copy upload, search and reports from the server, CSV from the
  server.
- Admin: workbench counters from the server, unassigned tasks, escalations preview / send, statuses
  page, **audit page**, officers and citizens searched on the server, workflows / SLA / rules on the
  API, the reset button removed (Q-67).
- Status names and badges come from the `statuses` lookup (D-B2-3).
- `workflow.ts`, `reports.ts`, `escalations.ts` moved to `@srisaa/noc-domain` (D-B2-4); they are
  the oracles of the server's SQL.
- Tests run against **`FakeApi`** (`src/testing/fake-api.ts`): an HTTP interceptor that answers the
  REST routes from the seed data, records every request (method, path, query, body) and can be
  overridden per test. `services.contract.spec.ts` asserts the requests of every feature service.

### 2.7 Hardening

| Item | What |
|---|---|
| **Authorization matrix** | `tests/integration/authorization.spec.ts`: **every route × anonymous / citizen / officer / admin** against a written policy (401 / 403 exactly where expected); a new route without a policy fails the test. Plus: another citizen's file is hidden, drafts are invisible to the department, the staff bundles are refused to citizens. |
| **Portal ↔ API contract** | `tests/integration/contract.spec.ts`: every catalogue entry is served; every route is used by the portal or listed as server-only. |
| **Rate limits** | As above, tested with small numbers (`rate-limit.spec.ts`). |
| **Backup / restore** | `npm run db:backup` / `db:restore` (§6 of the runbook): `pg_dump` + a tar of the storage root + a manifest with checksums and row counts; restore verifies, re-creates, restores the files (moving the current ones aside), checks the counts. Exercised by the smoke test on every run (backup → restore into a second database → same counts, same files). |
| **Load test** | `npm run db:load-test-data` builds `noc_load` with 300 000 applications (§4); `npm run perf:probe` times every hot screen, explains its SQL, times the write path and runs 100 concurrent users. |
| **OpenAPI** | `/docs` (Swagger UI) and `/docs/json`; `npm run openapi` writes `docs/backend/openapi.json`. Every route is listed with its group and bearer requirement; the request and response shapes are documented in `50-api-design.md` and the catalogue. |
| **Lint** | ESLint for the backend and the packages (root `eslint.config.mjs`, includes "only `config/env.ts` reads `process.env`"), and the Angular app's lint (fixed to zero findings). `npm run lint`, part of `npm run ci`. |
| **Several API processes** | `API_WORKERS=n` forks n workers sharing the port (node:cluster, restarted if they die); the outbox claims messages with `FOR UPDATE SKIP LOCKED`, the scheduler holds an advisory lock, so both are safe in every worker. |
| **Report memo (N-16)** | A report is computed at most once a minute per report + filter and API process; `?fresh=true` recomputes; `x-report-computed-at` tells the time. |
| **Readiness** | `/ready` reports pending migrations; the API log warns at start; `npm start` migrates. |
| **Configuration drift** | `npm start` / `npm run setup` create `backend/.env` if missing and list the settings an older copy lacks. |

## 3. Found and fixed during B3

| # | Problem | Fix |
|---|---|---|
| F-5 | The Angular dev server kept serving an **old build of `@srisaa/noc-domain`** after the packages were rebuilt (Vite's pre-bundle cache). In the browser a new application was refused ("Select the nearest fire station") because the old validation still read the pre-B3 field name. | `angular.json` excludes the `@srisaa/*` packages from pre-bundling; the dev server now always serves the current build. |
| F-6 | `backend/.env` (and `.env.example`) still had the **B2-era upload settings** (5 MB, JPEG / PNG allowed), overriding decision B2-10. | `.env.example` updated with every B3 setting and its decision; the `env` check lists missing settings. |
| F-7 | The development database was **one migration behind** (`npm start` did not migrate). | `npm start` migrates; `/ready` and the start-up log report pending migrations. |
| F-8 | Staff tokens reached the citizen write routes' validation (400 / 404 / 406 instead of 403). | Portal guard on those routes (found by the authorization matrix). |
| F-9 | The reference-data store's `BroadcastChannel` outlived its injector (listeners piled up; hundreds of errors in the unit tests) and its asynchronous reads were invisible to `whenStable`. | Channel closed on destroy; reads registered as pending tasks. |
| F-10 | Loading an application ran ~20 queries **concurrently on one transaction connection** (a pg deprecation, an error in pg 9) and, outside transactions, took up to 11 pool connections per request. | The aggregate is loaded sequentially (one connection per request). At 100 concurrent users no request waits for a connection. |
| F-11 | Formatting a date created an `Intl.DateTimeFormat` each time (~0.1 ms), which dominated lists of thousands of rows (My tasks of the DFS: 2.5 s). | One formatter per time zone (2.5 s → 0.2 s). |
| F-12 | The `search_vector` column existed but the lists searched with `LIKE` over a view, and the monitoring / list queries evaluated the summary view (joins, document flags, counts) for **every** matching row. | See §4. |

## 4. Performance at 300 000 applications

`npm run db:load-test-data` clones the demo applications — with their blocks, floors, FFE grids,
parties, documents, payments, process log and workflow runs — to **300 000 applications** (about
3 years at 100 000 a year; 4.1 GB): 95 % decided, 3.6 % in process (10 700 files, about two months of
intake), 2 % drafts; dates spread over five years; every fire station and district; one synthetic
citizen per 8 applications; the district-level tasks (DFO, SFO) assigned to a synthetic officer of the
file's district, the Head Office ones to the demo officers (so the DFS holds ~4 300 open tasks).

What changed (migration `0003_performance` and the queries):

- **Two-phase lists**: filter, count and sort on `applications` (indexed columns only), then decorate
  the one page with the summary view — applications lists, search, monitoring, My tasks.
- **Substring search** on a trigram index (`pg_trgm`, a generated lower-case `search_text` of number,
  site, address and builder) plus indexed branches for the district, the owner and the id; `%` and `_`
  typed by the user are literal.
- Indexes: `applications (current_wf_instance_id)`, `(fire_station_id, status_id)`,
  `(status_id, last_modified)`; `wf_instances (started_at) where completed_at is null` (the files in
  process); `wf_tasks (assignee_user_id, state, instance_id)` (index-only "files I worked on").
- The monitoring scope as uncorrelated `IN` sub-queries (hashed once), one statement for the stage
  chips + total + KPIs; My tasks counts every task but decorates only the returned rows; the
  escalation query per overdue run through a lateral join (it had a pathological plan: > 100 s);
  statuses' usage as one grouped pass; literal status / type ids so the planner uses the statistics.
- JIT and parallel query off for the API's connections (JIT cost 0.5–0.8 s on 1 s queries; parallel
  workers oversubscribe the CPUs when many users work at once); the local cluster starts with 512 MB
  shared buffers and SSD costs (`PG_SERVER_OPTIONS`).

Results (`npm run perf:probe`, median of 5 on this 4-vCPU sandbox; full report:
[`B3-performance-probe.md`](./B3-performance-probe.md); timings vary by ±30–50 % between runs):

| Area | Call (who) | Median |
|---|---|---|
| Citizen | My applications (a citizen with 8 files) · one application | 18 ms · 69 ms |
| Department | My tasks — DFS (4 300 open tasks) · a district officer | 166 ms · 60 ms |
| | Monitoring (files in process) — DFS · the busiest district officer | 153 ms · 397 ms |
| | Monitoring with decided files — DFS · district officer | **920 ms · 999 ms** (B3-1) |
| | The processing page of a file | 126 ms |
| | Search: an application number · a very common word ("tower", 64 000 matches) | 25 ms · 126 ms |
| Reports (computed, `fresh=true`) | the ten reports over every file | 177–839 ms (memo hit: 1–14 ms) |
| | CSV of the applications report (every block) | **6.1 s** (B3-3) |
| Admin | drafts sorted by idle days · accounts search · escalation preview · statuses with their use · workflow usage | 53 · 20 · 344 · 554 · 432 ms |
| Writes | create · save with the server assessment · pay · upload (each) · submit · decide · a workflow transition | 242 · 327 · 119 · 132 · 210 · 226 · 192 ms |
| Workload | **100 concurrent users** (5 s pause between requests, 2 API processes, 60 s): 1 158 requests, **p50 62 ms, p95 852 ms, p99 2.1 s, 0 errors**, at most 9 database connections busy | |
| | with a 3 s pause the sandbox is saturated (~28 requests/s; PostgreSQL and Node share 4 vCPUs): p95 1.8 s, 0 errors; with a 10 s pause: p95 0.44 s | |

Budgets (`80-test-plan.md` §8.11): screens 500 ms, reports 1.5 s, save 300 ms, submit 500 ms,
transition 200 ms, exports 15 s. **Over budget:** the "decided files" view of Monitoring for the busiest
officers (question B3-1 — now limited to the last 12 months, §8), the statuses page (its usage counts read the whole process log) and the save
(327 ms, on the edge; it recomputes the whole assessment). The CSV export is within its budget but
builds the file in memory (question B3-3).

Also from the workload: loading an application used up to 11 pool connections at once (F-10), and one
Node process tops out at ~20–25 heavy requests a second — hence **`API_WORKERS`** (node:cluster; the
outbox now claims messages with `SKIP LOCKED` so several processes can run it) and **reports memoised
for 60 s** per report and filter (N-16, `?fresh=true` recomputes, `x-report-computed-at` says when).

## 5. Deviations and carry-overs

| # | Item | Why / next |
|---|---|---|
| D-B3-1 | The admin "try it" previews (rule tester, workflow validation, officer simulator) and the SLA day counts run **in the browser** with the same library as the server; the server validates again on save. The server endpoints exist (`/rules/sets/:code/evaluate`, `/config/workflows/validate`, `…/simulate`) but no screen calls them. | Instant feedback (Q-14); question B3-5. |
| D-B3-2 | No version-history / restore panel for rule sets and workflows in the admin screens (the API has it). | Question B3-4. |
| D-B3-3 | The browser suite is one script (`e2e/smoke.mjs`, 64 checks: all three portals, registration, the citizen journey, the Section Note with the challan tick, the decision with the signed NOC, reports CSV, statuses, audit, escalations). The manual test scripts of the plan are not in the repository, so the suites were derived from the features; send back, bypass, reassign, return + revise, hand-over, the admin fee change reaching an open session and escalations with a frozen clock are covered by the API and component tests rather than the browser. | |
| D-B3-4 | Report parity is tested over the seed (100 cases), not over the 300 000-application dataset. | The oracle functions need every aggregate in memory. |
| D-B3-5 | The 100-user workload is measured by the probe (HTTP, 20 s), not a 10-minute `autocannon` soak. | |
| D-B3-6 | Re-seeding publishes the workflows again, so their version numbers grow with every `db:seed`. | Harmless; the versions of files in process are kept. |
| D-B3-7 | Gateways (B2-3), the real payment gateway (B2-2) and malware scanning (B2-11) are not built, as decided. | |

## 6. Test inventory

| Suite | Tests | Command |
|---|---|---|
| `@srisaa/rules-engine` | 58 | `npm run test:packages` |
| `@srisaa/workflow-engine` | 39 | `npm run test:packages` |
| `@srisaa/noc-domain` (domain, assessment, workflow bindings, **reports / escalations / workflow-admin oracles**, golden workflow trails, seed data) | 173 | `npm run test:packages` |
| Backend: department workflow 29, citizen lifecycle 30, applications 18, auth 17, reference cache 14, admin 12, config 11, schema 11, search 4, **authorization matrix** 4, escalations 3, jobs 4, OpenAPI 4, rate limits 3, **contract** 2, **reports 104** (parity with the oracles, CSV, memo, jurisdiction, access), aggregate parity 15, storage 9, re-dating 9, pg cluster 5, session expiry 2 | 310 | `npm -w @srisaa/noc-api test` |
| Frontend unit / component (against `FakeApi`) | 201 | `npm run test:web` |
| **Total automated** | **781** | `npm test` |
| API smoke on scratch databases (citizen → every officer → decision, registration, reports, admin, backup + restore) | 57 checks | `npm run smoke` |
| Browser suite (all portals, B1–B3 journeys) | 64 checks | `npm run test:e2e` (servers running) |

The frontend count fell from 290 to 201: the specs of the deleted mock services (accounts,
applications, department workflow, admin, workflows admin, mock persistence) and of the domain
files moved to `@srisaa/noc-domain` are gone; the behaviour they tested now runs on the server and is
tested there (backend 128 → 310, noc-domain 146 → 173).

## 7. Acceptance against the plan (`70-delivery-plan.md`, phase B3)

| Criterion | Result |
|---|---|
| The whole portal runs with no mock layer. | **Met.** The grep gate is green; the fixtures exist only as the seed (and the unit tests' data). |
| Department transitions through the engine (save, submit with server-side validation, send back, skip, reassign, decide with SLA-restricted outcomes and signed copy, preview, fire station, licensing authority, documents, SMS, allowed actions, queues). | **Met.** API tests, the smoke journey (every officer of P-MSB, then the decision) and the browser suite. |
| Admin: rules, workflows, SLA, statuses, accounts and stations, hand-over, unassigned tasks, search and delete, audit. | **Met** (version history UI: D-B3-2). |
| Ten reports in SQL + CSV, parity with the oracles. | **Met over the seed** (D-B3-4). |
| Escalations: preview, send, log, scheduled job; other jobs. | **Met.** |
| Hardening: authorization matrix, EXPLAIN review at 300 000, rate limits, backup / restore, deployment guide. | **Met** (deployment checklist in the runbook, B2-14). |
| Playwright: the manual scripts and the multi-actor journey. | **Partly met** (D-B3-3). |
| Performance budgets at 300 k applications. | **Met except** B3-1 and B3-3 (§4). |

## 8. After your review: the answers applied

| Answer | What changed |
|---|---|
| **Volume: at most 7 000 applications a year** | No further optimisation. The load-test generator now defaults to **21 000** applications (three years); the 300 000 measurements above remain as headroom. At 21 000 (`npm run perf:probe`): every screen 20–200 ms, every report 13–130 ms, the full CSV 0.9 s — all within budget. |
| B3-1 Decided files in Monitoring: 12 months, or all if few | With "Include decided files", the server lists the files decided in the **last 12 months** when the officer has more than **1 000** decided files, and **all** of them otherwise; the dashboard says which ("Decided files of the last 12 months are listed (N decided in all) — Show all decided files"), `GET /dept/monitoring?includeDecided=true&decided=all` lists every year. |
| B3-2, B3-3, B3-5 | Unchanged (as accepted). |
| B3-4, B3-6, B3-7 | Nothing built (not needed). |
| B3-8 Audit: 3 months; DG and admin | `GET /audit` (was `/admin/audit`) is readable by the **administrator and the DG** (403 for everyone else); the DG has **Department → Audit**. A daily job **`purge-audit`** (03:00) deletes entries older than **3 months** (`AUDIT_RETENTION_MONTHS`); otherwise the table stays append-only. |
| B3-9 No deletion of submitted applications | `DELETE /admin/applications` refuses (422) any application that was ever submitted — the whole request, so nothing is half-deleted; only **drafts never submitted** can be deleted. Admin → Applications offers Delete only on those rows ("Kept" on the others). |
| B3-10 Citizens 1 day idle | Confirmed (as built). |
| B3-11 Jobs inside the API | Confirmed (as built). |
| B3-12 No proxy | `TRUST_PROXY=false` (new setting, default): the connection's address is the client's for the rate limits and the audit trail. |
| B3-13 No `/docs` in production | `ENABLE_DOCS` unset = on in development, **off in production**. |
| B3-14 Reports jurisdictional | A **district or station officer's reports** (all ten, JSON and CSV) and the dashboard's ratings panel cover **the files of his fire stations** only; Head Office officers (all stations), the monitoring role and the administrator see every file. The reports page says so ("files of your fire stations only"); the one-minute memo is kept per jurisdiction. |

Tests added: monitoring's decided window, the audit readers and retention, the deletion refusal, the
jurisdiction of reports and of the ratings panel, `/docs` off in production (backend); the dashboard's
"show all decided", the DG's Audit link, the reports' jurisdiction note, the drafts-only deletion
(frontend); the DG's audit page and a district officer's reports (browser suite).

