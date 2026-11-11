# Demo & Deployment Readiness Guide

This guide separates two different bars:

- **Demo-ready** (~now): reliable, repeatable, impressive to show live or recorded.
- **Deployment-ready** (after hardening): safe to expose to real producers, with durability and isolation guarantees.

Only the first is achievable with the current Node MVP without the PostgreSQL/tenant work described in `docs/NODE_STRATEGY.md`.

---

## Part A - Demo readiness

### A.1 What is already in place

- One-command Docker image + `docker compose` service (`Dockerfile`, `docker-compose.yml`).
- Seed script that creates one API key and three demo endpoints (`scripts/seed.js`).
- Scenario runner that proves success, retry, dead-letter, and replay (`scripts/demo.js`).
- Fast-demo server profile so dead-lettering completes in seconds (`scripts/demo-server.js`).
- Live dashboard at `/dashboard` with events, deliveries, status pills, and one-click replay.
- HMAC-signed deliveries verified by the demo receiver.
- Structured JSON logs, `/healthz`, `/readyz`, `/metrics`.

### A.2 The 3-terminal demo run

Terminal 1 (seed a clean state):

```bash
npm run demo:reset
```

Terminal 2 (start with fast retry settings + dashboard):

```bash
npm run demo:server
```

Terminal 3 (drive the scenario):

```bash
npm run demo:run
```

Then open `http://127.0.0.1:8080/dashboard` and paste the API key printed by the seed step.

> **Port conflict:** if 8080 is already in use, run everything on another port:
>
> ```bash
> # terminal 1
> SIGNALMESH_BASE_URL=http://127.0.0.1:8091 npm run demo:reset
> # terminal 2
> PORT=8091 npm run demo:server
> # terminal 3
> SIGNALMESH_BASE_URL=http://127.0.0.1:8091 npm run demo:run
> ```
>
> On PowerShell, set env vars with `$env:PORT='8091'; npm run demo:server`.

### A.3 The 5-act demo script (talking points)

1. **Ingest** - `POST /v1/events` returns `202` immediately; delivery is async. Point out the idempotency key and that a retry returns the original event.
2. **Happy path** - delivery reaches `succeeded`; the receiver verified the HMAC signature.
3. **Retry** - flaky receiver returns `500` once; worker backs off with jitter and succeeds on attempt 2.
4. **Dead-letter** - down receiver exhausts retries; delivery becomes `dead_lettered` with `retry_exhausted`.
5. **Replay** - operator replays the dead-lettered delivery; a new delivery is created, original history preserved.

Close on the dashboard showing all states and the `/metrics` endpoint.

### A.4 Pre-demo checklist (15 minutes before)

- [ ] `npm install` succeeds and `npm test` is green (11 tests).
- [ ] `npm run demo:reset` run fresh (old `data/db.json` removed).
- [ ] Demo port is free (or `PORT`/`SIGNALMESH_BASE_URL` set consistently).
- [ ] `SIGNALMESH_ENABLE_DASHBOARD=true` (default outside production).
- [ ] Browser tab pre-opened to `/dashboard`, API key pasted.
- [ ] Optional: record a backup screen capture in case the live network fails.

### A.5 Docker demo

```bash
docker compose up --build
# then open http://localhost:8080/dashboard
```

The container persists `data/` in the `signalmesh-data` volume. To reset the demo:

```bash
docker compose down -v && docker compose up --build
```

### A.6 Demo limitations to state honestly

- Single process; worker runs inside the API process.
- JSON-file persistence, not a transactional database.
- No tenant isolation; all keys share one dataset.
- No rate limiting.
- Demo receiver counters (`/demo/orders-flaky`) reset on restart.

---

## Part B - Deployment readiness

### B.1 Hard blockers before exposing to real producers

Do **not** deploy publicly until these are resolved:

- [x] **Tenant isolation** - implemented (`organization_id` scoping + tests).
- [x] **Durable, atomic storage** - PostgreSQL store with atomic ingest and `SKIP LOCKED` claiming; run `npm run migrate`.
- [x] **Rate limiting** - tenant token bucket (in-process; move to Redis/PG for multi-replica).
- [ ] **Secrets configured** - set `SIGNALMESH_SECRET_ENCRYPTION_KEY` and `SIGNALMESH_API_KEY_PEPPER`; in `SIGNALMESH_ENV=production` the server refuses to start without the encryption key.
- [ ] **TLS termination** - terminate HTTPS at a reverse proxy (Caddy/nginx/ALB); the app speaks plain HTTP.
- [ ] **Backups** - back up PostgreSQL (or the `data/` volume for JSON demos) and test restore.
- [x] **Audit logging** - append-only, tenant-scoped, exposed at `GET /v1/audit`.

### B.2 Recommended production architecture (after blockers)

```
Internet -> TLS reverse proxy (Caddy/nginx) -> signalmesh API container
                                                     |
                                            PostgreSQL (durable queue)
                                                     |
                                            worker container(s)
```

