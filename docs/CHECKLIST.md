# SignalMesh - Delivery Checklist

Companion to `SIGNALMESH_SPEC.md`. Tracks what is done, what remains for the
end-product goal, and what remains for a hosted SaaS offering.

- Spec version: 1.0 (PRD + SRS + Technical Design)
- End product goal: SignalMesh is a self-hostable, observable, fault-tolerant webhook delivery engine for developers who need reliable event delivery without building the mechanism themselves.
- Last audit: 2026-11-12
- Product/SaaS roadmap: [`SAAS_READINESS_AUDIT.md`](./SAAS_READINESS_AUDIT.md)

## 1. Audit snapshot - current implementation vs. spec

| Area | Status | Notes |
|---|---|---|
| Stack vs. spec | Accepted deviation | Node.js + Express retained by decision; PostgreSQL is the durable store. Spec's Go prescription is intentionally not followed (see `NODE_STRATEGY.md`). |
| API surface | Done | Keys bootstrap/list/revoke + **scopes**, events, deliveries, endpoints incl. PATCH, replay/cancel, **attempt history**, audit, demo receivers. |
| Persistence | Done | JSON (dev) or PostgreSQL (atomic ingest transaction, indexes, constraints, idempotency TTL **enforced**). |
| Delivery engine | Done | Concurrent claims, Postgres `FOR UPDATE SKIP LOCKED`, lease expiry + stale-worker guard + **lease renewal**, attempt history, configurable concurrency. |
| Security | Done (with known limits) | SSRF blocklist + delivery-time re-check + connection-time validating DNS lookup; redirects disabled; constant-time signature compare; response cap; encrypted secrets; keyed key hashing; **enforced key scopes**; tenant rate limiting; audit log. |
| Observability | Partial | Structured JSON logs, Prometheus `/metrics`, `/readyz`, **worker heartbeat + `/healthz/workers`**. Remaining: metric labels, OpenTelemetry. |
| Tests / CI / DX | Partial | 34 tests + PG integration (CI), GitHub Actions, Dockerfile + Compose, dashboard, seed/demo scripts, OpenAPI. Remaining: lint, coverage floor, SAST, secret scan, load tests, SDK/CLI. |

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
- [x] SSRF protections are implemented and tested (delivery-time re-check + connection-time validating DNS lookup).
- [x] Health, readiness, logs, and metrics are available.
- [x] Docker Compose starts a working local environment.
- [x] Integration and end-to-end tests pass.
- [x] README explains guarantees, limitations, setup, and example integration.

## 3. MVP scope checklist - SPEC section 4.1

- [x] API-key authentication - Auth, list, revoke. Scopes stored **and enforced**.
- [x] Tenant/organization isolation - Implemented and tested.
- [x] Event ingestion - Implemented.
- [x] Event persistence - JSON (dev) or PostgreSQL (durable, atomic).
- [x] Endpoint registration and management - Full CRUD incl. PATCH.
- [x] Event-type subscriptions - Implemented (* wildcard supported).
- [x] Delivery creation and dispatch - Atomic transaction in PostgreSQL. Outbox table still not used (deliveries are written transactionally instead).
- [x] PostgreSQL-backed worker scheduling - Implemented with `SKIP LOCKED`.
- [x] Configurable concurrency - `SIGNALMESH_WORKER_CONCURRENCY`.
- [x] HTTP timeouts - Implemented, capped by `SIGNALMESH_MAX_ENDPOINT_TIMEOUT_MS`.
- [x] Bounded retry with exponential backoff and jitter - Spec-aligned defaults, env-configurable, per-endpoint attempt cap.
- [x] HMAC-SHA256 webhook signatures - Constant-time comparison (`timingSafeEqual`); signed over `timestamp.body`.
- [x] Delivery and attempt history - Implemented and **readable via API**.
- [x] Dead-letter state - Implemented.
- [x] Manual replay - Implemented with audit record.
- [x] Basic rate limiting - Tenant token bucket, `429` + `Retry-After`. **In-process only.**
- [x] Structured logs - JSON logs with request/org IDs, level-controlled.
- [x] Prometheus metrics - `/metrics` with counters/gauges/histogram. **No labels yet.**
- [x] Health and readiness endpoints - `/readyz` checks storage; `/healthz/workers` reports worker liveness.
- [x] Docker Compose deployment - All-in-one + split profile.
- [x] Unit and integration tests - 34 passing + PostgreSQL integration in CI.

