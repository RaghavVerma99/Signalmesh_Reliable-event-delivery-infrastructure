# SignalMesh Audit Report & Implementation Strategy

> **Status note (2026-11-11):** this is the original audit baseline. Tenant isolation, PostgreSQL, rate limiting, audit logging, the API/worker split, tests, and CI have since been implemented. See `docs/CHECKLIST.md` (sections 9-10) and `docs/NODE_STRATEGY.md` (section 8) for the current status.

**Repository:** SignalMesh webhook delivery MVP  
**Audit date:** 2026-11-11  
**Spec audited against:** `SIGNALMESH_SPEC.md` v1.0 (PRD + SRS + Technical Design)  
**Current implementation:** Node.js 26 + Express 4, JSON-file persistence, single in-process worker  
**Companion docs:** `docs/CHECKLIST.md` (existing audit checklist), `README.md`

---

## 1. Executive summary

SignalMesh is a functioning MVP demo that accepts events, fans them out to registered HTTP endpoints, retries failures with backoff, dead-letters on exhaustion, and supports replay/cancel/inspection. It successfully demonstrates the core delivery loop.

However, measured against `SIGNALMESH_SPEC.md` v1.0, the implementation is a **partial MVP at best**:

| Dimension | Spec requirement | Current state | Gap severity |
|---|---|---|---|
| Language / stack | Go + PostgreSQL + Docker Compose | Node.js 26 + Express + JSON file | Critical (decision gate) |
| Durability | Commit before `202 Accepted`; survive restarts | JSON file, debounced best-effort writes | Critical |
| Tenant isolation | Required for MVP | None - all keys see all data | Critical |
| Worker scheduling | PostgreSQL `FOR UPDATE SKIP LOCKED`, leases | Single process, 1s poll, in-memory lease | Critical |
| Atomicity | Event + deliveries in one transaction | Separate in-memory inserts, no transaction | Critical |
| SSRF protection | Block + DNS re-check at delivery time | Blocklist at registration only, no re-check | High |
| Rate limiting | Tenant + endpoint limits | None | High |
| Observability | Prometheus + OTel + structured logs | Partial metrics, no OTel, no heartbeat | Medium |
| API surface | Full CRUD incl. PATCH, pagination | Missing PATCH, no cursor pagination | Medium |
| Tests / CI | Unit + integration + e2e + failure injection | 2 test files, 6 tests, no CI | Medium |
| Security | Hashed keys, encrypted secrets, revocation | SHA-256 keys, plaintext secrets, revoke exists | Medium |

**Bottom line:** the code is a solid demo foundation, but it does **not** satisfy spec section 18 acceptance criteria or section 4.1 MVP scope. Do not treat the current Node build as production-ready. The first strategic decision is the stack end-state (see Section 5).

---

## 2. File-by-file audit findings

### `src/server.js` (API layer)
**What works:**
- Request-ID middleware and structured JSON logs
- Consistent error envelope matching spec 8.6 (`{ error: { code, message, request_id } }`)
- `POST /v1/events` returns `202 Accepted`, validates `event_type`, supports idempotency key
- Fan-out to all active, subscribed endpoints (wildcard `*` supported)
- `POST /v1/keys` bootstrap; `POST /v1/keys/:id/revoke` exists
- Endpoint CRUD: POST/GET/DELETE; soft-delete
- Delivery list/get, replay (creates new delivery), cancel (409 if processing)
- Demo receivers (`/demo/orders`, `-flaky`, `-down`) for manual testing
- `/healthz`, `/readyz`, `/metrics`; graceful shutdown on SIGTERM/SIGINT
- `redirect: 'manual'` (redirects disabled) - good

