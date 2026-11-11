# 55. Caching Strategy — Lookups, Master Data, Rules and Configuration

## 55.1 The problem

Almost every page loads reference data. The application wizard alone reads **about 25
resources** today: 20 lookups, 16 rule trees, fee, delegation and renewal configuration, NOC
terms and NBC Table 7. That is about **450 KB of JSON** on every cold load. This data changes
rarely, and mostly only through the admin screens or a deployment. At the same time, the
server is the source of truth for calculations, so **a stale client cache must never produce
a wrong persisted result**, only a briefly stale preview.

## 55.2 Data classes

| Bundle | Contents | Raw size (today) | Changes when | Who changes it | Audience | Sensitivity |
|---|---|---|---|---|---|---|
| `reference` | districts, regions, fire stations, application types and modes, build types and sub-types, directions, hazards, mapped codes, equipments, FFE notes, **statuses**, dept roles, party roles, block options, document requirements, undertakings, occupancy conditions | ~110 KB | deploy / seed | developers (seed, migrations) | everyone | public |
| `rules` | published versions of every rule set: 16 decision trees, approval-level and renewal tables, fee and escape-limit parameters | ~180 KB | admin publishes fees/approval/renewal; deploy for trees | admin | everyone (the wizard previews) | public |
| `content` | NOC terms (legal HTML), NBC Table 7 | ~60 KB | very rarely | developers | citizens (wizard FFE page, print), officers (decision preview) | public |
| `workflow` | workflow definitions (current versions), forms and questionnaires, SLA policies, escalation settings | ~40 KB | admin edits | admin | dept + admin | authenticated (dept/admin) |
| `directory` | active officers: id, name, role, stations (for reassign and hand-over pickers) — **no contact details** | small | account admin | admin | dept decider + admin | authenticated (dept/admin) |

Transactional data (applications, tasks, accounts in full) is **never** placed in a shared
cache (§55.8).

## 55.3 Overview

```
 PostgreSQL                         API process (each replica)                 Browser
 ──────────                         ──────────────────────────                 ───────
 source tables ─trigger─► cache_versions(bundle, version)      ┌──────────────────────────┐
        │                 pg_notify('noc_cache', bundle) ──────► LISTEN → ReferenceCache   │
        │                                                       │  per bundle:             │
        └───────────── reload on notify / 60 s poll ──────────► │   object, compiled rules │
                                                                │   JSON bytes, br, gzip   │
                                                                │   etag "<b>-v<n>-<h8>"   │
                                                                └────────────┬─────────────┘
  every API response ── header  X-Data-Versions: reference=12;rules=5;content=2;workflow=7;directory=3
  GET /meta/versions  (tiny, no-cache)                                       │
  GET /bundles/:b/v/:n  (immutable, 1 year) ─────────────────────► ReferenceDataStore (signals)
  GET /bundles/:b       (no-cache + ETag → 304)                       ├─ memory
                                                                      ├─ IndexedDB (per bundle+version)
                                                                      └─ BroadcastChannel (tabs)
```

## 55.4 Tier 1 — PostgreSQL: versioning and invalidation

- `cache_versions(id, bundle, version, etag, updated_at)` has one row per bundle.
- Every source table of a bundle has an `AFTER INSERT OR UPDATE OR DELETE … FOR EACH
  STATEMENT` trigger. It increments `version` and calls `pg_notify('noc_cache', bundle)`. The
  notify is delivered **on commit**, so a rolled-back change never invalidates anything.
- The trigger fires for **every** write path: the admin API, seeds, migrations, the demo
  reset script, or a DBA editing in `psql`. No code path can forget to invalidate.
- Rule-set publication touches `re_rule_sets.current_version_id`. Draft edits do **not** bump
  `rules`, because drafts are not served.

## 55.5 Tier 2 — the API: `ReferenceCache`

- **Warm at boot.** All five bundles are loaded before `/ready` reports ready.
- Per bundle it holds:
  - the materialised object;
  - for `rules`, the **compiled** rule sets used by `@noc/rules-engine`;
  - for `workflow`, the parsed definitions used by `@noc/workflow-engine`;
  - the serialised JSON bytes, pre-compressed **brotli** and **gzip** buffers;
  - an ETag derived from the version plus a short content hash.
