# Phase B2 — Delivery Notes

**Status: delivered and running.** A citizen can now do the whole application
lifecycle on the real backend: register, change the temporary password, create a draft,
save it, upload documents, pay, submit, revise, carry a NOC forward (occupancy and renewal),
and rate the service. The server does every calculation and starts the department workflow.
Department actions and administration writes are still phase B3.

See [`RUNBOOK.md`](./RUNBOOK.md) for setup, running, credentials and tests.

---

## 1. Operational fixes (reported after B1)

| # | Problem | Cause | Fix |
|---|---|---|---|
| F-1 | `npm run start` failed when run as **root**. | There was no `start` script. Also, PostgreSQL's `initdb`, `pg_ctl` and `postgres` refuse to run as root. | `npm start` is now `npm run dev`. `backend/scripts/pg/cluster.ts` is root-safe. As root, it runs the PostgreSQL binaries with `runuser -u <owner>`. The owner is whoever already owns `.pgdata/`, otherwise `PG_OS_USER`, otherwise `postgres`. It also creates and chowns `.pgdata/`, `var/log/` and `var/run/` for that user and checks the owner can reach the data directory. As a normal user, nothing changes. *This could not be run as root here because the sandbox has no sudo. The command construction is covered by unit tests (`tests/unit/pg-cluster.spec.ts`).* |
| F-2 | `npm run dev` failed with "port in use". | API and web servers from an earlier run were still running. | `scripts/servers.mjs` (no `ss` or `lsof` needed; it reads `/proc`). `npm run dev` first **checks** ports 3000 and 4200. If either is taken, it names the process and says how to stop it. **`npm run stop`** stops our API and web servers, including their watcher parents, so nothing respawns. **`npm run status`** shows the API, the web server and PostgreSQL. |
| F-3 (found in B2) | `npm test` ran the backend integration suites against the **development** database `noc`, and re-seeded it. | Vitest did not load `backend/.env`, so `TEST_DATABASE_URL` was unset and the helper fell back to the main database. | `backend/vitest.config.ts` now loads `backend/.env`. `testDatabaseUrl()` falls back to `<DB_NAME>_test` and **refuses any database whose name does not end in `_test`**. Verified: the development database is untouched by a full test run. |
| F-4 (found in B2) | `npm run dev:reset-demo -- --yes --i-understand-this-deletes-data` refused to run non-interactively. | The root script did not pass the flags on to the backend script; npm consumed `--yes` itself. | The root script now ends with `--`, so the flags reach the script. |

## 2. What was built

### 2.1 `@srisaa/workflow-engine` (new, generic, reusable)

`packages/workflow-engine` has no NOC knowledge and no runtime dependencies, and it is browser-safe.

- **Model:** a versioned process definition with sequential **stages** of parallel **tasks**
  (role, form, optional, on-demand), a final **decision** with outcomes, and an SLA policy.
- **Pure reducers:** each returns a new instance plus the events. The operations are
  `start`, `saveDraft`, `complete`, `sendBack`, `skip`, `reassign`, `reresolveAssignees`,
  `decide`, `archive`, `handover`, `allowedOutcomes`, and `openTasksOf`.
- **Queries:** `currentTasks`, `activeTasks`, `activeStageIndex`, `pendingWith`,
  `previousStageIndex`, `allowedActions`.
- **Ports:** `AssigneeResolver` (directory), `Clock`, and the permissions context.
- **Validation:** `validateDefinition` (empty stages, duplicate ids, unknown roles/forms).
- **SLA / escalations:** due dates and the escalation levels.
- **Testing kit:** `FixedClock`, `InMemoryDirectory`, and builders.
- **Tests:** 35 unit tests, plus 4 property tests (fast-check). The property tests check that at most one stage is active, that a decided instance is immutable, that events are append-only, and that the task set matches the definition. The default suite uses 2 000 random runs. `npm -w @srisaa/workflow-engine run test:deep` uses **10 000** (the B2 acceptance criterion, about 35 s). Coverage (`run coverage`): **95.8 % of statements, 99.7 % of lines**.
- **Documented semantic fix:** an *optional* task never blocks its stage. The browser
  engine had an unreachable branch for this.

