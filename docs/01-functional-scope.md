# NOC Portal — Functional Scope

> **Note (backend phase B3).** This document was written when the portal ran on JSON fixtures with a
> mock API layer (writes simulated in `localStorage`). Since backend phase B3 the portal runs entirely
> on the NOC backend: the fixtures are the backend's seed (`backend/seed/data`), the mock layer is gone,
> and the API catalogue lists REST routes. The functional content below still holds; for the backend,
> the data model as built and the API see [`backend/`](./backend/00-README.md) and
> [`03-api-catalog.md`](./03-api-catalog.md).

This document describes **what the Angular application does**, and how that relates to
the legacy AngularJS "FireNOC" portal (A.P. State Disaster Response and Fire Services
Department) it replaces. The legacy behaviour was reverse-engineered from `modules/**`,
`app/fireApp.js`, `script/*.js`, `uploads/rules/*` and the JSON stubs in `apis/*.txt`.
Where the new application deliberately differs from the legacy one, the difference is
stated (see also the decision log in `04-migration-plan.md`).

The legacy code is the source of truth for business rules. If something is not in the
legacy code and not listed here as a deliberate addition, it should not be in the new
application.

## 1. Purpose

Property developers ("citizens") apply to the Fire Services Department for **No Objection
Certificates (NOC)** for constructing and occupying buildings. The Department reviews each
application through several levels of staff, inspects the site, and issues, returns or
rejects the NOC. Issued Occupancy NOCs are renewed periodically.

## 2. Actors

| Actor | Portal | What they do |
|---|---|---|
| **Citizen / Builder** | `/citizen` | Registers, applies for NOCs, uploads documents, pays fees, tracks status, downloads certificates, rates the service. |
| **Department officer** (DG, DFS, DFS-CD, ADFS, DFO, RFO, SFO, Section, View-only) | `/dept` | Works the tasks assigned to them, writes notes/reports, decides, searches and reports. |
| **Administrator** | `/admin` | Manages accounts, rules and fees, workflows, SLAs and escalations, and can search/delete applications. |
| **External portals** (SDP / MAUD) | — | Only a data flag (`host_name`) on an application. Never functional in the legacy code; not migrated. |

All three portals are one single-page application with lazy-loaded route groups and a
separate shell (header/navigation) per portal. There is no real authentication: a mock
session decides which portal a user lands in.

## 3. Application types

| Code | Name | Notes |
|---|---|---|
| `P` | **Provisional NOC** | Required before construction. Multi-block, multi-floor application. |
| `O` | **Occupancy NOC** | Required before occupying a completed building. Modes: `O` (has a Provisional NOC on the portal), `M` (manual — paper Provisional NOC), `N` (no Provisional NOC). |
| `R` | **Renewal of Occupancy NOC** | Periodic renewal of an issued Occupancy NOC. Modes `O` / `M`. |
| `D` | **Declaration for Renewal** | Simplified self-declaration instead of a full renewal. (Legacy alias `RO` is kept only for data compatibility.) |

The "Existing Building / Pilot" application (`appl_type O` + `appl_mode E`) is **not part of
the new application**: no type, mode, route, template, fixture or UI remains, and a fixture
test asserts that.

The type and mode decide which Fire Fighting Equipment columns are shown and whether they
are text or input (`application-types.json` → `mode[].ffe[]`):

| Type · mode | Columns |
|---|---|
| P | Required (text) |
| O · O | Proposed (text) + Provided (input) |
| O · M, R · M | Proposed (input) + Provided (input) |
| O · N | Required (text) + Provided (input) |

## 4. Citizen journey

1. **Register / Login / Forgot password.** Registration uses the e-mail as the username and
   issues a temporary password. Deactivated accounts cannot log in. Login lands on the
   portal of the account's role.
2. **Dashboard.** "Apply for…" launchers (one per type, each with an instructions dialog) and
   **My Applications** with type, number, site, approval level, status badge and contextual
   actions: View, Acknowledgement, Download NOC, Rejection/Return letter, Revise, Apply for
   Occupancy (after an issued Provisional), Apply for Renewal (after an issued Occupancy),
   Delete (drafts only), Rate, and upload of documents requested by the department.
