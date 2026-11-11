# 5. REST API Design (`/api/v1`) — Revision 2

> Specification only.

## 5.1 Principles

1. **Every one of the 79 catalogue entries maps to one route.** The integrated frontend
   swaps `asset` for `path`.
2. Transitions are **action sub-resources** (`POST …/submit`), each with its own
   authorisation and its own transaction.
3. Response bodies keep the `core/models` shapes (field names, local ids). The wire-level
   changes are listed in `65-frontend-integration.md` §65.4.
4. Errors use **RFC 9457 problem+json**, with `detail` set to the **verbatim** messages used
   today.
5. **The server computes and the server decides.** Client-sent derived values (fee, level,
   FFE `reqt`, status, number, reviewer) are ignored and recomputed.
6. Lists are paginated and filtered on the server.
7. Reference data follows the caching contract in `55-caching.md`.

## 5.2 Conventions

| Concern | Rule |
|---|---|
| Ids | integers everywhere (`appl_id`, `role_id`, `fire_station_id`, workflow `id`); codes are separate fields (`code: 'P-MSB'`). Files use a UUID. |
| Auth | `Authorization: Bearer <access>`; refresh cookie `noc_rt` (httpOnly, SameSite=Lax, path `/api/v1/auth`) |
| Dates | `dd-Mon-yyyy` while `API_DATE_FORMAT=legacy` |
| Pagination | `page`, `pageSize` (default 25, max 200; `all` allowed where noted, capped at 1 000) → `{ items, page, pageSize, total }` |
| Concurrency | `If-Match: "r<row_version>"` on aggregate writes → `409` on mismatch; `wf_instances.lock_version` is checked internally for transitions |
| Idempotency | `Idempotency-Key` on payment, submit, decide and escalation send (stored for 24 h) |
| Data versions | **every** response carries `X-Data-Versions: reference=…;rules=…;content=…;workflow=…;directory=…` |
| Correlation | `X-Request-Id` |
| Rate limits | global 300/min/IP; login 10/min/IP + 5/min/username; uploads 30/min/user |
| Body size | JSON 2 MB; multipart `UPLOAD_MAX_BYTES` |

Error statuses: 400 bad-request · 401 unauthenticated · 403 forbidden · 404 not-found
(also used for resources the caller may not see) · 409 conflict · 413 too large · 415
unsupported media · 422 validation / business-rule (with `errors[]` in the `ValidationIssue`
shape: `step`, `block`, `blockStep`, `field`, `message`, `severity`) · 429 · 500 (with
`requestId`).

## 5.3 Auth

| Route | Body | Returns |
|---|---|---|
| `POST /auth/login` | `{ username, password }` | `{ user, accessToken, expiresIn, landing, dataVersions }` + refresh cookie |
| `POST /auth/refresh` | cookie | `{ accessToken, expiresIn, dataVersions }`; rotates the cookie |
| `POST /auth/logout` | cookie | 204; revokes the token family |
| `GET /auth/me` | — | `{ user, dataVersions }` |
| `POST /auth/register` | `RegistrationRequest` | `{ username, temporaryPassword? }` (the password is returned only outside production) |
| `POST /auth/forgot-password` | `{ email }` | 202 always |
| `POST /auth/reset-password` | `{ token, newPassword }` | 204 |
| `PUT /auth/password` | `{ currentPassword, newPassword }` | 204 |

`user` is `UserAccount` without `password`, with `must_change_password`. When
`must_change_password` is true, every route except `/auth/*` returns `403` with
`type=password-change-required`.

## 5.4 Reference data, rules and caching

| Route | Notes |
|---|---|
| `GET /meta/versions` | `{ reference, rules, content, workflow, directory, schema }` |
| `GET /bundles/:bundle/v/:version` | immutable; `:bundle ∈ reference, rules, content, workflow*, directory*` (* authenticated dept/admin) |
| `GET /bundles/:bundle` | ETag / 304 |
| `GET /bootstrap?include=…` | combined, for a cold start |
| `GET /lookups/{application-types, build-types, directions, districts, fire-stations, hazards, mapped-codes, equipments, ffe-notes, statuses, dept-roles, regions, party-roles, block-options, document-requirements, escape-rules, noc-terms, nbc-table7, undertakings, occupancy-conditions}` | the 20 catalogue lookups, ETag'd slices of the bundles. `escape-rules` is served from the `noc.escape_limits` parameter set in the legacy shape. |
| `GET /rules/ffe/:equipmentId`, `/rules/ffe-type`, `/rules/other-notes`, `/rules/riser-width`, `/rules/height-limits` | the 5 catalogue rule routes, which serve the current published tree definitions |

