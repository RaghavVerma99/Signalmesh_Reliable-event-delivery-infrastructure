# SignalMesh

A **webhook event delivery engine** — reliable event fan-out with signed
deliveries, retries, dead-lettering and replay.

Full design: [`SIGNALMESH_SPEC.md`](./SIGNALMESH_SPEC.md) ·
API contract: [`api/openapi.yaml`](./api/openapi.yaml)

## Core concepts demonstrated

- **Durable before acknowledgement** — an event and its initial deliveries are
  persisted before `202 Accepted` is returned.
- **At-least-once delivery** — a delivery may happen more than if a worker dies
  mid-attempt; receivers deduplicate on `event_id`
  (`x-signalmesh-event-id` header).
- **Tenant isolation** — every API key belongs to an organization; all reads and
  writes are scoped to it. Cross-tenant access returns `404`.
- **API key auth + scopes** — keys are limited to `events:*`, `endpoints:*`,
  `deliveries:*`, `keys:*`, `audit:read`; enforced per route.
- **Signed deliveries** — every outbound request carries
  `x-signalmesh-signature: v1=HMAC-SHA256(secret, "<timestamp>.<body>")`.
- **Retries with backoff + jitter** — exponential backoff on
  network/timeout/408/429/5xx; dead-letter after exhaustion.
- **Delivery states** — `pending` → `processing` → `succeeded` |
  `retry_scheduled` | `dead_lettered` | `cancelled`.
- **Attempt history** — status code, duration, error class and response excerpt
  for every outbound attempt.
- **Replay / cancel** — re-drive a dead-lettered or succeeded delivery; cancel a
  pending one.
- **Idempotent ingestion** — optional `Idempotency-Key` with TTL + fingerprint
  conflict detection.
- **Observability** — structured JSON logs, Prometheus `/metrics`, health
  endpoints, audit log, keyset cursor pagination, per-tenant rate limiting.

## Run the demo

```bash
npm install
npm run demo:reset    # seed a clean key + 3 demo endpoints (receiver mocks)
npm run demo:server   # start with fast-demo retry settings + dashboard
npm run demo:run      # prove success, retry, dead-letter, replay
```

Open `http://127.0.0.1:8080/dashboard` and paste the API key printed by
`demo:reset`. If port 8080 is taken, use `PORT=8091` and
`SIGNALMESH_BASE_URL=http://127.0.0.1:8091`.

Server only:

```bash
npm start            # API + worker in one process (JSON file store)
```

## Manual walkthrough (curl)

1. Create a key (bootstrap — only works while zero keys exist):

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
curl localhost:8080/v1/deliveries?status=succeeded -H 'Authorization: Bearer <KEY>'
```

5. Failure paths:

- flaky: endpoint -> `/demo/orders-flaky` -> first attempt 500, retry -> succeeded
- down: endpoint -> `/demo/orders-down` -> dead_lettered after retries
- replay: `POST /v1/deliveries/:id/replay` with a reason

For fast dead-lettering in a manual run, set `SIGNALMESH_MAX_ATTEMPTS=3` and
`SIGNALMESH_RETRY_MAX_DELAY_MS=30000` (the demo server script already does).

## Configuration

Copy `.env.example` to `.env` and adjust. Key variables:

- `SIGNALMESH_SECRET_ENCRYPTION_KEY` - 32-byte hex key for AES-256-GCM
  signing-secret encryption.
- `SIGNALMESH_API_KEY_PEPPER` - pepper for keyed API-key hashing.
- `SIGNALMESH_DELIVERY_TIMEOUT_MS`, `SIGNALMESH_MAX_ATTEMPTS`,
  `SIGNALMESH_RETRY_BASE_DELAY_MS`, `SIGNALMESH_RETRY_MAX_DELAY_MS` -
  delivery/retry policy.
- `SIGNALMESH_WORKER_CONCURRENCY`, `SIGNALMESH_WORKER_POLL_INTERVAL_MS` -
  worker tuning.
- `SIGNALMESH_LOG_LEVEL` - `debug` | `info` | `warn` | `error` | `silent`.

## Architecture

```
                 POST /v1/events
                       |
            persist event + deliveries          (durable, then 202)
                       |
             worker: claim -> sign -> POST     (backoff + jitter on failure)
                       |
        succeeded | retry_scheduled | dead_lettered
                       |
        POST /v1/deliveries/:id/replay  (re-drive)
```

- `src/server.js` — single process: HTTP API + background worker.
- `src/app.js` — REST routes, auth, scopes, rate limiting, mock receivers.
- `src/worker.js` — concurrent claims, signed HTTP POST, retry policy.
- `src/storage/json.js` — JSON file store used by the demo.
- `scripts/` — seed (`demo:reset`), demo server (`demo:server`), scripted
  demo run (`demo:run`).

## Demo limitations

- JSON file store is for the local demo only — it rewrites the whole file on
  every write and has no cross-process guarantees.
- Rate limiting is in-process (single instance).
- The `/dashboard` page is a local demo UI with no auth.
