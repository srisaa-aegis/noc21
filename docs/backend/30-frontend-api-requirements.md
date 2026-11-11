# 3. What the Angular 21 Frontend Actually Needs

Derived by reading every routed screen, every feature service and the API catalogue
(`frontend/src/app/core/api/api-endpoints.ts`, **79 entries**) of the new app, plus the
domain models in `core/models/**`. This is the requirement list the backend must satisfy.

## 3.1 Screen → data matrix

### Auth portal (`/auth`)

| Screen | Reads | Writes | Fields shown |
|---|---|---|---|
| Login | accounts (to match credentials), demo-account chips | session | username/e-mail, password; errors: *Invalid username or password.*, *This account has been deactivated…* |
| Register | — | new citizen account | name, mobile (10 digits), e-mail (**becomes the username**), gender, dob, aadhar, address → returns a **temporary password** shown once |
| Forgot password | accounts (by e-mail) | (reset request) | e-mail; errors: *No account found with that e-mail.*, *This account is deactivated…* |

### Citizen portal (`/citizen`)

| Screen | Reads | Writes |
|---|---|---|
| **Dashboard** | own applications as `ApplicationSummary[]`; application types (launcher cards + instruction dialogs); counters (total / in progress / approved / needs attention) | delete draft, rate, upload a requested document, start O/R carry-forward |
| **Application detail** `/applications/:id` | full `Application` aggregate + the workflow **stage stepper** (names only) + `processLog` + `deptfiles` (open requests) + `documents` + fee | feedback, requested-document upload |
| **Wizard** `/applications/:id/edit/**` | the aggregate + **all** lookups and rule trees + fee config + delegation rules + renewal rules + document requirements + undertakings + occupancy conditions + NBC Table 7 + escape rules + FFE notes + equipments + block options | save draft (whole aggregate), attach/remove document, pay online, record challan |
| **Confirm** `/applications/:id/confirm` | the aggregate, undertakings | **submit** |
| **Print** `/applications/:id/print/:doc` | the aggregate **+ its parent application** (certificates quote the Provisional/Occupancy NOC), NOC terms, renewal rules, district names | — |
| **Change password** | — | own password |

Print kinds: `acknowledgement` (status>1), `receipt` (payment paid), `certificate`
(status 7 → P/O/R/D legal format), `display-certificate` (status 7 and type O/R),
`rejection` (status 8 or 9).

### Department portal (`/dept`)

| Screen | Reads | Writes |
|---|---|---|
| **Dashboard** | *My tasks* (active tasks assigned to me, grouped, with days-pending + SLA badge + action label), *Monitoring* (applications in my jurisdiction whose workflow involves my role), feedback average by period, filters by type/level/district/text | — |
| **Processing page** `/applications/:id` | full aggregate + workflow run (stages snapshot, every task with officer/state/dates), documents, dept documents, SMS log, process log, parent application, all lookups, SLA, forms, roles | save task, submit task, send back, bypass, reassign, request document, upload dept document, send SMS, change fire station, update licensing authority, **final decision** (+ live preview, + mandatory signed copy) |
| **Search** | all submitted applications (text search) | — |
| **Reports** (10) | aggregations over all submitted applications with filters `level, type, region, status, host, from, to`; CSV + print | — |
| **Change password** | — | own password |

The ten reports: `pendency`, `statistics`, `consolidated`, `applications`, `overdue`,
`sms`, `feedback`, `challan`, `district`, `levels`.

### Admin portal (`/admin`)

| Screen | Reads | Writes |
|---|---|---|
| **Workbench** | escalation preview (overdue vs due now, last run), counts | send escalations, **reset demo data** |
| **Applications** | search incl. drafts, with `days_idle`, filters (text, type, status, drafts-only, idle-days) | delete one/many |
| **Citizen accounts** | citizen accounts | modify profile, change password, activate/deactivate |
| **Department users** | dept accounts + roles + districts + fire stations; open tasks of an officer | add (temp password), modify, reset password, activate/deactivate, **hand over open tasks** |
| **Rules & Fees** | fee config, delegation rules, renewal rules (+ live "try it") | save each |
| **Workflows** / **Workflow editor** | 12 definitions, defaults, forms, roles, regions, users, districts, stations, **usage counts per definition × version** | save a definition (validated, version + 1) |
| **SLA & Escalations** | SLA per workflow + escalation settings | save |

## 3.2 The 79 catalogue entries, grouped

| Group | # | Nature |
|---|---|---|
| Lookups / master data | 20 | read-only reference |
| Rule trees (FFE ×12 + 4) | 5 entries (one parameterised) | read-only, verbatim decision trees |
| Admin-configurable rules | 6 | read + write (fees, delegation, renewal) |
| Accounts & auth | 11 | read + write |
| Applications (citizen/dept/admin projections) | 17 | read + write, **all against one store** |
| Workflow config + dept operations + reports | 19 | read + write |
| Admin utilities | 1 | escalations |