## 5.5 Rules engine and calculations

| Route | Auth | Purpose |
|---|---|---|
| `GET /rules/sets` | dept/admin | list of rule sets with their current versions |
| `GET /rules/sets/:code` / `…/versions` / `…/versions/:version` | dept/admin | definitions and history |
| `POST /rules/sets/:code/versions` | admin | create a draft (`editable` sets only: fees, approval level, renewal period, escape limits) |
| `POST /rules/sets/:code/versions/:version/validate` | admin | structural problems + test-case results |
| `POST /rules/sets/:code/versions/:version/publish` | admin | runs validation and test cases; immutable afterwards; bumps `rules` |
| `POST /rules/sets/:code/evaluate` | authenticated | `{ facts \| factsList, versionId?, trace? }` → `{ value, trace, versionId }` — the admin "try it" and other consumers |
| `POST /assessments` | authenticated | stateless `assess()` of an application payload that is not saved → `Assessment` |

**NOC-shaped façades** (the existing admin *Rules & Fees* UI keeps working unchanged):

| Catalogue id | Route | Maps to |
|---|---|---|
| `configFees` / `adminSaveFees` | `GET` / `PUT /config/fees` | `noc.fees` parameters (`PUT` = draft + publish) |
| `configDelegationRules` / `adminSaveDelegationRules` | `GET` / `PUT /config/delegation-rules` | `noc.approval_level` table ↔ `DelegationRule[]` |
| `configRenewalRules` / `adminSaveRenewalRules` | `GET` / `PUT /config/renewal-rules` | `noc.renewal_period` table ↔ `RenewalRule[]` |

## 5.6 Workflow configuration

| Catalogue id | Route | Auth |
|---|---|---|
| `configWorkflows` | `GET /config/workflows` (the 12 current definitions in the `WorkflowDefinition` shape, plus `code`) | dept/admin |
| `configWorkflowsDefault` | `GET /config/workflows/defaults` | admin |
| `adminSaveWorkflows` | `PUT /config/workflows/:code` → validate (engine + NOC validators) → new version → bump `workflow` | admin |
| `configForms` | `GET /config/forms` | dept/admin |
| `configSla` / `adminSaveSla` | `GET` / `PUT /config/sla` (SLA policies + escalation settings) | dept/admin / admin |
| — | `POST /config/workflows/:code/validate` (unsaved body → problems) | admin |
| — | `POST /config/workflows/:code/simulate` `{ fire_station_id }` → officers per task + warnings | admin |
| — | `GET /config/workflows/:code/versions`, `GET /config/workflows/usage` (instances per definition × version, in process / total) | admin |
| — | `POST /config/workflows/:code/restore-default` | admin |
| — | `GET /config/statuses` / `PUT /config/statuses` (in-process statuses only: rename, re-order, add, deactivate — system statuses rejected) | admin — **see N-4** |

## 5.7 Applications

### Reads

| Catalogue id | Route | Notes |
|---|---|---|
| `citizenApplicationList` | `GET /applications?scope=mine&type&status&q&page` | `ApplicationSummary` page |
| `deptQueue` | `GET /applications?scope=dept&type&level&district&status&q&page` | submitted only, within the caller's jurisdiction |
| `adminApplicationSearch` | `GET /applications?scope=all&…&draftsOnly&idleDays` | admin; adds `days_idle` |
| `citizenApplicationDetail` / `deptApplication` | `GET /applications/:id` | full aggregate + `workflow` (as `WorkflowRun`) + `workflow_history`. The citizen view omits task `data` / `remarks`. The dept view embeds `allowed_actions`. `ETag: "r<row_version>"` |
| — | `GET /applications/:id/assessment` | latest `Assessment` (fee, level, issues, rule versions, trace) |
| — | `GET /applications/:id/revisions` / `…/revisions/:revision/:kind` | retained snapshots (Q-39) |
| — | `GET /applications/:id/certificate/:kind` | facts for `acknowledgement \| receipt \| certificate \| display-certificate \| rejection` (including the parent NOC) |
| — | `GET /applications/:id/process-log?page` | timeline |