**Gaps / defects:**
1. **No tenant scoping.** `store.listEndpoints()` returns every endpoint to every API key. Spec FR-001 / MVP scope requires tenant/organization isolation.
2. **No PATCH `/v1/endpoints/:id`** - required by FR-004.
3. **Idempotency is incomplete:** no retention expiry, no operation scoping, not tenant-scoped, no concurrency guard (FR-003).
4. **Durability window:** `insertEvent` calls `schedulePersist()` (debounced 500 ms) but `insertDelivery` also only schedules; `store.persist()` is invoked once after all inserts. A crash between in-memory insert and disk flush loses accepted work - violating NFR-001 and acceptance criterion #2 (atomic persist before 202).
5. **Signature headers use `x-signalmesh-*`** instead of the spec-suggested `SignalMesh-Event-Id` / `SignalMesh-Delivery-Id` / `SignalMesh-Timestamp` / `SignalMesh-Signature` (FR-011). This is a contract deviation, not a bug.
6. **No rate limiting** (FR-013), no cursor pagination (`next_cursor` always null), no audit-log writes for admin actions (FR-015).
7. Replay creates a new delivery but persists no audit record (actor, reason, timestamp) beyond a log line.

### `src/store.js` (JSON persistence layer)
**What works:**
- `genId`, `stableStringify` (deterministic fingerprinting), `hashToken` (SHA-256)
- Key creation with prefix display, hash storage, revocation
- Basic CRUD for events, endpoints, deliveries, idempotency records

**Gaps / defects:**
1. **Best-effort persistence.** `persist()` swallows errors (`catch (e) {}`). Writes are debounced, not synchronous. No durability guarantee.
2. **No transactions** - atomic event + delivery creation is impossible on this layer.
3. **Idempotency store** is a plain object keyed by raw key: no expiry, no operation, no tenant, no unique-constraint semantics.
4. `module.exports.state` exposes mutable internal state (test coupling).
5. `findKeyByToken` compares plain SHA-256 hashes directly - acceptable for high-entropy random tokens per spec NFR-006 discussion, but no pepper/keyed hash; spec suggests "keyed hash or secure one-way approach."

### `src/storage/postgres.js` (PostgreSQL stub - NOT wired up)
**Status:** Present but unused. `storeImpl` defaults to the JSON store; Postgres is only selected via `SIGNALMESH_STORAGE=postgres`.

**Gaps / defects:**
1. Tables use `TEXT` for IDs/timestamps instead of UUID / TIMESTAMPTZ (spec 9.x).
2. **No indexes** (spec 9.10 requires them).
3. `signing_secret` stored as literal `'hash_' + key` - not hashed/encrypted at all.
4. `findKeyByToken` compares `'hash_' + token` - broken auth if wired.
5. Missing `delivery_attempts` writes, `outbox_events` table, idempotency expiry column, unique constraints, `FOR UPDATE SKIP LOCKED` claim mechanism, lease columns (`locked_by`).
6. No migration framework, no seed command.

### `src/worker.js` (delivery engine)
**What works:**
- `computeBackoffMs` implements full jitter with exponential cap
- Retryable status set `[408, 425, 429, 500, 502, 503, 504]`
- `Retry-After` parsing for 429/503 (bounded by maxDelayMs)
- Attempt recording with status code, duration, error class, response excerpt
- `redirect: 'manual'`; bounded `AbortSignal.timeout`
- Queue-depth and oldest-pending-age gauges
- Graceful `start`/`stop`

**Gaps / defects:**
1. **Single worker, one delivery per 1s tick.** No concurrency, no batching, no `FOR UPDATE SKIP LOCKED` equivalent (FR-006).
2. **In-process lease only** (`lockedUntil`). No cross-process/worker crash recovery (NFR-005).
3. Defaults deviate from spec FR-008: maxAttempts 3 (spec: 8), baseDelay 1s (spec: 2s), maxDelay 30s (spec: 1h), timeout 5s (spec: 10s).
4. `RETRYABLE_STATUS` includes 425 (not in spec list) - minor deviation.
5. No SSRF re-check at delivery time (DNS rebinding window between registration and delivery).
6. No per-endpoint concurrency limits, no circuit breaker.
7. `claimDueDelivery` does not atomically mark a row as claimed - two workers/processes could pick the same delivery (no claim token/conditional update).
8. Dead-letter stored only as delivery status, no separate dead-letter table/audit (spec 9.x mentions `dead_letters`).

