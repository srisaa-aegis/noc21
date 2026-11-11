# NOC Portal — API Catalog (legacy RPC → REST API)

The legacy backend is ASP.NET, called as RPC-style endpoints (`*.aspx?PARAM=value` for reads,
`POST` with form-encoded JSON for writes). Its code is lost; only the AngularJS client and a few
flat JSON stubs (`apis/*.txt`) remain.

The new portal talks to the **NOC backend** (`backend/`, Fastify + PostgreSQL) through one explicit
**API catalogue**, [`frontend/src/app/core/api/api-endpoints.ts`](../frontend/src/app/core/api/api-endpoints.ts):
the only file that knows a URL. Feature services call `ApiClient` with a catalogue entry, never
`HttpClient` with a literal path (ESLint `no-restricted-imports` allows `HttpClient` only in
`core/api/api-client.service.ts` and `core/api/http-backend.service.ts`).

> **History.** Until phase B3 the catalogue pointed at JSON fixtures under
> `public/assets/data/**`, with writes simulated in `localStorage` (a "mock persistence" layer).
> Phase B3 of the backend removed that layer: the fixtures moved to the backend seed
> (`backend/seed/data/**`), every entry is now a REST route, and the unit tests use a fake of the
> backend (`frontend/src/testing/fake-api.ts`) instead of the fixtures.

## 1. Catalogue shape

```ts
export interface ApiEndpoint {
  id: string;           // stable key — also the record key in API_ENDPOINTS
  description: string;  // human-readable purpose
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;         // REST route under the API base (/api/v1), with :param placeholders
  legacy: string;       // the original ASP.NET endpoint, for traceability
}
```

`ApiClient.get(endpoint, params?, query?)`, `.request(endpoint, { params, body, headers })`,
`.upload(endpoint, params, form, onProgress?)` and `.download(endpoint, params?, query?)` substitute the
`:param` placeholders and add the base URL. Reference data, rules and configuration are **not**
fetched one endpoint at a time: `LookupService` reads them from the cached bundles
(`core/api/bundle-keys.ts` maps a catalogue entry to its place in a bundle; see
`docs/backend/55-caching.md`).

**Kept in step with the backend:** `backend/tests/integration/contract.spec.ts` checks that the
backend serves every entry of the catalogue, and that every backend route is either in the
catalogue or listed there as server-only on purpose. The request bodies are asserted in
`frontend/src/app/core/api/services.contract.spec.ts` and exercised against the real backend by the
browser suite (`e2e/smoke.mjs`). The backend's OpenAPI document is served at `/docs`.

## 2. Traceability matrix

Generated from the catalogue (`npx tsx frontend/scripts/generate-api-doc.ts`). 117 operations.

### Authentication & session

| Catalog id | Method | Route (under `/api/v1`) | Legacy endpoint | Purpose |
|---|---|---|---|---|
| `authLogin` | POST | `/auth/login` | `modules/login.aspx` | Sign in (username or e-mail + password); returns the access token, sets the refresh cookie |
| `authRefresh` | POST | `/auth/refresh` | `(new)` | Silent refresh from the httpOnly cookie (rotating, reuse-detecting) |
| `authLogout` | POST | `/auth/logout` | `logout.aspx` | Sign out (revokes the refresh-token family) |
| `authMe` | GET | `/auth/me` | `(new)` | The signed-in account |
| `authRegister` | POST | `/auth/register` | `modules/register/register.aspx` | Register a new citizen account |
| `authForgotPassword` | POST | `/auth/forgot-password` | `modules/register/forgotpwd.aspx` | Request a password-reset link (same answer whether or not the account exists) |
| `authResetPassword` | POST | `/auth/reset-password` | `(new)` | Set a new password from a reset / "set your password" link |
| `authChangePassword` | PUT | `/auth/password` | `modules/register/changepass.aspx / dept chpwd` | Change the password of the logged-in user (self-service) |

### Cached reference data (docs/backend/55-caching.md)

| Catalog id | Method | Route (under `/api/v1`) | Legacy endpoint | Purpose |
|---|---|---|---|---|
| `metaVersions` | GET | `/meta/versions` | `(new)` | Current version of every cached bundle |
| `bundle` | GET | `/bundles/:name` | `(new)` | A whole bundle (reference, rules, content, workflow, directory) |
| `bundleVersion` | GET | `/bundles/:name/v/:version` | `(new)` | One immutable version of a bundle |

### Lookups (served from the reference / rules / content bundles)

