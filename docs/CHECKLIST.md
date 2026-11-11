# SignalMesh - Audit and Delivery Checklist

Companion to SIGNALMESH_SPEC.md. Audits the current MVP implementation and tracks what remains to be done to reach the end-product goal and the MVP acceptance criteria.

- Spec version: 1.0 (PRD + SRS + Technical Design)
- End product goal: SignalMesh is a self-hostable, observable, fault-tolerant webhook delivery engine for developers who need reliable event delivery without building the mechanism themselves.
- Last audit: 2026-11-08

## 1. Audit snapshot - current implementation vs. spec

| Area | Status | Notes |
|---|---|---|
| Stack vs. spec | Accepted deviation | Node.js + Express retained by decision; PostgreSQL is the durable store. Spec's Go prescription is intentionally not followed (see NODE_STRATEGY.md). |
| API surface | Done | Keys bootstrap/list/revoke, events, deliveries, endpoints incl. PATCH, replay/cancel, audit, demo receivers. |
| Persistence | Done | JSON (dev) or PostgreSQL (atomic ingest transaction, indexes, constraints, idempotency TTL). |
| Delivery engine | Done | Concurrent claims, Postgres `FOR UPDATE SKIP LOCKED`, lease expiry + stale-worker guard, attempt history, configurable concurrency. |
| Security | Partial | SSRF blocklist + delivery-time re-check; redirects disabled; constant-time signature compare; response cap; encrypted secrets; keyed key hashing; tenant rate limiting; audit log. Remaining: connected-IP validation, secret rotation. |
| Observability | Partial | Structured JSON logs, Prometheus `/metrics`, `/readyz` storage check. Remaining: OTel, worker heartbeat. |
| Tests / CI / DX | Partial | 18 unit/integration tests + PG integration (CI), GitHub Actions, Dockerfile + Compose, dashboard, seed/demo scripts. Remaining: OpenAPI, SDK/CLI, load tests. |

## 2. End-product acceptance criteria - master checklist (SPEC section 18)

- [x] A producer can authenticate and submit an event.
- [x] SignalMesh persists the event and initial delivery work atomically (PostgreSQL transaction; JSON sync flush).
- [x] SignalMesh returns an event ID and does not wait for destination delivery.
- [x] An event can fan out to multiple endpoints.
- [x] Workers can process jobs concurrently without conflicting claims (PostgreSQL `FOR UPDATE SKIP LOCKED`).
- [x] Duplicate ingestion with the same idempotency key does not create a second event.
- [x] Reuse of an idempotency key with a different payload returns a conflict.
- [x] Outbound requests include verifiable HMAC signatures.
- [x] Timeouts and retryable failures are retried according to policy.
- [x] Retry scheduling survives restarts (PostgreSQL).
- [x] Worker crashes are recovered through lease expiry.
- [x] Exhausted deliveries become dead-lettered.
- [x] Operators can inspect attempts and replay failed deliveries.
- [x] Tenant isolation is covered by automated tests.
- [ ] SSRF protections are implemented and tested (delivery-time re-check done; connected-IP validation + dedicated tests pending).
- [x] Health, readiness, logs, and metrics are available.
- [x] Docker Compose starts a working local environment.
- [x] Integration and end-to-end tests pass.
- [x] README explains guarantees, limitations, setup, and example integration.

## 3. MVP scope checklist - SPEC section 4.1

