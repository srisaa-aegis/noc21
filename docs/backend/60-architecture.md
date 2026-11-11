# 6. Backend Architecture — Revision 2

## 6.1 Repository layout

```
noc/
├── package.json                         # workspaces: packages/*, backend, frontend, e2e
├── scripts/smoke.sh
├── packages/
│   ├── rules-engine/                    # @noc/rules-engine (45-engines.md §45.1)
│   │   ├── src/{tree,table,parameters,compile,evaluate,validate,trace,engine}.ts
│   │   ├── src/testing/                 # in-memory RuleSetSource, test-case runner
│   │   ├── schemas/*.schema.json        # JSON Schemas of the rule-set kinds
│   │   └── bin/rules-test.ts
│   ├── workflow-engine/                 # @noc/workflow-engine (§45.3)
│   │   ├── src/{definition,validate,reducer,queries,sla,escalations,events,errors}.ts
│   │   ├── src/ports.ts                 # Store, AssigneeResolver, SlaPolicy, Calendar, Clock, Authorizer, EventSink
│   │   ├── src/testing/                 # in-memory store, fake clock, builders
│   │   ├── src/adapters/drizzle/        # wf_* tables + WorkflowStore implementation
│   │   └── schemas/process-definition.schema.json
│   └── domain/                          # @noc/domain (§45.2, §45.4)
│       ├── src/models/                  # wire contract (ex frontend core/models)
│       ├── src/{commonrules,ffe,fees,assessment,validation,documents,certificate,task-forms,dates}.ts
│       └── src/workflow-binding.ts      # effects/status mapping, NOC validators
├── backend/
│   ├── src/
│   │   ├── main.ts  app.ts
│   │   ├── config/env.ts
│   │   ├── plugins/                     # request-id, logging, helmet, cors, compress, jwt, cookie,
│   │   │                                #   multipart, rate-limit, swagger, error-handler, db,
│   │   │                                #   reference-cache, storage, auth, data-versions-header
│   │   ├── db/{client.ts, schema/*.ts, migrations/}
│   │   ├── cache/                       # ReferenceCache, bundle builders, LISTEN/NOTIFY listener
│   │   ├── engines/                     # engine wiring: RuleSetSource, AssigneeResolver, SlaPolicy,
│   │   │                                #   Calendar (Asia/Kolkata), NOC EventSink
│   │   ├── repositories/                # the only importers of drizzle
│   │   ├── services/                    # auth, account, application, assessment, submission,
│   │   │                                #   payment, document, workflow, decision, config, rules,
│   │   │                                #   report, escalation, notification, revision
│   │   ├── routes/
│   │   ├── serializers/                 # rows → wire shapes (local ids, dates, role filtering)
│   │   ├── storage/                     # StorageProvider port + FilesystemStorage + contract tests
│   │   ├── jobs/                        # escalations, outbox, token cleanup, file GC
│   │   └── errors/  lib/
│   ├── scripts/{pg,db,dev,test}/…       # dev/reset-demo.ts lives here
│   ├── seed/{data/**, corrections.json}
│   └── tests/{unit,integration,parity}
├── e2e/                                 # Playwright (full stack)
└── frontend/
```

## 6.2 Layering rules (ESLint `no-restricted-imports`)

| Layer | May import | Must not import |
|---|---|---|
| `packages/rules-engine` | nothing | anything NOC, Node-only APIs |
| `packages/workflow-engine` (core) | nothing | anything NOC, `drizzle` (only `adapters/drizzle` may) |
| `packages/domain` | `@noc/rules-engine` | `@noc/workflow-engine` runtime (types only), Angular, Node, pg |
| `backend/routes` | services, serializers, schemas | db, repositories, engines |
| `backend/services` | repositories, engines wiring, domain, storage, cache | fastify, routes |
| `backend/repositories` | db, drizzle | services, routes |
| `frontend` | `@noc/domain`, `@noc/rules-engine` | `@noc/workflow-engine` |

## 6.3 Request lifecycle (a transition)

```
request-id → pino → helmet/cors/rate-limit → zod(params, query, body) → auth → portal/role guard
 → service:
     db.transaction(async tx => {
        app  = applicationRepo.lockForUpdate(tx, id)            // SELECT … FOR UPDATE
        inst = workflowStore.load(tx, 'noc_application', id)
        { instance', events } = workflowEngine.command(inst, cmd, ctx(cache, clock, resolver, sla))
        nocEventSink.apply(tx, app, events)                     // status, label, reviewer, process_log, outbox
        workflowStore.save(tx, instance', events, inst.lock_version)
        audit.write(tx, …)
     })
 → serializer (dept view + allowed_actions) → zod response → X-Data-Versions header
```

A save works the same way, with `assessmentService.assess(app)` (rules engine, memory only)
between the load and the persist.

## 6.4 Storage: S3-compliant port, filesystem implementation only (R2-1)

