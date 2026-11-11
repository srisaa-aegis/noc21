# 45. The Rules Engine and the Workflow Engine — Independent Libraries

## 45.0 Goals and boundaries

| Requirement | Design response |
|---|---|
| The Rules Engine and the Workflow Engine are independent libraries that other applications can use | Two workspace packages, `@noc/rules-engine` and `@noc/workflow-engine`. They have **no NOC vocabulary**: no "application", "block", "fire station", "citizen", "NOC" or status ids. |
| All rule-based calculation happens in the backend | The backend calls the engines on every save, submit, payment and decision and persists the results. Client results are advisory and overwritten. |
| All workflow transitions happen in the backend | `@noc/workflow-engine` is a backend dependency only. The frontend never imports it. It receives state and allowed actions from the API. |
| The client keeps its live calculations (Q-14) | The frontend imports `@noc/rules-engine` + `@noc/domain` (pure, browser-safe) and evaluates the same published rule versions, delivered by the `rules` cache bundle. |

```
                ┌──────────────────────── backend (@noc/api) ───────────────────────────┐
                │  services/assessment.service   services/workflow.service               │
                │          │                              │                              │
                │          ▼                              ▼                              │
                │   @noc/domain ── NOC bindings ──► @noc/workflow-engine (generic)       │
                │          │                              │  ports: Store, Assignee,     │
                │          ▼                              │  Clock, Calendar, Authorizer,│
                │   @noc/rules-engine (generic)           │  EventSink                   │
                │          │ port: RuleSetSource          │                              │
                │          ▼                              ▼                              │
                │   ReferenceCache (compiled)       Drizzle adapters (wf_*, re_* tables) │
                └────────────────────────────────────────────────────────────────────────┘
  frontend:  @noc/domain + @noc/rules-engine only (live preview), fed by the cached rules bundle
```

Dependency rules (ESLint-enforced): the engines depend on nothing but each other's *types*
(they do not even do that today). `@noc/domain` depends on `@noc/rules-engine`. The backend
depends on all three. The frontend depends on `@noc/domain` + `@noc/rules-engine`.

---

## 45.1 `@noc/rules-engine`

### Purpose
Evaluate **versioned, data-defined rules** against a set of **facts**, deterministically,
with an explanation of how the result was reached.

### Rule-set kinds

| Kind | What it is | Used by NOC for |
|---|---|---|
| `decision_tree` | The legacy `.rule` format, kept **verbatim**. Nodes have `check` (variable), `dtype` (n/s), and `decisions[]` with operators `EQ, DEF, GT, GE, LT, LE, BR, BL`, where each decision leads to `goto <node>` or `return <value>`. | The 12 FFE equipment trees, `ffe_type`, `other_notes`, `riser_width`, `height_limits` |
| `decision_table` | Ordered rows of conditions → outputs. Condition operators are `in`, `notIn`, `eq`, `ne`, `gt`, `ge`, `lt`, `le`, `between`, `isTrue`, `isFalse` and `any`. **Hit policies:** `FIRST`, `PRIORITY`, `COLLECT`. An optional **aggregation over a collection of fact sets** is `MAX_RANK(order)`, `MIN`, `MAX`, `SUM` or `LIST`, with a `default` when nothing matches. | Approval level: first hit per block, `MAX_RANK(DFO<RFO<MSB)` across blocks. Renewal period: first hit per block, `MIN` across blocks. |
| `parameters` | A typed, validated set of named constants: numbers, strings, maps and per-key rates. | Fees (rates per type, portal charges, declaration fee, Occupancy-without-Provisional additional and penalty rates) and escape limits (travel distance, dead end, exit widths, refuge area) |
| *(extension point, not in scope)* `expression` | A safe arithmetic/boolean expression language (parser, no `eval`) | A future fee formula edited as data |

### Core API (pure, synchronous after loading)

