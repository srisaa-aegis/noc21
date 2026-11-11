# @srisaa/workflow-engine

A generic, versioned human-workflow engine. It has **no business-domain knowledge**, no runtime
dependencies, and no Node-only APIs.

Copyright (c) Srisaa Technologies Private Limited. MIT licensed.

## Model

- A **process definition** is a sequence of **stages**. Each stage has **tasks** that run in
  parallel. Each task has a role, a form, an optional SLA class and permissions (send back,
  skip, reassign, request input). A task can be `optional` (it never blocks its stage) or
  `onDemand` (it runs only when an outcome orders it).
- The last stage has exactly one **decision** task. Its outcomes are either terminal (they
  complete the instance) or activate an on-demand stage and then return to the decision.
- Stages and outcomes carry opaque **effects**. The engine passes them back in its events,
  and the host decides what they mean (for example, the status the subject takes).

## Using it

Every command is a **pure reducer**: it takes an instance and returns a new instance plus
the events it produced. Nothing is mutated, and nothing is stored by the engine.

```ts
import { start, complete, decide, allowedActions, pendingWith } from '@srisaa/workflow-engine';

const ctx = { assignees, clock, sla };            // ports provided by the host
let { instance, events } = start(definition, 1, ctx);
({ instance, events } = complete(instance, taskNo, actorId, { data, remarks }, ctx));
({ instance, events } = decide(instance, decisionTaskNo, actorId, 'approve', { remarks }, ctx));
```

| Commands | `start`, `saveDraft`, `complete`, `sendBack`, `skip`, `reassign`, `reresolveAssignees`, `decide`, `archive`, `handover` |
|---|---|
| Queries | `currentTasks`, `activeTasks`, `activeStageIndex`, `pendingWith`, `previousStageIndex`, `allowedActions`, `allowedOutcomes`, `openTasksOf` |
| Validation | `validateDefinition(def, extraValidators)` |
| Escalations | `overdueItems(instance, now, sla)`, `dueForReminder(...)` |
| Ports | `AssigneeResolver` (who holds a role), `SlaPolicy` (due dates, total deadline, outcomes blocked after it), `Clock` |
| Errors | `WorkflowError`, with messages fit to show to a user |
| Testing kit | `@srisaa/workflow-engine/testing`: `FixedClock`, `InMemoryDirectory`, definition builders |

## Guarantees (tested)

- At most one stage is active at a time.
- A completed or archived instance never changes again.
- Events are append-only, and a rejected command changes nothing.
- Every instance can be driven to completion by its assignees.

The property tests check these over random definitions and command sequences. The default
suite runs 2 000 sequences; `npm run test:deep` runs 10 000, and `npm run coverage` reports coverage.
