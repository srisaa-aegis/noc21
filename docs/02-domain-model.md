# NOC Portal — Domain Model

> **Note (backend phase B3).** This document was written when the portal ran on JSON fixtures with a
> mock API layer (writes simulated in `localStorage`). Since backend phase B3 the portal runs entirely
> on the NOC backend: the fixtures are the backend's seed (`backend/seed/data`), the mock layer is gone,
> and the API catalogue lists REST routes. The functional content below still holds; for the backend,
> the data model as built and the API see [`backend/`](./backend/00-README.md) and
> [`03-api-catalog.md`](./03-api-catalog.md).

The canonical data model behind the TypeScript interfaces (`src/app/core/models/`) and the
JSON fixtures (`public/assets/data/**`). It consolidates what the legacy app scattered across
`apis/*.txt`, `newappl.txt`, `newrenewal.txt` and the controllers that read and write those
shapes. Field names stay close to the legacy ones so the mapping is traceable; additions are
marked *(new)*.

## 1. Reference data (read-only master data)

| Lookup | Asset / legacy source | Shape and notes |
|---|---|---|
| Application types | `lookups/application-types.json` ← `ApplTypes.txt` | `{ code, name, mode: [{ code, name, ffe: [{ tag, head, type }] }] }`. Codes `P`, `O` (modes O/M/N), `R` (modes O/M), `D`. Mode `E` (Existing Building) does not exist. |
| Build (occupancy) types | `build-types.json` ← `BuildTypes.txt` | `{ code, name, desc, sub: [{ code, name }], minh, maxh }` — `res, edu, ins, asm, biz, mer, ind, sto, haz`. |
| Directions | `directions.json` | `{ code, name }` — N/E/S/W and intercardinal. |
| Districts | `districts.json` | `{ id, desc, ddocode, distcode }` — 13 districts. |
| Fire stations | `fire-stations.json` | `{ id /* district */, stations: [{ id, name }] }`. |
| Hazards | `hazards.json` | `{ code, name, hazard_code }`. |
| DTCP ↔ NBC mapped codes | `mapped-codes.json` | `{ Activity_DTCP_Code, DTCP_Desc, Activity_NBC_Code, Use_DTCP_Code, Use_NBC_Code }`. |
| Fire fighting equipment | `equipments.json` ← `Equipments.txt` | `{ id, desc, short, level ('F' floor / 'B' building), suffix }`. The `id` is the number of the matching rule file. |
| FFE notes | `ffe-notes.json` | Dictionary `{ [noteKey]: text }`, not an array. |
| Statuses | `statuses.json` | `{ code (1–9), desc }`. |
| Department roles *(new)* | `dept-roles.json` | `{ id, code, name, scope, description }` — 1 DG, 2 DFS, 3 DFSCD, 5 ADFS, 6 DFO, 7 RFO, 8 VIEW (monitoring), 9 SFO, 10 SEC (Section). |
| Regions *(new)* | `regions.json` | `{ code, name, districts[] }` — ER = districts 1–6, SR = districts 7–13 (used by reports). |
| Party roles *(new)* | `party-roles.json` | `{ role_name, required_for[] }`. |
| Block options *(new)* | `block-options.json` | Block types (Normal / Tower / Podium), floor types (B/S/G/F/T), legacy floor occupancy codes, escape types, side property types, lift types (hard-coded in the legacy templates). |
| Escape rules *(new)* | `escape-rules.json` | Travel distance and dead-end limits, sprinkler factor, exit and head-room minimums, projection limit, refuge-area rules. |
| NOC conditions *(new)* | `noc-terms.json` | Verbatim HTML of `noc_terms_16`, `noc_terms_o`, `noc_terms_r`; items for buildings above 60 m are tagged `cond-height-gt-60`. |
| Occupancy conditions *(new)* | `occupancy-conditions.json` | The Provisional NOC conditions an applicant confirms when applying for Occupancy. |
| Undertakings *(new)* | `undertakings.json` | `{ id, text, required }[]` per type — the ticks on the confirmation page. |
| NBC Table 7 *(new)* | `nbc-table7.json` | Reference HTML from `table23.html`. |
| Document requirements *(new)* | `document-requirements.json` | The legacy upload-section `ng-if` rules. |
| Rule trees | `rules/ffe/{1..12}.json`, `rules/ffe-type.json`, `rules/other-notes.json`, `rules/riser-width.json`, `rules/height-limits.json` | The legacy `uploads/rules/*.rule` decision trees, verbatim (§8). |
| Admin configuration | `config/fee-config.json`, `delegation-rules.json`, `renewal-rules.json` | Editable in Admin → Rules & Fees (§9). |
| Workflow configuration | `config/workflows.json`, `sla.json`, `forms.json` | Workflows and SLAs editable in Admin; forms read-only (§10). |