| Catalog id | Method | Route (under `/api/v1`) | Legacy endpoint | Purpose |
|---|---|---|---|---|
| `lookupApplicationTypes` | GET | `/lookups/application-types` | `apis/ApplTypes.txt` | Application type catalog (Provisional/Occupancy/Renewal/Declaration) incl. FFE column modes |
| `lookupBuildTypes` | GET | `/lookups/build-types` | `apis/BuildTypes.txt` | Building occupancy/use type catalog with height limits |
| `lookupDirections` | GET | `/lookups/directions` | `apis/Directions.txt` | Compass directions |
| `lookupDistricts` | GET | `/lookups/districts` | `apis/Districts.txt` | District master list |
| `lookupFireStations` | GET | `/lookups/fire-stations` | `apis/FireStations.txt` | Fire stations grouped by district |
| `lookupHazards` | GET | `/lookups/hazards` | `apis/Hazards.txt` | Hazard / activity classification list |
| `lookupMappedCodes` | GET | `/lookups/mapped-codes` | `apis/MappedCodes.txt` | DTCP <-> NBC activity code mapping |
| `lookupEquipments` | GET | `/lookups/equipments` | `apis/Equipments.txt` | Fire fighting equipment catalog |
| `lookupFfeNotes` | GET | `/lookups/ffe-notes` | `apis/FFE_Notes.txt` | Explanatory footnotes for FFE requirement tables |
| `lookupStatuses` | GET | `/lookups/statuses` | `apis/Statuses.txt` | Canonical application lifecycle statuses (1-9) |
| `lookupDeptRoles` | GET | `/lookups/dept-roles` | `(server-side roles table)` | Department role catalog (legacy role ids) with the typical jurisdiction of each role |
| `lookupRegions` | GET | `/lookups/regions` | `(server-side: RFO-ER / RFO-SR users)` | Regions (RFO jurisdictions): districts of the Eastern and Southern regions |
| `lookupPartyRoles` | GET | `/lookups/party-roles` | `apis/newappl.txt parties[]` | Technical party roles and which application types require them |
| `lookupBlockOptions` | GET | `/lookups/block-options` | `(hardcoded in editpnoc_1.html)` | Floor types, floor occupancies, escape types, side property types |
| `lookupDocumentRequirements` | GET | `/lookups/document-requirements` | `editpnoc.html / editonoc.html / editrnoc.html / editdnoc.html upload sections` | Required documents & plans per application type |
| `lookupEscapeRules` | GET | `/lookups/escape-rules` | `editpnoc_2.html + commonrules.js (Table 5)` | Travel distance, exit, head-room, projection and refuge limits |
| `lookupNocTerms` | GET | `/lookups/noc-terms` | `modules/dept/partials/noc_terms*.html` | Conditions printed on NOCs (verbatim legal text per type / delegation level) |
| `lookupUndertakings` | GET | `/lookups/undertakings` | `modules/citizen/partials/confirmpnoc.html / confirmonoc.html / confirmrnoc.html` | Undertakings the applicant ticks on the final confirmation page, per application type |
| `lookupOccupancyConditions` | GET | `/lookups/occupancy-conditions` | `confirmpconditions.html / saveconditions.aspx` | Provisional NOC conditions to confirm when applying for Occupancy |
| `lookupNbcTable7` | GET | `/lookups/nbc-table7` | `modules/common/partials/table23.html` | NBC Part 4 Table 7 — minimum requirements for fire fighting installations (reference shown with the FFE grid) |
| `rulesFfeEquipment` | GET | `/rules/ffe/:id` | `uploads/rules/{id}.rule (calculateffe.aspx / floorwise_ffe.aspx)` | FFE decision tree for one equipment id (:id = Equipments.txt id) |
| `rulesFfeType` | GET | `/rules/ffe-type` | `uploads/rules/ffe_type.rule` | Fire extinguisher type decision tree (note key) |
| `rulesOtherNotes` | GET | `/rules/other-notes` | `uploads/rules/other_notes.rule` | Block-level FFE notes decision tree |
| `rulesRiserWidth` | GET | `/rules/riser-width` | `uploads/rules/riser_width.rule` | Wet riser / down comer size decision tree |
| `rulesHeightLimits` | GET | `/rules/height-limits` | `uploads/rules/validations/height.rule` | Maximum permissible height by occupancy decision tree |

### Configuration (admin-editable; published as new immutable versions)