Note how many logical operations share one asset today (`applications.json` appears in 25
entries). The backend turns each of those into its own route with its own authorisation and
its own transaction — the *API surface* stays 1:1 with the catalogue, the *storage* becomes
a proper schema.

## 3.3 Payload shapes the backend must produce

These are the TypeScript interfaces in `frontend/src/app/core/models/**`. They are the
**wire contract**; the backend's response schemas are generated from the same types (moved
to `@noc/domain/models`).

### `Application` (the aggregate, ~50 scalar fields + 8 collections)

```
appl_id, appl_number, appl_type(P|O|R|D), appl_mode('' |O|M|N), revision, owner(username)
site_name, site_addr, district, dist_name, firestation, corr_addr
plot_area, perimeter, lic_auth, lic_addr
build_name, build_landline, build_mobile, build_email, build_aadhar
ref_no, last_inspect_date, mcapprove_date, noc_level
applied_date, final_date, last_modified, status_id(1..9), delegation_level(MSB|RFO|DFO), reviewer
loc_lat, loc_lng, host_name(SDP|MAUD|null), parent_id, child_id
declaration_accepted, valid_from, valid_to, stage_label
parties[]        { sl_no, role_name, party_name, phone_number, email, license_no }
blocks[]         (see below)
conditions[]     { checklist_id, item_desc, selected:boolean|null }
documents[]      { doc_id, code, file_name, category, uploaded_on, size }
deptfiles[]      { fileid, appid, processid, file_name, file_desc, status(R|U|C), citizen_comment, requested_by, requested_on }
dept_documents[] { doc_id, file_name, description, uploaded_by, uploaded_on }
sms[]            { sms_id, message, sent_by, sent_on }
processLog[]     { step_id, uid, reviewer_name, role, status_id, action, remarks, at_date }
payment          { mode(online|challan|null), amount, status(pending|paid|failed), challan_num, challan_date, challan_bnk, challan_brch, txn_ref, paid_on }
feedback?        { rating 1-5, remarks, rated_on }
workflow?        WorkflowRun ; workflow_history?: WorkflowRun[]
```

### `Block` (one per building; the heaviest part)

```
block_id, sl_no, block_name, block_type(N|T|P), site_type, site_stype,
is_mixed, is_multiplex, is_miniplex, beds('Y'|'N'), height, permissible_height,
road_wide, xfer_sbak, front_dir, ta_dist, ta_dead, hrclear
roadwidening[] { rw_direc, rw_reqd }
sides[]        { bside_id, direc, ptype(R|B|S|O), pname, width }
floors[]       { floor_id, flr_type(B|S|G|F|T), flr_name, built_area, occ_type, occ_c_app, seats_num, parent_built_area?, parent_occ_c_app? }
ospaces[]      { ospace_id, direc, proposed, projection?, parent_proposed?, os_preqd? }
escapes[]      { escape_id, etype(I|E|R|C), desc, width, location, from_floor?, to_floor? }
exits[]        { exit_id, ename, width, awidth, direc }
doors[]        { door_id, desc, width, location }
lifts[]        { lift_id, ltype, lname, capacity }
refuges[]      { refuge_id, floor_id, area }
carparks[]     { cpark_id, floor, capacity }
ffe            { items[] { equip_id, level(F|B), floors:{[floor_id]:Cell}, block:Cell, note_keys[], added?, remarks? },
                 notes[] /* note keys */, agree_reqt }
                 Cell = { reqt:number|string|null, prop:number|string|null, prov:number|null }
```

**Important:** `block_id`, `floor_id`, `bside_id`, `doc_id`, `fileid`, `step_id`, `task_id`,
`sl_no` … are **local counters inside their parent**, not global ids (verified against the
fixtures: applications 101 and 102 both have blocks 1 and 2). The FFE grid keys its cells by
the *local* `floor_id`. In the database every table has an integer surrogate `id`, and these
local counters are stored as `*_no` columns that the serialiser maps back to the wire names
(`40-data-model.md` §4.0).

### `ApplicationSummary` (list projection — 30 fields)

Adds derived values the backend should compute in SQL rather than make the client fetch
aggregates: `site_type` (first block), `height` (max block height), `flr_count` (sum of
floors), `built_area` (sum of floor areas), `challan_amt`, `pending_requests` (open
`deptfiles`), `rating`, `challan_paid`, `bank_guarantee`, `undertaking`, `form16`,
`fire_draw_5` (presence of specific document codes).

### `WorkflowRun` / `WorkflowTask`

