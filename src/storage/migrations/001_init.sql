-- SignalMesh initial schema (PostgreSQL).
-- IDs are application-generated TEXT (evt_..., dlv_..., ep_..., key_...) for
-- parity with the JSON store and public identifiers.

CREATE TABLE IF NOT EXISTS organizations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  key_hash        TEXT NOT NULL UNIQUE,
  prefix          TEXT NOT NULL,
  scopes          JSONB NOT NULL DEFAULT '["admin"]'::jsonb,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_keys_org_idx ON api_keys (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,
  data            JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at     TIMESTAMPTZ,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_org_created_idx ON events (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS endpoints (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  url             TEXT NOT NULL,
  event_types     JSONB NOT NULL DEFAULT '["*"]'::jsonb,
  active          BOOLEAN NOT NULL DEFAULT true,
  signing_secret  TEXT NOT NULL,
  timeout_ms      INTEGER NOT NULL,
  max_attempts    INTEGER NOT NULL,
  base_delay_ms   INTEGER NOT NULL,
  max_delay_ms    INTEGER NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS endpoints_org_idx ON endpoints (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS deliveries (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_id        TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,
  endpoint_id     TEXT NOT NULL REFERENCES endpoints(id),
  status          TEXT NOT NULL,
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  locked_by       TEXT,
  locked_until    TIMESTAMPTZ,
  last_status_code INTEGER,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deliveries_due_idx ON deliveries (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS deliveries_org_created_idx ON deliveries (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS deliveries_event_idx ON deliveries (event_id);
CREATE INDEX IF NOT EXISTS deliveries_endpoint_idx ON deliveries (endpoint_id, created_at DESC);

CREATE TABLE IF NOT EXISTS delivery_attempts (
  id               TEXT PRIMARY KEY,
  delivery_id      TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  attempt_number   INTEGER NOT NULL,
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  status_code      INTEGER,
  duration_ms      INTEGER,
  error_class      TEXT,
  response_excerpt TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (delivery_id, attempt_number)
);
CREATE INDEX IF NOT EXISTS attempts_delivery_idx ON delivery_attempts (delivery_id, attempt_number);

CREATE TABLE IF NOT EXISTS idempotency_records (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  operation       TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  response_status INTEGER,
  response_body   JSONB,
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, operation, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idempotency_expiry_idx ON idempotency_records (expires_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id              TEXT PRIMARY KEY,
  organization_id TEXT,
  actor_key_id    TEXT,
  action          TEXT NOT NULL,
  resource_type   TEXT,
  resource_id     TEXT,
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_org_created_idx ON audit_log (organization_id, created_at DESC);
