# @srisaa/noc-domain

The Fire-NOC business rules: the NBC / G.O.Ms.No.119 calculations (`commonrules`), the Fire
Fighting Equipment grid, fees, approval levels, renewal periods, submission validation,
certificate facts, task forms and the read-only workflow views.

Pure TypeScript — no Angular, no HTTP, no database — so the same code runs on the server
(authoritative) and in the browser (live preview). Built on `@srisaa/rules-engine` and
`@srisaa/workflow-engine`.

Since phase B3 it also holds the **reference implementations** the server's SQL is tested
against: the ten reports (`reports.ts`), the escalations (`escalations.ts`), the decision preview
(`decision-preview.ts`), the workflow administration checks and simulator (`workflow-admin.ts`),
and the department forms' checks including the challan verification (`task-forms.ts`).

Copyright (c) Srisaa Technologies Private Limited. MIT licensed.

## The entry point the server uses

```ts
import { assess } from '@srisaa/noc-domain';

const assessment = assess(application, engine, lookups, now);
// → { fee, approvalLevel, renewalYears, issues, errorCount, ruleVersions, … }
// and the FFE grid of every block is recomputed in place.
```

## Rule-set catalogue

`noc.ffe.equipment.1..12`, `noc.ffe.type`, `noc.ffe.other_notes`, `noc.ffe.riser_width`,
`noc.height_limits` (decision trees) · `noc.approval_level`, `noc.renewal_period` (decision
tables) · `noc.fees`, `noc.escape_limits` (parameters).

`rule-sets.ts` converts losslessly between these and the shapes the admin UI edits
(`DelegationRule[]`, `RenewalRule[]`, `FeeConfig`, `EscapeRules`).
