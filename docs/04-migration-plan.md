# NOC Portal — AngularJS → Angular Migration: Approach, Decisions and Verification

> **Note (backend phase B3).** This document was written when the portal ran on JSON fixtures with a
> mock API layer (writes simulated in `localStorage`). Since backend phase B3 the portal runs entirely
> on the NOC backend: the fixtures are the backend's seed (`backend/seed/data`), the mock layer is gone,
> and the API catalogue lists REST routes. The functional content below still holds; for the backend,
> the data model as built and the API see [`backend/`](./backend/00-README.md) and
> [`03-api-catalog.md`](./03-api-catalog.md).

This document records **why** the Angular application is built the way it is, the decisions
taken against the legacy behaviour, and how to verify the result. What the application does is
in `01-functional-scope.md`; the data in `02-domain-model.md`; the mock API in
`03-api-catalog.md`; the code layout in `05-architecture.md`.

## 1. Goals

1. Replace the AngularJS 1.x application, which has several HTML entry points, with one modern
   **Angular application** (standalone components, lazy-loaded route groups per portal).
2. Replace hand-rolled RPC calls (`$http.get('x.aspx?...')`) with a clean **mock API layer**
   driven by JSON fixtures and reached only through one catalog file.
3. Deliver a consistent, accessible, responsive UI (the legacy one is Bootstrap 3 with raw
   glyphicons, `alert()` / `confirm()` dialogs and no design system) **without changing the
   business behaviour** it must preserve.
4. Treat the **legacy code as the source of truth** for rules, calculations, formats and
   workflow. Nothing is invented: a rule that is not in the legacy code is either configuration
   an administrator can edit, or a decision recorded in §4.

## 2. Toolchain

- Angular **21.2.x**, pinned exactly in `package.json`, with the `@angular/build` esbuild
  application builder, standalone components and functional guards.
- TypeScript in strict mode (5.9).
- Unit and component tests with `ng test`, which runs **Vitest** on Node + jsdom — no browser is
  needed, so tests run in CI or a sandbox without a display.
- ESLint (`angular-eslint`) and Prettier.
- No UI component library: a small SCSS design system (`src/styles/`).
- Angular 22 requires Node 22.22.3 or newer (or 24.15+). Angular 21.2.x supports Node
  ^20.19, ^22.12 and >=24, so it installs on a wider range of hosts. Moving to Angular 22 later
  is a routine `ng update` once the host Node is upgraded; nothing in the architecture is
  version-specific.

## 3. Approach

- **Fixtures instead of a backend.** Every API call resolves to a JSON file under
  `public/assets/data/**`; writes are simulated in `localStorage` (see `03-api-catalog.md`).
- **Business rules are pure code.** All calculations live in `src/app/core/domain` as pure
  functions that never touch Angular or storage. The same code runs in components, in unit
  tests and in the fixture generator.
- **Rules as data where the legacy had data.** The FFE decision trees are the legacy `.rule`
  files converted verbatim to JSON. Fees, approval levels, renewal periods, workflows and SLAs
  are admin-editable configuration, not constants in code.
- **One store per aggregate.** All applications in one store, all accounts in another, so the
  citizen list, department queue and admin search are projections of the same data.
- **Traceability.** Field names stay close to the legacy ones, and every catalog entry names
  the legacy endpoint it replaces.

## 4. Decision log

Decisions taken against the legacy behaviour, with where each is implemented.

### Scope and removals

| # | Decision | Where |
|---|---|---|
| D-1 | The **Existing Building / Pilot** application (`appl_type O` + `appl_mode E`) is dropped completely: lookups, model types, fixtures, UI and docs. A fixture test asserts no trace remains. | `application-types.json`, `lookup.models.ts`, `core/domain/fixtures.spec.ts` |
| D-2 | **NBC 2005** wording (`final_noc.html`, `noc_terms.html`), the **Goa** format (`final_noc_g`) and the one-off format (`final_noc_ic`) are dropped. All NOCs use the NBC 2016 formats. | `shared/certificates/**`, `noc-terms.json` |
| D-3 | Prototype and dead legacy screens are not migrated (see `01-functional-scope.md` §5). | — |
| D-4 | The SDP / MAUD integration is only a data flag. | `host_name` |
| D-5 | A questionnaire editor is not built. The admin only chooses which form a workflow step uses. | `config/forms.json` read-only |

### Accounts and administration