- [x] API-key authentication - Auth, list, revoke; scopes stored (rotation exposure still missing).
- [x] Tenant/organization isolation - Implemented and tested.
- [x] Event ingestion - Implemented.
- [x] Event persistence - JSON (dev) or PostgreSQL (durable, atomic).
- [x] Endpoint registration and management - Full CRUD incl. PATCH.
- [x] Event-type subscriptions - Implemented (* wildcard supported).
- [ ] Delivery creation and dispatch - Atomic transaction in PostgreSQL; outbox table not used yet.
- [x] PostgreSQL-backed worker scheduling - Implemented with `SKIP LOCKED`.
- [x] Configurable concurrency - `SIGNALMESH_WORKER_CONCURRENCY`.
- [x] HTTP timeouts - Implemented (10s default, env-configurable).
- [x] Bounded retry with exponential backoff and jitter - Spec-aligned defaults, env-configurable.
- [x] HMAC-SHA256 webhook signatures - Constant-time comparison (`timingSafeEqual`); signed over `timestamp.body`.
- [x] Delivery and attempt history - Implemented.
- [x] Dead-letter state - Implemented.
- [x] Manual replay - Implemented with audit record.
- [x] Basic rate limiting - Tenant token bucket, `429` + `Retry-After`.
- [x] Structured logs - JSON logs with request/org IDs.
- [x] Prometheus metrics - `/metrics` with counters/gauges/histogram.
- [x] Health and readiness endpoints - `/readyz` checks storage.
- [x] Docker Compose deployment - All-in-one + split profile.
- [x] Unit and integration tests - 18 passing + PostgreSQL integration in CI.

## 4. Milestone checklists - SPEC section 17

### Milestone 0 - Project foundation
- [ ] Go module and repo conventions - Node MVP instead (decision pending).
- [ ] Configuration loader - Inline env reads today.
- [ ] PostgreSQL Docker Compose service - Missing.
- [ ] Migration framework - Missing.
- [ ] Health endpoint - Done.
- [ ] CI formatting and test workflow - Missing.
- [ ] Done when: new developer can clone and start API + database via documented commands.

### Milestone 1 - Durable ingestion
- [ ] Organization and API-key model - Missing.
- [ ] Authentication middleware - Partial.
- [ ] Event ingestion endpoint - Done.
- [ ] Idempotency handling - No retention expiry.
- [ ] Event persistence - JSON store.
- [ ] Endpoint and subscription CRUD - No PATCH.
- [ ] Done when: accepted events survive restart; duplicate submissions behave per idempotency contract.

### Milestone 2 - Delivery engine
- [ ] Delivery creation and outbox transaction - Missing.
- [ ] Worker executable with safe job claiming - Single-process only.
- [ ] HTTP client with timeouts - Done.
- [ ] Attempt history - Done.
- [ ] Success/failure state transitions - Done.
- [ ] Done when: one event to multiple endpoints with isolated failures.

### Milestone 3 - Reliability
- [ ] Retry policy and jitter - Defaults now aligned to spec and env-configurable; retry tests added.
- [ ] Lease recovery - In-process only.
- [x] Dead-letter handling - Done.
- [x] Replay - Done.
- [x] HMAC signatures - Implemented with constant-time verification.
- [ ] Rate limiting - Missing.
- [ ] SSRF protections - Registration + delivery-time blocklist/re-check done; DNS-rebinding-aware connected-IP check and tests still needed.
- [ ] Done when: documented failure-injection suite passes.

### Milestone 4 - Operability
- [ ] Structured logs - Partial.
- [ ] Prometheus metrics - Missing.
- [ ] OpenTelemetry instrumentation - Missing.
- [ ] Graceful shutdown - Done.
- [ ] Operational documentation/backup-restore - Missing.

### Milestone 5 - Developer experience
- [ ] OpenAPI specification - Missing.
- [ ] CLI or SDK - Missing.
- [ ] Example producer / receiver with signature verification - Demo receivers exist.
- [ ] Optional dashboard - Missing.
- [ ] Done when: external developer can integrate without reading internal source.

## 5. Post-MVP enhancements - SPEC section 4.2 (unchecked backlog)

- [ ] Redis-backed rate limiting or scheduling acceleration.
- [ ] Go client SDK.
- [ ] CLI for endpoint testing and event replay.
- [ ] Dashboard for event and delivery inspection.
- [ ] OpenTelemetry distributed traces.
- [ ] Per-endpoint concurrency limits.
- [ ] Circuit breaker.
- [ ] Event retention and archival policies.
- [ ] Multiple worker replicas.
- [ ] API versioning and schema validation.
- [ ] Webhook endpoint verification handshake.
- [ ] Tenant usage quotas.
- [ ] Managed hosted version.

## 6. Explicitly deferred - SPEC section 4.3 (accepted backlog)

- [ ] Do not add Kubernetes, Kafka, microservices, complex React dashboard, billing, or multi-region infrastructure before the single-node durable delivery path is correct and tested.