## 2. Status model

Two layers:

1. **`status_id` (1–9)** — the canonical lifecycle stage: 1 Draft, 2 Submitted, 3 Inspected,
   4 Reviewed (ADFS), 5 Reviewed (DFS-CD), 6 Pending Final Approval, 7 Approved / Issued,
   8 Returned with Comments, 9 Rejected.
2. **Role-relative queue label and next action.** The same `status_id` reads differently to
   different officers. The label is the `stage_label` of the last completed workflow stage;
   the action is the `action_label` of the officer's task (§10). The legacy `RoleStatuses.txt`
   (including its non-standard status 31) is no longer used.

A derived 3-letter badge (`ISS`, `REJ`, `DRF`, `SUB`, …) is a display-only mapping over
`status_id`.

## 3. Application aggregate

One superset model covers the Provisional / Occupancy / Declaration shape (`newappl.txt`) and
the Renewal shape (`newrenewal.txt`); fields not used by a type are omitted or blank.

```
Application
├─ appl_id, appl_number, revision, appl_type (P|O|R|D), appl_mode, owner (citizen username)
├─ site_name, site_addr, district, corr_addr
├─ plot_area, perimeter, lic_auth, lic_addr
├─ build_name, build_landline, build_mobile, build_email, build_aadhar
├─ challan_num, challan_amt, challan_date, challan_bnk, challan_brch, challan_paid
├─ ref_no (Occupancy NOC reference, R/D), last_inspect_date (D), noc_level (D)
├─ applied_date, final_date, last_modified, status_id, delegation_level (MSB|RFO|DFO), reviewer
├─ declaration_accepted
├─ mcapprove_date (Occupancy without PNOC — penalty years), conditions: ConditionCheck[]
├─ valid_from, valid_to (issued Occupancy / Renewal / Declaration), feedback { rating 1-5, remarks, rated_on }
├─ loc_lat, loc_lng, firestation, host_name (SDP|MAUD|null)
├─ parent_id / child_id (Provisional → Occupancy → Renewal chain)
├─ parties: Party[]
├─ blocks: Block[]
├─ deptfiles: RequestedDocument[]   (document requests from the department)
├─ documents: UploadedDocument[]    (plans, challan, undertaking, declaration…)
├─ dept_documents: DeptDocument[], sms: SmsMessage[]
├─ processLog: ProcessStep[]        (append-only audit trail)
├─ workflow?: WorkflowRun, workflow_history?: WorkflowRun[], stage_label?   (§10)
└─ payment: Payment
```

### Party
```
Party { sl_no, role_name (Builder | Architect | Structural Engineer |
        Electrical Contractor | Fire Safety Systems Contractor),
        party_name, phone_number, email, license_no }
```

### Block (one physical building on the plot)
```
Block
├─ block_id, block_name, sl_no, block_type (N normal | T tower | P podium)
├─ site_type (BuildType.code), site_stype (sub-type code), beds ('Y'/'N', hospitals)
├─ is_mixed, is_multiplex, is_miniplex
├─ height, permissible_height (excl. stilt — open spaces of P / O-from-PNOC)
├─ road_wide, roadwidening: { rw_direc, rw_reqd }[], xfer_sbak, front_dir
├─ sides: BlockSide[]    { bside_id, direc, ptype (R road | B building | S open space | O others), pname, width }
├─ floors: Floor[]       { floor_id, flr_type (B/S/G/F/T), flr_name, built_area,
│                           occ_type (PAR, RES, EDU1…), occ_c_app, seats_num (ASM1),
│                           parent_built_area?, parent_occ_c_app? (values as per PNOC) }
├─ ospaces: OpenSpace[]  { ospace_id, direc, proposed, projection, parent_proposed?, os_preqd? }
├─ escapes: Escape[]     { escape_id, etype (I/E/R/C), desc, width, location, from_floor, to_floor }
├─ exits, doors, lifts, refuges, carparks, ta_dist, ta_dead, hrclear
└─ ffe: BlockFfe         (§8)
```

