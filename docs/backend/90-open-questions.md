# 9. Decisions and Open Questions — Revision 3 (after phase B3)

## 9.1 Your directions, recorded as decisions

| Ref | Decision | Applied in |
|---|---|---|
| Change 1 | S3 driver and all its dependencies, configuration and tests are out of scope. The design stays S3-compliant, with a storage contract test suite for a future driver. | 10 §1.5, 60 §6.4 |
| Change 2 | Every table has PK `id integer`, including fire stations. Uploaded files use UUIDs. `"4Q"` is a data error and is corrected in the seed. | 40 §4.0 |
| Change 3 | Caching strategy for reference, rules, content, workflow and directory bundles. | 55 |
| Change 4 | Rules Engine and Workflow Engine are independent libraries. All calculations and all transitions run in the backend. | 45 |
| Change 5 | Frontend integration is in scope. | 65, 70 |
| Q-6 | No production/legacy database. There is no import of legacy data or uploads. | 40 §4.14, 70 |
| Q-8 | 100 000 applications/year, 100 concurrent users. | 40 §4.13, 60 §6.10, 80 §8.11 |
| Q-14 | The client keeps its live calculation. The server recomputes at save and submit and is the source of truth. | 45 §45.2, 65 §65.5 |
| Q-39 | Revisions are retained as immutable snapshots (submitted, decided, archived). | 40 §4.7 |
| Q-57 | The fee is frozen at payment, together with its rule version. | 40 §4.7, 45 §45.2 |
| Q-59 | Unassigned tasks are created, flagged for the admin and escalated. | 45 §45.3, 60 §6.7 |
| Q-63 | Statuses 1, 2, 7, 8 and 9 are fixed. Statuses 3–6 are configurable in-process statuses, and code never hard-codes them. | 40 §4.3 |
| Q-67 | There is no Admin UI or API for the reset. It is a guarded development-only CLI script. | 20 §2.4 |
| All other Q-1 … Q-74 | The proposed defaults are accepted. | — |
| N-1 | Fire station "4Q" (Kunavaram) is dropped entirely. | seed, B1 |
| N-2 … N-17 | The proposed defaults are accepted (N-2: `yyyymm` + 5 digits; N-3: differential payment; N-4: used statuses are kept, new ones can be added; N-7: scope `@srisaa`, MIT). | B1, B2 |
| B2-1 … B2-15 (after B2) | **B2-1** challan accepted at once, verified by the section officer ("challan verified" tick on the Section Note, else on the first scrutiny task) · **B2-2** keep the PayU simulation · **B2-3** no gateways (log driver) · **B2-4** registration sends a "set your password" link · **B2-5** citizens signed out after **1 day** idle · **B2-6** officers and admins: 12 h absolute · **B2-7** reset links 1 h, single use · **B2-8** production seed forces a password change · **B2-9** unused files purged after 30 days · **B2-10** 10 MB / 250 MB, PDF only · **B2-11** no malware scanning · **B2-12** a revision keeps its number, only the differential is payable · **B2-13** no confirmation of a Declaration's level by the department · **B2-14** deployment-independent, focus on the sandbox · **B2-15** all of B3 in one delivery | B3 (see `B3-delivery-notes.md` §1) |
| B3-1 … B3-14 (after B3) | **Volume: at most 7 000 applications a year** (not 100 000; no further optimisation) · **B3-1** decided files in Monitoring: the last 12 months, or all of them when there are few (≤ 1 000) · **B3-2** shortened report lists accepted · **B3-3** CSV as it is · **B3-4** no version-history panel · **B3-5** admin previews in the browser · **B3-6** volume corrected, one officer per Head Office role · **B3-7** no second-level escalation · **B3-8** audit kept **3 months**, read by the **DG and the admin** · **B3-9** **submitted applications are never deleted** · **B3-10** citizens: 1 day idle · **B3-11** jobs inside the API · **B3-12** no reverse proxy · **B3-13** no `/docs` in production · **B3-14** reports **jurisdictional** for district and station officers | B3 (see `B3-delivery-notes.md` §8) |
| After B1 | The `/portal/*` transition surface stays until B3. The domain code moves to the shared package in B2. Aadhaar is masked. Demo data is re-dated. Passwords: 10+ characters with complexity. Public bundles are acceptable. Official status names are the screen names. String IDs switch to integers on both sides during B2/B3 (now planned for B3). Forgot password uses a reset link with no account-existence disclosure. Department search scoping is kept. Officers and admins get an 8 h idle timeout. Lockout after 5 failures for 15 min. | B2 (see `B2-delivery-notes.md` §3) |

