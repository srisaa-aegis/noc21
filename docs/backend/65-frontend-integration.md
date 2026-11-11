# 65. Frontend ↔ Backend Integration (in scope — R2-5)

The Angular 21 app (`frontend/`) moves from `MockPersistenceService` + `localStorage` to the
real API. It is delivered **per phase** (`70-delivery-plan.md`), and at the end of Phase 3 the
mock layer is deleted.

## 65.1 Goals and non-goals

**Goals**

- Every screen works against the backend.
- The server is authoritative for calculations and transitions.
- The caching strategy is in place.
- Uploads are real files.
- The existing component and UI behaviour is unchanged, including copy and error messages.
- The frontend test suite (Vitest, about 400 specs today) stays green.
- A Playwright suite automates the three manual test scripts.

**Non-goals**

- No visual redesign.
- No new features beyond what the backend requires: forced password change, revision
  history view, unassigned-task list and status configuration (N-4).

## 65.2 Transition mode

`environment.apiMode: 'http' | 'mock'`:

- `npm start` uses **http**, proxied to `:3000`.
- `npm run start:mock` keeps the fixture mode during B1–B2, so that features whose backend is
  not built yet can still be demonstrated.
- `ApiClient` has two implementations behind one injection token: `HttpApiClient` and
  `MockApiClient` (today's behaviour). **B3 deletes `MockApiClient`,
  `MockPersistenceService`, the `mock` configuration and the write path of
  `public/assets/data`.** The JSON files remain only as backend seed inputs and frontend test
  fixtures.

## 65.3 Core layer changes

| File / area | Change |
|---|---|
| `core/api/api-endpoints.ts` | `asset` → `path` (e.g. `/applications/:id/submit`) + `method`; `legacy` stays; `mutates` and `collection` are removed |
| `core/api/api-client.service.ts` | `get/post/put/delete/upload(endpoint, { params, query, body, headers, file, onProgress })`. `:param` substitution. `ApiError extends Error` with `status`, `type`, `detail` (→ `message`), `errors[]` (ValidationIssue), `requestId`. One retry for idempotent GETs on network failure. |
| `core/api/mock-persistence.service.ts` | moved behind `MockApiClient`; deleted in B3 |
| **Interceptors** (new) | `authInterceptor`: attach the bearer token; on 401, one shared refresh and replay, and on refresh failure log out to `/auth/login?returnUrl=`. `dataVersionInterceptor`: reads `X-Data-Versions` (`55-caching.md`). `requestIdInterceptor`. `passwordChangeInterceptor`: `403 password-change-required` → change-password route. |
| `core/auth/auth.service.ts` | `login` → `POST /auth/login`. The access token is held **in memory only**. `restoreSession()` = `POST /auth/refresh` at boot via the httpOnly cookie. `logout` → API. `currentAccount()` → `/auth/me`. `register` / `forgotPassword` → API. The session signal shape is unchanged. |
| Guards | unchanged API. `authGuard` awaits the boot refresh. New `mustChangePasswordGuard`. |
| `core/lookups/lookup.service.ts` | internals replaced by **`ReferenceDataStore`** (IndexedDB + signals + versioned bundles). Public observables/signals are unchanged. `wizard()` / `config()` / `workflowConfig()` are built from bundles. |
| `core/accounts/accounts.service.ts` | thin calls to `/admin/accounts*` and `/auth/*`. Client-side validation and the `list()`-everything-with-passwords calls are removed. |
| `core/domain/**` | **moved**: NBC/FFE/fees/validation/documents/certificate/task-forms/dates → `@noc/domain`; the tree evaluator → `@noc/rules-engine`. **Deleted** from the frontend: `workflow.ts` transitions, `reports.ts`, `escalations.ts`, `application-factory.ts` (number/id generation), and `nextApplicationNumber` / `nextId`. |
| `core/models/**` | moved to `@noc/domain/models`; changes listed in §65.4 |
| `scripts/generate-fixtures.ts` | moves to the backend seeder (`backend/scripts/db/seed.ts` reuses the same builders) |

## 65.4 Wire and model changes the frontend must absorb

| Model | Change | Reason |
|---|---|---|
| `UserAccount` | `password` removed; `deptRoleId: string` → `role_id: number`; `stations: string[]` → `fire_station_ids: number[]` | security; integer PKs (R2-2) |
| `DeptRole.id`, `FireStation.id`, `DistrictFireStations.id` | `string` → `number` | R2-2 (`4Q` → 199) |
| `WorkflowDefinition` | `id: number` + `code: 'P-MSB'`; `SlaConfig.workflows` keyed by **code** | R2-2 |
| `WorkflowTaskDef.role_id` | `number` | R2-2 |
| `StatusCode` | + `category`, `is_system`, `is_pre_decision`, `sort_order`, `badge` | Q-63 |
| `Application` | + `row_version`; + `allowed_actions?` (dept view); `firestation: string` → `fire_station_id: number` (`firestation` kept as a deprecated alias during B1–B2) | concurrency; server permissions |
| `Payment` | + `fee_breakdown`, `fee_rule_version_id` (frozen) | Q-57 |
| `UploadedDocument` / `DeptDocument` | + `file_id` (uuid) | real files |
| Save response | `PUT /applications/:id` returns `{ application, assessment }` | server-authoritative derived values |
| Status checks | every hard-coded `status_id` 3–6 comparison → category checks (`isInProcess(status)`) | Q-63 |

The fixture JSON (seed and test fixtures) is updated once to the integer ids, with the
`4Q` → 199 correction.

## 65.5 Feature service changes

| Service / component | Today | After |
|---|---|---|
| `ApplicationsService` | read-modify-write of the whole store in `localStorage`; number/level/run computed in the browser | `listMine` → `GET /applications?scope=mine`; `get` → `GET /applications/:id`; `createDraft` / `createFromDraft` → `POST`; `save` → `PUT` with `If-Match` (409 → "This application was changed elsewhere — reload" dialog); `submit` → `POST …/submit`; `revise`, `deleteDraft`, carry-forwards, `uploadRequestedDocument` (real `File`), `saveFeedback` → their endpoints. `summarize` / `applicationListFilter` → server query params. |
| `ApplicationDraftStore` (wizard) | derives FFE, level, fee and validation locally; save writes the whole store | **keeps** the local derivation for live feedback (Q-14). After every save it **replaces** the derived fields and `fee()` / `errors()` with the server's `assessment` (server wins). `attachDocument` uploads the real `File` with a progress bar, then links it; `payOnline` / `recordChallan` → `POST …/payment`; `submit` → `POST …/submit` (server `errors[]` feed the existing grouped dialog). |
| `DeptWorkflowService` | loads all applications, users and config, runs the engine locally | `queues` → `GET /dept/tasks` + `/dept/monitoring`; `application` → dept view with `allowed_actions`; every operation → its endpoint; `feedback` → `/dept/feedback-summary`. No imports of the workflow engine. |
| `ApplicationView` (processing page) + forms | computes permissions and outcomes locally | buttons, outcomes, send-back and skip targets come from `allowed_actions`. `FinalDecisionForm` live preview → debounced `POST …/decision-preview`. The signed copy is uploaded first, then `decide` is called. |
| `WorkflowProgress` (stepper) | uses `currentTasks`/`pendingWith` from the engine | uses server fields (`pending_with`, `active_stage_key`, `current` flags on tasks) |
| `Reports` | computes the 10 reports in the browser from every application | `GET /dept/reports/:id?…` (paginated); **CSV** → server `format=csv` through a download token; charts unchanged |
| `AdminService` | search/delete/escalations/hand-over computed locally; `resetDemoData()` | `/applications?scope=all`, `DELETE /applications`, `/admin/escalations/*`, `/admin/accounts/:id/open-tasks`, `/handover`. **`resetDemoData()` and the Workbench "Reset Demo Data" button are removed (Q-67).** |
| `WorkflowsAdminService` | validation and usage computed locally | `GET /config/workflows`, `/defaults`, `/usage`; `POST …/validate` (debounced, live), `…/simulate`; `PUT /config/workflows/:code` |
| `RulesConfigService` | saves JSON files to `localStorage` | `GET/PUT /config/fees`, `/delegation-rules`, `/renewal-rules` (façades); "try it" → `POST /rules/sets/:code/evaluate` with `trace` shown |
| `SlaConfigPage` | local | `GET/PUT /config/sla` |
| Citizen / dept-user admin pages | local account store | `/admin/accounts*` endpoints; deactivate with open tasks → a `409` drives the existing hand-over dialog |
| Print / certificates | get the application + parent locally | `GET /applications/:id/certificate/:kind`; the components render unchanged |
| New (small) | — | forced change-password flow; the citizen's **revision history** list (Q-39) on the application detail; the admin **unassigned tasks** card (Q-59); the admin **statuses** page, if N-4 = yes |

## 65.6 File upload and download UX

- **Upload:** `ApiClient.upload()` sends multipart with `reportProgress`. Client-side checks
  (PDF, 5 MB) stay for instant feedback; the server re-validates.
- **Download:** `filesService.open(fileId)` → `POST /files/:id/download-token` →
  `window.open(url)`, or an `<a download>` for CSV. No bearer token ever appears in a URL, and
  the same code works unchanged for a future S3 redirect.

## 65.7 Error handling and UX

- `ApiError.message` equals the server's `detail`. Every component that shows
  `e.message` today keeps working with the same text.
- `422` + `errors[]` on submit → the existing "cannot be submitted yet" grouped dialog.
- `409` on save → a reload prompt. `429` → "Too many attempts, please wait". `5xx` → a generic
  toast with the `requestId` for support.
- Offline or unreachable API → a banner, while reference data still renders from IndexedDB.

## 65.8 Dev setup

- `frontend/proxy.conf.json` maps `/api` → `http://127.0.0.1:3000` (no CORS in dev). In
  production nginx does the same.
- `environment.ts`: `apiBaseUrl: '/api/v1'`, `apiMode`.
- `npm run dev` (root) runs both.

## 65.9 Testing the frontend after integration

| Level | How |
|---|---|
| Unit (Vitest) | `HttpApiClient`, interceptors (refresh single-flight, 401 replay, data-version detection), `ReferenceDataStore` (with `fake-indexeddb`), and each feature service with `HttpTestingController` |
| Component (Vitest + TestBed) | `provideFixtureBackend()` becomes **`provideFakeApi()`**: an interceptor serving **route-shaped** responses built from the same seed JSON, with a thin in-memory fake of the write endpoints. The existing component specs keep running and are updated only where behaviour moved to the server (permissions, reports). |
| Contract | the frontend's request/response types are checked against the backend's OpenAPI (`openapi-typescript`-generated types compared in a type test). A drift fails `npm run typecheck`. |
| E2E (Playwright, Chromium preinstalled) | `e2e/` runs the real API on a scratch DB + `ng serve`, and automates the phase 1/2/3 manual scripts (`80-test-plan.md` §8.6) |
