# 1. Backend Tech Stack — Decisions and Rationale

ADR-style. Each decision records the options, what was **measured in this sandbox**, and the
consequence.

## 1.0 Summary

| Concern | Choice | Notes |
|---|---|---|
| Runtime | Node.js 22 LTS | 22.21.0 installed; `engines: >=22.12` |
| Language | TypeScript 5.9, `strict`, ESM | same as the frontend |
| HTTP | **Fastify 5** | `app.inject()` for socket-free HTTP tests |
| Validation / contract | **Zod 4** (in the handlers) · `@fastify/swagger` → OpenAPI 3.1 at `/docs` | *As built (B3):* the routes parse their input with Zod; the OpenAPI document lists every operation, its group and its bearer requirement, and a contract test keeps the portal's catalogue and the routes in step. |
| ORM / migrations | **Drizzle ORM + drizzle-kit**, driver `pg` | verified offline |
| Database | **PostgreSQL 16.15** | local cluster via `initdb` / `pg_ctl` |
| Rules | **`@noc/rules-engine`** (own library) | see `45-engines.md` |
| Workflow | **`@noc/workflow-engine`** (own library) | see `45-engines.md` |
| Password hashing | argon2id (`argon2`) | prebuilt binary verified |
| Auth | `@fastify/jwt` access token + `@fastify/cookie` httpOnly refresh | |
| Uploads | `@fastify/multipart`, streamed to the storage port | |
| Storage | `StorageProvider` port + **filesystem driver only** | S3-compliant design, no S3 driver (R2-1) |
| Cache invalidation | PostgreSQL triggers + `LISTEN/NOTIFY` | no Redis (see `55-caching.md`) |
| Scheduling | `node-cron` + PostgreSQL advisory locks | |
| Logging | pino | |
| Unit/integration tests | Vitest 4 | same runner as the frontend |
| Browser E2E | **Playwright `@playwright/test@1.56.x`** with the preinstalled Chromium | verified (see §1.7) |
| Frontend client cache | IndexedDB (small wrapper, no extra library) + `BroadcastChannel` | see `55-caching.md` |

## 1.1 ADR-001 — Prisma rejected (measured)

```
$ npm i prisma@7 @prisma/client@7          # installs
$ npx prisma generate
Error: request to https://binaries.prisma.sh/.../schema-engine.gz.sha256 failed,
       reason: getaddrinfo ENOTFOUND binaries.prisma.sh
```

Prisma's schema engine, used by `generate` and `migrate`, is downloaded from a host this
environment cannot reach. Prisma can therefore neither generate a client nor migrate here.
It is also weaker on partial unique indexes, generated columns and reporting SQL.

## 1.2 ADR-002 — Drizzle ORM chosen (measured)

`drizzle-orm`, `drizzle-kit` and `pg` installed from npm only. `drizzle-kit generate` wrote a
SQL migration with its snapshot and journal, and the programmatic migrator applied it to the
local PostgreSQL 16. Everything works offline.

Why Drizzle fits:

- pure TypeScript, so there is no engine download;
- the schema is written in TypeScript with inferred row types and no codegen step;
- migrations are SQL files generated from diffs and reviewed in git, and `drizzle-kit check`
  catches drift;
- it has typed `sql` for reports, `pgEnum`, identity columns, partial/expression indexes,
  `jsonb`, arrays, generated columns, `FOR UPDATE`, and transactions.

Rejected alternatives: TypeORM (decorator metadata, fragile migration generation), MikroORM
(unit-of-work weight not needed), Kysely (a good query builder but no migration
generation — the fallback choice).

## 1.3 ADR-003 — Fastify rather than NestJS or Express

Fastify is fast, validates and serialises with schemas, has official plugins for JWT,
cookies, multipart, CORS, rate-limit and swagger, and `inject()` makes HTTP tests trivial.
NestJS is about three times heavier and its DI container adds little when the business logic
lives in pure libraries. The layering (routes → services → repositories) is deliberately
Nest-shaped so a port stays cheap. Express has no schema validation or serialisation.