| Catalog id | Method | Route (under `/api/v1`) | Legacy endpoint | Purpose |
|---|---|---|---|---|
| `configFees` | GET | `/config/fees` | `(server-side challan_amt_reqd / PFInit.aspx)` | Fee rates per sq.m, penalties, declaration fee and portal charges |
| `adminSaveFees` | PUT | `/config/fees` | `(new) admin rules configuration` | Admin: update fee configuration |
| `configDelegationRules` | GET | `/config/delegation-rules` | `uploads/rules/validations/MSB.rule` | Approval level (MSB/RFO/DFO) rules |
| `adminSaveDelegationRules` | PUT | `/config/delegation-rules` | `(new) admin rules configuration` | Admin: update approval level rules |
| `configRenewalRules` | GET | `/config/renewal-rules` | `uploads/rules/validations/declaration.rule + images/periodicityofrenewal.png` | Renewal periodicity rules |
| `adminSaveRenewalRules` | PUT | `/config/renewal-rules` | `(new) admin rules configuration` | Admin: update renewal periodicity rules |
| `ruleSetVersions` | GET | `/config/rules/:code/versions` | `(new)` | Published versions of a rule set, newest first |
| `ruleSetEvaluate` | POST | `/rules/sets/:code/evaluate` | `(new)` | Evaluate the published rule set for some facts, with the trace |
| `configWorkflows` | GET | `/config/workflows` | `(server-side process steps — process_steps.aspx)` | Workflow per application type × approval level (stages, tasks, roles, forms, permissions) |
| `configWorkflowsDefault` | GET | `/config/workflows/defaults` | `(new)` | Workflows as shipped (used by "Restore default") |
| `workflowUsage` | GET | `/config/workflows/usage` | `(new)` | Files per workflow and version (current runs) |
| `workflowValidate` | POST | `/config/workflows/validate` | `(new)` | Problems of a workflow definition (nothing saved) |
| `workflowSimulate` | POST | `/config/workflows/simulate` | `(new)` | Who would do what for a fire station |
| `adminSaveWorkflow` | PUT | `/config/workflows/:code` | `(new) admin workflow configuration` | Save a workflow as a new version (files in process keep theirs) |
| `workflowVersions` | GET | `/config/workflows/:code/versions` | `(new)` | Versions of a workflow with their usage |
| `workflowRestore` | POST | `/config/workflows/:code/restore/:version` | `(new)` | Republish an earlier version |
| `configForms` | GET | `/config/forms` | `modules/dept/partials/*_note*.html, dfo_report*.html, dgfs_note*.html` | Note / report forms a workflow task can use |
| `configSla` | GET | `/config/sla` | `(new; legacy rtimeout / escalations.aspx)` | SLA per workflow (per step, inspection, processing) and escalation recipients |
| `adminSaveSla` | PUT | `/config/sla` | `(new) admin SLA configuration` | Admin: save the SLA and escalation settings |
| `configStatuses` | GET | `/config/statuses` | `(new)` | Statuses with their category, badge and order |

### Applications — citizen lifecycle

