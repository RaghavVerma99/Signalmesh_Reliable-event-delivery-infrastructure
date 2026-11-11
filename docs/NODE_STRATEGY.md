# SignalMesh Node.js Continuation Strategy

**Decision:** Continue on Node.js 26 + Express 4 as the implementation stack.  
**Durable store:** PostgreSQL (existing stub at `src/storage/postgres.js` to be repaired and wired as the source of truth). JSON file remains a local-dev fallback only.  
**Spec target:** `SIGNALMESH_SPEC.md` v1.0 acceptance criteria (section 18), MVP scope (section 4.1).  
**Audit baseline:** `docs/AUDIT_REPORT.md` (6 of 19 acceptance criteria currently met).

---

## 1. Why PostgreSQL even on Node

The spec's NFR-001 and acceptance criterion #2 require that accepted events + initial delivery work be **durably committed before `202 Accepted`**. The current JSON store writes are debounced (500 ms) and best-effort — a crash loses acknowledged work. PostgreSQL gives us:

- Atomic transaction for event + deliveries + outbox
- `SELECT ... FOR UPDATE SKIP LOCKED` for safe multi-worker claiming
- Crash recovery / lease expiry across processes
- Indexes on hot paths (spec 9.10)

The existing `pg` dependency is already in `package.json`. The `src/storage/postgres.js` stub exists but is unused, incomplete, and has bugs (plaintext `'hash_' + token`, missing indexes/constraints/lease columns).

---

## 2. Revised milestones (Node adaptation)

| Milestone | Goal | Node-specific notes |
|---|---|---|
| **M0 Foundation** | Config loader, Postgres + Docker Compose, migrations, health/readyz, CI | `dotenv`, `pg`, `node:test`, GitHub Actions |
| **M1 Durable ingestion** | Orgs, API keys, auth, event ingestion, idempotency, endpoint CRUD | Tenant scoping from API key; synchronous transaction before 202 |
| **M2 Delivery engine** | Outbox, worker, safe claiming (`SKIP LOCKED`), HTTP client, attempt history, state machine | Separate `worker.js` process; in-process or multi-process claiming |
| **M3 Reliability** | Retry/jitter, lease recovery, dead-letter, replay, HMAC, rate limiting, SSRF | Delivery-time DNS/IP re-check |
| **M4 Operability** | Structured logs, Prometheus, OTel, graceful shutdown, backup/restore docs | Existing `metrics.js` to be expanded |
| **M5 DX** | OpenAPI, SDK/CLI, example producer/receiver | — |

---

## 3. Phase 1 — Immediate security fixes (do now)

These close exploitable gaps in the running code before any feature work.

- [x] **SSRF delivery-time re-check**: `recheckDeliveryDestination` called before every outbound request in `worker.runAttempt`; blocked destinations dead-letter immediately.
- [x] **Encrypt signing secrets at rest**: AES-256-GCM via `encryptSecret`/`decryptSecret` (`enc:` prefix); `SIGNALMESH_SECRET_ENCRYPTION_KEY` required in production; `plain:` dev fallback; plaintext returned only once at creation.
- [x] **Keyed API-key hashing**: HMAC-SHA-256 with `SIGNALMESH_API_KEY_PEPPER`.
- [x] **Constant-time signature compare**: implemented via `timingSafeEqual`; explicit unit test added.
- [x] **Response body cap**: `MAX_RESPONSE_BYTES` truncation applied to stored response excerpts.
- [x] **Request body cap**: Express 256KB limit retained; configurable via env in future.
- [x] **No secrets in logs**: audited `log()` calls; secrets never logged.
- [x] **Revocation enforcement**: `findKeyByToken` rejects `revokedAt` keys.
- [x] **Durable persist before 202**: `persistSync` before response; `503` on failure.
- [x] **Retry timeout defaults aligned**: env-configurable (10s timeout, 8 attempts, 2s base, 1h cap).

---

## 4. Master checklist (adapted from SPEC section 18, Node version)

