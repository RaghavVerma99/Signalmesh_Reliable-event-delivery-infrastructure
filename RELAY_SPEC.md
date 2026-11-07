# Relay

## Technical Product Requirements & System Design Specification

**Document type:** Product Requirements Document (PRD) + Software
Requirements Specification (SRS) + Technical Design\
**Version:** 1.0\
**Status:** Proposed MVP specification\
**Primary implementation language:** Go\
**Database:** PostgreSQL\
**Deployment target:** Docker Compose for local development;
containerized Linux deployment for production\
**Audience:** Backend engineers, implementation agents/LLMs, reviewers,
and contributors

------------------------------------------------------------------------

# 1. Executive Summary

Relay is a self-hostable webhook event delivery platform. It accepts
events from producer applications, persists them durably, fans them out
to configured HTTP endpoints, retries transient failures, records
delivery attempts, and provides replay and inspection capabilities.

Relay addresses a recurring integration problem: applications need to
notify other systems when business events occur, but remote endpoints
can be unavailable, slow, rate-limited, misconfigured, or unreliable. A
basic HTTP request from one service to another is not sufficient when
the sender needs durable delivery, retry control, observability, and
operational recovery.

Relay is designed as a focused, developer-oriented infrastructure
product. Its core promise is:

> Accept an event durably, attempt delivery according to an explicit
> policy, preserve an auditable delivery history, and give operators
> safe tools to inspect and recover failures.

Relay does **not** promise exactly-once delivery over HTTP. The initial
delivery guarantee is **at-least-once**, subject to configured retry
limits and retention policies. Consumers must use event identifiers and
idempotent processing to avoid duplicate business effects.

## 1.1 Product goals

1.  Provide a simple authenticated API for event ingestion.
2.  Persist accepted events before returning a success response.
3.  Deliver events to one or more subscribed HTTP endpoints.
4.  Isolate failures between endpoints.
5.  Retry transient failures with bounded exponential backoff and
    jitter.
6.  Provide delivery history, replay, cancellation, and dead-letter
    handling.
7.  Support secure webhook signing and receiver-side verification
    guidance.
8.  Make the system operable through structured logs, metrics, traces,
    and health endpoints.
9.  Be easy to run locally and self-host using Docker Compose.
10. Demonstrate production-relevant backend engineering: concurrency,
    transactions, scheduling, fault tolerance, security, and
    observability.

## 1.2 Non-goals for the initial release

-   Exactly-once delivery across arbitrary HTTP receivers.
-   A general-purpose event streaming platform or Kafka replacement.
-   Arbitrary workflow orchestration.
-   A visual no-code integration builder.
-   Guaranteed global ordering across all events.
-   Multi-region active-active deployment.
-   Enterprise SSO, complex billing, or advanced organization hierarchy.
-   A hosted multi-tenant SaaS control plane in the first milestone.
-   Guaranteed delivery when Relay's own durable storage is permanently
    lost.

------------------------------------------------------------------------

# 2. Terminology

  -----------------------------------------------------------------------
  Term                                Definition
  ----------------------------------- -----------------------------------
  Producer                            Application that sends an event to
                                      Relay.

  Event                               Immutable business fact submitted
                                      to Relay, such as
                                      `payment.succeeded`.

  Endpoint                            Destination HTTP URL registered to
                                      receive selected event types.

  Subscription                        Association between an endpoint and
                                      one or more event types.

  Delivery                            Relay's attempt lifecycle for
                                      sending one event to one endpoint.

  Attempt                             One individual HTTP request made
                                      for a delivery.

  Worker                              Background process that claims and
                                      executes deliveries.

  Retry                               A later attempt after a retryable
                                      failure.

  Dead-letter                         A delivery that exhausted its retry
                                      policy or was permanently rejected.

  Replay                              Operator-triggered re-queuing of a
                                      failed delivery or event.

  Idempotency key                     Client-provided key used to prevent
                                      duplicate event creation within a
                                      defined scope and retention period.

  Transactional outbox                Database-backed record of work to
                                      be dispatched, written atomically
                                      with related business data.

  Lease                               Time-limited ownership of a claimed
                                      job, allowing recovery if a worker
                                      crashes.

  Tenant                              An isolated customer or
                                      organization using a Relay
                                      installation.
  -----------------------------------------------------------------------

------------------------------------------------------------------------

# 3. Users and Use Cases

## 3.1 Primary user personas

### Application developer

-   Integrates Relay into an application.
-   Creates endpoints and subscriptions.
-   Sends business events.
-   Needs clear API responses and SDK/CLI support.

### Backend/platform engineer

-   Operates Relay.
-   Investigates failed deliveries.
-   Adjusts retry policies and rate limits.
-   Needs metrics, logs, and reliable recovery.

### Integration consumer developer

-   Receives webhooks.
-   Verifies signatures.
-   Handles duplicate deliveries.
-   Needs stable event schemas and replay-safe processing guidance.

## 3.2 Core use cases

1.  A payment service submits `payment.succeeded`.
2.  Relay stores the event and creates one delivery per matching
    endpoint.
3.  Workers deliver the event concurrently.
4.  One endpoint returns HTTP 200 and becomes delivered.
5.  Another endpoint times out and is retried later.
6.  A third endpoint repeatedly fails and becomes dead-lettered.
7.  An operator inspects the failed delivery and its attempt history.
8.  After fixing the destination, the operator replays the delivery.
9.  A producer retries event ingestion after a network timeout using the
    same idempotency key.
10. Relay returns the original event result instead of creating a
    duplicate event.

------------------------------------------------------------------------

# 4. Scope and Release Plan

## 4.1 MVP scope

The MVP must include:

-   API-key authentication.
-   Tenant/organization isolation.
-   Event ingestion.
-   Event persistence.
-   Endpoint registration and management.
-   Event-type subscriptions.
-   Delivery creation and dispatch.
-   PostgreSQL-backed worker scheduling.
-   Configurable concurrency.
-   HTTP timeouts.
-   Bounded retry with exponential backoff and jitter.
-   HMAC-SHA256 webhook signatures.
-   Delivery and attempt history.
-   Dead-letter state.
-   Manual replay.
-   Basic rate limiting.
-   Structured logs.
-   Prometheus metrics.
-   Health and readiness endpoints.
-   Docker Compose deployment.
-   Unit and integration tests.

## 4.2 Post-MVP enhancements

-   Redis-backed rate limiting or scheduling acceleration.
-   Go client SDK.
-   CLI for endpoint testing and event replay.
-   Dashboard for event and delivery inspection.
-   OpenTelemetry distributed traces.
-   Per-endpoint concurrency limits.
-   Circuit breaker.
-   Event retention and archival policies.
-   Multiple worker replicas.
-   API versioning and schema validation.
-   Webhook endpoint verification handshake.
-   Tenant usage quotas.
-   Managed hosted version.

## 4.3 Explicitly defer