| Catalog id | Method | Route (under `/api/v1`) | Legacy endpoint | Purpose |
|---|---|---|---|---|
| `citizenApplicationList` | GET | `/applications` | `modules/citizen/applications.aspx` | My Applications (summaries; ?scope=mine) |
| `applicationDetail` | GET | `/applications/:id` | `modules/citizen/application.aspx` | The full application aggregate (visibility by portal and jurisdiction) |
| `citizenApplicationCreate` | POST | `/applications` | `modules/citizen/newapplication.aspx / newdeclaration.aspx` | Create a new draft application (any type) |
| `citizenApplicationUpdate` | PUT | `/applications/:id` | `modules/citizen/update_application.aspx + saveblockdetails.aspx + saveffe.aspx` | Save a draft application incl. blocks/floors/FFE (legacy SaveApplication — only site name + address needed) |
| `citizenApplicationDelete` | DELETE | `/applications/:id` | `modules/citizen/delete_application.aspx` | Delete a draft application |
| `citizenOccupancyFromProvisional` | POST | `/applications/:id/occupancy` | `modules/citizen/newonocappl.aspx` | Create an Occupancy draft carried forward from an issued Provisional NOC |
| `citizenRenewalFromOccupancy` | POST | `/applications/:id/renewal` | `modules/citizen/NewRenewals.aspx` | Create a Renewal draft carried forward from an issued Occupancy NOC |
| `applicationFee` | GET | `/applications/:id/fee` | `(new)` | Fee position: current fee, paid, due, frozen |
| `paymentInitiate` | POST | `/applications/:id/payment` | `PFInit.aspx / PaymentRequest.aspx / PaymentReturn.aspx` | Online fee payment (simulated gateway) |
| `citizenApplicationSubmit` | POST | `/applications/:id/submit` | `modules/citizen/submitapplication.aspx` | Submit a draft application to the department |
| `citizenApplicationRevise` | POST | `/applications/:id/revise` | `modules/citizen/revise.aspx` | Reopen a returned/rejected application as a new revision |
| `citizenFeedbackSave` | POST | `/applications/:id/feedback` | `modules/citizen/savefeedback.aspx` | Citizen rating / feedback on a completed application |
| `applicationRevisions` | GET | `/applications/:id/revisions` | `(new)` | Retained snapshots (submitted / decided / archived) |
| `documentUpload` | POST | `/applications/:id/documents` | `modules/citizen/uploaddocs.aspx / uploadplans.aspx` | Attach a document/plan (metadata only in this stub build) |
| `documentRemove` | DELETE | `/applications/:id/documents/:docNo` | `(new)` | Remove a document from a draft |
| `citizenRequestedDocUpload` | POST | `/applications/:id/document-requests/:requestNo/response` | `modules/dept/uploaddeptdocs.aspx / upload_request.aspx` | Upload a document requested by the department |
| `applicationCertificate` | GET | `/applications/:id/certificate/:kind` | `modules/citizen/*_print.html` | Facts for a printable certificate / letter |
| `applicationAssessment` | GET | `/applications/:id/assessment` | `(new)` | The server assessment of a stored application |
| `assessmentPreview` | POST | `/assessments` | `(new)` | Stateless assessment of an unsaved application |
| `fileDownloadToken` | POST | `/files/:id/download-token` | `uploads/*` | One-time link to open a stored file |

### Department

| Catalog id | Method | Route (under `/api/v1`) | Legacy endpoint | Purpose |
|---|---|---|---|---|
| `deptTasks` | GET | `/dept/tasks` | `modules/dept/applications.aspx` | My open tasks |
| `deptMonitoring` | GET | `/dept/monitoring` | `modules/dept/applications.aspx` | Files the officer follows (paginated, with stage chips and KPIs) |
| `deptSearch` | GET | `/applications` | `modules/dept/search.aspx` | Department search (?scope=dept) |
| `deptFeedbackRatings` | GET | `/dept/feedback-summary` | `modules/dept/Feedback_AvgRating.aspx` | Average citizen rating (dept dashboard) |
| `deptApplication` | GET | `/dept/applications/:id` | `modules/citizen/application.aspx + modules/dept/process_steps.aspx` | The processing page: application, what the officer may do, parent |
| `deptTaskSave` | POST | `/dept/applications/:id/tasks/:taskNo/save` | `modules/dept/process_move.aspx?s=false` | Department: save the note / report of a task as a draft |
| `deptTaskSubmit` | POST | `/dept/applications/:id/tasks/:taskNo/submit` | `modules/dept/process_move.aspx?s=true` | Department: submit the note / report of a task |
| `deptSendBack` | POST | `/dept/applications/:id/tasks/:taskNo/send-back` | `modules/dept/sendback.aspx` | Department: send the file back to the previous stage |
| `deptSkipTask` | POST | `/dept/applications/:id/tasks/:taskNo/skip` | `modules/dept/process_move.aspx (Officer Bypassed)` | Department: the issuing authority bypasses an officer |
| `deptReassignTask` | POST | `/dept/applications/:id/tasks/:taskNo/reassign` | `modules/dept/reassign.aspx` | Department: the issuing authority changes the officer of a task |
| `deptSignedCopy` | POST | `/dept/applications/:id/tasks/:taskNo/signed-copy` | `uploaddocs.aspx (FinalDoc)` | Upload the signed NOC / letter before the decision |
| `deptDecisionPreview` | POST | `/dept/applications/:id/tasks/:taskNo/decision-preview` | `(new)` | The application as it would be after the decision (live preview) |
| `deptDecision` | POST | `/dept/applications/:id/tasks/:taskNo/decide` | `modules/dept/process_move.aspx (final step) + uploaddocs.aspx (FinalDoc)` | Department: final decision of the issuing authority (with the signed NOC / letter) |
| `deptRequestDocuments` | POST | `/dept/applications/:id/document-requests` | `modules/dept/uploaddeptdocs.aspx (request)` | Department: request a document from the applicant |
| `deptUploadDocument` | POST | `/dept/applications/:id/dept-documents` | `modules/dept/uploaddeptdocs.aspx` | Department: upload a document (e.g. inspection photographs) |
| `deptSendSms` | POST | `/dept/applications/:id/sms` | `modules/dept/sendsms.aspx` | Department: send an SMS to the applicant (simulated) |
| `deptUpdateFireStation` | PUT | `/dept/applications/:id/fire-station` | `modules/dept/update_application.aspx (fire station)` | Department: change the fire station of a file (Submitted only) |
| `deptUpdateLicensingAuthority` | PUT | `/dept/applications/:id/licensing-authority` | `modules/dept/update_application.aspx (licensing authority)` | Department: update the licensing authority (final stage only) |
| `deptReports` | GET | `/dept/reports/:id` | `modules/dept/reports.aspx (Rpt_type 1-7) + reports/rpt_*.html` | Department reports (pendency, statistics, consolidated, applications, overdue, SMS, feedback, challan, district, level-wise) |

