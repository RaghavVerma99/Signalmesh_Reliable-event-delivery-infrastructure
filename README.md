# SignalMesh

A **self-hostable webhook event delivery engine** - reliable event fan-out with
signed deliveries, retries, dead-lettering and replay.

> **Status:** the delivery engine is production-shaped. The *hosted SaaS* layer
> around it (accounts, billing, quotas, dashboard, SDKs) is **not built yet**.
> See [`docs/SAAS_READINESS_AUDIT.md`](./docs/SAAS_READINESS_AUDIT.md) for the
> full gap analysis and the prioritised roadmap.

Full design: [`SIGNALMESH_SPEC.md`](./SIGNALMESH_SPEC.md)

## What it does

- Tenant isolation: every API key belongs to an organization; all reads/writes are scoped to it.
- API key auth: `POST /v1/keys` (bootstrap) + `Authorization: Bearer <key>` for `/v1/*`; key revoke/list.
- **Key scopes**: keys can be limited to `events:*`, `endpoints:*`, `deliveries:*`, `keys:*`, `audit:read`. Enforced per route.
- Event ingestion: `POST /v1/events` -> `202 Accepted`, optional `Idempotency-Key` (TTL + fingerprint conflict detection).
- Endpoint CRUD: `POST/GET/PATCH/DELETE /v1/endpoints` (url, event_types, timeout_seconds, max_attempts) + `POST /v1/endpoints/:id/rotate-secret`.
- Fan-out: event -> one delivery per matching active endpoint.
- Worker: concurrent claims, signed HTTP POST, bounded timeout, exponential backoff + jitter, retries on network/timeout/408/429/5xx, dead-letters on exhaustion.
- Delivery states: `pending`, `processing`, `retry_scheduled`, `succeeded`, `dead_lettered`, `cancelled`.
- Replay: `POST /v1/deliveries/:id/replay`; Cancel: `POST /v1/deliveries/:id/cancel`.
- **Attempt history**: `GET /v1/deliveries/:id/attempts` - status code, duration, error class and response excerpt for every outbound attempt.
- Inspect: `GET /v1/deliveries`, `GET /v1/deliveries/:id`, `GET /v1/events`, `GET /v1/audit`.
- Tenant rate limiting, audit log, keyset cursor pagination.
- Storage: JSON file (dev) or PostgreSQL (durable, atomic ingest, `FOR UPDATE SKIP LOCKED` claiming).
- Split processes: `src/api.js` and `src/worker-main.js` share PostgreSQL.
- Health: `GET /healthz`, `GET /readyz` (storage check), `GET /healthz/workers` (worker liveness), `GET /metrics`.
- Data retention: idempotency records, events, deliveries and audit rows are swept on a configurable schedule.
- OpenAPI contract: [`api/openapi.yaml`](./api/openapi.yaml).
- Mock receivers: `POST /demo/orders` (verifies HMAC signature), `POST /demo/orders-flaky` (fails once), `POST /demo/orders-down` (always fails).

## Run

```bash
npm install
npm test        # unit + integration tests (node:test)
npm start       # API + worker in one process
```

Server: http://localhost:8080 (override with `PORT` / `HOST`)

Split processes (requires `SIGNALMESH_STORAGE=postgres`):

```bash
npm run start:api      # API only
npm run start:worker   # worker only (run one per replica)
```

## PostgreSQL

```bash
export SIGNALMESH_STORAGE=postgres
export DATABASE_URL=postgres://signalmesh:signalmesh@localhost:5432/signalmesh
npm run migrate        # applies src/storage/migrations/*.sql
npm start
```

Docker Compose:

```bash
docker compose up --build                    # all-in-one, JSON store
docker compose --profile split up --build    # API + worker + PostgreSQL
```

## Deploying

- **Vercel (API only) + worker on Railway/Fly/Render:** see [`docs/VERCEL.md`](./docs/VERCEL.md). Vercel cannot run the long-lived worker, so the API and worker must be deployed separately.
- **Single platform (recommended for a delivery engine):** use the Docker image with `SIGNALMESH_ROLE=all`, or two services (`api` + `worker`) sharing PostgreSQL.

Vercel quick check:

```bash
npm run vercel:check   # validates api/index.js locally
```

## Configuration

Copy `.env.example` to `.env` and adjust. Key variables:

- `SIGNALMESH_SECRET_ENCRYPTION_KEY` - 32-byte hex key for AES-256-GCM signing-secret encryption (required in production).
- `SIGNALMESH_API_KEY_PEPPER` - pepper for keyed API-key hashing (required in production).
- `SIGNALMESH_STORAGE` - `json` (local demo default) or `postgres`; `DATABASE_URL` for the connection.
- `SIGNALMESH_ROLE` - `all` (default), `api`, or `worker`.
- `SIGNALMESH_DELIVERY_TIMEOUT_MS`, `SIGNALMESH_MAX_ATTEMPTS`, `SIGNALMESH_RETRY_BASE_DELAY_MS`, `SIGNALMESH_RETRY_MAX_DELAY_MS` - delivery/retry policy.
- `SIGNALMESH_WORKER_CONCURRENCY`, `SIGNALMESH_WORKER_POLL_INTERVAL_MS`, `SIGNALMESH_WORKER_LEASE_MS` - worker tuning.
- `SIGNALMESH_RATE_LIMIT`, `SIGNALMESH_RATE_LIMIT_PER_MINUTE`, `SIGNALMESH_RATE_LIMIT_BURST` - tenant rate limiting (in-process; single instance).
- `SIGNALMESH_IDEMPOTENCY_TTL_MS` - idempotency record retention.
- `SIGNALMESH_RETENTION_EVENT_DAYS`, `SIGNALMESH_RETENTION_DELIVERY_DAYS`, `SIGNALMESH_RETENTION_AUDIT_DAYS` - data retention sweep.
- `SIGNALMESH_MAX_ENDPOINT_TIMEOUT_MS`, `SIGNALMESH_MAX_ENDPOINT_ATTEMPTS` - per-endpoint caps.
- `SIGNALMESH_LOG_LEVEL` - `debug` | `info` | `warn` | `error` | `silent`.

For a fast demo that dead-letters within seconds, set `SIGNALMESH_MAX_ATTEMPTS=3` and `SIGNALMESH_RETRY_MAX_DELAY_MS=30000`.

An end-to-end smoke test is available once the server is running:

```bash
node scripts/smoke.js http://127.0.0.1:8080
```

## Scripted demo (recommended)

Three terminals, fast retry settings, and a live dashboard:

```bash
npm run demo:reset    # seed a clean key + 3 demo endpoints
npm run demo:server   # start with fast-demo retry + dashboard enabled
npm run demo:run      # prove success, retry, dead-letter, replay
```

Open `http://127.0.0.1:8080/dashboard` and paste the API key printed by `demo:reset`.
If port 8080 is taken, use `PORT=8091` and `SIGNALMESH_BASE_URL=http://127.0.0.1:8091`.
Full readiness guide: [`docs/DEMO_AND_DEPLOYMENT.md`](./docs/DEMO_AND_DEPLOYMENT.md).

## Quick demo walkthrough (curl)

1. Create a key:

```bash
curl -X POST localhost:8080/v1/keys -H 'Content-Type: application/json' -d '{"name":"demo"}'
```

2. Create a webhook endpoint pointing at a mock receiver:

```bash
curl -X POST localhost:8080/v1/endpoints \
  -H 'Authorization: Bearer <KEY>' -H 'Content-Type: application/json' \
  -d '{"name":"orders","url":"http://127.0.0.1:8080/demo/orders","event_types":["order.created"]}'
```

3. Send an event:

```bash
curl -X POST localhost:8080/v1/events \
  -H 'Authorization: Bearer <KEY>' -H 'Content-Type: application/json' -H 'Idempotency-Key: order-1' \
  -d '{"event_type":"order.created","data":{"order_id":"ord_789","amount":2500}}'
```

4. Wait ~5s, then check delivery status:

```bash
curl localhost:8080/v1/deliveries?status=succeeded \
  -H 'Authorization: Bearer <KEY>'
```

5. Try failure paths:

- flaky: endpoint -> `/demo/orders-flaky` -> event -> first attempt 500, retry -> succeeded
- down: endpoint -> `/demo/orders-down` -> event -> dead_lettered after retries
- replay: `POST /v1/deliveries/:id/replay` with reason

## MVP limitations

- **Not a hosted SaaS yet.** No accounts, billing, quotas, dashboard or SDKs - see [`docs/SAAS_READINESS_AUDIT.md`](./docs/SAAS_READINESS_AUDIT.md).
- JSON store is still the default for local demo; use `SIGNALMESH_STORAGE=postgres` for durable atomic ingest and safe multi-worker claiming. Do not run the JSON store in production - it rewrites the whole file on every write.
- Rate limiting is in-process only (single instance); the effective limit in a multi-replica deployment is a multiple of the configured one. Move to Redis/PostgreSQL for multi-replica.
- No dashboard auth: `/dashboard` is a local demo UI (disabled in production by default).
- No OpenTelemetry traces yet (Prometheus `/metrics` is available).
- PromQL metrics currently carry no labels, so failures cannot be attributed to a specific endpoint from metrics alone.

## Guarantees

- **At-least-once delivery.** A webhook may be delivered more than once if a worker crashes mid-attempt. Deduplicate on `event_id` (also sent as `x-signalmesh-event-id`).
- **Durable before acknowledgement.** The event and its initial deliveries are committed in one transaction before `202 Accepted` is returned.
- **Tenant isolation.** Every query is scoped by `organization_id`; cross-tenant access returns `404`.
- **Signing.** Every request carries `x-signalmesh-signature` = `v1=HMAC-SHA256(secret, "<timestamp>.<body>")`. During a secret rotation the previous secret is also sent as `x-signalmesh-signature-previous`.

## Security

See [`SECURITY.md`](./SECURITY.md) for the security posture, reporting process and
known limitations.