### Citizen writes

| Catalogue id | Route | Server does |
|---|---|---|
| `citizenApplicationCreate` | `POST /applications` `{ appl_type, appl_mode?, …first-save fields }` | `saveProblem()`; creates the draft with default parties; runs `assess()` |
| `citizenApplicationUpdate` | `PUT /applications/:id` + `If-Match` | owner + draft checks; diff-upsert of children; **`assess()` overwrites every derived field**; stores the assessment. Returns **`{ application, assessment }`** |
| `citizenApplicationDelete` | `DELETE /applications/:id` | draft at revision 1 only; unlinks the parent |
| `citizenOccupancyFromProvisional` | `POST /applications/:id/occupancy` `{ conditions }` | carry-forward + assess |
| `citizenRenewalFromOccupancy` | `POST /applications/:id/renewal` | carry-forward + assess |
| `paymentInitiate` | `POST /applications/:id/payment` `{ mode: 'online' }` or `{ mode: 'challan', challan_num, challan_date, bank, branch }` + `Idempotency-Key` | recompute the fee, **freeze** the amount, breakdown and `noc.fees` version |
| `citizenApplicationSubmit` | `POST /applications/:id/submit` `{ undertakings: string[] }` + `Idempotency-Key` | re-assess; `422` with `errors[]` if any issue; fee coverage check (N-3); number; level; workflow `start`; `application_revisions(submitted)`; process log; outbox |
| `citizenApplicationRevise` | `POST /applications/:id/revise` | `archive()` the instance; snapshot `archived`; `revision + 1`; back to draft |
| `citizenFeedbackSave` | `POST /applications/:id/feedback` | category approved or rejected only |
| `documentUpload` | `POST /applications/:id/documents` (multipart `file`, `code`) | validation → storage → `files` + link (replaces the same `code`) |
| — | `DELETE /applications/:id/documents/:docNo` | drafts only |
| `citizenRequestedDocUpload` | `POST /applications/:id/document-requests/:requestNo/response` (multipart `file`, `comment`) | status `U` |

## 5.8 Department

| Catalogue id | Route |
|---|---|
| — | `GET /dept/tasks` → `[{ app: ApplicationSummary, task, action_label, days_pending, due_date, sla_days, overdue }]` |
| — | `GET /dept/monitoring?type&level&district&q&page` |
| `deptFeedbackRatings` | `GET /dept/feedback-summary?months=` |
| — | `GET /dept/applications/:id/allowed-actions` → `{ save:[taskNo], submit:[…], sendBack:[…], skip:[…], reassign:[…], decide: taskNo \| null, outcomes:[…], requestDocuments, uploadDocument, sendSms, changeFireStation, updateLicensingAuthority }` |
| `deptTaskSave` | `POST /dept/applications/:id/tasks/:taskNo/save` `{ data }` |
| `deptTaskSubmit` | `POST …/tasks/:taskNo/submit` `{ data }` (server-side form validation with `taskFormProblems`) |
| `deptSendBack` | `POST …/tasks/:taskNo/send-back` `{ comments }` |
| `deptSkipTask` | `POST …/tasks/:taskNo/skip` |
| `deptReassignTask` | `POST …/tasks/:taskNo/reassign` `{ to_user_id }` |
| `deptDecision` | `POST …/tasks/:taskNo/decide` `{ outcome, remark, addcc?, rem_comm?, valid_from?, valid_to?, signed_file_id? }` + `Idempotency-Key` |
| — | `POST /dept/applications/:id/decision-preview` `{ outcome, …input }` → a preview aggregate, never persisted |
| `deptRequestDocuments` | `POST /dept/applications/:id/document-requests` `{ file_desc }` |
| `deptUploadDocument` | `POST /dept/applications/:id/dept-documents` (multipart) |
| `deptSendSms` | `POST /dept/applications/:id/sms` `{ message }` |
| `deptUpdateFireStation` | `PUT /dept/applications/:id/fire-station` `{ district_id, fire_station_id }` (engine `reresolveAssignees`) |
| `deptUpdateLicensingAuthority` | `PUT /dept/applications/:id/licensing-authority` `{ lic_auth, lic_addr }` |
| `deptReports` | `GET /dept/reports/:reportId?level&type&region&status&host&from&to&page&format=json\|csv` (10 reports; status filters by id or `category`) |

