/**
 * ============================================================================
 *  CENTRAL API CATALOGUE
 * ============================================================================
 * The ONE file that knows the URL of every operation the portal performs on
 * the NOC backend. Feature services call `ApiClient` with an entry of
 * `API_ENDPOINTS` — never with a literal URL and never with `HttpClient`.
 *
 * Each entry records the REST route (`:param` placeholders are substituted
 * from the params given at call time) and the legacy ASP.NET endpoint it
 * replaces, for traceability back to the original AngularJS application
 * (docs/03-api-catalog.md, docs/backend/50-api-design.md).
 * ============================================================================
 */

export type HttpMethodKind = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface ApiEndpoint {
  /** Stable key — also the record key in API_ENDPOINTS. */
  id: string;
  description: string;
  method: HttpMethodKind;
  /** Path under the API base (`environment.apiBaseUrl`), may contain `:param` placeholders. */
  path: string;
  /** The legacy endpoint this replaces (traceability). */
  legacy: string;
}

function endpoint(e: ApiEndpoint): ApiEndpoint {
  return e;
}

export const API_ENDPOINTS = {
  // ── Authentication & session ──────────────────────────────────────────────
  authLogin: endpoint({ id: 'authLogin', method: 'POST', path: '/auth/login', description: 'Sign in (username or e-mail + password); returns the access token, sets the refresh cookie', legacy: 'modules/login.aspx' }),
  authRefresh: endpoint({ id: 'authRefresh', method: 'POST', path: '/auth/refresh', description: 'Silent refresh from the httpOnly cookie (rotating, reuse-detecting)', legacy: '(new)' }),
  authLogout: endpoint({ id: 'authLogout', method: 'POST', path: '/auth/logout', description: 'Sign out (revokes the refresh-token family)', legacy: 'logout.aspx' }),
  authMe: endpoint({ id: 'authMe', method: 'GET', path: '/auth/me', description: 'The signed-in account', legacy: '(new)' }),
  authRegister: endpoint({ id: 'authRegister', method: 'POST', path: '/auth/register', description: 'Register a new citizen account', legacy: 'modules/register/register.aspx' }),
  authForgotPassword: endpoint({ id: 'authForgotPassword', method: 'POST', path: '/auth/forgot-password', description: 'Request a password-reset link (same answer whether or not the account exists)', legacy: 'modules/register/forgotpwd.aspx' }),
  authResetPassword: endpoint({ id: 'authResetPassword', method: 'POST', path: '/auth/reset-password', description: 'Set a new password from a reset / "set your password" link', legacy: '(new)' }),
  authChangePassword: endpoint({ id: 'authChangePassword', method: 'PUT', path: '/auth/password', description: 'Change the password of the logged-in user (self-service)', legacy: 'modules/register/changepass.aspx / dept chpwd' }),
  // ── Cached reference data (docs/backend/55-caching.md) ────────────────────
  metaVersions: endpoint({ id: 'metaVersions', method: 'GET', path: '/meta/versions', description: 'Current version of every cached bundle', legacy: '(new)' }),
  bundle: endpoint({ id: 'bundle', method: 'GET', path: '/bundles/:name', description: 'A whole bundle (reference, rules, content, workflow, directory)', legacy: '(new)' }),
  bundleVersion: endpoint({ id: 'bundleVersion', method: 'GET', path: '/bundles/:name/v/:version', description: 'One immutable version of a bundle', legacy: '(new)' }),
  // ── Lookups (served from the reference / rules / content bundles) ─────────
  lookupApplicationTypes: endpoint({ id: 'lookupApplicationTypes', method: 'GET', path: '/lookups/application-types', description: 'Application type catalog (Provisional/Occupancy/Renewal/Declaration) incl. FFE column modes', legacy: 'apis/ApplTypes.txt' }),
  lookupBuildTypes: endpoint({ id: 'lookupBuildTypes', method: 'GET', path: '/lookups/build-types', description: 'Building occupancy/use type catalog with height limits', legacy: 'apis/BuildTypes.txt' }),
  lookupDirections: endpoint({ id: 'lookupDirections', method: 'GET', path: '/lookups/directions', description: 'Compass directions', legacy: 'apis/Directions.txt' }),
  lookupDistricts: endpoint({ id: 'lookupDistricts', method: 'GET', path: '/lookups/districts', description: 'District master list', legacy: 'apis/Districts.txt' }),
  lookupFireStations: endpoint({ id: 'lookupFireStations', method: 'GET', path: '/lookups/fire-stations', description: 'Fire stations grouped by district', legacy: 'apis/FireStations.txt' }),
  lookupHazards: endpoint({ id: 'lookupHazards', method: 'GET', path: '/lookups/hazards', description: 'Hazard / activity classification list', legacy: 'apis/Hazards.txt' }),
  lookupMappedCodes: endpoint({ id: 'lookupMappedCodes', method: 'GET', path: '/lookups/mapped-codes', description: 'DTCP <-> NBC activity code mapping', legacy: 'apis/MappedCodes.txt' }),
  lookupEquipments: endpoint({ id: 'lookupEquipments', method: 'GET', path: '/lookups/equipments', description: 'Fire fighting equipment catalog', legacy: 'apis/Equipments.txt' }),
  lookupFfeNotes: endpoint({ id: 'lookupFfeNotes', method: 'GET', path: '/lookups/ffe-notes', description: 'Explanatory footnotes for FFE requirement tables', legacy: 'apis/FFE_Notes.txt' }),
  lookupStatuses: endpoint({ id: 'lookupStatuses', method: 'GET', path: '/lookups/statuses', description: 'Canonical application lifecycle statuses (1-9)', legacy: 'apis/Statuses.txt' }),
  lookupDeptRoles: endpoint({ id: 'lookupDeptRoles', method: 'GET', path: '/lookups/dept-roles', description: 'Department role catalog (legacy role ids) with the typical jurisdiction of each role', legacy: '(server-side roles table)' }),
  lookupRegions: endpoint({ id: 'lookupRegions', method: 'GET', path: '/lookups/regions', description: 'Regions (RFO jurisdictions): districts of the Eastern and Southern regions', legacy: '(server-side: RFO-ER / RFO-SR users)' }),
  lookupPartyRoles: endpoint({ id: 'lookupPartyRoles', method: 'GET', path: '/lookups/party-roles', description: 'Technical party roles and which application types require them', legacy: 'apis/newappl.txt parties[]' }),
  lookupBlockOptions: endpoint({ id: 'lookupBlockOptions', method: 'GET', path: '/lookups/block-options', description: 'Floor types, floor occupancies, escape types, side property types', legacy: '(hardcoded in editpnoc_1.html)' }),
  lookupDocumentRequirements: endpoint({ id: 'lookupDocumentRequirements', method: 'GET', path: '/lookups/document-requirements', description: 'Required documents & plans per application type', legacy: 'editpnoc.html / editonoc.html / editrnoc.html / editdnoc.html upload sections' }),
  lookupEscapeRules: endpoint({ id: 'lookupEscapeRules', method: 'GET', path: '/lookups/escape-rules', description: 'Travel distance, exit, head-room, projection and refuge limits', legacy: 'editpnoc_2.html + commonrules.js (Table 5)' }),
  lookupNocTerms: endpoint({ id: 'lookupNocTerms', method: 'GET', path: '/lookups/noc-terms', description: 'Conditions printed on NOCs (verbatim legal text per type / delegation level)', legacy: 'modules/dept/partials/noc_terms*.html' }),
  lookupUndertakings: endpoint({ id: 'lookupUndertakings', method: 'GET', path: '/lookups/undertakings', description: 'Undertakings the applicant ticks on the final confirmation page, per application type', legacy: 'modules/citizen/partials/confirmpnoc.html / confirmonoc.html / confirmrnoc.html' }),
  lookupOccupancyConditions: endpoint({ id: 'lookupOccupancyConditions', method: 'GET', path: '/lookups/occupancy-conditions', description: 'Provisional NOC conditions to confirm when applying for Occupancy', legacy: 'confirmpconditions.html / saveconditions.aspx' }),
  lookupNbcTable7: endpoint({ id: 'lookupNbcTable7', method: 'GET', path: '/lookups/nbc-table7', description: 'NBC Part 4 Table 7 — minimum requirements for fire fighting installations (reference shown with the FFE grid)', legacy: 'modules/common/partials/table23.html' }),
  rulesFfeEquipment: endpoint({ id: 'rulesFfeEquipment', method: 'GET', path: '/rules/ffe/:id', description: 'FFE decision tree for one equipment id (:id = Equipments.txt id)', legacy: 'uploads/rules/{id}.rule (calculateffe.aspx / floorwise_ffe.aspx)' }),
  rulesFfeType: endpoint({ id: 'rulesFfeType', method: 'GET', path: '/rules/ffe-type', description: 'Fire extinguisher type decision tree (note key)', legacy: 'uploads/rules/ffe_type.rule' }),
  rulesOtherNotes: endpoint({ id: 'rulesOtherNotes', method: 'GET', path: '/rules/other-notes', description: 'Block-level FFE notes decision tree', legacy: 'uploads/rules/other_notes.rule' }),
  rulesRiserWidth: endpoint({ id: 'rulesRiserWidth', method: 'GET', path: '/rules/riser-width', description: 'Wet riser / down comer size decision tree', legacy: 'uploads/rules/riser_width.rule' }),
  rulesHeightLimits: endpoint({ id: 'rulesHeightLimits', method: 'GET', path: '/rules/height-limits', description: 'Maximum permissible height by occupancy decision tree', legacy: 'uploads/rules/validations/height.rule' }),
  // ── Configuration (admin-editable; published as new immutable versions) ───
  configFees: endpoint({ id: 'configFees', method: 'GET', path: '/config/fees', description: 'Fee rates per sq.m, penalties, declaration fee and portal charges', legacy: '(server-side challan_amt_reqd / PFInit.aspx)' }),
  adminSaveFees: endpoint({ id: 'adminSaveFees', method: 'PUT', path: '/config/fees', description: 'Admin: update fee configuration', legacy: '(new) admin rules configuration' }),
  configDelegationRules: endpoint({ id: 'configDelegationRules', method: 'GET', path: '/config/delegation-rules', description: 'Approval level (MSB/RFO/DFO) rules', legacy: 'uploads/rules/validations/MSB.rule' }),
  adminSaveDelegationRules: endpoint({ id: 'adminSaveDelegationRules', method: 'PUT', path: '/config/delegation-rules', description: 'Admin: update approval level rules', legacy: '(new) admin rules configuration' }),
  configRenewalRules: endpoint({ id: 'configRenewalRules', method: 'GET', path: '/config/renewal-rules', description: 'Renewal periodicity rules', legacy: 'uploads/rules/validations/declaration.rule + images/periodicityofrenewal.png' }),
  adminSaveRenewalRules: endpoint({ id: 'adminSaveRenewalRules', method: 'PUT', path: '/config/renewal-rules', description: 'Admin: update renewal periodicity rules', legacy: '(new) admin rules configuration' }),
  ruleSetVersions: endpoint({ id: 'ruleSetVersions', method: 'GET', path: '/config/rules/:code/versions', description: 'Published versions of a rule set, newest first', legacy: '(new)' }),
  ruleSetEvaluate: endpoint({ id: 'ruleSetEvaluate', method: 'POST', path: '/rules/sets/:code/evaluate', description: 'Evaluate the published rule set for some facts, with the trace', legacy: '(new)' }),
  configWorkflows: endpoint({ id: 'configWorkflows', method: 'GET', path: '/config/workflows', description: 'Workflow per application type × approval level (stages, tasks, roles, forms, permissions)', legacy: '(server-side process steps — process_steps.aspx)' }),
  configWorkflowsDefault: endpoint({ id: 'configWorkflowsDefault', method: 'GET', path: '/config/workflows/defaults', description: 'Workflows as shipped (used by "Restore default")', legacy: '(new)' }),
  workflowUsage: endpoint({ id: 'workflowUsage', method: 'GET', path: '/config/workflows/usage', description: 'Files per workflow and version (current runs)', legacy: '(new)' }),
  workflowValidate: endpoint({ id: 'workflowValidate', method: 'POST', path: '/config/workflows/validate', description: 'Problems of a workflow definition (nothing saved)', legacy: '(new)' }),
  workflowSimulate: endpoint({ id: 'workflowSimulate', method: 'POST', path: '/config/workflows/simulate', description: 'Who would do what for a fire station', legacy: '(new)' }),
  adminSaveWorkflow: endpoint({ id: 'adminSaveWorkflow', method: 'PUT', path: '/config/workflows/:code', description: 'Save a workflow as a new version (files in process keep theirs)', legacy: '(new) admin workflow configuration' }),
  workflowVersions: endpoint({ id: 'workflowVersions', method: 'GET', path: '/config/workflows/:code/versions', description: 'Versions of a workflow with their usage', legacy: '(new)' }),
  workflowRestore: endpoint({ id: 'workflowRestore', method: 'POST', path: '/config/workflows/:code/restore/:version', description: 'Republish an earlier version', legacy: '(new)' }),
  configForms: endpoint({ id: 'configForms', method: 'GET', path: '/config/forms', description: 'Note / report forms a workflow task can use', legacy: 'modules/dept/partials/*_note*.html, dfo_report*.html, dgfs_note*.html' }),
  configSla: endpoint({ id: 'configSla', method: 'GET', path: '/config/sla', description: 'SLA per workflow (per step, inspection, processing) and escalation recipients', legacy: '(new; legacy rtimeout / escalations.aspx)' }),
  adminSaveSla: endpoint({ id: 'adminSaveSla', method: 'PUT', path: '/config/sla', description: 'Admin: save the SLA and escalation settings', legacy: '(new) admin SLA configuration' }),
  configStatuses: endpoint({ id: 'configStatuses', method: 'GET', path: '/config/statuses', description: 'Statuses with their category, badge and order', legacy: '(new)' }),
  // ── Applications — citizen lifecycle ──────────────────────────────────────
  citizenApplicationList: endpoint({ id: 'citizenApplicationList', method: 'GET', path: '/applications', description: 'My Applications (summaries; ?scope=mine)', legacy: 'modules/citizen/applications.aspx' }),
  applicationDetail: endpoint({ id: 'applicationDetail', method: 'GET', path: '/applications/:id', description: 'The full application aggregate (visibility by portal and jurisdiction)', legacy: 'modules/citizen/application.aspx' }),
  citizenApplicationCreate: endpoint({ id: 'citizenApplicationCreate', method: 'POST', path: '/applications', description: 'Create a new draft application (any type)', legacy: 'modules/citizen/newapplication.aspx / newdeclaration.aspx' }),
  citizenApplicationUpdate: endpoint({ id: 'citizenApplicationUpdate', method: 'PUT', path: '/applications/:id', description: 'Save a draft application incl. blocks/floors/FFE (legacy SaveApplication — only site name + address needed)', legacy: 'modules/citizen/update_application.aspx + saveblockdetails.aspx + saveffe.aspx' }),
  citizenApplicationDelete: endpoint({ id: 'citizenApplicationDelete', method: 'DELETE', path: '/applications/:id', description: 'Delete a draft application', legacy: 'modules/citizen/delete_application.aspx' }),
  citizenOccupancyFromProvisional: endpoint({ id: 'citizenOccupancyFromProvisional', method: 'POST', path: '/applications/:id/occupancy', description: 'Create an Occupancy draft carried forward from an issued Provisional NOC', legacy: 'modules/citizen/newonocappl.aspx' }),
  citizenRenewalFromOccupancy: endpoint({ id: 'citizenRenewalFromOccupancy', method: 'POST', path: '/applications/:id/renewal', description: 'Create a Renewal draft carried forward from an issued Occupancy NOC', legacy: 'modules/citizen/NewRenewals.aspx' }),
  applicationFee: endpoint({ id: 'applicationFee', method: 'GET', path: '/applications/:id/fee', description: 'Fee position: current fee, paid, due, frozen', legacy: '(new)' }),
  paymentInitiate: endpoint({ id: 'paymentInitiate', method: 'POST', path: '/applications/:id/payment', description: 'Online fee payment (simulated gateway)', legacy: 'PFInit.aspx / PaymentRequest.aspx / PaymentReturn.aspx' }),
  citizenApplicationSubmit: endpoint({ id: 'citizenApplicationSubmit', method: 'POST', path: '/applications/:id/submit', description: 'Submit a draft application to the department', legacy: 'modules/citizen/submitapplication.aspx' }),
  citizenApplicationRevise: endpoint({ id: 'citizenApplicationRevise', method: 'POST', path: '/applications/:id/revise', description: 'Reopen a returned/rejected application as a new revision', legacy: 'modules/citizen/revise.aspx' }),
  citizenFeedbackSave: endpoint({ id: 'citizenFeedbackSave', method: 'POST', path: '/applications/:id/feedback', description: 'Citizen rating / feedback on a completed application', legacy: 'modules/citizen/savefeedback.aspx' }),
  applicationRevisions: endpoint({ id: 'applicationRevisions', method: 'GET', path: '/applications/:id/revisions', description: 'Retained snapshots (submitted / decided / archived)', legacy: '(new)' }),
  documentUpload: endpoint({ id: 'documentUpload', method: 'POST', path: '/applications/:id/documents', description: 'Attach a document/plan (metadata only in this stub build)', legacy: 'modules/citizen/uploaddocs.aspx / uploadplans.aspx' }),
  documentRemove: endpoint({ id: 'documentRemove', method: 'DELETE', path: '/applications/:id/documents/:docNo', description: 'Remove a document from a draft', legacy: '(new)' }),
  citizenRequestedDocUpload: endpoint({ id: 'citizenRequestedDocUpload', method: 'POST', path: '/applications/:id/document-requests/:requestNo/response', description: 'Upload a document requested by the department', legacy: 'modules/dept/uploaddeptdocs.aspx / upload_request.aspx' }),
  applicationCertificate: endpoint({ id: 'applicationCertificate', method: 'GET', path: '/applications/:id/certificate/:kind', description: 'Facts for a printable certificate / letter', legacy: 'modules/citizen/*_print.html' }),
  applicationAssessment: endpoint({ id: 'applicationAssessment', method: 'GET', path: '/applications/:id/assessment', description: 'The server assessment of a stored application', legacy: '(new)' }),
  assessmentPreview: endpoint({ id: 'assessmentPreview', method: 'POST', path: '/assessments', description: 'Stateless assessment of an unsaved application', legacy: '(new)' }),
  fileDownloadToken: endpoint({ id: 'fileDownloadToken', method: 'POST', path: '/files/:id/download-token', description: 'One-time link to open a stored file', legacy: 'uploads/*' }),
  // ── Department ────────────────────────────────────────────────────────────
  deptTasks: endpoint({ id: 'deptTasks', method: 'GET', path: '/dept/tasks', description: 'My open tasks', legacy: 'modules/dept/applications.aspx' }),
  deptMonitoring: endpoint({ id: 'deptMonitoring', method: 'GET', path: '/dept/monitoring', description: 'Files the officer follows (paginated, with stage chips and KPIs)', legacy: 'modules/dept/applications.aspx' }),
  deptSearch: endpoint({ id: 'deptSearch', method: 'GET', path: '/applications', description: 'Department search (?scope=dept)', legacy: 'modules/dept/search.aspx' }),
  deptFeedbackRatings: endpoint({ id: 'deptFeedbackRatings', method: 'GET', path: '/dept/feedback-summary', description: 'Average citizen rating (dept dashboard)', legacy: 'modules/dept/Feedback_AvgRating.aspx' }),
  deptApplication: endpoint({ id: 'deptApplication', method: 'GET', path: '/dept/applications/:id', description: 'The processing page: application, what the officer may do, parent', legacy: 'modules/citizen/application.aspx + modules/dept/process_steps.aspx' }),
  deptTaskSave: endpoint({ id: 'deptTaskSave', method: 'POST', path: '/dept/applications/:id/tasks/:taskNo/save', description: 'Department: save the note / report of a task as a draft', legacy: 'modules/dept/process_move.aspx?s=false' }),
  deptTaskSubmit: endpoint({ id: 'deptTaskSubmit', method: 'POST', path: '/dept/applications/:id/tasks/:taskNo/submit', description: 'Department: submit the note / report of a task', legacy: 'modules/dept/process_move.aspx?s=true' }),
  deptSendBack: endpoint({ id: 'deptSendBack', method: 'POST', path: '/dept/applications/:id/tasks/:taskNo/send-back', description: 'Department: send the file back to the previous stage', legacy: 'modules/dept/sendback.aspx' }),
  deptSkipTask: endpoint({ id: 'deptSkipTask', method: 'POST', path: '/dept/applications/:id/tasks/:taskNo/skip', description: 'Department: the issuing authority bypasses an officer', legacy: 'modules/dept/process_move.aspx (Officer Bypassed)' }),
  deptReassignTask: endpoint({ id: 'deptReassignTask', method: 'POST', path: '/dept/applications/:id/tasks/:taskNo/reassign', description: 'Department: the issuing authority changes the officer of a task', legacy: 'modules/dept/reassign.aspx' }),
  deptSignedCopy: endpoint({ id: 'deptSignedCopy', method: 'POST', path: '/dept/applications/:id/tasks/:taskNo/signed-copy', description: 'Upload the signed NOC / letter before the decision', legacy: 'uploaddocs.aspx (FinalDoc)' }),
  deptDecisionPreview: endpoint({ id: 'deptDecisionPreview', method: 'POST', path: '/dept/applications/:id/tasks/:taskNo/decision-preview', description: 'The application as it would be after the decision (live preview)', legacy: '(new)' }),
  deptDecision: endpoint({ id: 'deptDecision', method: 'POST', path: '/dept/applications/:id/tasks/:taskNo/decide', description: 'Department: final decision of the issuing authority (with the signed NOC / letter)', legacy: 'modules/dept/process_move.aspx (final step) + uploaddocs.aspx (FinalDoc)' }),
  deptRequestDocuments: endpoint({ id: 'deptRequestDocuments', method: 'POST', path: '/dept/applications/:id/document-requests', description: 'Department: request a document from the applicant', legacy: 'modules/dept/uploaddeptdocs.aspx (request)' }),
  deptUploadDocument: endpoint({ id: 'deptUploadDocument', method: 'POST', path: '/dept/applications/:id/dept-documents', description: 'Department: upload a document (e.g. inspection photographs)', legacy: 'modules/dept/uploaddeptdocs.aspx' }),
  deptSendSms: endpoint({ id: 'deptSendSms', method: 'POST', path: '/dept/applications/:id/sms', description: 'Department: send an SMS to the applicant (simulated)', legacy: 'modules/dept/sendsms.aspx' }),
  deptUpdateFireStation: endpoint({ id: 'deptUpdateFireStation', method: 'PUT', path: '/dept/applications/:id/fire-station', description: 'Department: change the fire station of a file (Submitted only)', legacy: 'modules/dept/update_application.aspx (fire station)' }),
  deptUpdateLicensingAuthority: endpoint({ id: 'deptUpdateLicensingAuthority', method: 'PUT', path: '/dept/applications/:id/licensing-authority', description: 'Department: update the licensing authority (final stage only)', legacy: 'modules/dept/update_application.aspx (licensing authority)' }),
  deptReports: endpoint({ id: 'deptReports', method: 'GET', path: '/dept/reports/:id', description: 'Department reports (pendency, statistics, consolidated, applications, overdue, SMS, feedback, challan, district, level-wise)', legacy: 'modules/dept/reports.aspx (Rpt_type 1-7) + reports/rpt_*.html' }),
  // ── Administration ────────────────────────────────────────────────────────
  adminAccounts: endpoint({ id: 'adminAccounts', method: 'GET', path: '/admin/accounts', description: 'Accounts (paginated; ?portal=&q=)', legacy: '(new) admin account management' }),
  adminAccount: endpoint({ id: 'adminAccount', method: 'GET', path: '/admin/accounts/:id', description: 'One account', legacy: '(new)' }),
  adminOfficers: endpoint({ id: 'adminOfficers', method: 'GET', path: '/admin/officers', description: 'Department officers (directory bundle)', legacy: '(new)' }),
  adminDeptUserCreate: endpoint({ id: 'adminDeptUserCreate', method: 'POST', path: '/admin/accounts/dept', description: 'Admin: add a department user', legacy: '(new) admin account management' }),
  adminDeptUserUpdate: endpoint({ id: 'adminDeptUserUpdate', method: 'PUT', path: '/admin/accounts/:id/dept', description: 'Admin: modify a department user', legacy: '(new) admin account management' }),
  adminCitizenUpdate: endpoint({ id: 'adminCitizenUpdate', method: 'PUT', path: '/admin/accounts/:id/profile', description: 'Admin: modify a citizen account profile', legacy: '(new) admin account management' }),
  adminSetPassword: endpoint({ id: 'adminSetPassword', method: 'POST', path: '/admin/accounts/:id/password', description: 'Set a password (or issue a temporary one) — must be changed at next sign-in', legacy: 'modules/admin/users.aspx (change password)' }),
  adminAccountSetActive: endpoint({ id: 'adminAccountSetActive', method: 'PUT', path: '/admin/accounts/:id/active', description: 'Admin: deactivate / reactivate any citizen or department account', legacy: '(new) admin account management' }),
  adminOpenTasks: endpoint({ id: 'adminOpenTasks', method: 'GET', path: '/admin/accounts/:id/open-tasks', description: 'Pending tasks of an officer', legacy: '(new)' }),
  adminHandover: endpoint({ id: 'adminHandover', method: 'POST', path: '/admin/accounts/:id/handover', description: 'Move every pending task of an officer to another (same role)', legacy: '(new) — deactivation of an officer' }),
  adminUnassignedTasks: endpoint({ id: 'adminUnassignedTasks', method: 'GET', path: '/admin/unassigned-tasks', description: 'Tasks nobody could be assigned to (Q-59)', legacy: '(new)' }),
  adminReassignTask: endpoint({ id: 'adminReassignTask', method: 'POST', path: '/admin/applications/:id/tasks/:taskNo/reassign', description: 'Assign a task (administrator)', legacy: '(new)' }),
  adminApplicationSearch: endpoint({ id: 'adminApplicationSearch', method: 'GET', path: '/applications', description: 'Search every application incl. drafts (?scope=all)', legacy: 'modules/dept/search.aspx + draftfiles.htm' }),
  adminApplicationDelete: endpoint({ id: 'adminApplicationDelete', method: 'DELETE', path: '/admin/applications', description: 'Admin: delete applications', legacy: 'modules/admin/deleteOldFiles.aspx' }),
  adminStatuses: endpoint({ id: 'adminStatuses', method: 'GET', path: '/admin/statuses', description: 'Statuses with their usage (N-4)', legacy: '(new)' }),
  adminStatusAdd: endpoint({ id: 'adminStatusAdd', method: 'POST', path: '/admin/statuses', description: 'Add an in-process status', legacy: '(new)' }),
  adminStatusUpdate: endpoint({ id: 'adminStatusUpdate', method: 'PUT', path: '/admin/statuses/:id', description: 'Rename / re-order / (de)activate an in-process status', legacy: '(new)' }),
  adminStatusRemove: endpoint({ id: 'adminStatusRemove', method: 'DELETE', path: '/admin/statuses/:id', description: 'Remove an in-process status nothing has used', legacy: '(new)' }),
  adminEscalationPreview: endpoint({ id: 'adminEscalationPreview', method: 'GET', path: '/admin/escalations/preview', description: 'Overdue items and the reminders due now', legacy: 'modules/admin/escalations.aspx' }),
  adminSendEscalations: endpoint({ id: 'adminSendEscalations', method: 'POST', path: '/admin/escalations/send', description: 'Escalation reminders for tasks / applications past their SLA', legacy: 'modules/admin/escalations.aspx' }),
  adminEscalationLog: endpoint({ id: 'adminEscalationLog', method: 'GET', path: '/admin/escalations/log', description: 'Escalation runs, newest first', legacy: '(new)' }),
  auditTrail: endpoint({ id: 'auditTrail', method: 'GET', path: '/audit', description: 'Audit trail, newest first (the administrator and the DG; kept 3 months)', legacy: '(new)' }),
} satisfies Record<string, ApiEndpoint>;

export type ApiEndpointId = keyof typeof API_ENDPOINTS;

/** All catalogue entries as an array (e.g. for a developer data explorer). */
export const ALL_API_ENDPOINTS: ApiEndpoint[] = Object.values(API_ENDPOINTS);
