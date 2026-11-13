-- Worker liveness.
--
-- Readiness must reflect whether deliveries are actually being processed.
-- Each worker upserts a row on every tick; rows older than a few minutes
-- are pruned so the table stays tiny and a crashed worker's row ages out.

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_id    TEXT PRIMARY KEY,
  role         TEXT NOT NULL DEFAULT 'worker',
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS worker_heartbeats_seen_idx ON worker_heartbeats (last_seen_at DESC);