Do not add Kubernetes, Kafka, microservices, a complex React dashboard,
billing, or multi-region infrastructure before the single-node durable
delivery path is correct and tested.

------------------------------------------------------------------------

# 5. System Context and High-Level Architecture

## 5.1 Logical architecture

``` text
                  +-----------------------+
                  |   Producer Application|
                  +-----------+-----------+
                              |
                       HTTPS / JSON
                              |
                  +-----------v-----------+
                  |       Relay API       |
                  | Auth / Validation     |
                  | Event Ingestion       |
                  | Endpoint Management   |
                  +-----------+-----------+
                              |
                    PostgreSQL transaction
                              |
              +---------------+----------------+
              |                                |
      +-------v--------+               +-------v--------+
      | events         |               | outbox_events  |
      +----------------+               +-------+--------+
                                               |
                                      Dispatcher / Claim
                                               |
                                      +--------v--------+
                                      | Delivery Workers|
                                      | HTTP client     |
                                      | Signatures      |
                                      | Retry policy    |
                                      +--------+--------+
                                               |
                               +---------------+----------------+
                               |               |                |
                         +-----v----+     +----v-----+     +----v-----+
                         |Endpoint A|     |Endpoint B|     |Endpoint C|
                         +----------+     +----------+     +----------+
                               |
                         Attempt results
                               |
                      +--------v---------+
                      | PostgreSQL       |
                      | deliveries       |
                      | attempts         |
                      | dead_letters     |
                      +------------------+

              +--------------------------------------+
              | Metrics / Logs / Traces / Dashboard  |
              +--------------------------------------+
```

## 5.2 Recommended deployment topology

For the MVP, use a modular monolith with two executable processes:

1.  `relay-api`: handles public and administrative HTTP requests.
2.  `relay-worker`: claims and executes scheduled deliveries.

Both processes share one PostgreSQL database. They may be deployed as
separate containers and scaled independently.

This is intentionally not a microservices architecture. A modular
monolith reduces operational complexity while preserving clear domain
boundaries.

## 5.3 Core processing flow

1.  Producer authenticates using an API key.
2.  API validates payload size, event type, idempotency key, and tenant
    limits.
3.  API begins a database transaction.
4.  API inserts the event.
5.  API resolves active endpoint subscriptions.
6.  API creates delivery records and outbox work records.
7.  API commits the transaction.
8.  API returns `202 Accepted` with the event identifier and delivery
    summary.
9.  Worker claims due work using a safe database locking strategy.
10. Worker sends the HTTP request with a bounded timeout and signature
    headers.
11. Worker records the attempt outcome.
12. On success, delivery becomes `succeeded`.
13. On retryable failure, delivery is scheduled for a later attempt.
14. On permanent failure or retry exhaustion, delivery becomes
    `dead_lettered`.
15. Operator may inspect, replay, or cancel the delivery.

The API must not acknowledge an event before the event and its initial
delivery work are durably committed.

------------------------------------------------------------------------

# 6. Functional Requirements

Requirement IDs are normative. An implementation agent should preserve
these identifiers in design notes and tests.

## FR-001: Tenant and API-key authentication

-   Every producer API request must authenticate using an API key.
-   API keys must be scoped to a tenant.
-   Store only a secure hash of API keys; never store plaintext secrets.
-   Support key creation, revocation, and rotation.
-   Return `401 Unauthorized` for missing or invalid credentials.
-   Return `403 Forbidden` for authenticated callers lacking permission.
-   Administrative actions must be tenant-scoped.

**Acceptance criteria** - An invalid key cannot create or inspect
events. - Tenant A cannot access Tenant B's events or endpoints. -
Revoked keys stop working. - Plaintext API keys are displayed only once
at creation.

## FR-002: Event ingestion

-   Provide `POST /v1/events`.
-   Accept JSON event payloads.
-   Require `event_type`.
-   Accept optional `data`, `occurred_at`, and metadata.
-   Generate a unique Relay event ID.
-   Enforce configurable request-body size limits.
-   Validate content type and JSON syntax.
-   Persist the event before returning success.
-   Return `202 Accepted` for newly accepted events.

## FR-003: Idempotent ingestion

-   Support an `Idempotency-Key` header.
-   Scope keys by tenant and API operation.
-   Store a request fingerprint with the idempotency record.
-   A repeated key with the same request fingerprint returns the
    original result.
-   A repeated key with a different request fingerprint returns
    `409 Conflict`.
-   Define and document the idempotency retention period.
-   Concurrent requests using the same key must not create duplicate
    events.

## FR-004: Endpoint management

Provide: - `POST /v1/endpoints` - `GET /v1/endpoints` -
`GET /v1/endpoints/{endpoint_id}` -
`PATCH /v1/endpoints/{endpoint_id}` -
`DELETE /v1/endpoints/{endpoint_id}`

Endpoint fields: - ID. - Tenant ID. - URL. - Description/name. - Active
state. - Signing secret reference. - Configured event types or
subscriptions. - Timeout policy. - Retry policy override, if enabled. -
Creation and update timestamps.

Deletion should initially be soft deletion or deactivation so historical
delivery records remain understandable.

## FR-005: Event subscriptions and fan-out

-   An endpoint can subscribe to one or more event types.
-   An event can match multiple endpoints.
-   Create one independently tracked delivery per matching endpoint.
-   A failure at one endpoint must not block delivery to other
    endpoints.
-   Define behavior for events with no matching endpoints: retain the
    event and return an accepted response with zero deliveries, while
    recording the outcome.

## FR-006: Delivery scheduling

-   Persist delivery work in PostgreSQL.
-   Workers must claim jobs without conflicting claims.
-   Use row locking such as `FOR UPDATE SKIP LOCKED`, or an equivalently
    safe claim mechanism.
-   Support configurable batch size and worker concurrency.
-   Store `next_attempt_at`.
-   Support leases or processing timeouts for claimed jobs.
-   Recover jobs whose worker lease expires.
-   Do not hold database transactions open while making outbound HTTP
    requests.

## FR-007: HTTP delivery

-   Send the original event envelope as JSON.
-   Include a stable event ID and delivery ID in headers.
-   Include signature and timestamp headers.
-   Apply configurable connect, TLS handshake, response-header, and
    total request timeouts where supported by the chosen HTTP client.
-   Limit response-body bytes stored for diagnostics.
-   Record HTTP status, latency, and sanitized response information.
-   Treat configured 2xx responses as successful by default.
-   Do not follow redirects by default; redirects can change the
    destination and create security risks.
-   Ensure one slow endpoint cannot consume all worker capacity.

## FR-008: Retry policy

-   Retry network errors, timeouts, HTTP 408, HTTP 429, and selected 5xx
    responses.
-   Treat most other 4xx responses as permanent failures by default.
-   Allow explicit policy configuration for exceptional status codes.
-   Use exponential backoff with jitter.
-   Apply a maximum delay and maximum attempt count.
-   Respect `Retry-After` on HTTP 429 and 503 when valid and within
    configured bounds.