```
compile(ruleSetVersion) → CompiledRuleSet            // validates + indexes; cached by version id
evaluate(compiled, facts, { trace?: boolean }) → { value, trace?: TraceStep[] }
evaluateCollection(compiled, factsList, opts) → { value, perItem[], trace? }   // tables with aggregation
validateDefinition(kind, definition, inputSchema?) → Problem[]
runTestCases(compiled, cases) → TestResult[]
RuleEngine (facade) {
  constructor(source: RuleSetSource, opts?: { cacheSize?, clock? })
  get(code, { at?: Date, versionId? }) → CompiledRuleSet   // resolves the published version effective at `at`
  evaluate(code, facts, opts) ; evaluateCollection(code, factsList, opts)
  versionsUsed() → Record<code, versionId>                  // recorded with every result
}
```

### Ports

| Port | Responsibility | NOC backend adapter | NOC frontend adapter |
|---|---|---|---|
| `RuleSetSource` | return published versions by code, effective date, or id; notify changes | reads `re_rule_set_versions` through the `ReferenceCache` (no DB hit per evaluation) | reads the cached `rules` bundle from IndexedDB/memory |
| `FactTypes` (optional) | declare the fact names and types a rule set expects (`@height:number`, `@site_type:string`) | from `re_rule_sets.input_schema` | same |

### Guarantees

- **Deterministic.** Evaluation uses no clock, randomness or I/O, so the same facts and the
  same version always give the same result.
- **Versioned.** Published versions are immutable. Each result carries
  `{ ruleSetCode, versionId }`.
- **Explainable.** The trace lists the nodes visited, the decision taken and the value
  compared, or the rows tested and the row that hit. The admin "try it" panel and the
  officer's "why Head Office?" view show it.
- **Safe.** There is no code execution from data. Trees are checked for cycles, unknown
  nodes, unreachable nodes and a maximum depth. Tables are checked for unknown operators and
  type mismatches, and overlap/gap *warnings* are reported.
- **Browser-safe.** It uses no Node APIs, has zero runtime dependencies, and ships as ESM.

### Versioning lifecycle

```
draft ──(validate + test cases pass)──► published ──(superseded)──► retired
   ▲ editable                              immutable, effective_from
```

An admin edit to fees, approval levels or renewal periods creates a **draft**. Saving in the
admin UI validates the draft, runs the rule set's test cases, and publishes it in one step,
which matches today's behaviour. Publishing sets `current_version_id` and bumps the
`rules` cache version.

### Compatibility with the legacy trees

The existing `frontend/src/app/core/domain/rule-engine.ts` evaluator and its spec move into
the package **unchanged in behaviour**. The legacy-specific result encodings (`''`,
numbers, `D,<var>,<n>`, note keys such as `Note 10|Note 13`, yard-hydrant spacing) are
**not** interpreted by the engine. It returns the raw value, and `@noc/domain/ffe`
interprets it. That is what keeps the engine generic.

---

## 45.2 `@noc/domain` — NOC calculations on top of the rules engine

| Calculation | Rule sets used | Code (pure) |
|---|---|---|
| FFE grid per block (floor-wise items, building items, cumulative totals, notes, extinguisher type, riser width, yard hydrants) | `noc.ffe.equipment.{1..12}`, `noc.ffe.type`, `noc.ffe.other_notes`, `noc.ffe.riser_width` | `ffe.ts` (fact building + result interpretation) |
| Max permissible height | `noc.height_limits` | `validation.ts` |
| Open spaces (G.O.Ms.No.119, > 55 m formula, tower/podium, multiplex/miniplex, road widening), occupant load, staircases, exits, doors, fire lifts, refuge areas, travel distances | `noc.escape_limits` (parameters) | `commonrules.ts` (the 29 NBC functions; constants read from parameters) |
| Approval level | `noc.approval_level` (decision table) | `assessment.ts` |
| Renewal period and certificate validity | `noc.renewal_period` (decision table) | `assessment.ts` |
| Fee breakdown | `noc.fees` (parameters) | `fees.ts` (formula in code, constants from parameters) |
| Submit validation | all of the above | `validation.ts` |
| Certificate facts | `noc.renewal_period` | `certificate.ts` |

One entry point is used by both sides:

```
assess(application, engine, { now }) → Assessment {
  fee: FeeBreakdown, approvalLevel, renewalYears,
  derived: { blocks[i]: { ffe, requiredOpenSpaces, occupantLoad, stairsRequired, … } },
  issues: ValidationIssue[], ruleVersions: Record<code, versionId>, trace?
}
```