## 7. Open design decisions / stop-and-ask items - SPEC sections 19.5 and 21

- [ ] Language/runtime end-state (Node MVP now vs. Go prescribed by spec).
- [ ] PostgreSQL adoption timeline and job-queue mechanism.
- [ ] Tenant model and isolation approach.
- [ ] Default idempotency retention period.
- [ ] Final retry defaults (spec suggests max 8 attempts, base 2s, max 1h, timeout 10s).
- [ ] Replay semantics: new delivery generation vs. linked generation (MVP creates new delivery).
- [ ] SSRF: DNS re-check strategy at delivery time.

## 8. Recommended next tasks (priority order)

1. Security hardening - SSRF protections, disable redirects, constant-time signature compare, response-size limits, key revocation, secret handling.
2. Test foundation - unit then retry/backoff, signing, idempotency, state machine; then integration and e2e.
3. Observability - Prometheus metrics, structured log correlation, health/ready/heartbeat.
4. Ops and DX scaffolding - Docker Compose, CI, config loader, .env.example, OpenAPI, docs.
5. Delivery engine maturity - outbox, PostgreSQL scheduling, safe claims, concurrency.
6. Product completeness - PATCH endpoint, rate limiting, audit logging, idempotency expiry, cursor pagination, replay audit.

## 9. Node.js continuation + Phase 1 status (2026-11-11)

Decision: continue on Node.js; PostgreSQL is the target durable store (JSON remains local-dev fallback). See `docs/NODE_STRATEGY.md`.

Phase 1 security fixes completed in this pass:

- [x] Delivery-time SSRF re-check in worker (`recheckDeliveryDestination`).
- [x] Signing secrets encrypted at rest (AES-256-GCM; `plain:` dev fallback; `enc:` stored form).
- [x] API-key hashing switched to keyed HMAC-SHA256 with `SIGNALMESH_API_KEY_PEPPER`.
- [x] Constant-time signature comparison confirmed + tested.
- [x] Response-body cap enforced in worker excerpt.
- [x] Durable persist before `202 Accepted` (`persistSync`, returns `503` if persist fails).
- [x] Retry/timeout defaults aligned to spec and env-configurable.
- [x] Test script added (`npm test`) - 11 tests passing.
- [x] `.env.example` and end-to-end smoke script (`scripts/smoke.js`).

Phase 1 previously-implemented items now extended in Section 10 (tenant scoping, PostgreSQL wiring). Remaining security follow-ups:

- [ ] Enforce connected-IP check (not just resolved IP) for full DNS-rebinding defense.
- [ ] Secret-rotation overlap window.

## 10. Implementation pass 2 (2026-11-11) - roadmap items completed

- [x] **Tenant isolation** - `organizations` + `organization_id` scoping on every table/query; bootstrap creates the first org; tests in `tests/store.test.js` and `tests/api.test.js`.
- [x] **PostgreSQL + migrations** - `src/storage/migrations/001_init.sql`, `src/storage/migrate.js`, `npm run migrate`; atomic `ingestEvent`, `FOR UPDATE SKIP LOCKED` claiming, lease + stale-worker guard, attempt history.
- [x] **Rate limiting** - `src/ratelimit.js` tenant token bucket; `429` + `Retry-After`; `tests/ratelimit.test.js`.
- [x] **Audit logging** - append-only audit log, `GET /v1/audit`, tenant scoped.
- [x] **API/worker split** - `src/api.js`, `src/worker-main.js`, `SIGNALMESH_ROLE`, `npm run start:api` / `start:worker`, Compose `split` profile.
- [x] **PATCH endpoint + cursor pagination** - `PATCH /v1/endpoints/:id`; `cursor` on events/deliveries.
- [x] **Tests + CI** - 18 passing unit/integration tests + conditional PostgreSQL integration; `.github/workflows/ci.yml` (Node 22/24, PostgreSQL service, Docker build).

Outstanding from the spec: connected-IP SSRF validation, outbox-table usage, OpenTelemetry, secret rotation, load/failure-injection benchmarks, OpenAPI/SDK/CLI.