-   Persist retry scheduling before releasing the job.
-   Never retry indefinitely.

Suggested default policy (configurable): - Maximum attempts: 8 total
attempts. - Base delay: 2 seconds. - Multiplier: 2. - Maximum delay: 1
hour. - Jitter: full jitter or documented equivalent. - Per-request
timeout: 10 seconds. - Retry-After: respect within a configured maximum.

## FR-009: Dead-letter handling

-   Mark deliveries as dead-lettered when retry limits are exhausted or
    a non-retryable condition occurs.
-   Preserve the event, endpoint, and attempt history.
-   Expose a list and detail API.
-   Support replay after operator authorization.
-   Replay must create an auditable action and must not erase prior
    attempts.
-   Define whether replay resets the attempt counter or creates a new
    delivery generation. Prefer a new replay generation or a new
    delivery record linked to the original.

## FR-010: Manual replay and cancellation

-   Allow authorized users to replay a failed or dead-lettered delivery.
-   Allow cancellation of pending deliveries.
-   Do not allow cancellation to silently interrupt an HTTP request
    already in flight; mark cancellation requested or apply a documented
    cooperative cancellation policy.
-   Record actor, timestamp, reason, and source delivery for
    administrative actions.

## FR-011: Webhook signatures

-   Sign the exact transmitted body bytes using HMAC-SHA256.
-   Include a timestamp in the signed message.
-   Include a versioned signature header.
-   Use constant-time signature comparison in verification examples.
-   Support secret rotation with a defined overlap period.
-   Never log signing secrets.
-   Provide a receiver verification example and test vectors.

Suggested header format:

``` text
Relay-Event-Id: evt_...
Relay-Delivery-Id: dlv_...
Relay-Timestamp: 1790000000
Relay-Signature: v1=<hex_digest>
```

Suggested signed message:

``` text
{timestamp}.{raw_request_body}
```

The precise canonicalization must be specified once and used
consistently by Relay and its receiver SDK.

## FR-012: Delivery inspection

Provide APIs to inspect: - Event details. - Matching endpoints. -
Delivery status. - Attempt count. - Next scheduled attempt. - Last HTTP
status. - Last error classification. - Attempt timestamps and
durations. - Replay history.

## FR-013: Rate limiting and quotas

-   Support tenant-level ingestion limits.
-   Support endpoint-level delivery rate limits.
-   Support maximum concurrent deliveries per endpoint.
-   Return `429 Too Many Requests` for producer quota violations.
-   Include `Retry-After` where meaningful.
-   Avoid unbounded in-memory counters in multi-replica deployments.

## FR-014: Health and readiness

Provide: - `GET /healthz`: process liveness. - `GET /readyz`: readiness
including required dependencies. - A worker heartbeat or equivalent
operational signal. - Graceful shutdown that stops claiming new work and
allows in-flight work to finish within a deadline.

## FR-015: Auditability

Record: - API key creation/revocation. - Endpoint
creation/update/deactivation. - Retry-policy changes. - Delivery
replay/cancellation. - Administrative actions.

Do not record secrets or unrestricted sensitive payloads in audit logs.

------------------------------------------------------------------------

# 7. Non-Functional Requirements

## NFR-001: Durability

Once Relay returns `202 Accepted`, the event and initial delivery
scheduling records must be committed to durable storage. A process
restart must not lose accepted work.

The durability guarantee depends on PostgreSQL configuration, storage
reliability, and backup practices. Document those assumptions.

## NFR-002: Delivery semantics

-   Initial guarantee: at-least-once delivery attempts within the
    configured retry policy.
-   Duplicate delivery is possible.
-   Consumers must deduplicate using stable event identifiers.
-   Exactly-once business processing is outside Relay's control.
-   Ordering is not guaranteed in the MVP unless explicitly configured
    and implemented.

## NFR-003: Performance

Set initial engineering targets, then validate them with repeatable
benchmarks. These are targets, not claims.

-   Event ingestion p95: under 150 ms at a documented moderate test
    load, excluding external network latency.
-   API request processing must not wait for destination webhook
    completion.
-   Worker throughput must scale with worker concurrency until
    constrained by database, network, or destination limits.
-   Event and delivery list endpoints must use pagination.
-   Database queries on hot paths must have appropriate indexes.
-   No unbounded in-memory queue may be the sole source of pending work.

## NFR-004: Scalability

-   API and worker processes should be independently horizontally
    scalable.
-   Multiple worker replicas must safely share the PostgreSQL job table.
-   Tenant and endpoint quotas must prevent noisy-neighbor behavior.
-   Database connection pools must be bounded.
-   The architecture must allow a future queue broker without changing
    the public API contract.

## NFR-005: Reliability and recovery

-   Worker crashes must not permanently strand leased jobs.
-   Transient database errors must not cause false success responses.
-   Outbound request timeouts must be bounded.
-   Retry scheduling must survive process restarts.
-   Graceful shutdown must avoid acknowledging unfinished work as
    successful.
-   Poison events must not block unrelated deliveries.

## NFR-006: Security

-   Enforce tenant isolation at the service and database-query layers.
-   Hash API keys using an appropriate password/secret hashing strategy;
    use a keyed hash or secure one-way approach suited to high-entropy
    random API tokens.
-   Encrypt transport using TLS in production.
-   Never log API keys, endpoint signing secrets, or authorization
    headers.
-   Protect against SSRF: validate destination URLs, block
    loopback/private/link-local/metadata addresses, resolve and validate
    DNS safely, and re-check on connection to reduce DNS rebinding risk.
-   Restrict outbound ports and protocols.
-   Disable redirects by default.
-   Apply request and response size limits.
-   Use constant-time signature verification.
-   Apply least privilege to database and container identities.
-   Keep dependencies patched and scan container images.
-   Define a data retention and deletion policy.

## NFR-007: Observability

-   Emit structured JSON logs.
-   Include correlation IDs, event IDs, delivery IDs, tenant IDs
    (non-sensitive internal identifiers), and worker identifiers.
-   Expose Prometheus metrics.
-   Instrument API and worker operations with OpenTelemetry where
    practical.
-   Avoid high-cardinality labels such as raw URLs, event IDs, or
    customer-provided values in Prometheus metrics.
-   Provide dashboards for queue depth, success/failure rate, attempt
    count, latency, and worker health.

## NFR-008: Maintainability

-   Use clear package boundaries and dependency injection where useful.
-   Keep domain logic separate from HTTP handlers and database
    implementation.
-   Define interfaces around external dependencies only where they
    improve testability.
-   Use migrations for schema changes.
-   Keep API contracts documented using OpenAPI.
-   Require formatting, linting, unit tests, integration tests, and
    vulnerability checks in CI.

## NFR-009: Portability and operability