## 9.2 Follow-up questions raised by Revision 2

| # | Question | Proposed default |
|---|---|---|
| **N-1** | Fire station `"4Q"` (Kunavaram, East Godavari). Do you know its real numeric id, or should I assign the next free id (**199**)? Free ids inside the range are also available (33, 101–105, 107, 108). | 199, with the correction recorded in `seed/corrections.json` |
| **N-2** ⚑ | **Application numbers will overflow.** `yyyymm` + 4 digits allows 9 999 per month, and 100 000 per year averages 8 333 per month. Widen the sequence to 5 digits (`yyyymm#####`, 11 characters)? Or use another format, such as `yyyy` + 6 digits, or a district code prefix? | `yyyymm` + 5 digits. Existing 10-digit numbers stay valid. |
| **N-3** ⚑ | Q-57 follow-up: the fee is frozen at payment, but the citizen can still edit the draft. If the **built-up area grows after payment**, the frozen fee no longer covers it. Should the citizen pay the difference before submitting, should area edits be locked after payment, or should we accept the frozen amount? | Require a **differential payment** before submit, computed with the frozen rule version. No refund if the area shrinks. |
| **N-4** | Q-63 follow-up: how are statuses 3–6 changed? Through an **Admin UI page**, or only through seed/migration by developers? May admins **add** new in-process statuses? | Admin UI page in B3 (rename, re-order, add, deactivate in-process statuses). System statuses are read-only. |
| **N-5** | The frontend keeps its live calculation by importing the **shared** `@noc/domain` + `@noc/rules-engine` packages. Is that acceptable, or must the frontend keep its own copy, with the backend libraries being backend-only? | Shared packages (no drift). The workflow engine is backend-only. |
| **N-6** | Should admins be able to edit the **FFE decision trees** and `height_limits` (today verbatim legacy rules, not editable), or only the tables and parameters (fees, approval level, renewal period, escape limits)? | Trees stay seed/deploy-managed. Tables and parameters are admin-editable. |
| **N-7** | Naming and packaging of the reusable engines. Keep the `@noc/` scope, or use a neutral scope (e.g. `@apfire/rules-engine`)? Publish to a private registry later, or keep them as workspace packages? | A neutral scope chosen by you. Workspace packages now, built to be publishable. |
| **N-8** ⚑ | **File volume.** About 25 documents per application × 100 000 per year. What is the expected average file size? At 1.5 MB this is about **3.75 TB/year**. Where will the storage root live, and what is the backup target? | Dedicated volume mounted at `/srv/noc/storage` in production, with a nightly incremental backup |
| **N-9** | Q-39 follow-up: snapshots are taken at submit, decision and archive. Do you also want **draft history** (a snapshot on every save)? | No. It would add about 10× storage for little value. |
| **N-10** | Should the workflow definitions support **per-step notifications** declared in the definition, like the legacy `workflow.rule` `alerts[]`? Or are fixed notifications on assignment, forwarding and final decision enough? | Fixed notifications now. The definition model reserves an `alerts` field. |
| **N-11** | At the final decision, should the certificate validity use the **renewal rule version in force at submit** or the **current** one? | The version recorded at submit, for consistency with what the citizen applied under |
| **N-12** | Escalation job schedule. Daily at 09:00 IST? Also on weekends and holidays? | Daily at 09:00 IST, every day |
| **N-13** | Browser support. IndexedDB and `BroadcastChannel` require current evergreen browsers. Any requirement for older browsers or locked-down government desktops? | Current Chrome, Edge and Firefox. Memory-only fallback otherwise. |
| **N-14** | Playwright E2E in CI. Does your CI provide Chromium (as this sandbox does at `/opt/pw-browsers`), or should the pipeline install it? | Pin `@playwright/test` 1.56.x and use a provided `PLAYWRIGHT_BROWSERS_PATH` |
| **N-15** | Should the demo-reset script also reset **uploaded files** of the demo data? | Yes. It moves them to `var/backups/storage-<ts>/`, and never deletes them. |
| **N-16** | Reports at 100 000 per year: is a short **server-side memo** (60 s, per report + filters + jurisdiction) acceptable, or must reports always be real-time? | A 60 s memo, bypassed with `?fresh=true` |
| **N-17** | Revision snapshots hold personal data (names, mobile numbers, Aadhaar last 4). Do they need a **retention limit** or a redaction policy? | Keep indefinitely (legal record). The citizen's account deletion does not purge them. |