Every transition returns the updated aggregate (dept view). The signed decision copy is
uploaded first (`POST /applications/:id/documents` with `code=FinalDoc` → `file_id`) and
then referenced in `decide`. The decision is one atomic JSON transaction.

## 5.9 Admin

| Catalogue id | Route |
|---|---|
| `accountsList` | `GET /admin/accounts?portal&role&q&active&page` (no passwords) |
| `adminCitizenUpdate` | `PUT /admin/accounts/:id/profile` |
| `adminCitizenChangePassword` / `adminDeptUserResetPassword` | `POST /admin/accounts/:id/reset-password` → `{ temporaryPassword }` |
| `adminAccountSetActive` | `PUT /admin/accounts/:id/active` `{ active }` (`409` + open-task count if an officer with open tasks is deactivated without a hand-over) |
| `adminDeptUserCreate` / `adminDeptUserUpdate` | `POST /admin/accounts/dept` / `PUT /admin/accounts/:id/dept` (`role_id`, `district_id`, `fire_station_ids[]`, `all_stations`) |
| — | `GET /admin/accounts/:id/open-tasks` |
| `adminReassignTasks` | `POST /admin/accounts/:id/handover` `{ to_user_id }` (engine `handover`) |
| `adminApplicationDelete` | `DELETE /applications` `{ ids }` (soft delete) |
| `adminSendEscalations` | `POST /admin/escalations/send` + `GET /admin/escalations/preview` + `GET /admin/escalations` (log) |
| — | `GET /admin/unassigned-tasks` (Q-59) |
| — | `GET /admin/audit?entity&actor&from&to&page` |

**Removed (Q-67):** there is no demo-reset endpoint. It is a CLI script (`20-…` §2.4).

## 5.10 Files

| Route | Notes |
|---|---|
| `POST /files/:id/download-token` | authorises (owner / involved officer / admin) → `{ url: "/api/v1/files/download/<token>", expiresIn }` — one-time, short-lived (`DOWNLOAD_TOKEN_TTL_SECONDS`) |
| `GET /files/download/:token` | the only unauthenticated download path. It validates and consumes the token, then **streams** the file (filesystem driver). A future S3 driver would answer `302` to a presigned URL at this same point. Headers: `Content-Disposition`, `nosniff`, `private, no-store`. |
| `GET /files/:id/metadata` | name, size, mime, checksum, uploaded by/on |

The token indirection lets PDFs open in a new tab (`<a href>`/`window.open`) without putting
bearer tokens in URLs. It is also exactly the hook an S3 driver needs.

## 5.11 Operations

`GET /health` · `GET /ready` (DB, migrations current, cache warm, storage root writable and
outside the web root) · `GET /version` · `GET /docs` + `/docs/json` (`ENABLE_DOCS`) ·
`GET /metrics` (optional).

## 5.12 Authorisation matrix

| Resource | citizen | dept | admin |
|---|---|---|---|
| own application | read; write while draft | — | read, delete |
| other applications | ✘ | submitted, in jurisdiction | ✔ |
| workflow commands | ✘ | per `allowedActions` (assignee / decider / involved) | hand-over, reassign |
| rule sets, workflows, SLA, statuses | read public bundles | read | write |
| accounts | own password | own password | all |
| files | own application | involved application | all |
| reports | ✘ | ✔ | ✔ |

Enforced by route preHandlers (portal/role) and again inside services (ownership,
involvement, engine permissions), and covered by the authorisation matrix test suite.