### `src/security.js`
**What works:**
- CIDR blocklist (private, loopback, link-local, multicast, reserved)
- Blocked outbound ports (SSH, databases, SMTP, DNS, etc.)
- DNS resolution + IP validation; `https_required` in production
- `timingSafeEqual` for signature verification (constant-time) - contradicts CHECKLIST.md claim; code is actually correct here
- HMAC-SHA256 over `timestamp.body`; `v1=` prefix
- Response-size cap constant (`MAX_RESPONSE_BYTES`)

**Gaps / defects:**
1. **No DNS re-check at connection/delivery time** - DNS rebinding risk (spec 12.2 #5).
2. `validateDeliveryUrl` called only at endpoint registration, not before each delivery.
3. Signing secrets generated and stored in plaintext (NFR-006: "protected secret reference or encrypted at rest").
4. No secret-rotation overlap support.
5. `localhost` allowed in development (acceptable but should be explicitly opt-in).
6. No rate-limiting or abuse detection on signature verification.

### `src/metrics.js`
**What works:**
- Prometheus text exposition, counters, gauges, histogram buckets for duration

**Gaps / defects:**
1. Missing spec 13.2 metrics: `delivery_failure_total`, `worker_claim_errors_total`, `dead_letter_total`, `delivery_duration_seconds` exists but lacks `delivery_success_total` vs failure breakdown.
2. No labels at all - good for cardinality, but no outcome/error_class dimensions for debugging.
3. No OpenTelemetry tracing (NFR-007).

### `tests/`
**Status:** `security.test.js` (4 tests) + `worker.test.js` (3 tests) = 6 tests total. No test script in `package.json`, no CI, no integration/e2e/failure-injection tests.

---

## 3. Gap analysis vs. spec acceptance criteria (section 18)

| # | Acceptance criterion | Status | Evidence |
|---|---|---|---|
| 1 | Producer can authenticate and submit an event | ✅ Done | `POST /v1/events` with Bearer auth |
| 2 | Persist event + initial delivery work atomically before 202 | ❌ Fail | JSON debounced writes; no transaction |
| 3 | Returns event ID, does not wait for destination | ✅ Done | 202 returned immediately |
| 4 | Fan-out to multiple endpoints | ✅ Done | Loop over matching endpoints |
| 5 | Concurrent workers without conflicting claims | ❌ Fail | Single worker, in-memory claim |
| 6 | Same idempotency key ⇒ no duplicate event | ⚠ Partial | Works in single process, no expiry/concurrency safety |
| 7 | Same key, different payload ⇒ 409 conflict | ✅ Done | Fingerprint comparison |
| 8 | Outbound requests include verifiable HMAC signatures | ✅ Done | `signDelivery`/`verifyDeliverySignature` |
| 9 | Timeouts and retryable failures retried per policy | ⚠ Partial | Implemented but defaults deviate from spec |
| 10 | Retry scheduling survives restarts | ❌ Fail | In-memory only; JSON persistence not durable |
| 11 | Worker crashes recovered via lease expiry | ❌ Fail | In-process lease only |
| 12 | Exhausted deliveries become dead-lettered | ✅ Done | `dead_lettered` state |
| 13 | Inspect attempts; replay failed deliveries | ✅ Done | GET delivery + replay endpoint |
| 14 | Tenant isolation covered by automated tests | ❌ Fail | No tenant model; no tests |
| 15 | SSRF protections implemented and tested | ⚠ Partial | Registration-time blocklist only; no delivery-time re-check |
| 16 | Health, readiness, logs, metrics available | ⚠ Partial | Endpoints exist; metrics incomplete; no dependency checks |
| 17 | Docker Compose starts working local env | ❌ Fail | No Dockerfile, no compose |
| 18 | Integration and e2e tests pass | ❌ Fail | 6 unit-level tests only |
| 19 | README explains guarantees/limitations/setup | ✅ Done | README present |

**Result: 6 of 19 criteria fully met.**

---

## 4. Strategic plan & prioritized checklists

### Strategic recommendation on the stack (decision gate)

The spec's Section 1 mandates **Go + PostgreSQL**; Section 19 rule #6 says "Use PostgreSQL as the source of truth"; Section 21 recommends PostgreSQL. The current Node/Express build is a demo prototype.

**Recommended path:**
1. **Gate decision now:** Either (a) continue Node as a throwaway demo and build the end product in Go per spec, or (b) migrate the codebase to Go now. Do not attempt to productionize the Node build beyond demo scope.
2. If staying on Node for the interim: treat `src/storage/postgres.js` as the migration target and harden the JSON store only as a short-term bridge.
3. All checklists below assume the **spec-mandated end state (Go + PostgreSQL)**; items marked [NODE-BRIDGE] apply only if the Node build is kept temporarily.

---

### Phase 1 - Immediate security fixes (do before any feature work)

These close exploitable gaps in the current running code.

- [ ] **SSRF delivery-time re-check**: Re-run `validateDeliveryUrl` (or DNS + IP re-check) immediately before each outbound HTTP request in the worker to defeat DNS rebinding.
- [ ] **Disable redirects enforcement**: Confirm `redirect: 'manual'` is applied on every outbound client, not just `fetch` defaults.
- [ ] **Constant-time signature comparison**: Already implemented via `timingSafeEqual` - add a test asserting timing-safe behavior and document it.
- [ ] **Signing secrets at rest**: Stop storing signing secrets in plaintext; store encrypted ciphertext or a KMS reference; return secret only once at creation.
- [ ] **API key hashing**: Replace plain SHA-256 with a keyed hash / peppered HMAC for API keys (spec NFR-006).
- [ ] **Response body size limit**: Enforce `MAX_RESPONSE_BYTES` truncation in the worker (already referenced; verify it is applied).
- [ ] **Request body limit**: Keep Express 256KB limit; document as configurable.
- [ ] **Key revocation enforcement**: `findKeyByToken` must reject revoked keys (already checks `revokedAt` in JSON store; verify Postgres stub does too).
- [ ] **No secrets in logs**: Audit all `log()` calls to ensure no API keys, signing secrets, or full payloads are logged.

### Phase 2 - Milestone 0: Project foundation (spec section 17)

- [ ] **Stack decision recorded**: Node-prototype vs Go end-state; document in ADR.
- [ ] **Go module + repo conventions**: `go.mod`, directory layout per spec section 15.
- [ ] **Configuration loader**: env-driven config with defaults (spec section 14), `.env.example` without real secrets.
- [ ] **PostgreSQL + Docker Compose**: `docker-compose.yml` with postgres service; healthcheck.
- [ ] **Migration framework**: schema migrations (e.g., golang-migrate), initial migration for all spec 9.x tables.
- [ ] **Health endpoint**: `GET /healthz` (liveness) + `GET /readyz` (readiness incl. DB connectivity).
- [ ] **CI workflow**: formatting (`gofmt`), linting (`golangci-lint`), `go test`, `go vet` on push/PR.
- [ ] **Done when**: new developer clones, runs `docker compose up`, and starts API + worker via documented commands.

### Phase 3 - Milestone 1: Durable ingestion (spec section 17)

- [ ] **Organization + API-key model**: `organizations`, `api_keys` tables; key scoped to tenant.
- [ ] **Authentication middleware**: Bearer token validation, `401`/`403` responses, tenant-scoped.
- [ ] **Event ingestion endpoint**: `POST /v1/events`, `202 Accepted`, event_type required, body-size limit.
- [ ] **Idempotency**: `Idempotency-Key` header scoped by tenant+operation; request fingerprint; `409` on fingerprint mismatch; retention expiry column + cleanup; concurrent-request safety via DB unique constraint.
- [ ] **Event persistence**: Event + initial delivery work committed in one PostgreSQL transaction before 202.
- [ ] **Endpoint + subscription CRUD**: POST/GET/PATCH/DELETE; soft-delete; `(endpoint_id, event_type)` unique constraint.
- [ ] **Done when**: accepted events survive restart; duplicate submissions obey idempotency contract.

### Phase 4 - Milestone 2: Delivery engine

- [ ] **Atomic delivery/outbox creation**: `outbox_events` written in same transaction as event; dispatcher converts to scheduled delivery work.
- [ ] **Worker executable**: separate process from API, shared codebase.
- [ ] **Safe job claiming**: `SELECT ... FOR UPDATE SKIP LOCKED` with `locked_by`/`locked_until` claim token; conditional update to prevent stale-worker overwrite.
- [ ] **HTTP client with timeouts**: connect, TLS, header, total timeouts; `redirect: manual`; response-body cap.
- [ ] **Attempt history**: `delivery_attempts` table with status, duration, error class, excerpt.
- [ ] **State machine**: explicit transition function; statuses `pending` → `processing` → `succeeded`/`retry_scheduled`/`dead_lettered`/`cancelled`.
- [ ] **Done when**: one event delivered to multiple endpoints; endpoint failures isolated.

### Phase 5 - Milestone 3: Reliability

- [ ] **Retry policy + jitter**: bounded exponential backoff with full jitter; spec defaults (max 8 attempts, base 2s, max 1h, 10s timeout); `Retry-After` respected within bounds; never retry indefinitely.
- [ ] **Lease recovery**: lease expiry allows reclaim; lease > timeout + margin; heartbeat option for long work.
- [ ] **Dead-letter handling**: dead-letter state; preserve attempt history; list/detail API.
- [ ] **Replay**: operator-triggered re-queue; new delivery generation linked to original; audit record (actor, timestamp, reason).
- [ ] **HMAC signatures**: HMAC-SHA256 over `timestamp.body`, versioned header, receiver verification example + test vectors.
- [ ] **Rate limiting**: tenant ingestion limits + endpoint delivery limits; `429` with `Retry-After`.
- [ ] **SSRF protections**: URL validation, private/loopback/link-local/metadata IP block, DNS resolve + connected-IP re-check, port restriction, redirect disabled.
- [ ] **Done when**: documented failure-injection suite passes (spec 16.5 scenarios 1-10).

### Phase 6 - Milestone 4: Operability

- [ ] **Structured JSON logs**: correlation IDs, event/delivery/tenant/worker IDs, error class, duration; no secrets/payloads.
- [ ] **Prometheus metrics**: spec 13.2 metric set; bounded labels only (no raw URLs/event IDs as labels).
- [ ] **OpenTelemetry instrumentation**: traces on API + worker operations.
- [ ] **Graceful shutdown**: stop claiming new work; in-flight work finishes within deadline.
- [ ] **Operational docs**: backup/restore procedures, retention config, alert conditions.
- [ ] **Done when**: operator can identify backlog, locate failed deliveries, recover from worker crash.

### Phase 7 - Milestone 5: Developer experience

- [ ] **OpenAPI spec**: `api/openapi.yaml` for `/v1` contract.
- [ ] **Go SDK or CLI**: endpoint testing, event replay.
- [ ] **Example producer + receiver**: with signature verification.
- [ ] **Optional dashboard**: defer until core engine is stable (spec 4.3 defers complex React dashboard).
- [ ] **Done when**: external developer integrates without reading internal source.

### Phase 8 - Post-MVP backlog (spec section 4.2) - unchecked

- [ ] Redis-backed rate limiting or scheduling acceleration (only after measured need)
- [ ] Go client SDK
- [ ] CLI for endpoint testing and replay
- [ ] Dashboard for event/delivery inspection
- [ ] OpenTelemetry distributed traces (can move to Milestone 4)
- [ ] Per-endpoint concurrency limits
- [ ] Circuit breaker
- [ ] Event retention and archival policies
- [ ] Multiple worker replicas
- [ ] API versioning and schema validation
- [ ] Webhook endpoint verification handshake
- [ ] Tenant usage quotas
- [ ] Managed hosted version

### Explicitly deferred (spec section 4.3) - do not add

- [ ] Kubernetes, Kafka, microservices, complex React dashboard, billing, multi-region
- Condition: only reconsider after single-node durable delivery path is correct and tested.

---

## 5. Open design decisions (stop-and-ask before proceeding)

Per spec sections 19.5 and 21, resolve these before writing production code:

1. **Language/runtime end-state** - Node MVP now vs. Go prescribed by spec. *Recommendation: decide now; do not mix runtimes long-term.*
2. **PostgreSQL adoption timeline** - immediate migration or JSON bridge? *Recommendation: migrate to PostgreSQL in Milestone 0/1; JSON is demo-only.*
3. **Tenant model and isolation approach** - row-level tenant ID on all tables vs. separate schemas/databases.
4. **Default idempotency retention period** - select documented value (e.g., 24h), make configurable.
5. **Final retry defaults** - spec suggests max 8 attempts, base 2s, multiplier 2, max delay 1h, timeout 10s.
6. **Replay semantics** - new delivery record vs. new generation linked to original (MVP currently creates new delivery).
7. **SSRF DNS re-check strategy at delivery time** - resolve + check connected IP before each attempt; cache TTL.
8. **Endpoint secret rotation overlap** - how to represent old/new secret overlap period.
9. **Event subscription snapshotting** - recommended: snapshot subscribed event types at ingestion time so later subscription changes don't alter historical fan-out.
10. **No-match behavior** - accept and retain event with zero deliveries (recommended).

---

## 6. Per-file remediation priorities

| File | Priority | Primary actions |
|---|---|---|
| `src/server.js` | High | Add tenant scoping, PATCH endpoint, synchronous durable persist before 202, audit-log writes, spec-conformant signature headers, cursor pagination, rate-limit middleware |
| `src/store.js` | High | Replace best-effort debounced writes with synchronous transactional writes; add idempotency expiry/operation/tenant; stop exporting mutable state |
| `src/storage/postgres.js` | High | Wire up or replace: UUID/TIMESTAMPTZ, indexes, unique constraints, hashed/encrypted secrets, `delivery_attempts`, `outbox_events`, claim/lease columns, migration SQL |
| `src/worker.js` | High | Concurrency + `SKIP LOCKED` claiming, cross-process lease recovery, spec-compliant retry defaults, delivery-time SSRF re-check, per-endpoint concurrency, dead-letter table |
| `src/security.js` | High | Delivery-time DNS/IP re-check, encrypted secret storage, keyed API-key hashing, rotation overlap model |
| `src/metrics.js` | Medium | Add missing spec 13.2 metrics, outcome/error_class dimensions, OpenTelemetry hooks |
| `tests/` | High | Add unit (retry, signing, idempotency, state machine, URL validation), integration (real PostgreSQL), e2e (mock receiver), failure-injection suite |
| `docs/CHECKLIST.md` | Medium | Update to reflect corrected findings (e.g., constant-time compare is actually implemented) |

---

## 7. Suggested execution order (next 30 days)

1. **Week 1**: Stack decision + security fixes (SSRF re-check, secret storage, key hashing) + Milestone 0 scaffolding (Go module, Docker Compose, migrations, CI).
2. **Week 2**: Milestone 1 (organizations, API keys, auth middleware, event ingestion, idempotency, endpoint CRUD).
3. **Week 3**: Milestone 2 (outbox, worker, safe claiming, HTTP client, attempt history, state machine).
4. **Week 4**: Milestone 3 (retry/jitter, lease recovery, dead-letter, replay, rate limiting, SSRF) + failure-injection tests.

---

## 8. How to use this report

- `docs/CHECKLIST.md` - existing companion checklist; update its "Status" column using the gap analysis in Section 3.
- `docs/AUDIT_REPORT.md` (this file) - keep as the authoritative audit baseline; re-audit after each milestone.
- `SIGNALMESH_SPEC.md` section 18 acceptance criteria - the Definition of Done for the MVP; check off only after automated evidence exists.