### Process step and payment
```
ProcessStep { uid /* officer user id */, role, status_id, action, remarks, at_date, j /* captured step data */ }
Payment     { mode: 'online'|'challan', amount, status, challan_num, challan_date, bank, branch, txn_ref }
```
`ProcessStep` is the typed, append-only version of what `process_steps.aspx` returned, so the
UI can render a timeline. The tasks of the workflow run (§10) are the live form of the same
idea.

## 4. Application summary row

A flattened projection of `Application` for lists (cheaper than the whole aggregate):

```
ApplicationSummary {
  appl_id, appl_number, appl_type, appl_mode, revision,
  site_name, site_addr, site_type, height, flr_count, built_area,
  build_name, build_landline, build_mobile, build_email,
  challan_amt, applied_date, final_date, status_id, status,
  delegation_level, dist_name, host_name, reviewer, child_id,
  challan_paid, bank_guarantee, undertaking, form16, fire_draw_5 }
```

## 5. TypeScript mapping and normalization

The interfaces are strict. Where legacy JSON was inconsistent (`status_id` sometimes a string,
BOM characters, stray trailing fields) the fixtures are normalized, but names are kept
close to the legacy ones, and additions are additive, not destructive.

## 6. Accounts

One store (`auth/users.json`) holds every login:

```
UserAccount { id, username, password, displayName, portal (citizen|dept|admin),
              email, mobile, active, created_on, must_change_password?,
              gender?, dob?, aadhar?, address?,         // citizen profile (register.aspx fields)
              deptRoleId?, district?,                   // department user
              stations?: string[], all_stations? }      // fire stations the officer is associated with
```

Citizens register with their e-mail as username and receive a temporary password. Deactivated
accounts cannot log in. The officers of an application's workflow are the active officers of
each role associated with the application's fire station (`all_stations` for Head Office).
All demo accounts use the password `demo`; these are fixtures, not real credentials.

## 7. One applications store

All application aggregates live in **one** store (`applications/applications.json`). The
citizen list (filtered by `owner`), the department queue (status > 1) and the admin search
are projections of it, so a submitted application appears in the department queue and in
admin search at once, as it would with a real backend.

`npm run fixtures` (`scripts/generate-fixtures.ts`) generates the store with the **same
TypeScript domain code** the app uses (rule trees, commonrules, fees, approval levels,
renewal periods, workflow engine) and fails if any seeded submitted application would not
pass submission validation.

## 8. Fire Fighting Equipment

```
BlockFfe { items: FfeItem[], notes: string[] /* general note keys */, agree_reqt: boolean }
FfeItem  { equip_id, level: 'F' | 'B', floors: { [floor_id]: FfeCell }, block: FfeCell,
           note_keys: string[], added?: boolean /* "Add Fire Fighting Equipment" */, remarks? }
FfeCell  { reqt: number | string | null   // required by the rule tree ("Note 10" = stated by the note)
           prop: number | string | null   // proposed (as per PNOC / previous certificate)
           prov: number | null }          // provided
```

- **Floor-wise items** (`Equipments.txt` level F: extinguishers, hose reels, sprinklers, MCP,
  detection) are evaluated per floor (`@floor_area`, `@flr_type`). The block requirement is
  the cumulative total (legacy `GetFFETotal`).
- **Building items** (level B: risers, tanks, pumps, yard hydrants, additional) are evaluated
  once per block (the legacy "Total" row).
- **Rule variables**: `site_type, site_stype, height, floors, maxarea, cov_area, base_area,
  built_area, plot_area, beds, occ_load, exit_count, is_multiplex, floor_area, flr_type`.
- **Rule results**: `''` (not required), a number, `D,<var>,<n>` (= ceil(var / n)), a variable
  name, or note keys (`Note 10`, `Note 12|Note 13`, `UT_A5` …). Yard hydrants return the
  spacing (30 / 45 m) → ceil(perimeter / spacing) plus the note `YH_<n>`.
- Which of `reqt` / `prop` / `prov` are shown, and whether as text or input, comes from
  `application-types.json` `mode[].ffe[]` (see `01-functional-scope.md` §3).

## 9. Admin configuration

```
FeeConfig       { portal_charges, declaration_fee, rates_per_sqm: { P, O, R },
                  occupancy_without_provisional: { additional_per_sqm, penalty_per_sqm_per_year } }
DelegationRule  { id, level (MSB|RFO|DFO), label, site_types[], site_stypes[],
                  min_height|null, min_inclusive, max_height|null,
                  multiplex_only? /* only blocks marked "Is Multiplex" */ }   // ordered, first match per block
RenewalRule     { id, label, site_types[], site_stypes[], max_height|null, years }   // ordered, first match
```

