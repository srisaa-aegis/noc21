# A1. Legacy Traceability

Three-way mapping: the **legacy ASP.NET RPC** → the **Angular catalogue entry** → the
**new route and tables**. Also records the legacy database names recovered from the code.

## A1.1 Legacy database names recovered

`NOC-base/uploads/templates/Application_Submit.json` embeds real SQL from the lost backend:

```sql
select A.APPL_NUMBER, U.USER_NAME, U.MOBILE
from   noc_applications A
join   noc_process     P on P.APPL_ID = A.APPL_ID and P.DELETED = 0
                          and P.END_DATE is null and P.ACTION_ like '%Inspection%'
join   noc_users       U on U.DELETED = 0 and U.USER_ID = P.USER_ID
where  A.DELETED = 0 and A.APPL_ID = @OBJECT_ID;

select C.MOBILE from noc_applications A
join   noc_citizens C on C.CITIZEN_ID = A.CITIZEN_ID and C.DELETED = 0 …
```

| Legacy table/column | Evidence | New home |
|---|---|---|
| `noc_applications(APPL_ID, APPL_NUMBER, SITE_NAME, CITIZEN_ID, DELETED)` | the queries above | `applications(appl_id, appl_number, site_name, owner_user_id, deleted_at)` |
| `noc_process(APPL_ID, USER_ID, ACTION_, END_DATE, DELETED)` | the queries above | `wf_tasks(instance_id→wf_instances.subject_id, assignee_actor_id, task_key, completed_at)` + `wf_events` + `process_log` |
| `noc_users(USER_ID, USER_NAME, MOBILE, DELETED)` | the queries above | `users` + `dept_profiles` |
| `noc_citizens(CITIZEN_ID, MOBILE, DELETED)` | the queries above | `users(portal='citizen')` + `citizen_profiles` |
| `DELETED = 0` convention | all queries | `deleted_at IS NULL` |
| `@OBJECT_ID` parameter convention | notification templates | route params |

Other artefacts mined for the model:

| Artefact | Used for |
|---|---|
| `uploads/rules/{1..12}.rule`, `ffe_type.rule`, `other_notes.rule`, `riser_width.rule` | `re_rule_sets` / `re_rule_set_versions` of kind `decision_tree` (verbatim JSON, already converted by the frontend) |
| `uploads/rules/validations/{MSB,declaration,height}.rule` | decision tables `noc.approval_level`, `noc.renewal_period`; decision tree `noc.height_limits` |
| `uploads/rules/workflow/workflow.rule`, `workflow_rfo update.rule`, `templates.txt` | the shape of `wf_definition_versions.definition` (steps, `assign_to`, `form`, `print`, `move_to`; `alerts` reserved — N-10) |
| `uploads/templates/Email/*.xml`, `templates.txt` | `notification_templates` (submitted, assigned_to, forwarded_to, final_status, final_status_mail, forgot_password) |
| `uploads/applications/<id>/{documents,inspection}/…`, `uploads/blocks/<id>/…`, `FinalDoc.pdf`, `Declaration.pdf` | inspiration for the storage key scheme (`40-data-model.md` §4.8). No import: there is no legacy data (Q-6). |
| `apis/*.txt` (ApplTypes, BuildTypes, Districts, FireStations, Hazards, Equipments, FFE_Notes, Statuses, MappedCodes, Directions, RoleStatuses, Users, newappl, newrenewal, ApplList, Application, Block) | the reference tables and the aggregate shape |
| `script/commonrules.js` (29 `Common_*` functions) | `@noc/domain/commonrules` (already ported) |

## A1.2 Endpoint map

### Auth & accounts

| Legacy | Catalogue id | New route | Tables |
|---|---|---|---|
| `login.aspx` | `accountsList` (client-side match) | `POST /auth/login` | users, refresh_tokens, audit_log |
| `register.aspx` | `authRegister` | `POST /auth/register` | users, citizen_profiles, notification_outbox |
| `forgotpwd.aspx` | `authForgotPassword` | `POST /auth/forgot-password` | password_reset_tokens, notification_outbox |
| `changepass.aspx` | `authChangePassword` | `PUT /auth/password` | users |
| `users.aspx` | `accountsList` | `GET /admin/accounts` | users + profiles + stations |
| *(new)* | `adminCitizenUpdate` | `PUT /admin/accounts/:id/profile` | users, citizen_profiles |
| `changepass.aspx` (admin) | `adminCitizenChangePassword`, `adminDeptUserResetPassword` | `POST /admin/accounts/:id/reset-password` | users |
| *(new)* | `adminAccountSetActive` | `PUT /admin/accounts/:id/active` | users |
| *(new)* | `adminDeptUserCreate` / `adminDeptUserUpdate` | `POST /admin/accounts/dept` / `PUT /admin/accounts/:id/dept` | users, dept_profiles, dept_user_stations |

