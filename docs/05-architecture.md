# NOC Portal — Angular Application Architecture

> **Note (backend phase B3).** This document was written when the portal ran on JSON fixtures with a
> mock API layer (writes simulated in `localStorage`). Since backend phase B3 the portal runs entirely
> on the NOC backend: the fixtures are the backend's seed (`backend/seed/data`), the mock layer is gone,
> and the API catalogue lists REST routes. The functional content below still holds; for the backend,
> the data model as built and the API see [`backend/`](./backend/00-README.md) and
> [`03-api-catalog.md`](./03-api-catalog.md).

## Toolchain

- Angular **21.2.x** (standalone components, the `@angular/build` esbuild application builder,
  functional route guards), pinned exactly in `package.json`.
- TypeScript in strict mode.
- `ng test` runs **Vitest** on Node + jsdom. No headless browser is needed, so tests run in CI
  or a sandbox without a display server.
- ESLint (`angular-eslint`, with the architectural rule below) and Prettier.
- No UI component library. A small SCSS design system lives in `src/styles/`.
- Node: Angular 21.2.x supports Node ^20.19, ^22.12 and >=24 (see `04-migration-plan.md` §2).

## Folder structure

```
frontend/
├── public/
│   └── assets/
│       └── data/                       # all JSON "API" fixtures (see 03-api-catalog.md)
│           ├── lookups/*.json          # master data, NOC conditions, undertakings, NBC Table 7
│           ├── rules/ffe/{1..12}.json  # legacy FFE decision trees (uploads/rules/*.rule, verbatim)
│           ├── rules/*.json            # ffe-type, other-notes, riser-width, height-limits trees
│           ├── config/*.json           # ADMIN-EDITABLE: fee-config, delegation-rules, renewal-rules,
│           │                           #   workflows, sla;  forms (read-only)
│           ├── auth/users.json         # ALL accounts (citizen / dept / admin)
│           ├── applications/applications.json   # ALL application aggregates
│           └── admin/escalations.json
├── src/
│   ├── app/
│   │   ├── core/
│   │   │   ├── api/
│   │   │   │   ├── api-endpoints.ts           # the single API catalog
│   │   │   │   ├── api-client.service.ts      # generic fetch + mock write-through
│   │   │   │   └── mock-persistence.service.ts
│   │   │   ├── auth/ (auth.service, auth.guard, role.guard)
│   │   │   ├── accounts/accounts.service.ts   # account store operations (register, admin management)
│   │   │   ├── domain/                        # PURE business rules, no Angular:
│   │   │   │   ├── rule-engine.ts             #   evaluator of the legacy .rule decision trees
│   │   │   │   ├── commonrules.ts             #   1:1 port of script/commonrules.js
│   │   │   │   ├── ffe.ts                     #   floor-wise / building FFE grid from the rule trees
│   │   │   │   ├── application-rules.ts       #   fees, approval level, renewal period, action rules
│   │   │   │   ├── validation.ts              #   save and submit validation (messages shown on the form)
│   │   │   │   ├── certificate.ts             #   facts and wording of the legal documents
│   │   │   │   ├── workflow.ts                #   workflow engine: validation, officers, runs, queues, SLA, decisions
│   │   │   │   ├── task-forms.ts              #   note / report form shapes, defaults, validation, recommendation
│   │   │   │   ├── reports.ts                 #   report aggregations + CSV
│   │   │   │   ├── escalations.ts             #   SLA-based escalations
│   │   │   │   └── config-rules.ts, feedback.ts, documents.ts, application-factory.ts, dates.ts, password.ts …
│   │   │   ├── models/                        # domain TypeScript interfaces
│   │   │   └── lookups/lookup.service.ts
│   │   ├── layout/ (auth-shell, citizen-shell, dept-shell, admin-shell)
│   │   ├── features/
│   │   │   ├── auth/ (login, register, forgot-password)
│   │   │   ├── account/ (change-password — all portals)
│   │   │   ├── citizen/ (dashboard, application-detail, rate-dialog,
│   │   │   │             wizard/ incl. confirm-application, print/)
│   │   │   ├── dept/ (dept-workflow.service, dashboard [My tasks / Monitoring / feedback],
│   │   │   │          application-view [processing page], forms/ [section-note, inspection-report,
│   │   │   │          committee-concurrence, rfo-note, questionnaire, final-decision],
│   │   │   │          search, reports/)
│   │   │   └── admin/ (workbench + escalations, applications search & delete, citizen-accounts,
│   │   │               dept-users, rules-config, workflows [matrix], workflow-editor,
│   │   │               sla-config, workflows-admin.service)
│   │   ├── shared/
│   │   │   ├── ui/ (modal, toast, confirm dialog, icons, badges, star-rating, portal-header)
│   │   │   ├── ffe/ffe-grid                   # legacy FFE summary + floor-wise grid (edit / read / document)
│   │   │   ├── application-sheet/             # whole application on one page (confirm, detail, dept view)
│   │   │   ├── workflow/workflow-progress     # stage stepper + process-steps table (compact for citizens)
│   │   │   ├── charts/bar-chart               # dependency-free SVG grouped bar chart (reports)
│   │   │   └── certificates/                  # legal documents; also used live by the decision preview
│   │   └── app.ts / app.routes.ts / app.config.ts
│   ├── styles/ (_tokens.scss, _mixins.scss, _buttons, _forms, _layout)
│   ├── testing/ (fixture-backend.ts, session.ts)   # test-only, excluded from the app build
│   └── styles.scss
└── scripts/
    ├── generate-fixtures.ts          # npm run fixtures — seeds built with the app's own domain code
    ├── generate-fixture-index.ts     # npm run fixtures:index — test import map of every JSON asset
    └── generate-api-doc.ts           # prints the API traceability matrix for docs/03
```