-   Local development must work through Docker Compose.
-   Configuration must be environment-variable driven.
-   Provide `.env.example` without real secrets.
-   Provide database migration and seed commands.
-   Document backup and restore procedures.
-   Support Linux containers.

## NFR-010: Privacy

-   Store only data required for event delivery and diagnosis.
-   Allow operators to configure retention.
-   Limit stored destination response bodies.
-   Provide a way to redact or avoid storing sensitive event fields
    where practical.
-   Do not use customer payloads for model training or unrelated
    analytics.

------------------------------------------------------------------------

# 8. API Specification

All endpoints are versioned under `/v1`. JSON is the default request and
response format.

## 8.1 Authentication

``` http
Authorization: Bearer <relay_api_key>
```

Administrative and producer keys should have distinct scopes where
practical.

## 8.2 Ingest an event

`POST /v1/events`

Headers:

``` http
Authorization: Bearer <key>
Idempotency-Key: payment-123-event
Content-Type: application/json
```

Request:

``` json
{
  "event_type": "payment.succeeded",
  "data": {
    "payment_id": "pay_123",
    "amount": 2500,
    "currency": "INR"
  },
  "occurred_at": "2026-11-07T10:30:00Z",
  "metadata": {
    "source": "payments-service"
  }
}
```

Response:

``` json
{
  "event_id": "evt_01J...",
  "status": "accepted",
  "created_at": "2026-11-07T10:30:01Z",
  "matched_endpoints": 2,
  "deliveries_created": 2
}
```

## 8.3 Create endpoint

`POST /v1/endpoints`

Request:

``` json
{
  "name": "Merchant order service",
  "url": "https://merchant.example.com/webhooks/relay",
  "event_types": [
    "payment.succeeded",
    "payment.failed"
  ],
  "timeout_seconds": 10,
  "active": true
}
```

Response should return endpoint ID and the signing secret only at
creation time, if generated by Relay. Store only a protected
representation of the secret thereafter.

## 8.4 List deliveries

`GET /v1/deliveries?status=failed&limit=50&cursor=...`

Response:

``` json
{
  "data": [
    {
      "delivery_id": "dlv_01J...",
      "event_id": "evt_01J...",
      "endpoint_id": "ep_01J...",
      "status": "retry_scheduled",
      "attempt_count": 2,
      "next_attempt_at": "2026-11-07T10:31:00Z"
    }
  ],
  "next_cursor": null
}
```

## 8.5 Replay a delivery

`POST /v1/deliveries/{delivery_id}/replay`

Request:

``` json
{
  "reason": "Destination endpoint has been repaired"
}
```

Return a replay operation or new delivery-generation identifier.
Preserve the original delivery history.

## 8.6 Error response format

Use a consistent envelope:

``` json
{
  "error": {
    "code": "idempotency_conflict",
    "message": "The idempotency key was already used with a different request.",
    "request_id": "req_01J..."
  }
}
```

Use standard HTTP status codes: - `400` malformed request. - `401`
missing/invalid authentication. - `403` insufficient permission. - `404`
resource not found within caller's tenant. - `409` idempotency or state
conflict. - `413` request too large. - `422` semantic validation
failure. - `429` rate limit exceeded. - `500` unexpected internal
failure. - `503` required dependency unavailable.

------------------------------------------------------------------------

# 9. Data Model and Database Requirements

The following is a logical schema. Exact column types and constraints
should be finalized during implementation.

## 9.1 organizations

  Column       Type          Notes
  ------------ ------------- -------------------
  id           UUID          Primary key
  name         TEXT          Organization name
  created_at   TIMESTAMPTZ   Creation time

## 9.2 api_keys

  Column            Type                        Notes
  ----------------- --------------------------- ----------------------------
  id                UUID                        Primary key
  organization_id   UUID                        Tenant owner
  key_prefix        TEXT                        Safe lookup/display prefix
  key_hash          TEXT/BYTEA                  Never plaintext
  scopes            JSONB or normalized table   Permissions
  revoked_at        TIMESTAMPTZ                 Nullable
  created_at        TIMESTAMPTZ                 Creation time

## 9.3 events

  Column            Type          Notes
  ----------------- ------------- -------------------------------
  id                UUID          Internal primary key
  public_id         TEXT          Public event identifier
  organization_id   UUID          Tenant
  event_type        TEXT          e.g. `payment.succeeded`
  payload           JSONB         Immutable event envelope/data
  payload_hash      BYTEA         Integrity/idempotency support
  occurred_at       TIMESTAMPTZ   Producer event time
  created_at        TIMESTAMPTZ   Relay acceptance time

## 9.4 endpoints

  ---------------------------------------------------------------------------
  Column                      Type                    Notes
  --------------------------- ----------------------- -----------------------
  id                          UUID                    Primary key

  organization_id             UUID                    Tenant

  name                        TEXT                    Human-readable label

  url                         TEXT                    Validated destination

  signing_secret_ciphertext   BYTEA                   Encrypted at rest or
                                                      protected secret
                                                      reference

  active                      BOOLEAN                 Enabled state

  timeout_ms                  INTEGER                 Bounded timeout

  created_at                  TIMESTAMPTZ             Creation time

  updated_at                  TIMESTAMPTZ             Update time

  deleted_at                  TIMESTAMPTZ             Soft deletion
  ---------------------------------------------------------------------------

## 9.5 endpoint_subscriptions

  Column        Type          Notes
  ------------- ------------- -----------------------
  id            UUID          Primary key
  endpoint_id   UUID          Endpoint
  event_type    TEXT          Subscribed event type
  created_at    TIMESTAMPTZ   Creation time

Unique constraint: `(endpoint_id, event_type)`.

## 9.6 deliveries

  -----------------------------------------------------------------------
  Column                  Type                    Notes
  ----------------------- ----------------------- -----------------------
  id                      UUID                    Primary key

  public_id               TEXT                    Public delivery ID

  event_id                UUID                    Source event

  endpoint_id             UUID                    Destination

  status                  TEXT/ENUM               State

  attempt_count           INTEGER                 Number of attempts
                                                  started/completed per
                                                  defined semantics

  next_attempt_at         TIMESTAMPTZ             Due time

  locked_by               TEXT                    Worker identity

  locked_until            TIMESTAMPTZ             Lease expiry

  last_status_code        INTEGER                 Nullable

  last_error_code         TEXT                    Sanitized
                                                  classification

  created_at              TIMESTAMPTZ             Creation

  updated_at              TIMESTAMPTZ             Last update
  -----------------------------------------------------------------------

## 9.7 delivery_attempts

  Column             Type          Notes
  ------------------ ------------- --------------------------------------
  id                 UUID          Primary key
  delivery_id        UUID          Parent delivery
  attempt_number     INTEGER       Sequential attempt
  started_at         TIMESTAMPTZ   Start
  finished_at        TIMESTAMPTZ   Completion
  http_status        INTEGER       Nullable
  duration_ms        BIGINT        Duration
  error_class        TEXT          Timeout, DNS, connection, HTTP, etc.
  response_excerpt   TEXT          Size-limited and sanitized
  created_at         TIMESTAMPTZ   Creation

