# NOC Portal — AngularJS → Angular Migration Documentation

Read in this order:

1. [`01-functional-scope.md`](./01-functional-scope.md) — what the application does: actors,
   application types, the citizen, department and admin journeys, business rules and the
   department workflow, and how each relates to the legacy AngularJS app.
2. [`02-domain-model.md`](./02-domain-model.md) — the canonical data model: lookups, the
   application aggregate, accounts, fire-fighting-equipment grid, admin configuration and the
   workflow model.
3. [`03-api-catalog.md`](./03-api-catalog.md) — every legacy `.aspx` RPC endpoint mapped to an
   entry of the portal's REST catalogue and its backend route.
4. [`04-migration-plan.md`](./04-migration-plan.md) — goals, toolchain, approach, the decision
   log against the legacy behaviour, engineering practices, and how to verify the result
   (automated commands and a manual smoke checklist).
5. [`05-architecture.md`](./05-architecture.md) — folder structure, layering rules, routing,
   state management, data flow and the testing strategy.

6. [`backend/`](./backend/00-README.md) — the **backend engine** design & delivery plan
   (TypeScript + Fastify + Drizzle ORM + PostgreSQL; reusable Rules and Workflow engine
   libraries; caching strategy; file storage outside the web root; frontend integration;
   3-phase plan, test plan, open questions). Phases B1, B2 and B3 are built — see
   [`backend/RUNBOOK.md`](./backend/RUNBOOK.md) to set up and run it.

The Angular application these documents describe lives in [`../frontend`](../frontend/README.md).
The legacy code is the source of truth for business rules; where the application differs from
it on purpose, the difference is recorded in `01-functional-scope.md` and `04-migration-plan.md`.