## Layering rules

1. **`core/api/api-endpoints.ts`** is the one file that lists every API entry. Nothing else
   hard-codes a path to a JSON file.
2. **`core/api/api-client.service.ts`** is the only place that calls `HttpClient`. It resolves
   an `ApiEndpoint` (by id, with optional route params such as `:id`) and performs the GET. For
   endpoints flagged `mutates: true` it delegates to `MockPersistenceService`, which reads and
   writes a `localStorage`-backed working copy instead of the static asset. ESLint
   (`no-restricted-imports`) enforces this.
3. **Feature services** (`ApplicationsService`, `LookupService`, `AuthService`,
   `AccountsService`, `DeptWorkflowService`, `WorkflowsAdminService`, `AdminService`, …) are the
   only consumers of `ApiClient`. Components never call `ApiClient` or `HttpClient` directly,
   which keeps them easy to test with fakes.
4. **`core/domain`** contains pure functions with no Angular, no storage and no HTTP. Each
   operation takes data and returns new data, or throws a user-presentable `Error`. The same
   code runs in services, in unit tests and in `scripts/generate-fixtures.ts`.
5. **`layout/*-shell`** components hold the per-portal chrome (header, navigation, footer) as
   lazy-loaded route groups in one SPA, mirroring the legacy entry points (`home.html`,
   `process.html`, `admin.html`).
6. **Route guards** (`auth.guard.ts`, `role.guard.ts`) replace the legacy server-trusted
   session with a mock session in `localStorage` / `sessionStorage`. They isolate the place
   where real authentication would plug in.

## Routing

| Portal | Routes |
|---|---|
| `/auth` | `login`, `register`, `forgot-password` |
| `/citizen` | `dashboard`, `applications/:id`, `applications/:id/edit/**` (application form), `applications/:id/confirm`, `applications/:id/print/:doc`, `change-password` |
| `/dept` | `dashboard`, `search`, `applications/:id`, `reports/:report`, `change-password` |
| `/admin` | `dashboard`, `applications`, `citizens`, `dept-users`, `rules`, `workflows`, `workflows/:id`, `sla`, `change-password` |

**Application form routing.** One route with a custom `UrlMatcher` (`applicationFormMatcher`
in `app.routes.ts`) serves both
`applications/:id/edit/:step` (`basic | blocks | documents | submit`) and
`applications/:id/edit/blocks/:blockId/:blockStep` (`details | floors | escapes | ffe | plans`).
Angular therefore keeps the **same** `Wizard` component, and its unsaved working copy, while
the user moves between application pages and block flows. For a new application `:id` is `new`
with `?type=` until the first Save. Validation issues of a block carry `block` (index) and
`blockStep`, which drive the block stepper badges, the block cards and the grouped "cannot be
submitted yet" dialog.

## State management

No external state library. Angular **signals** plus RxJS `Observable`s from `HttpClient` are
enough at this scale:

- **Lookup data**: loaded once and cached in a `signal` / `shareReplay(1)`.
- **Per-feature lists** (applications, department queue): a small service per feature exposing
  signals, refreshed after mutations.
