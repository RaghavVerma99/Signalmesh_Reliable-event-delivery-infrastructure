# Deploying SignalMesh on Vercel

## Verdict

| Piece | Vercel? | Why |
|---|---|---|
| **API** (`/v1/*`, health, metrics, dashboard) | ✅ Yes | Stateless request/response; works with external PostgreSQL |
| **Delivery worker** | ❌ No (not natively) | Vercel functions are request-scoped and frozen after the response; no long-lived `setInterval` worker |
| **Whole app on Vercel only** | ⚠️ Demo only | Possible via a scheduler-driven tick endpoint; poor latency/throughput, not production-grade |

**Recommendation:** deploy the API on Vercel and the worker on a long-running host (Railway, Fly.io, Render, or a VPS). If you want a single platform, use that container host for everything instead.

## Why the full app fails on Vercel

1. **No background process.** The worker polls with `setInterval`; serverless functions don't stay alive.
2. **No persistent filesystem.** The JSON store writes to `data/db.json`; Vercel's filesystem is ephemeral/read-only except `/tmp`.
3. **No `app.listen`.** Vercel needs an exported handler; `src/server.js` starts a listener.
4. **Cold-start migrations.** Multiple instances could race; we added a PostgreSQL advisory lock, but you should run migrations during deploy instead.
5. **Per-instance state.** Rate-limit buckets and Prometheus counters reset per function instance.

## Recommended architecture (split)

```
           +-----------------------+
Producers →|  Vercel: API function |→ PostgreSQL (Neon/Supabase, pooled)
           +-----------------------+
                        ↑
           +-----------------------+
           | Worker (Railway/Fly)  |→ outbound webhooks
           +-----------------------+
```

## Step-by-step

### 1. Provision PostgreSQL

Use a managed Postgres with a **pooled** connection string (Neon pooler, Supabase pooler, or PgBouncer). Serverless functions open many short-lived connections; pooling is required.

### 2. Run migrations (from your machine or CI)

```bash
SIGNALMESH_STORAGE=postgres \
DATABASE_URL='postgres://...' \
npm run migrate
```

### 3. Deploy the API to Vercel

The repo already contains:

- `api/index.js` — exports the Express app as a Vercel handler (lazy, single-init).
- `vercel.json` — routes `/v1/*`, health, metrics, dashboard, and demo paths to the function.
- `.vercelignore` — excludes tests/docs/data.

```bash
npm i -g vercel
vercel            # preview
vercel --prod     # production
```

Set these environment variables in the Vercel project:

| Variable | Value |
|---|---|
| `SIGNALMESH_ENV` | `production` |
| `SIGNALMESH_STORAGE` | `postgres` |
| `DATABASE_URL` | pooled Postgres URL |
| `SIGNALMESH_SECRET_ENCRYPTION_KEY` | `openssl rand -hex 32` |
| `SIGNALMESH_API_KEY_PEPPER` | `openssl rand -hex 32` |
| `SIGNALMESH_SKIP_MIGRATIONS` | `true` (run migrations in step 2) |
| `SIGNALMESH_ENABLE_DASHBOARD` | `false` |
| `SIGNALMESH_RATE_LIMIT_PER_MINUTE` | e.g. `600` |

> The server refuses to start in production without `SIGNALMESH_SECRET_ENCRYPTION_KEY`.

### 4. Deploy the worker on a long-running host

Use the existing `Dockerfile` and run the worker entrypoint:

```bash
node src/worker-main.js
```

On Railway / Fly.io / Render:

- Build from the repo `Dockerfile`.
- Start command: `node src/worker-main.js`.
- Use the **same** `DATABASE_URL`, `SIGNALMESH_STORAGE=postgres`, and secrets.
- Set `SIGNALMESH_WORKER_CONCURRENCY` (e.g. `4`).
- Scale the worker replicas freely; `FOR UPDATE SKIP LOCKED` makes claiming safe.

### 5. Verify

```bash
curl https://<app>.vercel.app/healthz
curl https://<app>.vercel.app/readyz
```

Then run the API flow (key → endpoint → event) and confirm the worker moves deliveries to `succeeded`.

## Vercel-only option (scheduler-driven tick)

If you insist on Vercel-only, the API exposes an optional tick endpoint:

```
GET|POST /internal/worker-tick
Authorization: Bearer <SIGNALMESH_INTERNAL_TOKEN>
```

It runs one bounded worker tick (`SIGNALMESH_WORKER_CONCURRENCY` deliveries) whenever called. Enable it by setting `SIGNALMESH_INTERNAL_TOKEN`; it returns `404` otherwise.

**With Vercel Cron (Pro plan):**

```json
{
  "crons": [{ "path": "/internal/worker-tick", "schedule": "* * * * *" }]
}
```

Set `CRON_SECRET` and `SIGNALMESH_INTERNAL_TOKEN` to the same value; Vercel sends `Authorization: Bearer <CRON_SECRET>`.

**Or with GitHub Actions:**

```yaml
on:
  schedule: [{ cron: '* * * * *' }]
jobs:
  tick:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -fsS -X POST https://<app>.vercel.app/internal/worker-tick \
            -H "Authorization: Bearer ${{ secrets.SIGNALMESH_INTERNAL_TOKEN }}"
```

**Limits of this approach**

- Delivery latency is bounded by the cron frequency (1 minute+).
- Each tick processes at most `SIGNALMESH_WORKER_CONCURRENCY` deliveries.
- Vercel Hobby cron is daily; Pro is required for per-minute.
- Slow receivers can hit the function duration limit (10s default).
- Cold starts add latency.
- No graceful drain or lease heartbeat.

Use this for demos and very low volume only.

## Operational notes specific to Vercel

- **Rate limiting is per function instance.** Limits effectively multiply per concurrent instance. Pin to one region/instance if you rely on it, or implement a shared limiter.
- **Prometheus metrics are per instance.** Scrape from a long-running instance or use the worker; Vercel function counters are not aggregated.
- **Connection pooling:** use a pooled provider; `pg.Pool` inside a function can exhaust connections under load.
- **Function duration:** `vercel.json` sets `maxDuration: 10`; raise it on Pro if needed (ingestion is fast and should not need more).
- **No filesystem:** always `SIGNALMESH_STORAGE=postgres`.

## If you want a single platform

Skip Vercel and deploy both API and worker from the existing Docker setup:

```bash
docker compose --profile split up --build   # API + worker + PostgreSQL
```

or use Railway/Fly.io/Render with two services sharing one Postgres. This is simpler and strictly better for a delivery engine than Vercel-only.