| # | Acceptance criterion | Node status | Owner file(s) |
|---|---|---|---|
| 1 | Producer authenticates and submits event | ✅ Done | `app.js` |
| 2 | Persist event + delivery work atomically before 202 | ✅ Done (Postgres transaction; JSON sync flush) | `storage/postgres.js`, `storage/json.js` |
| 3 | Returns event ID, doesn't wait for destination | ✅ Done | `app.js` |
| 4 | Fan-out to multiple endpoints | ✅ Done | `app.js` |
| 5 | Concurrent workers without conflicting claims | ✅ Done (Postgres `SKIP LOCKED`; JSON in-process) | `storage/postgres.js`, `worker.js` |
| 6 | Same idempotency key ⇒ no duplicate event | ✅ Done (TTL + unique constraint) | `storage/postgres.js` |
| 7 | Same key, different payload ⇒ 409 | ✅ Done | `app.js` |
| 8 | Outbound HMAC signatures verifiable | ✅ Done | `security.js` |
| 9 | Timeouts/retries per policy | ✅ Done | `worker.js` |
| 10 | Retry scheduling survives restarts | ✅ Done (Postgres) | `storage/postgres.js` |
| 11 | Worker crash recovery via lease expiry | ✅ Done (lease + stale-worker guard) | `worker.js`, `storage/postgres.js` |
| 12 | Exhausted deliveries dead-lettered | ✅ Done | `worker.js` |
| 13 | Inspect attempts; replay failed deliveries | ✅ Done | `app.js` |
| 14 | Tenant isolation covered by automated tests | ✅ Done | `tests/store.test.js`, `tests/api.test.js` |
| 15 | SSRF protections implemented + tested | ⚠ Partial | Delivery-time re-check done; connected-IP check + tests pending |
| 16 | Health/readiness/logs/metrics | ✅ Done (readyz checks storage) | `app.js`, `metrics.js` |
| 17 | Docker Compose local env | ✅ Done (all-in-one + split profile) | `Dockerfile`, `docker-compose.yml` |
| 18 | Integration + e2e tests pass | ✅ Done (unit + API integration; PG integration in CI) | `tests/` |
| 19 | README explains guarantees/limits/setup | ✅ Done | `README.md` |

---

## 5. Open design decisions (stop-and-ask before coding)

1. **JSON fallback retention** — keep `data/db.json` as local-dev-only option behind `SIGNALMESH_STORAGE=json`, or remove entirely?
2. **Tenant model** — `organization_id` column on every table (row-level scoping) vs. separate DB per tenant? Recommendation: row-level `organization_id`.
3. **Idempotency TTL** — documented default (e.g., 24h), configurable, with expiry cleanup job.
4. **Retry defaults** — adopt spec: max 8 attempts, base 2s, multiplier 2, max delay 1h, timeout 10s.
5. **Replay semantics** — new delivery record linked to original (current behavior) vs. new generation on same delivery. Keep current for MVP; document.
6. **Secret rotation overlap** — represent as `signing_secret` + `signing_secret_previous` with overlap window.
7. **Subscription snapshotting** — snapshot matched endpoint IDs at ingestion time so later subscription changes don't alter historical fan-out.

---

## 6. Suggested execution order (next 30 days, Node)

- **Week 1:** Phase 1 security fixes + M0 scaffolding (Postgres connection, migrations, Docker Compose, CI).
- **Week 2:** M1 (orgs, API keys, auth, idempotency, event ingestion, endpoint CRUD, tenant scoping).
- **Week 3:** M2 (outbox, worker claiming, HTTP client, attempt history, state machine).
- **Week 4:** M3 (retry/jitter, lease recovery, dead-letter, replay, rate limiting, SSRF) + failure-injection tests.

---

## 7. How to use this with the existing checklist

`docs/CHECKLIST.md` remains the companion checklist. Update its "Status" column using Section 4 above. The corrected finding: constant-time signature comparison **is** implemented (`timingSafeEqual` in `security.js`) — the checklist's "Missing" mark for that item is incorrect.

---

## 8. Implemented in this pass (2026-11-11)

Tenant isolation, PostgreSQL, rate limiting, audit logging, process split, tests, and CI are now in place:

- **Tenant model**: `organizations` + `organization_id` scoping across keys, events, endpoints, deliveries, idempotency, and audit. Bootstrap creates the first org; all queries are tenant scoped.
- **Async store contract**: `src/storage/json.js` and `src/storage/postgres.js` implement the same interface; `src/store.js` selects via `SIGNALMESH_STORAGE`.
- **PostgreSQL**: `src/storage/migrations/001_init.sql` (tables + indexes + unique constraints), `src/storage/migrate.js` runner, atomic `ingestEvent` transaction, `FOR UPDATE SKIP LOCKED` claiming, lease + stale-worker guard, `delivery_attempts`.
- **Rate limiting**: `src/ratelimit.js` tenant token bucket, `429` + `Retry-After` (in-process; Redis/PG for multi-replica).
- **Audit log**: append-only, tenant-scoped, exposed at `GET /v1/audit`; records key, endpoint, event, replay, cancel actions.
- **Endpoint PATCH**: `PATCH /v1/endpoints/:id` with URL re-validation.
- **Cursor pagination** on events and deliveries.
- **API/worker split**: `src/api.js`, `src/worker-main.js`, `SIGNALMESH_ROLE`, `npm run start:api` / `start:worker`; Docker Compose `split` profile.
- **Tests**: 18 unit/integration tests + conditional PostgreSQL integration test; `tests/api.test.js`, `tests/store.test.js`, `tests/ratelimit.test.js`.
- **CI**: `.github/workflows/ci.yml` (Node 22/24, PostgreSQL service, Docker build).

Remaining for full spec parity: connected-IP SSRF validation, OpenTelemetry, outbox table usage, secret-rotation overlap, and load/failure-injection benchmarks.