- **Application form**: `ApplicationDraftStore`, provided per wizard (and per confirmation page)
  instance. It holds a plain mutable working copy bound with `ngModel`. Every change calls
  `touch()`, which re-derives the FFE grid, approval level, fee and district name, bumps a
  change-counter signal that drives `computed` validation, fee and document lists, and marks the
  form dirty. Saving is explicit; page changes save first when possible and never block; an
  unsaved-changes guard protects leaving the form. A saved draft is backed by the same mock
  persistence layer, so it survives a reload.

## Data flow examples

**Reading** (citizen dashboard)

```
Dashboard
  → ApplicationsService.listMine(owner)
      → ApiClient.get(API_ENDPOINTS.citizenApplicationList)   // mutates: true
          → MockPersistenceService.read('assets/data/applications/applications.json')
              (first time: HttpClient.get, then copy to localStorage)
  → filter by owner, map to ApplicationSummary[]
  → render a card per row
```

**Writing** (submit an application)

```
StepSubmit.submit()
  → ApplicationDraftStore.validateForSubmit()      // saves, then validates everything
      errors → dialog grouped by page (Go to page)
      ok     → /citizen/applications/:id/confirm
ConfirmApplication.confirm()                       // after the undertakings are ticked
  → ApplicationDraftStore.submit()
      → ApplicationsService.submit(app, delegationRules)
          ├─ LookupService.workflowConfig()        // workflows, SLA, forms, roles, regions (read fresh)
          ├─ AccountsService.list()                // officers and their fire stations
          └─ ApiClient.update(citizenApplicationSubmit, apps => …startRun(…))   // one transaction
              → MockPersistenceService.update(asset, mutator)
                  (read the working copy → mutator checks "is a draft", assigns number, status,
                   reviewer and log, starts the workflow run → write back; a thrown error aborts
                   the transaction and is shown as a toast)
  → navigate to /citizen/applications/:id/print/acknowledgement
```

## Department workflow

```
dept dashboard ──▶ DeptWorkflowService.queues(username) → myTasks() / monitoredApplications()
dept actions   ──▶ DeptWorkflowService.saveTask / submitTask / sendBack / skipTask / reassignTask /
                   requestDocuments / uploadDocument / sendSms / changeFireStation /
                   updateLicensingAuthority / decide
                     = api.update(<endpoint>, apps => engineFn(app, ...))
decision preview ─▶ FinalDecisionForm: decisionPreviewApp(app, outcome, draftInput, ctx, renewalRules, now)
                   — pure, never persisted — fed straight into the certificate components, so the
                   officer previews exactly what the citizen will receive
admin          ──▶ WorkflowsAdminService.save (validate, version + 1) / saveSla;
                   AdminService.escalationPreview / sendEscalations / reassignOpenTasks
reports        ──▶ DeptWorkflowService.data() → core/domain/reports.ts (pure) → tables, SVG charts, CSV
```

The engine never touches Angular or storage. `scripts/generate-fixtures.ts` plays every seeded
file through it.

## Testing strategy

- **Unit tests** (`*.spec.ts`, Vitest): services (API client, mock persistence, auth,
  accounts, lookups) and all pure domain logic (rule engine, FFE, commonrules, fees, approval
  levels, renewal periods, validation, certificates, workflow engine, task forms, reports,
  escalations, feedback). Fast, no DOM.
- **Component / integration tests**: Angular `TestBed` with `provideFixtureBackend()`
  (`src/testing/fixture-backend.ts`), an HTTP interceptor that serves the **real** JSON
  fixtures, imported at build time. Tests therefore exercise the actual seed data and fail if
  the fixtures drift from the model or the rules. `core/domain/fixtures.spec.ts` checks the
  referential integrity of the data.
- **End-to-end flows in tests** include: save versus submit, the grouped problem dialog, the
  confirmation page, the block-wise flow, the department processing chain (note → inspection →
  concurrence → RFO note), send back, bypass and reassign, documents and SMS, the final
  decision with the citizen seeing the NOC, the admin rules and workflow editors, and report
  aggregations reconciled with the seed store.
- **Manual smoke checklist**: `04-migration-plan.md` §6.

## Visual design direction

- Replace Bootstrap 3, glyphicons and `alert()` / `confirm()` with a small typographic scale, a
  restrained palette (brand red / orange for the Fire Department identity, neutral greys and
  semantic status colours), card-based layouts, accessible form controls with inline
  validation, a toast service and a confirm **dialog** component.
- Status colours live in one SCSS map and one `StatusBadge` component, so every screen (citizen
  list, department queue, reports) renders status the same way.
- Layout is responsive-first (flex / grid) and checked at common breakpoints, instead of the
  legacy desktop-first grid with `hidden-xs` escape hatches.
