# SignalMesh

A self-hosted webhook event delivery engine: durable event fan-out, signed
HTTP deliveries, retries, dead-lettering and replay.

- API contract: [`api/openapi.yaml`](./api/openapi.yaml)
- Production runbook: [`docs/OPERATIONS.md`](./docs/OPERATIONS.md)
- Design history: [`SIGNALMESH_SPEC.md`](./SIGNALMESH_SPEC.md) — includes a
  descoped PostgreSQL/outbox design; the shipped engine is JSON-only.

## Quick start

```bash
npm install
npm run demo:reset    # seed a demo key and three mock receivers
npm run demo:server   # API + worker, fast retry settings, dashboard enabled
npm run demo:run      # exercise success, retry, dead-letter and replay
```

Open `http://127.0.0.1:8080/dashboard` and paste the key printed by
`demo:reset`. To use another port, set `PORT=8091` and
`SIGNALMESH_BASE_URL=http://127.0.0.1:8091`.

Run the plain server with `npm start`. It starts one process containing both
the API and the worker.

## How it works

```text
POST /v1/events
      |
      +-- write event + deliveries atomically, then return 202
              |
              +-- worker claims a due delivery under a lease
                      |
                      +-- sign -> HTTP POST -> record attempt
                              |
                              +-- succeeded | retry_scheduled | dead_lettered
```

- **Durable before acknowledgement.** A `202` is only returned after the event
  and its initial deliveries are on disk.
- **At-least-once delivery.** A delivery can repeat if a worker dies mid-attempt.
  Receivers deduplicate on `x-signalmesh-event-id`.
- **Signed requests.** Each POST carries `x-signalmesh-timestamp` and
  `x-signalmesh-signature: v1=HMAC-SHA256(secret, "<timestamp>.<raw body>")`.
- **Retries.** Network errors, timeouts, 408, 429 and 5xx use bounded
  exponential backoff with jitter; exhaustion dead-letters the delivery.
- **Replay and cancel.** Replay is allowed only for `succeeded` or
  `dead_lettered` deliveries. Cancel stops a pending or retry-scheduled
  delivery; an in-flight attempt is flagged `cancel_requested` and is not
  retried. `cancelled` deliveries cannot be replayed.
- **Idempotency.** An optional `Idempotency-Key` deduplicates ingestion and
  rejects a reused key with a different payload fingerprint.
- **Tenant isolation.** Keys belong to an organization; all reads and writes
  are scoped to it, with scopes enforced per route.

## API

All `/v1` routes require `Authorization: Bearer <KEY>` except the bootstrap
`POST /v1/keys`, which works only while no key exists. Error bodies have the
shape `{"error":{"code","message","request_id"}}`.

| Area       | Routes                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------- |
| Keys       | `POST/GET /v1/keys`, `POST /v1/keys/:id/revoke`                                              |
| Events     | `POST /v1/events`, `GET /v1/events`                                                          |
| Endpoints  | `POST/GET /v1/endpoints`, `GET/PATCH/DELETE /v1/endpoints/:id`, `POST .../rotate-secret`      |
| Deliveries | `GET /v1/deliveries`, `GET /v1/deliveries/:id`, `.../attempts`, `.../replay`, `.../cancel`    |
| Audit      | `GET /v1/audit`                                                                              |
| Operations | `GET /healthz`, `/readyz`, `/healthz/workers`, `/metrics`                                    |

See `api/openapi.yaml` for request bodies, response codes and pagination.

A minimal flow:

```bash
KEY=$(curl -s -X POST localhost:8080/v1/keys \
  -H 'Content-Type: application/json' -d '{"name":"demo"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).key.key')

curl -X POST localhost:8080/v1/endpoints \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"name":"orders","url":"http://127.0.0.1:8080/demo/orders","event_types":["order.created"]}'

curl -X POST localhost:8080/v1/events \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: order-1' \
  -d '{"event_type":"order.created","data":{"order_id":"ord_789"}}'
```

For fast dead-lettering locally, use `SIGNALMESH_MAX_ATTEMPTS=3` and
`SIGNALMESH_RETRY_MAX_DELAY_MS=30000` (already set by `npm run demo:server`).

## Configuration

Copy `.env.example` to `.env` and adjust it. Production requires:

- `SIGNALMESH_ENV=production`
- `SIGNALMESH_DATA_FILE` — absolute path on a persistent volume
- `SIGNALMESH_SECRET_ENCRYPTION_KEY` — 32-byte hex key for signing secrets
- `SIGNALMESH_API_KEY_PEPPER` — 32-byte hex pepper for API-key hashes

The process fails fast if any of these are missing or invalid. Other settings
cover retries, worker concurrency, rate limits, idempotency TTL, retention and
logging; see `.env.example` for the full list. `SIGNALMESH_ROLE` no longer
exists: there is one process, not separate API and worker deployments.

Secret-key rotation uses `SIGNALMESH_SECRET_ENCRYPTION_KEY_PREVIOUS`; see
[`docs/OPERATIONS.md`](./docs/OPERATIONS.md). The API-key pepper has no
rotation path, because changing it invalidates every stored key hash.

## Deployment

```bash
docker compose up --build
```

SignalMesh is one long-lived process with one durable volume. Do not run more
than one replica against the same data file. Serverless platforms are not
supported: the worker needs a long-lived process and the JSON store needs
durable local storage. For multiple hosts, place a shared queue/storage layer
in front of the service rather than sharing a file.

## Operations

Health, metrics, backup/restore, key rotation, retention and alerting are
documented in [`docs/OPERATIONS.md`](./docs/OPERATIONS.md).

In short: alert on `/healthz/workers`, which returns 503 when no heartbeat is
fresh; use `/readyz` for storage readiness; scrape `/metrics` for Prometheus
data. Audit write failures are logged and returned with
`X-Audit-Write-Failed: 1`, but are not automatically retried.

## Verification

```bash
npm run check                 # lint, formatting, tests, OpenAPI route-drift check
npm start &                   # or npm run demo:server
npm run smoke                 # end-to-end flow against localhost:8080
```

The test scripts use an explicit quoted glob (`"tests/*.test.js"`): passing a
bare `tests/` directory to `node --test` fails on Node 22/24 because those
versions treat arguments as paths, not directories. `npm run check` also fails
if a public Express route is missing from `api/openapi.yaml`, or vice versa;
demo and internal routes are deliberately excluded.

## Limitations and next steps

- The JSON store coordinates a single host only.
- Rate limiting is in-process; use a gateway for a hard multi-instance cap.
- `/dashboard` is an unauthenticated demo UI, disabled in production.
- Request signatures bind a timestamp, but neither the engine nor the mock
  receiver enforces a freshness window. Consumers must reject old timestamps.
- Backup/restore is a filesystem operation (see the runbook), not a CLI command.
- Audit failures are signalled but not queued for retry.

Prioritized next work: receiver timestamp-skew enforcement, a tested
backup/restore command, and release automation (CHANGELOG, tag, image publish).