## 4. Milestone checklists - SPEC section 17

### Milestone 0 - Project foundation
- [ ] Go module and repo conventions - Node MVP instead (decision recorded in `NODE_STRATEGY.md`).
- [x] Configuration loader - `src/config.js`, env-driven with defaults.
- [x] PostgreSQL Docker Compose service - Present.
- [x] Migration framework - `src/storage/migrate.js`, advisory-locked + transactional, tracked in `schema_migrations`.
- [x] Health endpoint - `/healthz` + `/readyz` + `/healthz/workers`.
- [x] CI workflow - GitHub Actions: Node 22/24 matrix, PostgreSQL service, Docker build.
- [ ] Lint / format / type-check gate - **Not built. See audit section 4.3.**
- [ ] Done when: new developer can clone and start API + database via documented commands. *(Effectively done; formally re-verified by a newcomer.)*

### Milestone 1 - Durable ingestion
- [x] Organization and API-key model - `organizations` + `api_keys` with `organization_id` scoping.
- [x] Authentication middleware - Bearer token, `401`/`403`, tenant-scoped, scope-enforced.
- [x] Event ingestion endpoint - `POST /v1/events`, `202 Accepted`, `event_type` required, body-size limit.
- [x] Idempotency - TTL **enforced**, fingerprint conflict, tenant+operation scoped, DB unique constraint, expired records swept.
- [x] Event persistence - PostgreSQL transaction; JSON sync flush.
- [x] Endpoint and subscription CRUD - Full CRUD incl. PATCH, soft delete.
- [x] Done when: accepted events survive restart; duplicate submissions obey the idempotency contract.

### Milestone 2 - Delivery engine
- [x] Delivery creation and transaction - Event + deliveries committed atomically. *Outbox table not used.*
- [x] Worker executable with safe job claiming - Separate process, `SKIP LOCKED`, lease + stale-worker guard.
- [x] HTTP client with timeouts - Bounded timeout, `redirect: manual`, response-body cap, validating DNS lookup.
- [x] Attempt history - `delivery_attempts` table **and API**.
- [x] Success/failure state transitions - Explicit state machine.
- [x] Done when: one event to multiple endpoints with isolated failures.

### Milestone 3 - Reliability
- [x] Retry policy and jitter - Spec-aligned defaults, env-configurable, `Retry-After` respected within bounds.
- [x] Lease recovery - Cross-process lease expiry + stale-worker guard + **lease renewal during long attempts**.
- [x] Dead-letter handling - State, preserved attempt history, list/detail API.
- [x] Replay - Re-queue with a linked new delivery and an audit record.
- [x] HMAC signatures - Constant-time verification, secret rotation overlap.
- [x] Rate limiting - Tenant token bucket, `429` + `Retry-After`. *Shared limiter still missing.*
- [x] SSRF protections - Registration + delivery-time + connection-time checks; tests present.
- [ ] Failure-injection suite - **Not built. See audit section 4.2.**

### Milestone 4 - Operability
- [x] Structured logs - JSON logs with request/org IDs, level-controlled, component tag.
- [x] Prometheus metrics - `/metrics` with counters/gauges/histogram. *Labels missing.*
- [ ] OpenTelemetry instrumentation - **Not built.**
- [x] Graceful shutdown - Stops claiming, drains in-flight work, closes the store.
- [x] Operational docs - Retention + sweep configuration, `SECURITY.md`, `CONTRIBUTING.md`.
- [ ] Backup/restore procedure - **Not written.** See audit section 5.
- [ ] SLOs / error budgets / alerts - **Not defined.** See audit section 5.

