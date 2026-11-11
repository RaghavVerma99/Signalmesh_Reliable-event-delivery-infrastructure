# SignalMesh - Audit and Delivery Checklist

Companion to SIGNALMESH_SPEC.md. Audits the current MVP implementation and tracks what remains to be done to reach the end-product goal and the MVP acceptance criteria.

- Spec version: 1.0 (PRD + SRS + Technical Design)
- End product goal: SignalMesh is a self-hostable, observable, fault-tolerant webhook delivery engine for developers who need reliable event delivery without building the mechanism themselves.
- Last audit: 2026-11-08

## 1. Audit snapshot - current implementation vs. spec

| Area | Status | Notes |
|---|---|---|
| Stack vs. spec | Warning | Node.js 26 + Express 4 (MVP). Spec prescribes Go + PostgreSQL + Docker Compose. Deviation to resolve. |
| API surface | Partial | Keys bootstrap, events, deliveries, endpoints (no PATCH), replay/cancel, demo receivers. No revoke route. |
| Persistence | Partial | JSON file (data/db.json), debounced writes, best-effort. Spec NFR-001 wants durable commit before 202. |
| Delivery engine | Partial | Single worker, 1s poll, one delivery/tick, in-process lease. Retry defaults deviate from spec suggestions. |
| Security | Partial | SSRF blocklist at registration + delivery-time re-check; redirects disabled; constant-time signature compare implemented; response-size cap; encrypted signing secrets; key revocation exists. Still missing: rate limiting, API-key pepper in prod config, audit logging. |
| Observability | Missing | JSON logs ok; no Prometheus metrics, no OTel, no worker heartbeat/ready check. |
| Tests / CI / DX | Missing | No tests, no CI workflow, no Docker, no OpenAPI, no CLI/SDK/dashboard. |

## 2. End-product acceptance criteria - master checklist (SPEC section 18)

- [ ] A producer can authenticate and submit an event.
- [ ] SignalMesh persists the event and initial delivery work atomically.
- [ ] SignalMesh returns an event ID and does not wait for destination delivery.
- [ ] An event can fan out to multiple endpoints.
- [ ] Workers can process jobs concurrently without conflicting claims.
- [ ] Duplicate ingestion with the same idempotency key does not create a second event.
- [ ] Reuse of an idempotency key with a different payload returns a conflict.
- [ ] Outbound requests include verifiable HMAC signatures.
- [ ] Timeouts and retryable failures are retried according to policy.
- [ ] Retry scheduling survives restarts.
- [ ] Worker crashes are recovered through lease expiry.
- [ ] Exhausted deliveries become dead-lettered.
- [ ] Operators can inspect attempts and replay failed deliveries.
- [ ] Tenant isolation is covered by automated tests.
- [ ] SSRF protections are implemented and tested.
- [ ] Health, readiness, logs, and metrics are available.
- [ ] Docker Compose starts a working local environment.
- [ ] Integration and end-to-end tests pass.
- [ ] README explains guarantees, limitations, setup, and example integration.

## 3. MVP scope checklist - SPEC section 4.1

- [x] API-key authentication - Auth implemented; revoke route present; scopes/rotation exposure still missing.
- [ ] Tenant/organization isolation - Missing.
- [x] Event ingestion - Implemented.
- [ ] Event persistence - JSON-file store (not PostgreSQL).
- [ ] Endpoint registration and management - Missing PATCH endpoint.
- [x] Event-type subscriptions - Implemented (* wildcard supported).
- [ ] Delivery creation and dispatch - No transactional outbox pattern.
- [ ] PostgreSQL-backed worker scheduling - Missing.
- [ ] Configurable concurrency - Missing (single worker today).
- [x] HTTP timeouts - Implemented (10s default, env-configurable).
- [ ] Bounded retry with exponential backoff and jitter - Defaults now aligned to spec (8 attempts, 2s base, 1h cap); configurable via env.
- [x] HMAC-SHA256 webhook signatures - Constant-time comparison implemented (`timingSafeEqual`); signed over `timestamp.body`.
- [x] Delivery and attempt history - Implemented.
- [x] Dead-letter state - Implemented.
- [x] Manual replay - Implemented; audit fields partial.
- [ ] Basic rate limiting - Missing.
- [ ] Structured logs - Partial.
- [ ] Prometheus metrics - Partial (`/metrics` with core counters/gauges/histogram).
- [ ] Health and readiness endpoints - Partial (no dependency checks / heartbeat).
- [ ] Docker Compose deployment - Missing.
- [ ] Unit and integration tests - Unit tests added (11 passing); integration/e2e missing.

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

Remaining before feature work:

- [ ] Add API-key pepper + encryption key to production config validation / docs.
- [ ] Enforce connected-IP check (not just resolved IP) for full DNS-rebinding defense.
- [ ] Add tenant scoping so keys cannot see each other's data.
- [ ] Repair and wire `src/storage/postgres.js` with migrations + indexes.