### How the server applies it

| Moment | Server action |
|---|---|
| `PUT /applications/:id` (save) | `assess()`; **overwrite** every derived field in the aggregate (FFE `reqt`, notes, `os_preqd`, caches); store `application_assessments`; return `{ application, assessment }` |
| `POST /applications/:id/payment` | recompute the fee, **freeze it** on the payment with the `noc.fees` version id (Q-57) |
| `POST /applications/:id/submit` | `assess()` again. Reject if there are issues. Check that the frozen fee still covers the fee computed **with the frozen parameter version** (the area may have changed — N-3). Set the delegation level (or the declaration level). Snapshot the revision with the rule versions. |
| `POST …/decide` (approve) | validity from `noc.renewal_period`, evaluated with the versions recorded at submit (or the current ones — N-11) |
| `POST /assessments` (stateless) | the same `assess()` for a payload that is not saved. Other applications and the admin "try it" use it. |

The client computes the same values live. When it saves, the response contains the
authoritative values and the `ruleVersions`. If the client's cached rules are older, its data
interceptor has already seen the new `X-Data-Versions` header and refreshes the bundle
(`55-caching.md`).

---

## 45.3 `@noc/workflow-engine`

### Purpose
Run **versioned, data-defined human workflows**: sequential stages of parallel tasks that end
in a decision. It handles send back, bypass, reassignment, optional and on-demand stages,
SLA due dates, an event log and escalations. It is storage-agnostic and has no knowledge of
the subject being processed.

### Definition model (stored as JSON in `wf_definition_versions.definition`)

```
ProcessDefinition {
  code, name, subjectType,
  stages: StageDef[]                      // executed in order
}
StageDef {
  key, name,
  onDemand?: boolean                      // only activated by a decision outcome
  effects?: Record<string, unknown>       // opaque to the engine; emitted in StageCompleted
                                          //   NOC: { status_id: 3, stage_label: 'Inspected' }
  tasks: TaskDef[]                        // run in parallel
}
TaskDef {
  key, name,
  role: number                            // opaque actor-role id
  form: string                            // opaque form code
  actionLabel,
  optional?: boolean,
  slaClass?: string                       // e.g. 'inspection' → class_days
  permissions: { sendBack, requestInput, skippable, reassignable },
  decision?: { outcomes: OutcomeDef[] }   // only on the single task of the last stage
}
OutcomeDef {
  key,                                    // 'approve' | 'return' | 'reject' | 'inspect' (data)
  terminal: boolean,                      // completes the instance with this outcome
  activatesStage?: string,                // non-terminal: activate an onDemand stage, then return to decision
  effects?: Record<string, unknown>       // NOC: { status_id: 7 } …
  requiresAttachment?: string,            // NOC: 'signed_decision'
  requiresRemarks?: boolean
}
```

The NOC seed translates today's 12 `workflows.json` definitions 1:1.
`citizen_status` / `stage_label` become `effects`. The `approve`/`return`/`reject`/`inspect`
outcomes become `OutcomeDef`s. The mandatory signed copy becomes
`requiresAttachment: 'signed_decision'`.

### Generic structural validation (engine)

- There is at least one stage, and keys are unique within their scope.
- The last stage has exactly one task, and only that task has `decision`.
- At least one outcome is terminal, and every `activatesStage` points to an `onDemand`
  stage.
- Every non-final, non-on-demand stage has at least one mandatory task.
- Names and action labels are not empty.
- Hosts can register **additional validators**. NOC adds four:
  - roles and forms exist (`wf_version_refs`);
  - effects use `in_process` statuses;
  - statuses never go backwards (by `sort_order`);
  - the stage before the decision sets the `is_pre_decision` status.
  NOC also requires the outcomes approve, return and reject.

### Instance state and commands

The engine is a **pure reducer**:
`(instance, command, ctx) → { instance', events[] }`. It throws
`WorkflowError(code, message)` when a command is not allowed. It never performs I/O.