Unique constraint: `(delivery_id, attempt_number)`.

## 9.8 idempotency_records

  Column            Type          Notes
  ----------------- ------------- --------------------------
  id                UUID          Primary key
  organization_id   UUID          Tenant
  operation         TEXT          API operation
  idempotency_key   TEXT          Client key
  request_hash      BYTEA         Fingerprint
  response_status   INTEGER       Original response status
  response_body     JSONB         Original result
  expires_at        TIMESTAMPTZ   Retention expiry
  created_at        TIMESTAMPTZ   Creation

Unique constraint: `(organization_id, operation, idempotency_key)`.

## 9.9 outbox_events

  Column           Type          Notes
  ---------------- ------------- --------------------------
  id               UUID          Primary key
  aggregate_type   TEXT          e.g. delivery
  aggregate_id     UUID          Related record
  event_type       TEXT          Internal dispatch action
  payload          JSONB         Minimal work metadata
  published_at     TIMESTAMPTZ   Nullable
  created_at       TIMESTAMPTZ   Creation

The outbox is written in the same transaction as the event and initial
delivery records. A dispatcher or worker safely claims unpublished rows
and converts them into scheduled delivery work. Avoid having both an
outbox queue and a separate deliveries queue without a clearly defined
responsibility for each.

## 9.10 Indexing requirements

At minimum, evaluate indexes for: -
`events(organization_id, created_at DESC)`. -
`events(organization_id, public_id)` unique. -
`deliveries(status, next_attempt_at)`. -
`deliveries(endpoint_id, created_at DESC)`. - `deliveries(event_id)`. -
`delivery_attempts(delivery_id, attempt_number)`. -
`endpoint_subscriptions(endpoint_id, event_type)` unique. - Idempotency
unique constraint and expiry cleanup. -
`outbox_events(published_at, created_at)` for pending work.

Use `EXPLAIN (ANALYZE, BUFFERS)` on realistic data before claiming query
performance.

------------------------------------------------------------------------

# 10. Delivery State Machine

Use explicit, validated state transitions.

``` text
                 +----------+
                 | pending  |
                 +----+-----+
                      |
                      v
                 +----+-----+
          +------|processing|------+
          |      +----+-----+      |
          |           |            |
       lease       success       failure
       expires        |            |
          |            v            v
          |       +----+----+   +---+----------------+
          +------>|succeeded|   | retryable failure? |
                  +---------+   +---+----------------+
                                    | yes       | no
                                    v           v
                              +-----+----+  +---+-------------+
                              |retry_    |  |dead_lettered    |
                              |scheduled |  +-----------------+
                              +-----+----+
                                    |
                              next_attempt_at
                                    |
                                    v
                                 pending
```

Recommended statuses: - `pending` - `processing` - `retry_scheduled` -
`succeeded` - `dead_lettered` - `cancelled`

Define legal transitions in one domain-level state transition function.
Do not scatter arbitrary status updates across handlers and workers.

### Lease and crash recovery

A worker claims a delivery and sets: - `locked_by` - `locked_until` -
status = `processing`

If the worker crashes, another worker may reclaim the delivery after the
lease expires. A lease must be longer than the normal request timeout
plus a safety margin, or be extended with a heartbeat for long-running
work.

A stale worker must not overwrite a newer worker's result. Use a claim
token, lease version, or conditional update that verifies current
ownership.

------------------------------------------------------------------------

# 11. Retry and Failure Classification

## 11.1 Failure categories

  -------------------------------------------------------------------------
  Failure                 Default classification    Action
  ----------------------- ------------------------- -----------------------
  DNS lookup failure      Transient                 Retry

  Connection refused      Transient                 Retry

  Connection timeout      Transient                 Retry

  Request timeout         Ambiguous/transient       Retry; receiver must
                                                    deduplicate

  HTTP 408                Transient                 Retry

  HTTP 429                Transient                 Retry; respect bounded
                                                    `Retry-After`

  HTTP 500--599           Usually transient         Retry

  HTTP 400                Usually permanent         Dead-letter or mark
                                                    failed

  HTTP 401/403            Usually                   Dead-letter; alert
                          permanent/configuration   

  HTTP 404                Usually                   Dead-letter or
                          permanent/configuration   policy-based retry

  Invalid destination URL Permanent                 Reject endpoint
                                                    configuration

  TLS certificate         Usually                   Do not silently disable
  validation error        configuration/security    verification
  -------------------------------------------------------------------------

The classification should be configurable, but safe defaults must be
documented.

## 11.2 Backoff calculation

A suitable full-jitter strategy:

``` text
cap = min(max_delay, base_delay * 2^(attempt_number - 1))
delay = random(0, cap)
next_attempt_at = now + delay
```

Use a bounded attempt number to avoid overflow. Persist the computed
`next_attempt_at`; do not rely on in-memory timers.

------------------------------------------------------------------------

# 12. Security and Threat Model

Webhook infrastructure makes outbound HTTP requests based on
user-configured destinations. This creates a significant SSRF risk.

## 12.1 Threats

-   SSRF to cloud metadata services or internal services.
-   DNS rebinding.
-   Redirect-based access to prohibited destinations.
-   API key theft.
-   Signing secret exposure.
-   Cross-tenant data access.
-   Maliciously large request or response bodies.
-   Log injection and sensitive data leakage.
-   Replay attacks against receivers.
-   Denial of service through excessive events or slow endpoints.

## 12.2 Required mitigations

1.  Allow only `https` by default in production. Permit `http` only in
    explicit local development/test configurations.
2.  Parse and normalize URLs using a trusted URL parser.
3.  Reject loopback, private, link-local, multicast, unspecified, and
    reserved IP ranges.
4.  Resolve DNS and validate all returned IP addresses.
5.  Ensure the actual connected IP is also checked; a one-time DNS
    validation is insufficient against rebinding.
6.  Disable redirects by default.
7.  Restrict outbound ports.
8.  Apply network-level egress controls in production.
9.  Set strict timeouts and response-size limits.
10. Never include secrets in logs or error responses.
11. Use tenant-scoped database access patterns.
12. Rotate API keys and signing secrets.
13. Protect administrative replay and endpoint-management operations
    with authorization and audit logs.

A production implementation should receive a dedicated security review
before accepting arbitrary customer-controlled URLs.

------------------------------------------------------------------------

# 13. Observability and Operations

## 13.1 Structured log fields

Recommended fields: - `timestamp` - `level` - `service` - `request_id` -
`trace_id` - `organization_id` - `event_id` - `delivery_id` -
`endpoint_id` - `worker_id` - `attempt_number` - `error_class` -
`duration_ms`

Do not log full payloads by default. Provide controlled, redacted
diagnostics where necessary.