## 1.4 ADR-004 — Monorepo with three reusable libraries (revised)

```
noc/
├── package.json                     # npm workspaces root
├── packages/
│   ├── rules-engine/                # @noc/rules-engine   — generic, no NOC knowledge
│   ├── workflow-engine/             # @noc/workflow-engine — generic, no NOC knowledge
│   │   └── src/adapters/drizzle/    #   optional PostgreSQL store adapter (separate export)
│   └── domain/                      # @noc/domain — NOC rules + NOC workflow bindings + models
├── backend/                         # @noc/api — Fastify + Drizzle
├── e2e/                             # Playwright suites (frontend + backend together)
└── frontend/                        # Angular 21 — imports @noc/domain and @noc/rules-engine
```

- Both engines are **framework-free, I/O-free cores** with ports for storage, clock,
  assignment and authorisation. They can be published to a private registry and used by other
  applications (see `45-engines.md` §45.6).
- The backend runs **all** authoritative calculations and **all** workflow transitions.
- Per Q-14, the frontend keeps its live calculations. It imports the **same**
  `@noc/domain` + `@noc/rules-engine` code, so there is no second copy to drift. It does
  **not** import `@noc/workflow-engine`, because it never performs transitions.
- The existing `frontend/src/app/core/domain/**` files are split: NBC/FFE/fee/validation go
  to `@noc/domain`; the decision-tree evaluator goes to `@noc/rules-engine`; the workflow
  engine is generalised into `@noc/workflow-engine`; reports and escalations move to the
  backend (SQL, with the old functions kept as test oracles).

## 1.5 ADR-005 — File storage (revised: S3-compliant design, filesystem driver only)

- Files are never stored in the database and never under the web root.
- There is one `StorageProvider` port with one implementation, `FilesystemStorage`, rooted at
  `FS_STORAGE_ROOT`.
- The design is S3-compliant, so an S3 driver can be added later without changing callers
  (`60-architecture.md` §6.5):
  - flat object keys, with no reliance on directories, rename visibility, symlinks or
    listing;
  - metadata (bucket, key, size, checksum, content type) is kept in the `files` table and
    never read back from the storage layer;
  - downloads go through download tokens or redirects, so a future driver can return
    presigned URLs;
  - streaming writes are compatible with multipart upload;
  - a storage contract test suite is written now and must be passed by any future driver.
- **Not built:** the S3 driver, the S3 SDK dependency, MinIO, S3 configuration or S3 tests.

## 1.6 ADR-006 — Dates on the wire

The database stores `date` / `timestamptz` in UTC, with business dates in `Asia/Kolkata`.
The API serialiser keeps the legacy `dd-Mon-yyyy` format for now (no Angular model change).
A single `API_DATE_FORMAT=iso` switch changes the API to ISO-8601 later.

## 1.7 ADR-007 — Browser E2E with Playwright (new, measured)

Frontend integration is now in scope, so the portal needs browser-level tests.
`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` already contains Chromium builds.
`@playwright/test@1.56.1` was installed from npm and launched the preinstalled Chromium
141.0.7390.37 headless without downloading anything. The Playwright version is **pinned to the
1.56 line** so it matches the installed browser build (`chromium-1194`).

## 1.8 Dependency budget (production)

`fastify` + official plugins (`cors`, `cookie`, `jwt`, `multipart`, `rate-limit`, `helmet`,
`swagger`, `swagger-ui`), `zod`, `drizzle-orm`,
`pg`, `pino`, `argon2`, `node-cron`, `dotenv`.

Dev dependencies: `drizzle-kit`, `tsx`, `typescript`, `vitest`, `@playwright/test@1.56.x`,
`fake-indexeddb` (frontend cache tests), `eslint`, `prettier`, `pino-pretty`.

There is no S3 SDK and no Redis.