- **Invalidation.** A dedicated `pg` client `LISTEN`s on `noc_cache`. On notify it reloads
  that bundle, with single-flight (concurrent requests keep using the old snapshot until the
  new one is atomically swapped in).
- **Safety net.** Every `CACHE_POLL_INTERVAL_MS` (60 s) it compares `cache_versions` with
  memory, in case the LISTEN connection dropped. On reconnect it does a full version check.
- **Engines read only from here.** Every rule evaluation and workflow definition lookup is a
  memory read with **zero database queries**, which matters for the per-save assessment.
- **Multi-replica.** Each replica has its own cache, synchronised by NOTIFY. Convergence is
  under about 1 s, with at most 60 s if a notify is lost. No Redis is needed at 100
  concurrent users (§55.10).
- **Consistency for writes.** A transaction that *uses* configuration (submit, payment,
  decide) reads the rule-set **version ids** from the cache and records them. When the result
  must match the database exactly (publishing and then immediately evaluating in the same
  request), the service reads `cache_versions` inside its transaction and forces a reload if
  the cache is behind.

## 55.6 Tier 3 — HTTP

| Endpoint | Cache-Control | Validation | Notes |
|---|---|---|---|
| `GET /meta/versions` | `no-cache` | — | about 100 bytes: `{reference:12, rules:5, …, schema:1}` |
| `GET /bundles/:bundle/v/:version` | **public** bundles: `public, max-age=31536000, immutable`; **private** bundles: `private, max-age=31536000, immutable` | — | **content-addressed URL**. If `:version` is not current, the API answers `302` to the current versioned URL, so old links self-heal. |
| `GET /bundles/:bundle` | `no-cache` (public) / `private, no-cache` | `ETag` → `304` | for clients that don't track versions |
| `GET /bootstrap?include=reference,rules,content` | `no-cache` | combined ETag | one round-trip for a cold start |
| Individual `GET /lookups/*`, `GET /rules/*`, `GET /config/*` | `no-cache` | `ETag` from the bundle version → `304` | kept for compatibility, other clients and admin screens |
| Any other API response | `private, no-store` (transactional) | — | always carries `X-Data-Versions` |

- Compressed buffers are served directly according to `Accept-Encoding` (`br` > `gzip`). The
  whole cold set is about **50–60 KB on the wire** instead of about 450 KB.
- `Vary: Accept-Encoding` on bundles; `Vary: Authorization` on private bundles.
- Public bundles may be cached by nginx or a CDN. They contain no personal data.
- The `schema` number in `/meta/versions` is the **bundle format version**. It is bumped when
  the *shape* changes in a deploy, so clients discard incompatible persisted caches.

## 55.7 Tier 4 — the browser: `ReferenceDataStore`

An Angular root service that replaces the internals of `LookupService`. Its **public API
stays the same** (`applicationTypes$`, `districts$`, `wizard()`, `config()`, `workflowConfig()`
…), so components do not change.

**Boot sequence** (`provideAppInitializer`, does not block first paint for public pages):

1. Read persisted bundles from **IndexedDB** (`noc-cache` DB, key `bundle`, value
   `{ version, schema, etag, data }`). Publish them to signals immediately, so a returning
   user's pages render with **zero network** for reference data.
2. Obtain the current versions. They come from the login or `/auth/me` response if
   available, otherwise from `GET /meta/versions`.
3. For each bundle that is missing or stale and **relevant to the user's portal**, fetch
   `GET /bundles/:b/v/:n` (immutable; the HTTP cache may already have it), then store it in
   IndexedDB and update the signals.
   - citizens: `reference`, `rules`; `content` is lazy, when the wizard FFE page or print
     opens;
   - officers: all five;
   - admin: all five.

**Staying fresh while the app is open:**

- A `dataVersionInterceptor` reads `X-Data-Versions` on **every** API response. If any
  relevant bundle is newer, it schedules a background refresh. This costs no polling and no
  extra requests; the app learns of a change on its next API call.
- When the tab becomes visible again after more than 5 minutes hidden, it calls
  `GET /meta/versions` once.
- A `BroadcastChannel('noc-cache')` shares "bundle X is now version N" with the other tabs,
  so they reuse the same IndexedDB entry instead of refetching.

**Consumers react automatically:** the bundles are signals, so the wizard's fee preview,
approval level and FFE grid recompute when `rules` changes mid-session.