### Administration

| Catalog id | Method | Route (under `/api/v1`) | Legacy endpoint | Purpose |
|---|---|---|---|---|
| `adminAccounts` | GET | `/admin/accounts` | `(new) admin account management` | Accounts (paginated; ?portal=&q=) |
| `adminAccount` | GET | `/admin/accounts/:id` | `(new)` | One account |
| `adminOfficers` | GET | `/admin/officers` | `(new)` | Department officers (directory bundle) |
| `adminDeptUserCreate` | POST | `/admin/accounts/dept` | `(new) admin account management` | Admin: add a department user |
| `adminDeptUserUpdate` | PUT | `/admin/accounts/:id/dept` | `(new) admin account management` | Admin: modify a department user |
| `adminCitizenUpdate` | PUT | `/admin/accounts/:id/profile` | `(new) admin account management` | Admin: modify a citizen account profile |
| `adminSetPassword` | POST | `/admin/accounts/:id/password` | `modules/admin/users.aspx (change password)` | Set a password (or issue a temporary one) — must be changed at next sign-in |
| `adminAccountSetActive` | PUT | `/admin/accounts/:id/active` | `(new) admin account management` | Admin: deactivate / reactivate any citizen or department account |
| `adminOpenTasks` | GET | `/admin/accounts/:id/open-tasks` | `(new)` | Pending tasks of an officer |
| `adminHandover` | POST | `/admin/accounts/:id/handover` | `(new) — deactivation of an officer` | Move every pending task of an officer to another (same role) |
| `adminUnassignedTasks` | GET | `/admin/unassigned-tasks` | `(new)` | Tasks nobody could be assigned to (Q-59) |
| `adminReassignTask` | POST | `/admin/applications/:id/tasks/:taskNo/reassign` | `(new)` | Assign a task (administrator) |
| `adminApplicationSearch` | GET | `/applications` | `modules/dept/search.aspx + draftfiles.htm` | Search every application incl. drafts (?scope=all) |
| `adminApplicationDelete` | DELETE | `/admin/applications` | `modules/admin/deleteOldFiles.aspx` | Admin: delete applications |
| `adminStatuses` | GET | `/admin/statuses` | `(new)` | Statuses with their usage (N-4) |
| `adminStatusAdd` | POST | `/admin/statuses` | `(new)` | Add an in-process status |
| `adminStatusUpdate` | PUT | `/admin/statuses/:id` | `(new)` | Rename / re-order / (de)activate an in-process status |
| `adminStatusRemove` | DELETE | `/admin/statuses/:id` | `(new)` | Remove an in-process status nothing has used |
| `adminEscalationPreview` | GET | `/admin/escalations/preview` | `modules/admin/escalations.aspx` | Overdue items and the reminders due now |
| `adminSendEscalations` | POST | `/admin/escalations/send` | `modules/admin/escalations.aspx` | Escalation reminders for tasks / applications past their SLA |
| `adminEscalationLog` | GET | `/admin/escalations/log` | `(new)` | Escalation runs, newest first |
| `adminAudit` | GET | `/admin/audit` | `(new)` | Audit log |

## 3. Server-only routes

Served by the backend but not called through the catalogue (API clients, the browser following a
link): `GET /files/download/:token` (the one-time download link), `GET /files/:id/metadata`,
`GET /bootstrap`, `GET /rules/sets`, `GET /rules/sets/:code`, `GET /applications/:id/summary`,
`GET /applications/:id/validation`, `GET /applications/:id/process-log`, `GET /dept/reports`, and the
operational `GET /health`, `/ready`, `/version`, `/docs`.