### Milestone 5 - Developer experience
- [x] OpenAPI specification - `api/openapi.yaml`.
- [ ] CLI or SDK - **Not built.** See audit section 5, Sprint 0.
- [x] Example producer / receiver with signature verification - Demo receivers + smoke script.
- [ ] Optional dashboard - Demo-only, unauthenticated, disabled in production. **A real dashboard is required for a hosted offering.**
- [ ] Done when: external developer integrates without reading internal source.

## 5. Hosted SaaS checklist (new - see `SAAS_READINESS_AUDIT.md`)

- [ ] User accounts: signup, login, sessions, email verification, password reset.
- [ ] Organization management: create, members, invites, roles.
- [ ] Billing: plans, trials, Stripe, subscriptions, dunning, invoices.
- [ ] Usage metering + per-tenant quotas with server-side enforcement.
- [ ] Customer-visible usage endpoint.
- [ ] Authenticated product dashboard (events, deliveries, attempts, DLQ, replay).
- [ ] Email notifications (dead-letter, endpoint health, quota warnings).
- [ ] Onboarding flow + endpoint verification handshake.
- [ ] Node + Python SDKs.
- [ ] Docs site with quickstart and rendered API reference.
- [ ] Shared (multi-replica) rate limiter.
- [ ] Per-endpoint concurrency limits + circuit breaker.
- [ ] Fair tenant scheduling.
- [ ] Metric labels + OpenTelemetry.
- [ ] Load harness with published targets; failure-injection suite.
- [ ] SLOs, error budgets, burn-rate alerts, runbooks.
- [ ] Backup/restore drill; PITR.
- [ ] Lint, coverage floor, SAST, secret scan, container scan in CI.
- [ ] Release process: semver, changelog, signed images, provenance.
- [ ] `LICENSE`, `CODEOWNERS`, `CODE_OF_CONDUCT`.
- [ ] Self-serve data export and deletion.

## 6. Post-MVP enhancements - SPEC section 4.2 (unchecked backlog)

- [ ] Redis-backed rate limiting or scheduling acceleration.
- [ ] Go client SDK.
- [ ] CLI for endpoint testing and event replay.
- [ ] Dashboard for event and delivery inspection.
- [ ] OpenTelemetry distributed traces.
- [ ] Per-endpoint concurrency limits.
- [ ] Circuit breaker.
- [ ] Event retention and archival policies. *(Basic retention sweep implemented; archival still open.)*
- [ ] Multiple worker replicas. *(Mechanically supported; not yet load-tested.)*
- [ ] API versioning and schema validation. *(Path versioning only; no JSON Schema validation.)*
- [ ] Webhook endpoint verification handshake.
- [ ] Tenant usage quotas.
- [ ] Managed hosted version.

## 7. Explicitly deferred - SPEC section 4.3 (accepted backlog)

- [ ] Do not add Kubernetes, Kafka, microservices, complex React dashboard, billing, or multi-region infrastructure before the single-node durable delivery path is correct and tested.
  - *Note: for a hosted SaaS offering, billing and a dashboard are no longer "deferred" - they are prerequisites. That is a positioning decision, see `SAAS_READINESS_AUDIT.md` section 7.*

## 8. Open design decisions / stop-and-ask items - SPEC sections 19.5 and 21

- [x] Language/runtime end-state - Node, decided (see `NODE_STRATEGY.md`).
- [x] PostgreSQL adoption timeline - Adopted; JSON is a dev-only fallback.
- [x] Tenant model and isolation approach - Row-level `organization_id` on every table.
- [x] Default idempotency retention period - 24h, configurable, now enforced.
- [x] Final retry defaults - max 8 attempts, base 2s, max 1h, timeout 10s; env-configurable.
- [x] Replay semantics - New delivery linked to the original, with an audit record.
- [x] SSRF re-check strategy - Resolve + validate the connected IP at delivery time.
- [ ] **New:** Hosted SaaS vs. self-host-only. **Blocks the entire SaaS track.**
- [ ] **New:** License choice. **No `LICENSE` file exists.**
- [ ] **New:** Billing provider and usage-based vs. seat-based.
- [ ] **New:** Auth model for hosted accounts (email/OAuth vs. API-key-only).
- [ ] **New:** Multi-region - confirm it stays deferred until single-region has a measured SLO.