### 2.2 `@srisaa/noc-domain` (now shared by the backend and the browser)

- `workflow-binding.ts` maps the 12 NOC workflow definitions onto the generic engine. It defines the outcome effects (7 Approved, 8 Returned, 9 Rejected), the signed decision, the NOC SLA policy and the effects of submission. `tests/workflow-binding.spec.ts` shows that **all 12 workflows behave step for step like the legacy browser engine**.
- `password.ts`: the new password policy (decision Q-5).
- The **models moved here**. The frontend's `core/models` and 14 `core/domain` files now
  re-export the package, and their specs run in the package. This is decision N-5, and it means the browser and server logic cannot drift.
- **Bug fixed in `assess()`:** the approval level is now derived *before* validation.
  Before the fix, a draft saved without a stored level was treated as "DFO". For Head Office and Regional applications, the server then stopped asking for the Undertaking, the Bank Guarantee and the FFE Estimate. The server accepted such a submission, while the browser correctly refused it. A regression test covers this in the package and the API. The level is now also stored on every draft save.

### 2.3 Backend: the citizen lifecycle

| Endpoint | What the server does |
|---|---|
| `POST /applications` | Creates a draft. It needs only the site name and address, as the legacy `SaveApplication` did. It creates the default parties, the assessment and an audit entry. |
| `PUT /applications/:id` (`If-Match: "r<row_version>"`) | Saves the whole aggregate. It uses **optimistic locking** (409 with *"changed elsewhere…"*). Only the fields the applicant owns are taken from the payload: status, number, fee, payment and level can't be forged. The server recomputes the FFE grid, fee, level and validation, and the response carries the server's assessment. |
| `DELETE /applications/:id` | Soft-deletes a first-revision draft, with the same rule as before. |
| `POST /applications/:id/occupancy`, `/renewal` | Carries an issued Provisional NOC forward to an Occupancy draft, or an Occupancy/Renewal forward to a Renewal draft. Parent and child are linked. |
| `GET /applications/:id/fee` | Returns the fee position: current fee, amount paid, amount due, and whether it is frozen. |
| `POST /applications/:id/payment` (`Idempotency-Key`) | Takes an online payment (simulated PayU, `PAYU…` reference) or records a challan. **The fee is frozen at the first payment** with its rule version (Q-57). A repeated key charges nothing. If the area grows after payment, the **differential** is due before submission, computed at the frozen rate (N-3). |
| `POST /applications/:id/submit` `{undertakings}` | Runs full server validation with the same messages as the wizard. It then checks the required undertakings. The level is computed (a Declaration follows its parent NOC). The NOC workflow is started by the engine, and the **number is issued as `yyyymm` + 5 digits** (N-2) from a per-month sequence. The server also sets the status, stage and reviewer, writes the process log, takes a `submitted` **revision snapshot** (Q-39), queues the SMS, and writes the audit entry. |
| `POST /applications/:id/revise` | Allowed for a returned or rejected application. It archives a snapshot, archives the workflow run, and creates revision + 1 as a draft. |
| `POST /applications/:id/feedback` | Records the citizen's rating of a decided application. |
| `POST /applications/:id/documents` (multipart: `code`, then `file`) | Streams the upload into storage **outside the web root**. The type is decided by **magic bytes**, not the file name (PDF for application documents), which gives 415. The size limit gives 413. Only documents the application needs are accepted (422). Uploading again for the same requirement replaces the file. |
| `DELETE /applications/:id/documents/:docNo` | Removes a document from a draft. |
| `POST /applications/:id/document-requests/:n/response` | The citizen's answer to a department document request. |
| `GET /applications/:id/revisions` | Lists the retained snapshots: kind, date, fee and level. |
| `POST /files/:id/download-token` → `GET /files/download/:token` | Issues a **one-time** token (120 s) per download, so no bearer token appears in a URL. **Security fix:** the access check now runs inside the handler. In B1 the check ran in a hook before authentication, so it was skipped. |