## 13.2 Prometheus metrics

Suggested metrics: - `relay_events_accepted_total` -
`relay_event_ingest_errors_total` - `relay_deliveries_created_total` -
`relay_delivery_attempts_total` - `relay_delivery_success_total` -
`relay_delivery_failure_total` - `relay_delivery_duration_seconds` -
`relay_queue_depth` - `relay_oldest_pending_delivery_age_seconds` -
`relay_worker_active_count` - `relay_worker_claim_errors_total` -
`relay_dead_letter_total` - `relay_http_requests_total`

Avoid event IDs, tenant IDs, endpoint URLs, or arbitrary event types as
unbounded metric labels. Use bounded labels such as outcome and error
class.

## 13.3 Operational dashboard

A later dashboard should show: - Event ingestion rate. - Delivery
success and failure rates. - Queue depth and oldest pending age. - Retry
volume. - Dead-letter count. - p50/p95/p99 delivery latency. - Worker
availability. - Per-endpoint health, with access controls.

## 13.4 Alert conditions

Examples: - Oldest pending delivery exceeds a configured threshold. -
Dead-letter rate rises above baseline. - Worker heartbeat is missing. -
Database connection pool is exhausted. - Ingestion error rate spikes. -
One endpoint repeatedly times out or returns 5xx.

------------------------------------------------------------------------

# 14. Configuration Specification

Use environment variables, with documented defaults.

``` dotenv
RELAY_ENV=development
RELAY_HTTP_ADDR=:8080

DATABASE_URL=postgres://relay:relay@postgres:5432/relay?sslmode=disable
DATABASE_MAX_OPEN_CONNS=20
DATABASE_MAX_IDLE_CONNS=10

RELAY_WORKER_CONCURRENCY=10
RELAY_WORKER_BATCH_SIZE=20
RELAY_WORKER_POLL_INTERVAL=1s
RELAY_WORKER_LEASE_DURATION=45s

RELAY_DELIVERY_TIMEOUT=10s
RELAY_MAX_ATTEMPTS=8
RELAY_RETRY_BASE_DELAY=2s
RELAY_RETRY_MAX_DELAY=1h

RELAY_MAX_EVENT_BYTES=262144
RELAY_MAX_RESPONSE_BYTES=16384

RELAY_METRICS_ADDR=:9090
RELAY_LOG_LEVEL=info
```

These are starting defaults, not universal production values. Validate
that lease duration exceeds the maximum delivery timeout plus processing
and persistence margin.

Never commit real secrets or production database credentials.

------------------------------------------------------------------------

# 15. Recommended Repository Structure

``` text
relay/
├── cmd/
│   ├── api/
│   │   └── main.go
│   ├── worker/
│   │   └── main.go
│   └── migrate/
│       └── main.go
│
├── internal/
│   ├── config/
│   ├── domain/
│   │   ├── event.go
│   │   ├── endpoint.go
│   │   ├── delivery.go
│   │   └── errors.go
│   ├── auth/
│   ├── ingestion/
│   ├── endpoint/
│   ├── subscription/
│   ├── delivery/
│   ├── worker/
│   ├── scheduler/
│   ├── retry/
│   ├── signing/
│   ├── idempotency/
│   ├── ratelimit/
│   ├── deadletter/
│   ├── audit/
│   ├── observability/
│   ├── httpapi/
│   │   ├── middleware/
│   │   ├── handlers/
│   │   └── routes.go
│   └── storage/
│       └── postgres/
│
├── migrations/
├── api/
│   └── openapi.yaml
├── sdk/
│   └── go/
├── cli/
├── dashboard/
├── deployments/
│   └── docker/
├── docs/
│   ├── architecture.md
│   ├── security.md
│   ├── operations.md
│   └── receiver-guide.md
├── tests/
│   ├── integration/
│   ├── e2e/
│   ├── load/
│   └── fixtures/
├── scripts/
├── docker-compose.yml
├── Dockerfile
├── Makefile
├── go.mod
├── go.sum
├── .env.example
└── README.md
```

Keep the package structure aligned with actual domain boundaries. Do not
create empty packages merely to match this tree. The dashboard, SDK, and
CLI may be deferred.

------------------------------------------------------------------------

# 16. Testing Requirements

Testing is a core deliverable, not a final polish task.

## 16.1 Unit tests

Test: - Retry delay calculation and jitter bounds. - Failure
classification. - State transition validation. - HMAC signing and
verification. - Idempotency fingerprint behavior. - URL validation and
IP-range rejection. - Request and response size limits. - Authorization
scopes.

## 16.2 Integration tests

Use a real PostgreSQL instance, preferably through Testcontainers or
Docker Compose.

Test: - Event persistence. - Atomic creation of event, deliveries, and
outbox rows. - Concurrent idempotency-key requests. - Concurrent job
claims. - Lease expiration and recovery. - Retry persistence across
process restarts. - Tenant isolation. - Replay audit history.

## 16.3 End-to-end tests

Create a controllable mock webhook receiver that can: - Return 200. -
Return 400. - Return 429 with `Retry-After`. - Return 500. - Delay
responses. - Close connections. - Accept a request but drop the
response. - Record duplicate event IDs.

Verify the expected Relay state and attempt history for every scenario.

## 16.4 Load and resilience tests

Measure: - Ingestion throughput. - Delivery throughput. - API
p50/p95/p99 latency. - Queue growth under slow destinations. - Database
pool saturation. - Worker recovery after termination. - Behavior under
endpoint failure bursts.

Document test hardware, concurrency, payload size, duration, and
configuration. Never publish benchmark numbers without methodology.

## 16.5 Required failure-injection scenarios

1.  Kill a worker after claiming a delivery.
2.  Kill a worker after the receiver accepts the request but before
    Relay records success.
3.  Restart PostgreSQL during ingestion.
4.  Simulate DNS failure.
5.  Simulate a slow receiver.
6.  Submit the same idempotency key concurrently.
7.  Run multiple worker replicas against the same queue.
8.  Attempt cross-tenant resource access.
9.  Configure an endpoint pointing to a prohibited internal IP.
10. Make the receiver return oversized response bodies.

------------------------------------------------------------------------

# 17. Development Milestones and Definition of Done

## Milestone 0: Project foundation

Deliver: - Go module and repository conventions. - Configuration
loader. - PostgreSQL Docker Compose service. - Migration framework. -
Health endpoint. - CI formatting and test workflow.

Done when a new developer can clone the repository and start the API and
database using documented commands.

## Milestone 1: Durable ingestion

Deliver: - Organization and API-key model. - Authentication
middleware. - Event ingestion endpoint. - Idempotency handling. - Event
persistence. - Endpoint and subscription CRUD.

Done when accepted events survive API process restarts and duplicate
submissions behave according to the idempotency contract.

## Milestone 2: Delivery engine