3. **Application form** (§4a). Save any number of times, then Submit (§4b).
4. **Print views.** Acknowledgement, fee receipt, the NOC in the legacy legal format for the
   type, the display certificate (Occupancy / Renewal), and the return / rejection letter.
5. **Respond to the department.** Documents requested by an officer are listed on the
   application; the citizen uploads each one with a comment.
6. **Track progress.** The application page shows the current stage ("Pending with …") and
   a stage stepper of the department workflow (names only, no internal notes).
7. **Rate the service.** 1–5 stars plus a description, offered on every completed
   application (Issued = status 7, Rejected = status 9).
8. **Change password / Logout** from the user menu in the header.

### 4a. The application form

Application pages: **Application → Blocks → Documents → Fee & Submit** (Declaration:
Application → Documents → Fee & Submit). Under *Blocks*, each block has its own flow:
**Block Details → Floors → Means of Escape → Fire Fighting Equipment → Plans**, so all the
information of one block is entered together, block by block (the legacy block table with
one set of buttons per block).

- *Application*: site, district and fire station, plot area and perimeter, licensing
  authority, correspondence address, builder, technical parties (builder, architect,
  structural engineer, electrical contractor, fire-safety contractor). Occupancy: the
  Provisional NOC reference (portal / manual Rc. No. / not applied + municipal approval
  date) and the Provisional NOC conditions checklist. Renewal / Declaration: the Occupancy
  NOC reference.
- *Blocks*: one card per block (occupancy, height, floors, area, approval level, status of
  its five pages), *Add Block* (Normal, or Tower + Podium), *Delete Block*.
- *Block Details*: block type, occupancy and sub-type, height, permissible height, beds
  (hospitals), multiplex / miniplex, road widening, surroundings with the front side, open
  spaces required (by the rules) versus proposed with projections.
- *Floors*: legacy floor types and occupancies, fixed seats, NBC occupant load, "as per
  PNOC" columns.
- *Means of Escape*: staircases and ramps with from/to floor and minimum widths, NBC counts,
  per-floor aggregate width, travel and dead-end distance, doors, exits and head-room,
  refuge areas, fire lifts, car parking.
- *Fire Fighting Equipment*: the legacy floor-wise grid with a building "Total" row, a
  "Minimum required" summary, notes, NBC Table 7, a confirmation tick and *Add Fire
  Fighting Equipment*.
- *Plans*: site, section, elevation and floor plans.
- *Documents*: supporting documents plus the plan status of every block.
- *Fee & Submit*: fee breakdown, online (simulated) or challan payment, verification tick,
  Submit.

Navigation: one route serves both levels, so the working copy survives while moving between
pages. Save is in the header and footer; page changes save first when possible; leaving with
unsaved changes asks for confirmation. Pages are never locked.

### 4b. Save versus Submit

- **Save** can be done any number of times and needs only the **Site Name** and the **Site
  Address** (legacy `SaveApplication`). A new application exists only in the browser until
  its first Save.
- Validation messages are shown on the form **at all times** but **never block navigation**
  between pages.
- **Submit** validates the whole application. Problems are listed grouped by application
  page and by block page, each with a *Go to page* link. Otherwise a single-page
  **Confirmation before Submission** shows the applicant's undertakings (required ticks:
  P = 6, O / R / D = 3). **Confirm & Submit** numbers the application and starts the
  department workflow.
- Open-space shortfalls block submission for P, O and R.

### 4c. Business rules