⚑ = affects the schema or the contract.

## 9.3 Most important to answer before B1 starts

**N-2** (number format), **N-3** (fee after payment), **N-4** (statuses UI), **N-5**
(shared packages), **N-8** (storage volume). The others can be answered during B1 without
rework.

## 9.4 Questions raised by phase B2

| # | Question | Proposed default |
|---|---|---|
| **B2-1** ⚑ | **Challan payments.** The legacy portal treated a recorded challan as paid at once, and B2 does the same. Should the department verify the challan first, for example with a "challan verified" tick by the section officer before the file moves on? | Accept it at once (as legacy), and add a verification tick to the first scrutiny task in B3. |
| **B2-2** | **Payment gateway.** Is PayU the target? Are merchant sandbox credentials available? B2 simulates it (`PAYU…` reference, idempotent). | Keep the simulation through B3. Real integration (redirect + server-to-server callback + reconciliation job) is a separate work item. |
| **B2-3** ⚑ | **SMS and e-mail gateways.** Which providers (for example the NIC SMS gateway or an SMTP relay)? In India, SMS templates need DLT registration. Who owns the registered template ids? | B3 builds an SMTP driver and a configurable HTTP SMS driver. `log` stays the development driver. |
| **B2-4** | **Registration in production.** The temporary password is shown on screen only outside production. In production, should it be sent by **e-mail, SMS or both**? Or should registration send a **"set your password" link**, like the reset, with no temporary password at all? | A set-password link by e-mail. It is simpler and safer, and the flow already exists. |
| **B2-5** | **Citizen sessions.** Officers are signed out after 8 h idle. Citizens have no idle limit, only the 30-day refresh lifetime. Should citizens also have an idle timeout? | 7 days idle for citizens. |
| **B2-6** | **Officers' absolute session length.** 8 h idle, but up to 30 days in total. Should officers sign in again every day (for example a 12 h absolute limit)? | 12 h absolute for officers and admins. |
| **B2-7** | **Reset-link validity.** Currently 1 hour, single use. | Keep 1 hour. |
| **B2-8** | **Go-live passwords.** Should every account created by the production seed (officers, admin) be forced to change its password at first sign-in? | Yes in production, no in the demo seed. |
| **B2-9** ⚑ | **File retention.** When a draft's document is replaced or removed, or a draft is deleted, the document row is soft-deleted and the stored file is kept. Nothing deletes it yet. How long should such files be kept? | A B3 job purges them 30 days after they stop being referenced. Files of submitted applications are kept indefinitely. |
| **B2-10** | **Upload limits.** Application documents are PDF only, with 5 MB per file and 100 MB per application (`UPLOAD_MAX_BYTES`, `UPLOAD_MAX_PER_APPLICATION_BYTES`). Is 5 MB enough for scanned plans? Should photos (JPEG/PNG) be allowed for any document? | 10 MB per file, 250 MB per application, PDF only. |
| **B2-11** | **Virus scanning.** Is a malware scan of uploads mandated, for example ClamAV or a state data-centre scanner? | B3 adds a scanner port (no-op in development). Uploads are quarantined until scanned in production. |
| **B2-12** | **Revisions and fees.** A revised application keeps its number (revision + 1), and a new payment is only due if the area grows beyond what was paid (frozen rate). Is that right, or does a resubmission after rejection need a fresh fee? | As implemented: the same number, and only the differential is payable. |
| **B2-13** | **Declaration level without a parent.** A Declaration follows the level of the NOC it renews. When that NOC predates the portal, the citizen's chosen `noc_level` is used. Should the department confirm or correct that level at scrutiny? | Yes, through the "fire station / level" correction the department already has (B3). |
| **B2-14** | **Deployment target for B3 hardening.** Containers (Docker/Podman) or systemd services? Nginx in front (serving the Angular build and proxying `/api`)? Which OS? Is there a managed PostgreSQL, or the same host? | Podman/Docker images for the API, Nginx for the web build and TLS, and PostgreSQL 16 on a separate host with nightly `pg_dump` plus WAL archiving. |
| **B2-15** | **B3 priorities.** B3 covers department transitions, admin writes, server-side reports and escalations, the status admin page (N-4), integer ids on both sides, removal of `/portal/*` and of the mock layer, and Playwright suites for the three manual scripts. Should anything be pulled forward or dropped? | The order as listed, with department transitions first so that a file can be completed end to end. |