```
interface StorageProvider {
  readonly backend: 'fs';                         // 's3' reserved
  put(key, stream, { contentType, contentLength? }) → { size, checksumSha256 }
  getStream(key) → Readable
  createDownload(key, { fileName, contentType, ttlSeconds })
       → { kind: 'stream' } | { kind: 'redirect', url }   // fs: always 'stream'
  delete(key) → void
  head(key) → { exists, size }                    // never used for business metadata
}
```

**S3-compliance rules the filesystem driver must respect**, so that a future driver is a
drop-in:

1. Keys are flat strings (§4.8 scheme). Directories are an implementation detail, and the
   code never lists them.
2. Writes are atomic from the caller's view. The filesystem driver writes `<key>.part` and
   then `rename()`s; S3 `PutObject` and multipart are atomic. Callers never observe partial
   objects.
3. There is no in-place update, append, rename, move or symlink. A replaced document is a
   **new object**; the old one is soft-deleted and garbage-collected.
4. All metadata (name, mime, size, checksum, owner) lives in `files`. The storage layer is
   opaque bytes.
5. Downloads go through `createDownload`. Routes never assume a local path.
6. Streams are used end to end, so there is no whole-file buffering (compatible with S3
   multipart for large objects).
7. A bucket is kept as a logical name (`files.bucket = 'noc'`).

**Storage contract test suite** (`storage/contract.ts`): a parameterised Vitest suite
covering put/get round-trip, checksum, atomic visibility, overwrite refusal, delete,
`head` on a missing key, a 5 MB stream with constant memory, and unicode/long original names
(which must not leak into keys). It runs today against `FilesystemStorage`. A future S3
driver must pass it against MinIO. **No S3 code, SDK, configuration or test is built now.**

Filesystem driver specifics:

- The root is `FS_STORAGE_ROOT`. Boot fails if the path is inside any served directory
  (frontend `dist/`, `public/`).
- Directories are `0750` and files `0640`, owned by the service user.
- Keys are sharded by `floor(application_id / 1000)`, because there are about 2.5 M files
  per year.

## 6.5 Caching

See [`55-caching.md`](./55-caching.md). Backend pieces: `cache/ReferenceCache`,
`cache/listener` (a dedicated `pg` client with `LISTEN noc_cache`, auto-reconnect and a 60 s
poll), `plugins/data-versions-header`, and bundle routes serving pre-compressed buffers.

## 6.6 Notifications

The legacy templates (`submitted`, `assigned_to`, `forwarded_to`, `final_status`,
`final_status_mail`, `forgot_password`) are stored in `notification_templates`. The NOC
event sink and the account service insert `notification_outbox` rows **in the same
transaction**. The `outbox` job sends them through the `log` driver (SMTP/SMS later).

## 6.7 Jobs (`ENABLE_SCHEDULER`, advisory-locked, recorded in `job_runs`)

| Job | Schedule | Does |
|---|---|---|
| `escalations` | daily 09:00 IST (N-12) | engine `findEscalations` over `v_active_tasks` (uses the `due_at` index) → notices + outbox |
| `outbox-flush` | every minute | send with backoff |
| `unassigned-tasks` | hourly | flags tasks with no assignee (Q-59) for the admin and escalation |
| `token-cleanup` | hourly | refresh, reset and download tokens |
| `file-gc` | nightly | deletes objects of files soft-deleted more than 30 days ago |
| `cache-consistency` | every 10 min | cross-checks `cache_versions` against memory (logs only) |

## 6.8 Security

argon2id; 15-minute access tokens; rotated refresh tokens with reuse detection; forced
password change; CORS allow-list; helmet; Zod stripping unknown keys (so server-owned fields
cannot be mass-assigned); ownership and involvement checks in services; uploads checked by
size, magic bytes and extension, with random keys; one-time download tokens; rate limits and
lockout; Aadhaar stored as hash + last 4; log redaction; `audit_log` on every mutation; boot
refuses default secrets in production.

## 6.9 Observability

Structured pino logs with `requestId`, `userId` and `applId`. Domain events
(`application.submitted`, `task.completed`, `decision.taken`, `rules.published`,
`cache.reloaded`) are logged as structured events. Health and readiness endpoints; optional
`/metrics`; slow-query logging at 500 ms.

## 6.10 Performance at 100 000 applications/year and 100 concurrent users

- Reference data, rules and workflow definitions come from memory (0 queries).
- The aggregate load uses about 12 indexed queries by `application_id` / `block_id`, with
  no row-multiplying joins.
- List screens read `v_application_summary`, which depends on the cached aggregate columns.
- *My tasks* uses an index on `(assignee_actor_id, state)`. The escalation scan uses
  `(state, due_at)`.
- Reports are single-pass SQL over `v_report_base` with `FILTER` aggregates, streamed as CSV.
  The budget is < 1.5 s p95 over 3 years of data (300 k applications).
- Pool 20, statement timeout 15 s.

## 6.11 Deployment (documented)

`node dist/main.js` under systemd or a container, behind nginx. nginx serves the Angular
`dist/` and proxies `/api`; it **never** maps the storage root. Pre-deploy: `db:migrate` and
`db:seed:master`. Backups: nightly `pg_dump -Fc`, plus a storage-root sync sized for about
3.75 TB/year (N-8).