| # | Decision | Where |
|---|---|---|
| D-6 | **Admin account management**: citizens — Modify, Change Password, Deactivate / Reactivate (admins never create citizens); department users — Add, Modify, Reset Password, Deactivate / Reactivate. Login honours deactivation and changed passwords. Registration creates a real account with a temporary password. | `core/accounts`, `features/admin/citizen-accounts`, `features/admin/dept-users` |
| D-7 | The admin **stale-applications grid is replaced by Search & Delete** (text, type, status, drafts-only and idle-days filters, a stale-drafts preset, single and bulk delete with a non-draft warning). | `features/admin/applications` |
| D-8 | **Change own password** for citizens, officers and admins, from a user menu (name ▾ → Change password / Logout) in the top bar. | `features/account/change-password`, `shared/ui/portal-header` |

### Application form

| # | Decision | Where |
|---|---|---|
| D-9 | **Save needs only Site Name and Site Address** (legacy `SaveApplication`). A new application is created on its first Save. Validation messages are always visible and **never block** moving between pages; there is no autosave and no step gating. | `application-draft.store.ts`, `wizard.*`, `saveProblem()` |
| D-10 | **Save versus Submit.** Submit validates everything and lists problems grouped by page with *Go to page*, or opens the single-page **Confirmation before Submission** (undertakings), whose *Confirm & Submit* numbers the application and starts the workflow. | `step-submit.*`, `confirm-application.*`, `shared/application-sheet` |
| D-11 | **Block-wise flow** (legacy block table → per-block pages): *Block Details → Floors → Means of Escape → Fire Fighting Equipment → Plans*, with its own stepper and per-page open items. | `wizard.*`, `step-blocks-list`, `step-block-*`, `applicationFormMatcher` |
| D-12 | **Fire Fighting Equipment from the legacy rule trees**, evaluated by a rule engine, with the legacy floor-wise grid, building "Total" row, "Minimum required" summary, notes and NBC Table 7. | `rules/**`, `rule-engine.ts`, `ffe.ts`, `shared/ffe/ffe-grid` |
| D-13 | **All 29 `Common_*` rules** are ported 1:1 and used (open spaces per G.O.Ms.No.119 including the formula beyond 55 m, tower / podium, multiplex / miniplex, road widening, occupant load, stairs, escapes, doors, lifts, names, `_O` comparisons). | `commonrules.ts` |
| D-14 | The legacy undertakings on the confirmation page were not bound (a directive typo in the legacy template). They are now **required ticks** (P: 6, O / R / D: 3, as in the legacy `SubmitAppl`). | `undertakings.json` |
| D-15 | Open-space shortfalls **block submission** for P, O and R. | `validation.ts` |

### Configurable business rules

| # | Decision | Where |
|---|---|---|
| D-16 | **Fees are configuration**: rate per sq.m per type, additional fee and yearly penalty (Occupancy without Provisional), declaration fee, portal charges. **No minimum fee** — it is not in the legacy code. | `config/fee-config.json`, Admin → Rules & Fees |
| D-17 | **Approval levels and renewal periods are ordered, admin-editable rules** with a live tester. Industrial joins Hazardous and Storage → Head Office; the multiplex rule (legacy `MSB.rule`) applies only to blocks marked *Is Multiplex*. | `delegation-rules.json`, `renewal-rules.json`, `features/admin/rules-config` |
| D-18 | **Certificates in the legacy legal formats** per type (Provisional, Occupancy, Annual Periodical Renewal, rejection, display certificate) with the verbatim NOC conditions; items for buildings above 60 m appear only when applicable. | `shared/certificates/**`, `noc-terms.json`, `certificate.ts` |
| D-19 | **Rating** of every completed application (Issued 7 / Rejected 9), with the average by period on the department dashboard. | `rate-dialog`, `star-rating`, `feedback.ts` |

### Department workflow