An application's approval level is the highest level of its blocks (MSB > RFO > DFO); its
renewal period is the shortest period of its blocks.

## 10. Department workflow

```
WorkflowDefinition { id ("P-MSB"), appl_type, level, name, version, updated_on, updated_by,
                     stages: WorkflowStageDef[] }                 // config/workflows.json, one per type × level
WorkflowStageDef   { key, name, stage_label, citizen_status (2-6), tasks: WorkflowTaskDef[] }   // tasks run in parallel
WorkflowTaskDef    { key, name, role_id, form, action_label, optional?, on_demand?,
                     permissions { send_back, request_documents, skippable, reassignable },
                     decision? { outcomes: (approve|return|reject|inspect)[], inspect_stage? } }  // last stage only
FormDef            { id, kind (structured|questionnaire), name, legacy, summary?, questions?, inspection?, decision? }
SlaConfig          { workflows: { [id]: { processing_days, inspection_days, step_days: { [task_key]: n } } },
                     escalation: { notify_officer, notify_approver, remind_every_days } }

WorkflowRun  { definition_id, version, revision, started_on, stages /* snapshot */, tasks: WorkflowTask[],
               approver, completed_on?, outcome? }
WorkflowTask { task_id, stage_key, task_key, name, role_id, assignee, assignee_name,
               state (waiting|active|done|skipped|sent_back|not_required), start_date?, end_date?,
               form, data, draft, remarks, recommendation?, decision?, sent_back_to? /* stage key */ }
EscalationLogEntry { sent_at, recipients, applications, notices: EscalationNotice[] }   // admin/escalations.json
```

**Lifecycle**

- Submission snapshots the definition into the run, resolves the officer of each task from the
  fire-station association, activates the first regular stage, and derives `reviewer`
  ("Pending with") from the active tasks.
- A stage completes when its mandatory tasks are done or bypassed. Then
  `status_id = citizen_status`, `stage_label` is set, and the next regular stage opens.
- The decision sets 7 / 8 / 9, or activates the "only when ordered" inspection stage for
  Declarations.
- Send back creates new tasks for the previous stage with the data carried over. Revise
  archives the run into `workflow_history`.

**Task state machine**

```
            start run                 stage reached                submit (form complete)
 (none) ───────────────▶ waiting ─────────────────▶ active ─────────────────────────▶ done
                            ▲                      │  │  ├── skip (approver) ────────▶ skipped
                            │ later stage reset    │  │  └── send back (owner) ──────▶ sent_back
                            └──────────────────────┘  │        └─ creates a NEW active task for the
                                                      │           chosen earlier officer (copy of data)
                                                      └── reassign (approver/admin): assignee changes
 on_demand stages stay "not_required" unless a decision activates them
```

**Validation of a definition (admin save)**

- Exactly one definition per type × level (12).
- At least one stage. The **last stage has exactly one task, with form `final_decision`** and
  at least the outcomes `approve`, `return`, `reject`. No `final_decision` elsewhere.
  `inspect` needs an `inspect_stage` pointing to an `on_demand` stage.
- Unique keys; non-empty names, labels and buttons; roles and forms exist.
- `citizen_status` in 2–6 and non-decreasing; the stage before the decision sets status 6.
- Every non-final stage has at least one mandatory task. "Only when ordered" applies to whole
  stages.
- A warning (not an error) from the simulator: no officer, or more than one, for a task's role
  at the chosen fire station.
- SLA: every workflow has an entry; values 1–365; inspection ≤ processing; reminder interval
  ≥ 1; at least one escalation recipient.

**Invariants (tested)**: exactly one run per submitted application; the active stage is the
first stage with an undone, non-optional task; status never passes 6 before the decision;
only the assignee can save or submit a task; the decision task is always last.

**Forms**: *structured forms* (`section_note`, `inspection_report`, `committee_concurrence`,
`rfo_note`, `final_decision`) are code components that adapt to the application type and reuse
the open-space, staircase and FFE calculations. *Questionnaires* (`adfs_note`, `dfscd_note`,
`dfs_note`, `dfo_note`) are data — lists of questions (`text` | `choice`, `required`,
`show_if`) seeded verbatim from the legacy templates. The admin chooses the form of a step
but cannot edit questionnaires.