- Run **separate API and worker processes** so they scale independently.
- Use PostgreSQL as the source of truth (see `docs/NODE_STRATEGY.md`, Milestone 2).
- Terminate TLS at the proxy; keep the app on a private network.
- Put the app behind a process supervisor (Docker restart policy, systemd, or a platform).

### B.3 Configuration (production)

Minimum environment for a real deployment:

```dotenv
SIGNALMESH_ENV=production
PORT=8080
SIGNALMESH_STORAGE=postgres
SIGNALMESH_DB_HOST=...
SIGNALMESH_DB_PORT=5432
SIGNALMESH_DB_NAME=signalmesh
SIGNALMESH_DB_USER=...
SIGNALMESH_DB_PASSWORD=...
SIGNALMESH_DB_SSL=true

# Generate with: openssl rand -hex 32
SIGNALMESH_SECRET_ENCRYPTION_KEY=<hex>
SIGNALMESH_API_KEY_PEPPER=<hex>

SIGNALMESH_MAX_ATTEMPTS=8
SIGNALMESH_RETRY_BASE_DELAY_MS=2000
SIGNALMESH_RETRY_MAX_DELAY_MS=3600000
SIGNALMESH_DELIVERY_TIMEOUT_MS=10000
SIGNALMESH_ENABLE_DASHBOARD=false
```

Rules:

- Never commit real values; use your platform's secret store.
- Rotate keys on a schedule and keep an overlap window for signing secrets.
- Set `SIGNALMESH_ENABLE_DASHBOARD=false` in production (the dashboard is unauthenticated shell + client-side key entry).

### B.4 Deployment options

| Option | Best for | Notes |
|---|---|---|
| Docker Compose on a VPS | Self-hosted MVP | All-in-one or `--profile split`; add Caddy for TLS; back up PostgreSQL |
| Single container on Fly.io / Render / Railway | Fast public demo | JSON store needs a persistent volume; for durability use PostgreSQL |
| Kubernetes / multi-replica | Now viable with PostgreSQL | Scale **workers** freely (`SKIP LOCKED`); API is stateless but the rate limiter is per-process |

Multiple worker replicas are safe with the PostgreSQL store. If you scale the API horizonally, move rate limiting to Redis/PostgreSQL so limits are shared.

### B.5 Observability for deployment

- [ ] Scrape `/metrics` (Prometheus) and alert on: oldest pending age, dead-letter rate, worker_active_count stuck at 0 while queue > 0.
- [ ] Ship stdout JSON logs to your log platform; ensure `request_id`, `organization_id`, `event_id`, `delivery_id` are indexed.
- [x] `/readyz` checks storage reachability (ping) before routing traffic.
- [x] Worker heartbeat metric: `worker_last_tick_timestamp_seconds`.

### B.6 CI/CD

- [x] GitHub Actions: `npm ci`, `npm test`, `npm audit --omit=dev`, PostgreSQL service, Docker build (`.github/workflows/ci.yml`).
- [ ] Build and push the Docker image on tags.
- [x] Migration step available (`npm run migrate`); wire it into deploy.
- [ ] Add a smoke test against the deployed URL (`scripts/smoke.js`).

### B.7 Security checklist for deployment

- [ ] TLS everywhere; HSTS at the proxy.
- [ ] Secrets in a vault, not env files committed to disk.
- [ ] SSRF: delivery-time re-check + connection-time validating lookup are in place; keep outbound egress controls too.
- [ ] Disable redirects (already `manual`).
- [ ] Restrict outbound egress at the network layer.
- [ ] Add request/response size limits at the proxy too.
- [ ] Enable DB TLS and least-privilege DB users.
- [ ] Run `npm audit` and patch dependencies.
- [ ] Back up and test restore; define retention.
- [ ] Document incident runbooks (queue backlog, dead-letter spike, worker down).

### B.8 Go/No-Go checklist

| Question | Demo | Public deployment |
|---|---|---|
| Can a producer send an event and get `202`? | Yes | Yes |
| Are events durable across a crash? | Partial (JSON) | Yes, with PostgreSQL |
| Are tenants isolated? | Yes | Yes |
| Is abuse rate-limited? | Yes (per process) | Yes; shared limiter for multi-replica |
| Are secrets encrypted/hashed? | Yes (dev fallback) | Yes, with keys set |
| Is there TLS? | No | Required at proxy |
| Can it scale horizontally? | Workers: yes (PostgreSQL) | Workers: yes; API: needs shared limiter |

Use the Demo column to present; use the Public deployment column as your pre-launch gate.

---

## Part C - Suggested next steps

1. ~~Tenant model + PostgreSQL + migrations~~ - done.
2. ~~Rate limiting + audit logging~~ - done.
3. ~~PostgreSQL scheduling + API/worker split~~ - done.
4. ~~Integration tests + CI~~ - done.
5. Remaining hardening: connected-IP SSRF validation, shared rate limiter for multi-replica, worker heartbeat, OpenTelemetry, secret rotation, OpenAPI, load/failure-injection benchmarks.