| Rule | Legacy source | New implementation |
|---|---|---|
| Fire Fighting Equipment — 12 decision trees (one per equipment id), extinguisher type, riser width, other notes | `uploads/rules/1..12.rule`, `ffe_type.rule`, `riser_width.rule`, `other_notes.rule` | Verbatim JSON trees in `assets/data/rules/**`, evaluated by `core/domain/rule-engine.ts` and `ffe.ts` (floor-wise items per floor, building items per block, cumulative totals, notes) |
| Occupant load (Table 20), stairs by load, escape counts and widths (NBC 2016), doors, fire lifts, open spaces (G.O.Ms.No.119, including the formula beyond 55 m, towers/podiums, multiplex/miniplex, road widening), names, `_O` comparisons | `script/commonrules.js` (29 `Common_*` functions) | `core/domain/commonrules.ts`, a 1:1 port |
| Maximum permissible height per occupancy | `uploads/rules/validations/height.rule` | `rules/height-limits.json` |
| Renewal period | `validations/declaration.rule`, `images/periodicityofrenewal.png` | `config/renewal-rules.json` — admin-editable |
| Approval level (Head Office / Regional / District) | server side (`MSB.rule`) | `config/delegation-rules.json` — admin-editable (see below) |
| Fee | commented code in `applicationController.js` | `config/fee-config.json` — admin-editable; **no minimum fee** |

Approval-level rules (ordered, first match per block; the application takes the highest
level of its blocks): Hazardous, Storage and Industrial → Head Office; multiplexes
(Assembly D6 marked "Is Multiplex") → Head Office; Residential apartments (A4) ≥ 18 m →
Head Office; any other building ≥ 15 m → Head Office; > 10 m → Regional; otherwise District.
All of these are configuration, none is hard-coded.

Fees: rate per sq.m per application type; the Occupancy-without-Provisional additional fee
(per sq.m) and yearly penalty (per sq.m per year); the flat Declaration fee; the portal
charges.

## 5. Department journey