### Reference data

| Legacy | Catalogue id | New route | Table |
|---|---|---|---|
| `apis/ApplTypes.txt` | `lookupApplicationTypes` | `GET /lookups/application-types` | application_types(+modes) |
| `apis/BuildTypes.txt` | `lookupBuildTypes` | `GET /lookups/build-types` | build_types(+sub) |
| `apis/Directions.txt` | `lookupDirections` | `GET /lookups/directions` | directions |
| `apis/Districts.txt` | `lookupDistricts` | `GET /lookups/districts` | districts |
| `apis/FireStations.txt` | `lookupFireStations` | `GET /lookups/fire-stations` | fire_stations |
| `apis/Hazards.txt` | `lookupHazards` | `GET /lookups/hazards` | hazards |
| `apis/MappedCodes.txt` | `lookupMappedCodes` | `GET /lookups/mapped-codes` | mapped_codes |
| `apis/Equipments.txt` | `lookupEquipments` | `GET /lookups/equipments` | equipments |
| `apis/FFE_Notes.txt` | `lookupFfeNotes` | `GET /lookups/ffe-notes` | ffe_notes |
| `apis/Statuses.txt` | `lookupStatuses` | `GET /lookups/statuses` | statuses |
| *(server roles table)* | `lookupDeptRoles` | `GET /lookups/dept-roles` | dept_roles |
| *(RFO-ER / RFO-SR)* | `lookupRegions` | `GET /lookups/regions` | regions |
| `newappl.txt parties[]` | `lookupPartyRoles` | `GET /lookups/party-roles` | party_roles |
| *(hardcoded in `editpnoc_1.html`)* | `lookupBlockOptions` | `GET /lookups/block-options` | block_option_values |
| upload sections of `editpnoc/onoc/rnoc/dnoc.html` | `lookupDocumentRequirements` | `GET /lookups/document-requirements` | document_requirements |
| `editpnoc_2.html` + `commonrules.js` | `lookupEscapeRules` | `GET /lookups/escape-rules` | re_rule_set_versions (`noc.escape_limits` parameters) |
| `dept/partials/noc_terms*.html` | `lookupNocTerms` | `GET /lookups/noc-terms` | reference_documents |
| `common/partials/table23.html` | `lookupNbcTable7` | `GET /lookups/nbc-table7` | reference_documents |
| `confirmpnoc/onoc/rnoc.html` | `lookupUndertakings` | `GET /lookups/undertakings` | undertakings |
| `confirmpconditions.html` / `saveconditions.aspx` | `lookupOccupancyConditions` | `GET /lookups/occupancy-conditions` | occupancy_conditions |
| `uploads/rules/*.rule` via `calculateffe.aspx` / `floorwise_ffe.aspx` | `rulesFfe*`, `rulesHeightLimits` | `GET /rules/**` | re_rule_set_versions (decision trees) |

### Configuration

| Legacy | Catalogue id | New route | Tables |
|---|---|---|---|
| `challan_amt_reqd` / `PFInit.aspx` | `configFees`, `adminSaveFees` | `GET/PUT /config/fees` | re_rule_set_versions (`noc.fees` parameters) |
| `validations/MSB.rule` | `configDelegationRules`, `adminSaveDelegationRules` | `GET/PUT /config/delegation-rules` | re_rule_set_versions (`noc.approval_level` table) |
| `validations/declaration.rule` + `periodicityofrenewal.png` | `configRenewalRules`, `adminSaveRenewalRules` | `GET/PUT /config/renewal-rules` | re_rule_set_versions (`noc.renewal_period` table) |
| `process_steps.aspx` (server-side steps) | `configWorkflows`, `adminSaveWorkflows`, `configWorkflowsDefault` | `GET /config/workflows`, `PUT /config/workflows/:code` | wf_definitions, wf_definition_versions, wf_version_refs, noc_workflow_bindings |
| `dept/partials/*_note*.html`, `dfo_report*.html`, `dgfs_note*.html` | `configForms` | `GET /config/forms` | wf_forms |
| `rtimeout` / `escalations.aspx` | `configSla`, `adminSaveSla` | `GET/PUT /config/sla` | wf_sla_policies, wf_escalation_settings |

### Applications

