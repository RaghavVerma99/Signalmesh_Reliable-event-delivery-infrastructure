# SignalMesh MVP

Small working demo of **SignalMesh** - a webhook event delivery platform.
Full design: [`SIGNALMESH_SPEC.md`](./SIGNALMESH_SPEC.md)

## What this MVP does

- API key auth: `POST /v1/keys` (bootstrap) + `Authorization: Bearer <key>` for `/v1/*`
- Event ingestion: `POST /v1/events` -> `202 Accepted`, optional `Idempotency-Key`
- Endpoint registration: `POST /v1/endpoints` (url, event_types, timeout_seconds, max_attempts)
- Fan-out: event -> one delivery per matching active endpoint
- Worker: claims due deliveries, sends signed HTTP POST, bounded timeout, exponential backoff + jitter, retries on network/timeout/408/429/5xx, dead-letters on exhaustion
- Delivery states: `pending`, `processing`, `retry_scheduled`, `succeeded`, `dead_lettered`, `cancelled`
- Replay: `POST /v1/deliveries/:id/replay`
- Cancel: `POST /v1/deliveries/:id/cancel`
- Inspect: `GET /v1/deliveries`, `GET /v1/deliveries/:id`, `GET /v1/events`
- Health: `GET /healthz`, `GET /readyz`
- Mock receivers: `POST /demo/orders` (verifies HMAC signature), `POST /demo/orders-flaky` (fails once), `POST /demo/orders-down` (always fails)

## Run

```bash
npm install
npm test        # unit tests (node:test)
npm start
```

Server: http://localhost:8080 (override with `PORT` / `HOST`)

## Configuration

Copy `.env.example` to `.env` and adjust. Key variables:

- `SIGNALMESH_SECRET_ENCRYPTION_KEY` - 32-byte hex key for AES-256-GCM signing-secret encryption (required in production).
- `SIGNALMESH_API_KEY_PEPPER` - pepper for keyed API-key hashing (required in production).
- `SIGNALMESH_STORAGE` - `json` (local demo default) or `postgres`.
- `SIGNALMESH_DELIVERY_TIMEOUT_MS`, `SIGNALMESH_MAX_ATTEMPTS`, `SIGNALMESH_RETRY_BASE_DELAY_MS`, `SIGNALMESH_RETRY_MAX_DELAY_MS` - delivery/retry policy.

For a fast demo that dead-letters within seconds, set `SIGNALMESH_MAX_ATTEMPTS=3` and `SIGNALMESH_RETRY_MAX_DELAY_MS=30000`.

An end-to-end smoke test is available once the server is running:

```bash
node scripts/smoke.js http://127.0.0.1:8080
```

## Quick demo walkthrough

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

- JSON-file persistence (`data/db.json`) by default; a PostgreSQL store exists but is not yet wired for scheduling/claims.
- Single worker instance with in-process lease; no multi-replica queue.
- No rate limiting, dashboard, or OpenTelemetry yet (basic Prometheus `/metrics` exists).
- Tenant isolation not implemented; all API keys currently share the same data (demo scope).
- SSRF protection is blocklist-based at registration and delivery time; connected-IP re-check is still pending.