| Command | Preconditions (generic) | Effect |
|---|---|---|
| `start(definitionVersion, subject, cycle)` | no live instance for the subject | creates tasks, resolves assignees, activates the first regular stage, computes `due_at` |
| `saveDraft(taskNo, actor, data)` | task is current and active; actor is the assignee | stores data, `draft = true` |
| `complete(taskNo, actor, data, resultCode?)` | as above; not the decision task | `done`; if the stage is complete (mandatory tasks done or skipped), emit `StageCompleted(effects)`, activate the next regular stage, and cascade if that stage is already fully bypassed |
| `sendBack(taskNo, actor, remarks)` | `permissions.sendBack`; remarks present; a previous stage with done tasks exists | current row → `sent_back`; siblings reset; previous stage's done tasks copied as new active rows with their data; emit `SentBack(restoredEffects)` |
| `skip(taskNo, actor)` | actor is the decider; `skippable`; task is waiting or active; not the decision task | `skipped`; advance if it belongs to the active stage |
| `reassign(taskNo, actor, toActor, { asAdmin })` | decider (or admin); `reassignable` (unless admin); target has the task's role (checked through the `AssigneeResolver`) | assignee changes; if it is the decision task, the decider changes |
| `decide(taskNo, actor, outcome, input)` | assignee; decision task; outcome in the definition **and** allowed by the SLA policy; attachment and remarks requirements met | terminal: complete the instance, `InstanceCompleted(outcome, effects)`. Non-terminal: activate the on-demand stage and re-queue the decision task. |
| `reresolveAssignees(subjectContext)` | no task acted on yet | re-runs assignment for pending tasks (NOC: change of fire station) |
| `handover(fromActor, toActor)` | admin | reassigns every pending task of one actor, across instances |
| `archive()` | instance completed | `status = archived` (NOC: citizen revises; a new instance starts on resubmit) |

**Queries** (pure): `currentTasks`, `activeTasks`, `activeStage`, `previousStage`,
`pendingWith`, `allowedActions(instance, actor, now)` → e.g.
`{ save: [3], complete: [3], sendBack: [3], skip: [5,6], reassign: [5], decide: null, outcomes: [] }`,
`isOverdue(task, now)`, `processingOverdue(instance, now)`.

### Ports

| Port | Contract | NOC implementation |
|---|---|---|
| `AssigneeResolver` | `resolve(role, subjectContext) → Actor \| null`; `canHoldRole(actor, role)` | active dept users with the role and associated with the application's fire station (`all_stations` counts everywhere); lowest id first; `null` → the task is created unassigned, flagged on the admin dashboard and escalated (Q-59) |
| `WorkflowStore` | `load(subjectType, subjectId, { forUpdate })`, `save(instance', events, expectedLockVersion)` | Drizzle adapter over `wf_instances` / `wf_tasks` / `wf_events`, in the caller's transaction |
| `SlaPolicy` | `dueAt(task, activatedAt)`, `totalDue(instance)`, `allowedOutcomes(instance, now)` | `wf_sla_policies`. After the total SLA, `return` is removed (legacy `rtimeout`). |
| `BusinessCalendar` | `addDays(date, n)`, `daysBetween(a, b)` | calendar days in Asia/Kolkata. A holiday calendar can be plugged in later. |
| `Clock` | `now()` | injectable; frozen in tests |
| `Authorizer` (optional override) | `can(actor, action, task, instance)` | the default generic rules (assignee, decider, admin) |
| `EventSink` | receives the events of a transition, inside the same transaction | NOC binding (below) |

### Events

`InstanceStarted`, `TaskActivated`, `TaskDraftSaved`, `TaskCompleted`, `TaskSkipped`,
`TaskReassigned`, `SentBack`, `StageCompleted{effects}`, `DecisionTaken{outcome}`,
`OnDemandStageActivated`, `InstanceCompleted{outcome, effects}`, `InstanceArchived`.
All of them are persisted to `wf_events` and passed to the `EventSink`.

### Escalations module (part of the engine)