Deliver: - Delivery creation and outbox transaction. - Worker
executable. - Safe job claiming. - HTTP client with timeouts. - Attempt
history. - Success/failure state transitions.

Done when one event can be delivered to multiple endpoints and endpoint
failures are isolated.

## Milestone 3: Reliability

Deliver: - Retry policy and jitter. - Lease recovery. - Dead-letter
handling. - Replay. - HMAC signatures. - Rate limiting. - SSRF
protections.

Done when the documented failure-injection suite passes.

## Milestone 4: Operability

Deliver: - Structured logs. - Prometheus metrics. - OpenTelemetry
instrumentation. - Graceful shutdown. - Operational documentation. -
Backup/restore instructions.

Done when an operator can identify queue backlog, locate failed
deliveries, and recover from a worker crash.

## Milestone 5: Developer experience

Deliver: - OpenAPI specification. - CLI or Go SDK. - Example producer. -
Example receiver with signature verification. - Optional dashboard. -
Public demo environment or reproducible local demo.

Done when an external developer can integrate Relay without reading its
internal source code.

------------------------------------------------------------------------

# 18. Acceptance Criteria for the Complete MVP

The MVP is complete only when all of the following are true:

-   [ ] A producer can authenticate and submit an event.
-   [ ] Relay persists the event and initial delivery work atomically.
-   [ ] Relay returns an event ID and does not wait for destination
    delivery.
-   [ ] An event can fan out to multiple endpoints.
-   [ ] Workers can process jobs concurrently without conflicting
    claims.
-   [ ] Duplicate ingestion with the same idempotency key does not
    create a second event.
-   [ ] Reuse of an idempotency key with a different payload returns a
    conflict.
-   [ ] Outbound requests include verifiable HMAC signatures.
-   [ ] Timeouts and retryable failures are retried according to policy.
-   [ ] Retry scheduling survives restarts.
-   [ ] Worker crashes are recovered through lease expiry.
-   [ ] Exhausted deliveries become dead-lettered.
-   [ ] Operators can inspect attempts and replay failed deliveries.
-   [ ] Tenant isolation is covered by automated tests.
-   [ ] SSRF protections are implemented and tested.
-   [ ] Health, readiness, logs, and metrics are available.
-   [ ] Docker Compose starts a working local environment.
-   [ ] Integration and end-to-end tests pass.
-   [ ] README explains guarantees, limitations, setup, and example
    integration.

------------------------------------------------------------------------

# 19. Implementation Guidance for an LLM Coding Agent

This section is intended to be used as implementation instructions for a
coding agent.

## 19.1 Role

Act as a senior backend engineer implementing Relay from this
specification. Prioritize correctness, security, durability,
testability, and maintainability over speed or unnecessary abstraction.

## 19.2 Mandatory engineering rules

1.  Read the complete specification before editing code.
2.  Inspect the existing repository before creating or modifying files.
3.  Do not assume the repository is empty.
4.  Preserve established conventions unless they conflict with this
    specification.
5.  Implement a modular monolith with separate API and worker processes.
6.  Use PostgreSQL as the source of truth for durable work.
7.  Do not use an in-memory channel as the only job queue.
8.  Do not hold database transactions open during outbound HTTP
    requests.
9.  Implement safe concurrent job claiming.
10. Make delivery state transitions explicit.
11. Treat duplicate delivery as possible.
12. Never claim exactly-once delivery.
13. Implement SSRF defenses before allowing arbitrary destination URLs.
14. Never log secrets or unrestricted customer payloads.
15. Add tests with each feature; do not postpone all testing.
16. Use migrations for every schema change.
17. Document assumptions and unresolved design decisions.
18. Do not add Redis, Kafka, Kubernetes, or microservices without a
    demonstrated requirement.
19. Do not invent benchmark results.
20. Run formatting, linting, unit tests, and relevant integration tests
    before declaring a task complete.

## 19.3 Preferred implementation order

1.  Repository inspection and architecture plan.
2.  Configuration, logging, database connection, migrations.
3.  Domain types and state machine.
4.  Authentication and tenant isolation.
5.  Event ingestion and idempotency.
6.  Endpoint and subscription management.
7.  Atomic delivery/outbox creation.
8.  Worker claim and lease mechanism.
9.  HTTP delivery and signatures.
10. Retry and dead-letter handling.
11. Replay, cancellation, and audit.
12. Rate limiting and SSRF protection.
13. Metrics, traces, health and readiness.
14. Integration, end-to-end and resilience tests.
15. OpenAPI, examples, SDK/CLI and documentation.

## 19.4 Required output after each implementation task

After each task, report:

-   Files created or modified.
-   Behavior implemented.
-   Database migrations added.
-   Tests added and their results.
-   Commands executed.
-   Known limitations.
-   Next recommended task.

Do not claim a test passed unless it was actually executed and its
result was observed.

## 19.5 Stop and ask before

-   Changing delivery semantics.
-   Changing public API contracts.
-   Introducing a new infrastructure dependency.
-   Storing secrets in a different way.
-   Making an irreversible data migration.
-   Relaxing SSRF, authentication, or tenant-isolation controls.
-   Adding a feature that materially expands MVP scope.

## 19.6 First task prompt

Use this as the first instruction to your coding agent:

> Read `RELAY_SPEC.md` completely. Inspect the repository and report its
> current structure, language/toolchain, existing implementation, and
> test status. Then propose a concise implementation plan for Milestone
> 0 and Milestone 1. Do not write code yet. Identify ambiguities,
> security concerns, and architectural decisions that need resolution.
> Keep the implementation aligned with the specification and avoid
> premature infrastructure complexity.

------------------------------------------------------------------------

# 20. Sources and Reference Material for Implementation

The following official documentation and engineering references should
be treated as the primary reading list. An LLM coding agent should
consult the relevant sections while implementing each subsystem, rather
than attempting to ingest every source at once.

## 20.1 Go language and concurrency

1.  **Go Documentation**\
    https://go.dev/doc/\
    Language, modules, tooling, testing, and standard library
    references.

2.  **Effective Go**\
    https://go.dev/doc/effective_go\
    Idiomatic Go, interfaces, errors, concurrency patterns, and code
    organization.

3.  **Go Concurrency Patterns: Pipelines and cancellation**\
    https://go.dev/blog/pipelines\
    Worker pipelines, cancellation, goroutines, and channel lifecycle.

4.  **Go context package**\
    https://pkg.go.dev/context\
    Request-scoped cancellation, deadlines, and graceful work
    cancellation.

5.  **Go net/http package**\
    https://pkg.go.dev/net/http\
    HTTP server/client behavior, transports, timeouts, request handling.

6.  **Go race detector**\
    https://go.dev/doc/articles/race_detector\
    Detect data races during concurrent worker development.

## 20.2 PostgreSQL and transaction processing

7.  **PostgreSQL Documentation**\
    https://www.postgresql.org/docs/current/\
    SQL, transactions, indexes, locking, constraints, and operations.