1. **Dashboard.** *My tasks* (active tasks assigned to the officer, grouped by task, with
   days pending and SLA, button = the task's action label) and *Monitoring* (applications in
   the officer's jurisdiction in which the role takes part, grouped by stage label). Filters
   by type, level, district and text. A feedback panel shows the average citizen rating by
   period. This replaces the legacy `RoleStatuses.txt` buckets, which are now derived from the
   workflows.
2. **Processing page** (`/dept/applications/:id`, the legacy `fulledit2`). Application
   summary and quick actions; a stage stepper with the officer and state of each task; the
   officer's task form inline; documents; SMS log.
   - Forms: Section Note, Inspection Report (per block, with a computed recommendation),
     Committee Concurrence, RFO Note, questionnaire notes (ADFS, DFS-CD, DFS, DFO), and the
     Final Decision.
   - Actions: save draft, submit, send back (to the previous stage only), bypass an officer,
     change an officer, request documents from the citizen, upload a department document,
     send an SMS (simulated), change the fire station (while Submitted), update the licensing
     authority (final stage only).
   - **Final Decision**: Approve / Return / Reject (or order an Inspection for Declarations),
     remarks to the applicant, optional "Copy to", a live preview of the NOC or letter in the
     legal format, and a **mandatory signed copy** before submit. Only the final officer
     returns or rejects. Once the processing SLA is crossed the final officer can only approve
     or reject (legacy `rtimeout`).
3. **Search.** Global application search, opening the department view.
4. **Reports** (all with filters, print and CSV where relevant): Pendency (DG dashboard with
   charts), Statistics, Consolidated status, Applications, Overdue, SMS, Feedback, Challan,
   Received/Approved by district, and Level-wise.
5. **Print note.** A task's note in its legacy print layout.
6. **Change password / Logout.**

Legacy screens that were prototypes or dead code are not migrated: `fulledit.html`,
`receive.html` / `inwardlist.html`, `insrpt.html` / `inspectlist.html`, `display_*.html`,
the `statusupdate.aspx` flow, *Pull Back*, *Recalculate Equipment*.

### 5a. Workflow (configuration, not code)

There is one workflow per **application type × approval level** (12 in total). Each is a list
of **stages**; each stage has one or more **tasks** that run in parallel (performing role,
form, action label, permissions); the last stage has exactly one task, the final decision.
Each stage sets the status the citizen sees (2–6) and a queue label. The legacy sequences
are the shipped defaults:

| Type · Level | Stages → final decision |
|---|---|
| P · Head Office | Section note ∥ Inspection report ∥ committee concurrence → RFO note → ADFS note → DFS-CD note → DFS note → **DG** decides |
| O · Head Office | As P · Head Office → **DG** |
| R · Head Office | As above → **DFS** decides (renewals are signed by the Director) |
| P / O / R · Regional | Inspection report (SFO) → DFO note → **RFO** decides |
| P / O / R · District | Inspection report (SFO) → **DFO** decides |
| D · any | Issuing authority accepts / returns / rejects, or orders an inspection (SFO) and decides after it. A Declaration is processed at the level of the Occupancy NOC it renews. |

Rules that apply to every workflow:

- **Officers** of a file are the active officers of each role associated with the fire
  station of the property (Head Office officers are associated with *all stations*). No load
  balancing; if several match, the lowest id is used and the admin simulator warns about it.
- **Send back** goes only to the previous stage and creates a new active task for that
  officer with the data carried over.
- **Versioning**: saving a workflow creates a new version; an application keeps the snapshot
  it was submitted with. A Revise + resubmit archives the run and starts a new one with the
  current version.
- **SLAs** (separate admin page): processing days, inspection days and per-step days per
  workflow, plus escalation recipients (the officer and / or the issuing authority) and a
  reminder interval.

## 6. Administrator journey

- **Workbench.** Send escalations (preview of overdue items, recipients, items already
  reminded inside the interval are not repeated, every run logged), and *Reset demo data*.
- **Applications — Search & Delete.** Filter by text (number, site, builder, owner, district),
  type, status, drafts only and idle-for-N-days (with a "stale drafts, 180+ days" preset);
  delete one or many, with a warning when the selection includes non-draft applications.
- **Citizen accounts.** Search, Modify profile (username is immutable), Change password,
  Deactivate / Reactivate. The admin never creates citizens; they self-register.
- **Department users.** Search by role, Add (temporary password), Modify, Reset password,
  Deactivate / Reactivate, and the **fire-station association** (all stations, or stations
  grouped by district and region). Deactivating an officer with open tasks requires handing
  them over to an officer of the same role.
- **Rules & Fees.** Fee configuration, approval-level rules and renewal-period rules, each
  with a live "try it" preview.
- **Workflows.** A matrix of the 12 workflows, an editor (stages, tasks, roles, forms, labels,
  permissions, decision outcomes), a flow preview, a simulator, validation, versions, and
  *Restore default*. Admins choose the form of a step but cannot edit the forms themselves.
- **SLA & Escalations.** SLA per workflow and the escalation settings.
- Every user, in every portal, can change their own password.

## 7. Cross-cutting concerns

- **Uploads** (plans, challans, undertakings, inspection photos, requested documents) are
  simulated: only metadata (name, size, type, timestamp) is stored.
- **Payment** is simulated: *Pay Online* succeeds immediately and records a transaction id;
  *Challan* accepts the bank challan fields.
- **Status model**: a numeric lifecycle status (below) layered with a role-relative queue
  label and action derived from the workflow.

  | id | Meaning |
  |---|---|
  | 1 | Draft |
  | 2 | Submitted |
  | 3 | Inspected |
  | 4 | Reviewed (ADFS) |
  | 5 | Reviewed (DFS-CD) |
  | 6 | Pending Final Approval |
  | 7 | Approved / Issued |
  | 8 | Returned with Comments |
  | 9 | Rejected |

- **Authorization** is a mock session with route guards by portal and role. The legacy
  server-trusted session cookie and `CanAccess()` have no equivalent.

## 8. Out of scope (by design)

- A real backend, real authentication, sessions or persistence. Everything runs against
  local JSON fixtures plus `localStorage`.
- Live PayU payment integration.
- Byte-identical certificates. The legal **wording and structure** of the Provisional,
  Occupancy and Renewal NOCs, the rejection letter, the display certificate and the NOC
  conditions are reproduced verbatim, but rendered as clean HTML print previews (no
  images or barcodes).
- Dropped on purpose: the Goa format (`final_noc_g`), the one-off format (`final_noc_ic`) and
  the NBC 2005 wording (`final_noc.html` / `noc_terms.html`). All NOCs use the NBC 2016 format.
- The NBC reference partials (`table*.html`) are shown as reference content (Table 7 next to
  the FFE grid); the calculations they describe are implemented (§4c).
- A questionnaire editor for the department forms.
- The SDP / MAUD integration module (always an empty stub).