**Security and hygiene:**

- On **logout**, the private bundles (`workflow`, `directory`) are deleted. Public bundles
  are kept.
- A `schema` mismatch or a corrupted entry discards that bundle and refetches it.
- IndexedDB unavailable (private mode) → memory only. The app still works; only the
  cross-session benefit is lost.
- Size is about 500 KB uncompressed in IndexedDB, far below quotas.

## 55.8 What is deliberately **not** cached

| Data | Policy | Reason |
|---|---|---|
| Application aggregates, lists, tasks, dashboards | `private, no-store`. `GET /applications/:id` has `ETag = "r<row_version>"` so a revisit can return `304` (private revalidation only). | per-user and frequently changing; correctness matters more |
| Accounts (full records) | `no-store` | personal data |
| Reports | computed on request; an optional **server-side** 60 s memo keyed by (report, filters, data watermark), never shared across users with different jurisdictions | aggregation cost at 100 k/year |
| Files | `private, no-store`; delivered through one-time download tokens | authorisation |
| Auth endpoints | `no-store` | |

## 55.9 Correctness: stale client cache versus a server-authoritative result

| Scenario | Outcome |
|---|---|
| Admin publishes a new fee rate while a citizen is in the wizard | The citizen's next save response carries `rules=6`. The interceptor refreshes the bundle, the preview recomputes, and the save response already contains the **server's** fee. Nothing wrong is persisted. |
| The citizen paid before the change | The fee is **frozen at payment** with its parameter version (Q-57). Later changes don't affect it. |
| The client calculation differs from the server (rules version or a bug) | The server value wins and replaces the client's. The frontend logs a `calc-drift` warning (dev console; optional telemetry endpoint), which parity tests keep at zero for the same version. |
| Admin changes a workflow definition while an officer has a file open | Instances keep their definition version. The new `workflow` bundle only affects the editor and new submissions. Transitions are validated server-side against the instance's version. |
| A status is renamed (configurable 3–6) | The `reference` version is bumped. Badges update on the next API call in every open tab. |
| A NOTIFY is lost | The API polls every 60 s. Clients learn on their next response. The worst case is about 60 s of stale *preview*, never a stale persisted result. |

## 55.10 Why not Redis, a service worker, or HTTP-only caching

- **Redis.** At 100 concurrent users, with about 400 KB of data per process, an in-process
  cache with NOTIFY is simpler, faster (no network hop) and has one less moving part. Redis
  (or an HTTP cache in front) becomes worth it only with many replicas or if *report* results
  need sharing. The `ReferenceCache` interface allows that swap.
- **Service worker.** It would add offline capability, which is not a requirement, and extra
  deployment subtlety. IndexedDB plus immutable URLs gives the same warm-start benefit. It is
  a possible later addition.
- **Relying only on the browser HTTP cache.** Immutable URLs already use it, but it cannot
  give synchronous signals at boot, cross-tab coordination, or controlled eviction on logout.
  Hence IndexedDB on top.

## 55.11 Expected effect

| Metric | Today (fixtures) | After |
|---|---|---|
| Wizard cold load (first visit) | ~25 requests, ~450 KB | 1–2 requests, ~55 KB (br) |
| Wizard load (returning user, nothing changed) | ~25 requests | **0 requests** for reference data (versions arrive with `/auth/me`) |
| Per-save rule evaluation on the server | — | 0 DB queries for rules (memory) |
| Propagation of an admin change | — | < 1 s to servers; next API call for clients |

## 55.12 Tests for the cache (see `80-test-plan.md`)

- A direct SQL `UPDATE` in `psql` on `districts` bumps `reference`, sends NOTIFY, and a
  second in-process app instance reloads.
- A rolled-back transaction does not bump anything.
- The immutable URL returns the correct headers. A stale version redirects. ETag returns 304.
- `X-Data-Versions` is present on every response type, including errors.
- Brotli, gzip and identity responses decode to the same bytes.
- Frontend store (Vitest + `fake-indexeddb`): warm start from IndexedDB; stale detection from
  the header; cross-tab broadcast; logout purges private bundles; schema mismatch discards.
- Playwright: change the fee as admin in one browser context, then the citizen context's next
  save shows the new fee and the preview updates.