| # | Decision | Where |
|---|---|---|
| D-20 | **The workflow is configuration, not code**: one workflow per type × approval level (12), edited by the administrator, versioned, with each application keeping the snapshot it was submitted with. The legacy sequences are the shipped defaults. | `config/workflows.json`, Admin → Workflows |
| D-21 | **Officers are those of each role associated with the fire station of the property.** No load balancing; Head Office officers are associated with all stations; the first (lowest id) match is used and the admin simulator warns about duplicates. | `users.json` `stations[]` / `all_stations`; `officersFor()` |
| D-22 | **Sequences.** Regional: SFO inspection → DFO note → RFO decides. District: SFO inspection → DFO decides. Head Office renewals are decided by the DFS. At Head Office the Section note and the Inspection report run in parallel, and committee-member concurrence is required for all types. | `workflows.json` |
| D-23 | **Declarations** are processed at the level of the Occupancy NOC being renewed. For a paper NOC the citizen selects *Occupancy NOC issued at*. | `declarationLevel()`, `noc_level` |
| D-24 | **Regions**: ER = districts 1–6, SR = districts 7–13. | `regions.json` |
| D-25 | **Return to the citizen only by the final officer.** After the processing SLA is crossed, the final officer can only approve or reject (legacy `rtimeout`). | `allowedOutcomes()`, `sla.json` |
| D-26 | **Send back only to the previous stage.** | `previousStageIndex()`, `sendBack()` |
| D-27 | **Escalations** go to the officer and / or the issuing authority, at a configurable reminder interval. | `sla.json`, `escalations.ts` |
| D-28 | A **signed copy is mandatory** before a decision is submitted (simulated upload). | `decide()` |
| D-29 | **All ten reports** plus the DG dashboard charts, with filters, print and CSV. | `reports.ts`, `features/dept/reports` |

### Corrections to legacy behaviour

| # | Decision | Where |
|---|---|---|
| D-30 | Legacy bug fixed: `Common_StairsbyLoad` always returned 0 for institutional floors. | `commonrules.ts` |
| D-31 | The occupancy-conditions checklist text is derived from the NOC conditions (the legacy list came from the database). | `occupancy-conditions.json` |
| D-32 | Refuge area (0.3 sq.m per person of two floors, minimum 15 sq.m, above 24 m) and travel-distance limits were server-side in the legacy app. They are data. | `escape-rules.json` |
| D-33 | Yard-hydrant rule results (30 / 45) are interpreted as spacing along the plot perimeter (note `YH_n`). | `ffe.ts` |
| D-34 | Rejected applications (status 9) can be rated, as well as issued ones (7). | `feedback.ts` |

## 5. Engineering practices

- **One API catalog, one mock layer.** No feature code imports `HttpClient`; ESLint enforces it.
- **Strict TypeScript**, no `any` in committed domain models.
- **Feature folders**, standalone components, typed route `data` and guards, no NgModules.
- **Design tokens** (`styles/_tokens.scss`) for colour, spacing and typography; status colours
  and badges come from one map and one component.
- **Business logic in `core/domain`**, covered by unit tests without Angular.
- **Tests run against the real fixtures** (`provideFixtureBackend()`), so they fail if the seed
  data drifts from the model or the rules.

**Definition of done** for any change: `npm run lint`, `npm test` and `npm run build` pass; the
relevant part of §6 is walked by hand; and the docs are updated if behaviour, data shape or an
endpoint changed.

## 6. Verification

### Automated

```
cd frontend
npm install
npm run lint
npm test            # Vitest via ng test
npm run build       # production bundle
npm run fixtures    # regenerate seeds; fails if a seeded submission would not validate
```

### Manual smoke checklist

Log in from the demo-account chips on the login screen (password `demo`).

1. **Citizen.** Apply for a Provisional NOC. Fill only Site Name and Site Address and Save; the
   application gets an id. Move freely between pages while validation messages stay visible.
2. Add a block, set a use type, floors and sides. Check required open spaces and the FFE grid
   fill in from the rules.
3. On *Fee & Submit*, press Submit with problems: the dialog groups them by page and block
   page. Fix them, open the confirmation page, tick the undertakings, *Confirm & Submit*. The
   application gets a number and appears as Submitted.
4. Reload the browser. The application is still there.
5. **Department.** Log in as the officer of the first task. The file appears under *My tasks*.
   Submit the note, and check that the next stage opens and the citizen's status changes.
   Try *Send back* (only to the previous stage) and *Bypass*.
6. **Final decision.** As the final officer, check the live NOC preview, that submit is blocked
   without a signed copy, then approve. The citizen can now download the NOC.
7. **Reject / return** a second file and check the letter and that the citizen can *Revise*.
8. **Admin.** Change a fee rate and an approval-level rule and check the live tester and the
   fee on a new draft. Open Workflows, edit a stage, save (version + 1), and confirm an
   in-process file keeps its old snapshot. Open SLA & Escalations and preview escalations.
   Deactivate an officer with open tasks and confirm the hand-over dialog.
9. **Reports.** Open each report, apply a filter, export CSV.
10. **Reset demo data** from the admin workbench and confirm the seeds come back.
11. Resize to a mobile width: all three portals reflow without horizontal scrolling.

## 7. Known limitations

- No real authentication, authorization, persistence or payment.
- Uploads store metadata only.
- The workflow forms are fixed; only the choice of form per step is configurable.
- Certificates are HTML print previews, not the legacy PDFs.