```
WorkflowRun  { definition_id('P-MSB'), version, revision, started_on, stages[snapshot],
               tasks[], approver(username|null), completed_on?, outcome? }
WorkflowTask { task_id, stage_key, task_key, name, role_id, assignee, assignee_name,
               state(waiting|active|done|skipped|sent_back|not_required),
               start_date?, end_date?, form, data{}, draft, remarks,
               recommendation?('Y'|'N'), decision?, sent_back_to? }
```

### `UserAccount`

```
id, username, password(!), displayName, portal(citizen|dept|admin), email, mobile,
active, created_on, must_change_password?, gender?, dob?, aadhar?, address?,
deptRoleId?, district?, stations?[], all_stations?
```
→ **The backend never returns `password`.** The login flow moves server-side; the
`accountsList` endpoint becomes an admin-only, password-free account list. The full list of
wire changes (this one, integer ids for roles/stations/workflows, status categories, …) is in
`65-frontend-integration.md` §65.4.

## 3.4 Reference data volumes (today's fixtures = the seed)

| Dataset | Rows |
|---|---|
| districts | 13 |
| fire stations | 13 groups, ~180 stations |
| regions | 2 (ER: districts 1–6, SR: 7–13) |
| application types | 4, with 8 modes and their FFE column sets |
| build types | 9 + sub-types |
| directions | 9 |
| hazards | 152 |
| DTCP↔NBC mapped codes | 210 |
| equipments | 13 |
| FFE notes | dictionary (~40 keys) |
| statuses | 9 |
| dept roles | 9 (ids 1,2,3,5,6,7,8,9,10) |
| party roles | 5 |
| block options | 6 groups (block/floor/occupancy/escape/side/lift types) |
| document requirements | 4 types + plan rules |
| occupancy conditions | 8 |
| undertakings | per type (P:6, O/R/D:3) |
| escape rules / NBC Table 7 / NOC terms | 3 reference documents (2 contain verbatim legal HTML) |
| FFE rule trees | 12 + `ffe_type`, `other_notes`, `riser_width`, `height_limits` |
| delegation rules / renewal rules | 7 / 4 (ordered, admin-editable) |
| fee config | 1 document |
| workflows / SLA / forms | 12 definitions (3–6 stages each) / 12 SLA entries + escalation settings / 9 forms (4 questionnaires with 5–9 questions) |
| demo accounts | 22 (4 citizens incl. 1 deactivated, 17 officers incl. 1 deactivated, 1 admin) |
| demo applications | 14 (every type & status: 3 drafts, 11 with workflow runs) |

## 3.5 Behaviours the backend owns (today done in the browser)

Per Revision 2 the backend is the **source of truth for every calculation and every
transition**:

1. **Application numbering** `yyyymm` + sequence — atomic (today `max+1` in the browser,
   which races). See the overflow note in `40-data-model.md` §4.6.
2. **Assessment on every save and submit** (rules engine): FFE grid (`reqt` cells and notes),
   required open spaces, occupant load / staircase / exit numbers, approval level, renewal
   period, fee, and the full submit validation. The server's values **replace** the
   client's in the save response.
3. **Fee freezing at payment** (Q-57): the fee and the parameter-set version used are
   recorded on the payment.
4. **Every workflow transition** (start, save draft, submit task, send back, bypass,
   reassign, decide, on-demand inspection, archive on revise), the officer resolution from
   the fire-station association, the SLA due dates, and `allowedOutcomes`.
5. **Derived workflow views**: "pending with", active stage, *My tasks*, *Monitoring*, and
   the **allowed actions** of the current user (the UI no longer derives permissions).
6. **Carry-forward** P→O and O→R, **revise**, and **revision snapshots** (Q-39).
7. **Certificate facts and validity** (`valid_from` / `valid_to`) and the decision preview.
8. **Reports** (10) and **escalations**.
9. **Authorisation** everywhere.

## 3.6 Behaviours that stay in the browser (Q-14)

Live feedback while typing: the FFE grid, open-space, staircase and occupant-load numbers,
inline validation messages and the fee preview. These use the **same** `@noc/domain` and
`@noc/rules-engine` code as the server and the **same rule versions**, delivered through the
cached `rules` bundle (`55-caching.md`). They are advisory only. On save, the server's
assessment overwrites them.

The live NOC preview on the decision form moves to the server
(`POST /dept/applications/:id/decision-preview`), because it is part of a workflow
transition.

## 3.7 Status model (Q-63)

Statuses **1 Draft, 2 Submitted, 7 Approved, 8 Returned, 9 Rejected** are fixed system
statuses. Statuses **3–6** are configurable in-process statuses and may be renamed,
re-ordered or added to. The frontend therefore stops hard-coding 3–6. It reads `category`,
`sort_order` and `is_pre_decision` from the statuses lookup (`40-data-model.md` §4.3), and
badges and colours come from the category.

## 3.8 Frontend integration

The integration is **in scope**. It is specified in
[`65-frontend-integration.md`](./65-frontend-integration.md).