| Legacy | Catalogue id | New route | Tables |
|---|---|---|---|
| `citizen/applications.aspx` | `citizenApplicationList` | `GET /applications?scope=mine` | v_application_summary |
| `citizen/application.aspx` | `citizenApplicationDetail`, `deptApplication` | `GET /applications/:id` | the whole aggregate |
| `newapplication.aspx` / `newdeclaration.aspx` | `citizenApplicationCreate` | `POST /applications` | applications, application_parties |
| `newonocappl.aspx` | `citizenOccupancyFromProvisional` | `POST /applications/:id/occupancy` | applications, blocks…, application_conditions |
| `NewRenewals.aspx` | `citizenRenewalFromOccupancy` | `POST /applications/:id/renewal` | applications, blocks… |
| `update_application.aspx` + `saveblockdetails.aspx` + `saveffe.aspx` | `citizenApplicationUpdate` | `PUT /applications/:id` | the whole aggregate |
| `submitapplication.aspx` | `citizenApplicationSubmit` | `POST /applications/:id/submit` | applications, application_number_sequence, application_assessments, application_revisions, wf_instances, wf_tasks, wf_events, process_log, notification_outbox |
| `revise.aspx` | `citizenApplicationRevise` | `POST /applications/:id/revise` | applications, wf_instances(status=archived), application_revisions(archived) |
| `delete_application.aspx` | `citizenApplicationDelete` | `DELETE /applications/:id` | applications(deleted_at) |
| `uploaddocs.aspx` / `uploadplans.aspx` | `documentUpload` | `POST /applications/:id/documents` | files, application_documents |
| `uploaddeptdocs.aspx` / `upload_request.aspx` | `citizenRequestedDocUpload` | `POST /applications/:id/document-requests/:fileid/response` | files, document_requests |
| `PFInit.aspx` / `PaymentRequest.aspx` / `PaymentReturn.aspx` | `paymentInitiate` | `POST /applications/:id/payment` | payments, payment_events |
| `savefeedback.aspx` | `citizenFeedbackSave` | `POST /applications/:id/feedback` | application_feedback |
| `dept/applications.aspx` | `deptQueue` | `GET /applications?scope=dept` | v_application_summary |
| `dept/search.aspx` + `draftfiles.htm` | `adminApplicationSearch` | `GET /applications?scope=all` | v_application_summary |
| `admin/deleteOldFiles.aspx` | `adminApplicationDelete` | `DELETE /applications` | applications(deleted_at) |

### Department workflow

| Legacy | Catalogue id | New route | Tables |
|---|---|---|---|
| `RoleStatuses.txt` buckets (derived) | — | `GET /dept/tasks`, `GET /dept/monitoring` | v_active_tasks |
| `Feedback_AvgRating.aspx` | `deptFeedbackRatings` | `GET /dept/feedback-summary` | application_feedback |
| `process_move.aspx?s=false` | `deptTaskSave` | `POST /dept/applications/:id/tasks/:taskId/save` | wf_tasks |
| `process_move.aspx?s=true` | `deptTaskSubmit` | `…/submit` | wf_tasks, applications, process_log |
| `sendback.aspx` | `deptSendBack` | `…/send-back` | wf_tasks, applications, process_log |
| `process_move.aspx` ("Officer Bypassed") | `deptSkipTask` | `…/skip` | wf_tasks |
| `reassign.aspx` | `deptReassignTask` | `…/reassign` | wf_tasks, wf_instances.decider_actor_id |
| `process_move.aspx` (final) + `uploaddocs.aspx` (FinalDoc) | `deptDecision` | `…/decide` | wf_tasks, wf_task_attachments, applications, application_revisions(decided), files, process_log |
| `uploaddeptdocs.aspx` (request) | `deptRequestDocuments` | `POST /dept/applications/:id/document-requests` | document_requests |
| `uploaddeptdocs.aspx` | `deptUploadDocument` | `POST /dept/applications/:id/dept-documents` | files, dept_documents |
| `sendsms.aspx` | `deptSendSms` | `POST /dept/applications/:id/sms` | sms_messages, notification_outbox |
| `update_application.aspx` (fire station) | `deptUpdateFireStation` | `PUT /dept/applications/:id/fire-station` | applications, wf_tasks |
| `update_application.aspx` (licensing authority) | `deptUpdateLicensingAuthority` | `PUT /dept/applications/:id/licensing-authority` | applications |
| *(new — officer deactivation)* | `adminReassignTasks` | `POST /admin/accounts/:id/handover` | wf_tasks |
| `reports.aspx (Rpt_type 1-7)` + `reports/rpt_*.html` | `deptReports` | `GET /dept/reports/:reportId` | v_report_base |
| `admin/escalations.aspx` | `adminSendEscalations` | `POST /admin/escalations/send` | wf_escalation_runs, wf_escalation_notices, wf_reminders, notification_outbox |

## A1.3 Legacy screens deliberately not backed by any route

`fulledit.html`, `receive.html` / `inwardlist.html`, `insrpt.html` / `inspectlist.html`,
`display_*.html`, `statusupdate.aspx`, *Pull Back*, *Recalculate Equipment*, the SDP/MAUD
integration module, the Goa NOC format (`final_noc_g`), the one-off format (`final_noc_ic`),
the NBC-2005 wording, and the "Existing Building / Pilot" application type
(`appl_type O` + `appl_mode E`) — all already dropped by the frontend migration
(`docs/04-migration-plan.md` decisions D-1…D-5) and therefore absent from the schema too.