`findEscalations(activeTasks, instances, policy, reminders, settings, now) → Notice[]`. It
applies the step SLA, the SLA class (inspection) and the total SLA, skips items reminded
within `remind_every_days`, and resolves recipients (assignee and/or decider). The backend
job and the admin "send escalations" action both call it over `v_active_tasks` (which uses
the `due_at` index).

### Invariants (property-tested)

1. There is exactly one live instance per subject.
2. The active stage is the first stage with an unfinished mandatory task.
3. There is at most one decision task, and it is the last stage.
4. Only the assignee can save, complete or decide; only the decider can skip or reassign.
5. Applying effects in event order never moves a status backwards, except through
   `SentBack`, which restores the earlier effects.
6. `wf_events` replayed from `InstanceStarted` rebuilds the same task states.

---

## 45.4 NOC workflow binding (in `@noc/domain` + `backend/services/workflow.service.ts`)

| Concern | Binding |
|---|---|
| Which definition | `noc_workflow_bindings(application_type, delegation_level)`. A Declaration uses the level of the Occupancy NOC it renews. |
| `subjectType` / `subjectId` / `cycle` | `'noc_application'` / `applications.id` / `applications.revision` |
| `StageCompleted.effects` | `applications.status_id`, `stage_label` |
| `InstanceCompleted` | status 7, 8 or 9, `final_date`, and validity (approve; from the rules engine); `application_revisions(kind='decided')` |
| `SentBack` | restores the status and label of the earlier stage |
| Any transition | recompute `reviewer` (pending with), write `process_log` entries, enqueue notifications from the legacy templates (`assigned_to`, `forwarded_to`, `final_status`) |
| Actions that are not transitions but require involvement (request document, department upload, SMS, change fire station, licensing authority) | use `allowedActions` / `isInvolved(actor)` from the engine for permission, then NOC logic |
| Citizen revise | `archive()` the instance and snapshot `application_revisions(kind='archived')`. Resubmitting starts a new instance with `cycle = revision`. |

Each API transition is one database transaction:
`SELECT applications … FOR UPDATE` → `store.load(forUpdate)` → engine command → event sink
(NOC effects) → `store.save(expectedLockVersion)` → outbox → commit.

---

## 45.5 What the frontend does with workflows now

- It **reads** the instance from `GET /applications/:id` as today's `WorkflowRun` /
  `WorkflowTask` shapes, which the serialiser produces from `wf_instances` / `wf_tasks`.
  Stepper and progress views are unchanged.
- It **reads** `allowedActions` (`GET /dept/applications/:id/allowed-actions`, also embedded
  in the department detail response) to decide which buttons and outcomes to show. It no
  longer computes permissions.
- It **posts** commands: save, submit, send back, skip, reassign, decide.
- The live certificate preview on the decision form is
  `POST /dept/applications/:id/decision-preview`.
- The admin workflow editor validates through `POST /config/workflows/:code/validate`
  (debounced) and simulates officers through `POST /config/workflows/:code/simulate`.
- The files `frontend/src/app/core/domain/workflow.ts` (transitions), `escalations.ts` and
  `reports.ts` are removed from the frontend. Their read-only helpers are replaced by server
  fields.

## 45.6 Reuse by other applications

| Aspect | Provision |
|---|---|
| Packaging | ESM + `.d.ts`; semver; `exports` map: `.` (core), `./testing` (in-memory store, fake clock, fixture builders), `./adapters/drizzle` (PostgreSQL tables + store, workflow engine only) |
| Persistence | Core is storage-agnostic. The optional Drizzle adapter ships its own table definitions (`wf_*` / `re_*`) and a migration generator, and takes a table-name prefix option. |
| Identity | Actors, roles and subjects are opaque integer/string ids with resolver ports. There is no user table dependency. |
| Extensibility | Custom validators, custom rule-set kinds (registry), custom SLA policies and calendars, and event sinks |
| Documentation | README, API reference (TypeDoc), the definition JSON Schemas (`schemas/process-definition.schema.json`, `schemas/decision-table.schema.json`, …) and examples: an approval chain and a leave request |
| Quality bar | 95 % line coverage, property-based tests, no runtime dependencies, no Node-only APIs in the rules engine |

Publishing to a registry is not in scope. The packages are built as if they will be
published (N-7).