⚑ = affects the schema, the contract or an external dependency.

## 9.5 Questions raised by phase B3 (answered — see §9.1)

| # | Question | Proposed default |
|---|---|---|
| **B3-1** | **"Decided files" in Monitoring at volume.** With 300 000 applications the list of decided files of the busiest officers takes 0.6–0.75 s (every other screen is under 0.5 s). Should that view default to a date window, for example decisions of the last 12 months, with older files found through Search? | Default to the last 12 months, with a "show all" option. |
| **B3-2** | **Long report lists.** On screen, the SMS and rating lists show the 5 000 most recent rows, the pendency and overdue lists the 500 longest-pending files per type, and the escalation preview the 500 most overdue items; the totals and the CSV export cover everything. Is that acceptable for the DG dashboard and the other reports? | Yes. |
| **B3-3** ⚑ | **Large CSV exports.** The applications report (every block of every application) takes about 7 s for 300 000 applications and is built in memory. Do you expect exports of that size to be common? If so, should large exports run as a background job that e-mails a download link? | Stream the CSV (no memory peak) in the next phase; a background job only if exports take more than a minute. |
| **B3-4** | **Version history in the admin screens.** Every publication of fees, approval levels, renewal periods and workflows is an immutable version, and the API can list and restore them (`/config/rules/:code/versions`, `/config/workflows/:code/versions`, `…/restore/:version`). The screens only show the current version. Add a "History / restore" panel? | Yes — a small addition to Rules & Fees and the workflow editor. |
| **B3-5** | **Where the admin "try it" previews run.** The rule tester, the workflow validation and the officer simulator run in the browser with the same library the server uses (instant feedback, Q-14); the server validates again on save. Keep that, or call the server (`/rules/sets/:code/evaluate`, `/config/workflows/validate`, `…/simulate`) so the preview is guaranteed to be the server's? | Keep the browser (same code, no drift). |
| **B3-6** ⚑ | **Head Office queues.** Every Head Office file passes through one DFS, one DFS-CD, one ADFS and the DG. At 100 000 applications a year these officers hold thousands of open tasks (the load test gives the DFS ~4 300). Will there be several officers (desks) per Head Office role? If so, how should files be shared — least-loaded, round robin, by district? | Allow several officers per role and assign the least-loaded one; the admin can still reassign. |
| **B3-7** | **Second-level escalation.** Reminders go daily to the officer and the issuing authority. Should an item still overdue after N reminders also go to a higher authority (for example the DG)? | Add a second level (after 3 reminders, to the DG) in the next phase. |
| **B3-8** | **Audit retention.** Every change writes an audit entry (about 15–20 per application, so ~2 million a year) with the user, the address and the browser. How long must they be kept, and who may read them (today: the admin only)? | Keep 7 years; partition the table by year when it passes 10 million rows; admin-only. |
| **B3-9** | **Deleting submitted applications.** The admin may delete any application (legacy deleteOldFiles). Drafts' files are purged after 30 days; the files of a **submitted** application that the admin deletes are kept indefinitely (B2-9). Should they follow the 30-day purge as well, or should submitted applications not be deletable at all? | Submitted applications cannot be deleted; only drafts (and returned / rejected files older than a retention period). |
| **B3-10** | **Citizen session of 1 day.** A citizen filling a long application over several days signs in again each day (the draft is saved). Is 1 day what you want, rather than the proposed 7 days? | As decided: 1 day. |
| **B3-11** | **Background jobs in production.** The scheduler runs inside the API (an advisory lock lets one instance run each job). Is that acceptable, or should jobs run in a separate worker process/container? | In the API with the lock, until a job needs more than a few seconds. |
| **B3-12** ⚑ | **Client address behind the reverse proxy.** The rate limits and the audit trail use the client's address. Behind a proxy the API must trust `X-Forwarded-For` from that proxy only (today it trusts any). What is the proxy's address / network? | Set `trustProxy` to the proxy's address in production. |
| **B3-13** | **API documentation in production.** `/docs` (OpenAPI + Swagger UI) is on by default. Keep it on in production (internal network only), or off? | Off in production (`ENABLE_DOCS=false`). |
| **B3-14** | **Reports for whom.** Every officer (and the monitoring role) can open every report and export it as CSV, with the applicants' names and mobile numbers. Should reports be limited to the officer's jurisdiction, or to certain roles? | Department-wide for the monitoring role, DG and DFS; jurisdiction-limited for district and station officers. |

⚑ = affects the schema, the contract or an external dependency.