8.  **Explicit Locking**\
    https://www.postgresql.org/docs/current/explicit-locking.html\
    Row-level locks and concurrency control.

9.  **SELECT / SKIP LOCKED**\
    https://www.postgresql.org/docs/current/sql-select.html\
    Understand `FOR UPDATE SKIP LOCKED` for concurrent job claiming.

10. **Transaction Isolation**\
    https://www.postgresql.org/docs/current/transaction-iso.html\
    Understand isolation levels and concurrency anomalies.

11. **Indexes**\
    https://www.postgresql.org/docs/current/indexes.html\
    Design and validate indexes for event and delivery queries.

12. **EXPLAIN**\
    https://www.postgresql.org/docs/current/using-explain.html\
    Analyze query plans and benchmark database operations.

## 20.3 Event-driven architecture and reliability

13. **Transactional Outbox Pattern --- microservices.io**\
    https://microservices.io/patterns/data/transactional-outbox.html\
    Understand atomic persistence of business changes and dispatch
    records.

14. **Idempotent Consumer Pattern --- microservices.io**\
    https://microservices.io/patterns/communication-style/idempotent-consumer.html\
    Understand duplicate message processing and deduplication.

15. **AWS Builders' Library: Making retries safe with idempotent APIs**\
    https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/\
    Practical guidance on retry safety and idempotency.

16. **AWS Architecture Blog: Exponential Backoff and Jitter**\
    https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/\
    Retry scheduling and avoiding synchronized retry storms.

17. **HTTP Semantics --- RFC 9110**\
    https://www.rfc-editor.org/rfc/rfc9110\
    HTTP methods, status codes, semantics, and retry-related behavior.

18. **HTTP Retry-After semantics --- RFC 9110**\
    https://www.rfc-editor.org/rfc/rfc9110.html\
    Reference for `Retry-After` behavior and HTTP response semantics.

## 20.4 Security

19. **OWASP Server-Side Request Forgery Prevention Cheat Sheet**\
    https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html\
    Essential reading before implementing user-controlled webhook
    destinations.

20. **OWASP API Security Top 10**\
    https://owasp.org/API-Security/\
    Authentication, authorization, resource consumption, and API
    exposure risks.

21. **Go crypto/hmac package**\
    https://pkg.go.dev/crypto/hmac\
    HMAC signing and constant-time verification primitives.

22. **Go crypto/sha256 package**\
    https://pkg.go.dev/crypto/sha256\
    SHA-256 primitives used for request fingerprints and signatures.

23. **OWASP Secrets Management Cheat Sheet**\
    https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html\
    Secret storage, access, rotation, and exposure prevention.

## 20.5 Observability

24. **OpenTelemetry Documentation**\
    https://opentelemetry.io/docs/\
    Traces, metrics, logs, instrumentation, and context propagation.

25. **Prometheus Documentation**\
    https://prometheus.io/docs/introduction/overview/\
    Metrics design, instrumentation, and monitoring.

26. **Prometheus Instrumentation Practices**\
    https://prometheus.io/docs/practices/instrumentation/\
    Metric types, naming, labels, and cardinality considerations.

27. **Grafana Documentation**\
    https://grafana.com/docs/\
    Dashboards, alerting, and operational visualization.

## 20.6 Containers, testing and API documentation

28. **Docker Documentation**\
    https://docs.docker.com/\
    Container builds, networking, volumes, and Compose.

29. **Docker Compose Documentation**\
    https://docs.docker.com/compose/\
    Local multi-container development environments.

30. **Testcontainers for Go**\
    https://golang.testcontainers.org/\
    Integration tests using disposable real dependencies.

31. **Go testing package**\
    https://pkg.go.dev/testing\
    Unit tests, benchmarks, and test helpers.

32. **OpenAPI Specification**\
    https://spec.openapis.org/oas/latest.html\
    Machine-readable API contract and generated documentation.

33. **GitHub Actions Documentation**\
    https://docs.github.com/en/actions\
    Continuous integration and automated quality checks.

## 20.7 Suggested reading order

  Implementation stage        Read first
  --------------------------- ----------------
  Go foundations              1, 2, 4, 5
  Worker concurrency          3, 4, 6
  Database and job claiming   7, 8, 9, 10
  Atomic event dispatch       13, 14
  Idempotency and retries     15, 16, 17
  Webhook security            19, 20, 21, 23
  Monitoring                  24, 25, 26
  Deployment and testing      28, 29, 30, 31
  API contract                32

------------------------------------------------------------------------

# 21. Open Design Decisions

Resolve these before a production release. For the MVP, use the
recommended defaults unless a concrete requirement suggests otherwise.

  Decision                          Recommended starting point
  --------------------------------- -------------------------------------------------
  Database                          PostgreSQL
  Job queue                         PostgreSQL-backed scheduling
  Redis                             Defer until measured need
  API/worker deployment             Separate processes, shared codebase
  Delivery guarantee                At-least-once
  Event ordering                    No global ordering guarantee
  Retry policy                      Bounded exponential backoff with jitter
  Redirects                         Disabled
  Production destination protocol   HTTPS only by default
  Signature                         HMAC-SHA256 over timestamp and exact body bytes
  Event storage                     JSONB with retention controls
  Dashboard                         Defer until core engine works
  SDK                               Go SDK after stable API contract
  Deployment                        Docker Compose first

Additional questions: - Should replay create a new delivery record or a
new generation linked to the original? - How should endpoint secret
rotation overlap be represented? - Should event subscriptions be
snapshotted at ingestion time? Recommended: yes, so later subscription
changes do not silently alter historical fan-out. - What should happen
when no endpoints match? Recommended: accept and retain the event, with
zero deliveries. - Should the API key model support read-only and
administrative scopes? Recommended: yes before external users. - What is
the default event retention period? Select a documented value and make
it configurable. - How are endpoint URL DNS checks repeated at delivery
time? This must be settled as part of the SSRF implementation.

------------------------------------------------------------------------

# 22. Product Quality Bar

Relay should not be considered successful merely because it can send a
webhook.

A credible release should demonstrate:

1.  **Correctness:** state transitions and database invariants are
    enforced.
2.  **Durability:** accepted work survives process restarts.
3.  **Resilience:** worker and destination failures are recoverable.
4.  **Security:** arbitrary endpoint URLs cannot be used to access
    internal infrastructure.
5.  **Transparency:** every delivery has inspectable history.
6.  **Developer experience:** a new user can run the example producer
    and receiver quickly.
7.  **Evidence:** performance and reliability claims are backed by
    reproducible tests.

The strongest demonstration is a live failure-recovery scenario: submit
an event, make the receiver unavailable, observe retries, restart a
worker, restore the receiver, and show successful recovery without
losing the event.

**Final product positioning:** Relay is a self-hostable, observable,
fault-tolerant webhook delivery engine for developers who need reliable
event delivery without building the entire mechanism themselves.