**Auth changes:**
- **Password policy:** at least 10 characters, with upper case, lower case, a digit and a symbol, and not containing the username (Q-5). It applies whenever a password is set.
- **Temporary passwords** are 12 characters and compliant.
- **Forced change:** the API answers 403 until a temporary password is changed.
- **Lockout:** 5 failures lock the account for 15 minutes.
- **Idle timeout:** officers and admins are signed out after **8 h idle** (sliding), with a 30-day absolute limit.
- **Forgot password** sends a **reset link** to `${PORTAL_URL}/auth/reset-password?token=…`. The answer is the same whether or not the account exists.

**Notification outbox:** messages are queued in the same transaction as the action, so a rollback sends nothing. A dispatcher runs every 5 s. The only driver is **`log`**: reset links and SMS texts appear in the API log as `EMAIL (log driver)` / `SMS (log driver)`.

**Seed re-dating:** demo applications are moved relative to "now", so pendency, SLA and validity look current. Numbers follow the new 11-digit format. Set `SEED_REDATE=false` to keep the original fixture dates.

**Performance:** seeding uses batched inserts, one per child table (33 s → about 2 s on this machine's 2.6 ms database round trip).

**Database:** no schema change was needed in B2. The B1 model already had revisions, assessments, the number sequence, payments/payment events, outbox and reset tokens. `drizzle-kit generate` confirms there is no drift.

### 2.4 Frontend

| Area | Change |
|---|---|
| `CitizenApi` (new) | A typed client for every B2 endpoint: `If-Match`, `Idempotency-Key`, upload progress, one-time download URLs. |
| `ApplicationsService`, `ApplicationDraftStore` | *My Applications* now reads summaries from `/applications?scope=mine`. Before, it loaded every aggregate through `/portal/applications`. The browser smoke checks that the citizen portal makes **no** `/portal/*` call. In `http` mode, every write goes to the server. The draft store adopts the **server's** application and assessment after each save. It logs a warning if the browser's fee differs from the server's; the server value is kept. |
| Wizard | A **409 prompt**: *"This application was changed elsewhere"*, offering to load the latest version. Upload progress ("Uploading… 60%"). Uploaded file names are **download links**. |
| Confirmation page | Sends the ticked undertakings, and the server enforces them. |
| Application detail | **Revision history** card. Document names open the stored PDF in a new tab. |
| Auth pages | New **Reset Password** page (`/auth/reset-password?token=`). Forgot-password now says *"If an account exists for that e-mail address, a reset link has been sent"*. Login shows a notice after a reset. A **forced password change** guard keeps every portal page behind *Change Password* while a temporary password is in use, with a *Sign out* button there. The policy text appears on every password form, and the rules are checked before calling the server. |
| `http-routes.ts` | The B2 writes are live. The department and admin writes still answer with a clear "arrives in phase B3" message. |
| Mock mode | `npm run start:mock` still works. Its forgot-password and password rules now behave like the server's. The sign-in page footer now says which mode is running. |

---

## 3. Decisions applied in B2

| Ref | Decision |
|---|---|
| N-2 | Numbers are `yyyymm` + 5 digits. Old 10-digit numbers stay valid. |
| N-3 | A differential payment is due if the area grows after payment. There is no refund if it shrinks. |
| N-5 | The domain code lives in one shared package, used by the backend and the browser. |
| Q-5 (raised) | The password policy above. Existing `demo` passwords still work until they are changed. |
| Q-39 | Snapshots are taken at submit and at archive on revise. Snapshots at decision come with B3. |
| Q-57 | The fee is frozen at the first payment, with its rule version. |
| Sessions | Officers and admins: 8 h idle timeout. Lockout: 5 failures / 15 min. |
| Forgot password | Reset link, no account-existence disclosure. |
| Aadhaar | Never stored in full. The builder's Aadhaar on an application is stored as `XXXXXXXX1234`, and registration keeps the last 4 digits plus a hash. The wizard tells the citizen so. |
| Status names | Official names = screen names ("Reviewed (ADFS)", "Reviewed (DFS-CD)"). |
| Demo data | Re-dated relative to today on every seed. |

## 4. Deviations and carry-overs

| # | Item | Why / when |
|---|---|---|
| D-B2-1 | **String ids → integer ids on both sides** (agreed) has **not** been done yet. | It touches every department screen, so it moves to B3 together with the department refactor. The API already uses integer keys internally. |
| D-B2-2 | The **`/portal/*` transition surface** still serves the department and admin reads. | The citizen reads and writes now use `/applications/*`. `/portal/*` is removed in B3, when those services move. |
| D-B2-3 | **Status badge labels** are still hard-coded in `frontend/src/app/shared/status.util.ts`. | Moves to the `statuses` lookup in B3, with the N-4 status admin page. |
| D-B2-4 | `workflow.ts`, `reports.ts` and `escalations.ts` remain in the frontend. | They are department/admin logic, so they move (or are deleted) in B3, when those transitions run on the server. |
| D-B2-5 | Notifications use only the **log driver**. | No SMS or e-mail gateway has been chosen (see the questions). |
| D-B2-6 | Challan payments are accepted as **paid immediately**, as in the legacy portal. | Whether the department must verify them is an open question. |

## 5. Test inventory

| Suite | Tests | Command |
|---|---|---|
| `@srisaa/rules-engine` | 58 | `npm run test:packages` |
| `@srisaa/workflow-engine` (unit + property + escalations/validation) | 39 | `npm run test:packages` |
| `@srisaa/noc-domain` (domain + assessment + **12-workflow parity**) | 146 | `npm run test:packages` |
| Backend: auth (17), applications (18), **citizen lifecycle (30, including concurrency)**, reference/caching (14), schema (11), parity (15), storage (9), re-dating (9), pg cluster (5) | 128 | `npm run test:api` runs the 105 integration/parity tests; `npm test` runs all 128 |
| Frontend unit/component | 290 | `npm run test:web` |
| **Total automated** | **661** | `npm test` |
| API smoke on a scratch database, including the B2 journey | 34 checks | `npm run smoke` |
| Browser smoke, all three portals plus the B2 journeys | 36 checks | `npm run test:e2e` (servers running) |

## 6. Acceptance against the plan (`70-delivery-plan.md`, phase B2)

| Criterion | Result |
|---|---|
| A citizen completes Apply → Save → Upload real PDFs → Pay → Submit in the browser, and the first task appears for the right officer. | **Met.** Browser smoke: `section.hq` opens the new file. |
| The server computes FFE, fee and level. | **Met.** Every save and submit runs `assess()` on the server. |
| Uploaded PDFs exist under `var/storage/applications/<shard>/<id>/…`, are downloadable through tokens, and are not reachable through the web server. | **Met.** Checked by the API smoke, the browser smoke and the integration tests. |
| Parallel submits get distinct numbers; parallel saves give one `409`. | **Met.** There are 3 concurrency tests, including a double-clicked Submit, which submits once. |
| Workflow engine: 95 % coverage, invariants over 10 000 random command sequences. | **Met.** 95.8 % of statements, 10 000 runs pass (`test:deep`). |
| Client/server assessment equality. | **Met by construction.** The browser and server run the same `@srisaa/noc-domain` build (N-5). Seed parity is tested. The separate randomised client-vs-server property test is no longer meaningful. |
| Playwright: the phase-2 manual script for P, O-from-P, R-from-O and D. | **Partly met.** The browser runs P end to end, plus registration, forced change and forgot-password. The API tests cover revise, the renewal carry-forward, the occupancy rule, requested documents, rating and delete. The full Playwright suites for the three manual scripts are planned with B3, when the department side can complete a file. |
| `POST /rules/sets/:code/evaluate` | **Moved to B3**, together with the admin rules editor that uses it. |

The frontend count fell from 396 to 290 because the domain specs moved into `@srisaa/noc-domain`. There they run against the same code the backend uses.
