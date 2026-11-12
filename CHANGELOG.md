# Changelog

All notable changes to SignalMesh are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Idempotency TTL is now enforced.** `expires_at` was written but never read,
  so an expired `Idempotency-Key` replayed the original response forever. The
  retention period in `SIGNALMESH_IDEMPOTENCY_TTL_MS` now takes effect, and
  expired records are swept.
- **Attempt history is now readable.** Attempts were persisted but never
  exposed. Added `GET /v1/deliveries/:id/attempts`; `GET /v1/deliveries/:id`
  now also embeds the attempt list. This is what a customer needs to find out
  why a webhook failed.
- **Cursor pagination no longer skips rows.** Cursors were a bare timestamp, so
  rows sharing a millisecond were silently dropped. Cursors are now opaque and
  keyset-based over `(created_at, id)`.
- **API key scopes are now enforced.** Scopes were stored but never checked, so
  a read-only key had full write access. Scope violations return `403`.
- **Duplicate deliveries from long-running attempts are prevented.** An
  endpoint timeout longer than the worker lease could cause a delivery to be
  reclaimed while its first attempt was still in flight. Endpoint timeouts and
  attempt counts are now capped, and the worker renews the lease for as long as
  an attempt is running.
- **`GET /v1/events` no longer issues one COUNT query per event.** A single
  aggregate query replaces the N+1 pattern.
- **`SIGNALMESH_LOG_LEVEL` is now honoured** across the API, worker and store.
- **Audit log and endpoint listing are now paginated.** `next_cursor` was
  always `null` for both.

### Added

- Data retention: `SIGNALMESH_RETENTION_EVENT_DAYS`,
  `SIGNALMESH_RETENTION_DELIVERY_DAYS`, `SIGNALMESH_RETENTION_AUDIT_DAYS`, swept
  periodically by the worker.
- Worker liveness heartbeats (`worker_heartbeats` table) and
  `GET /healthz/workers` for alerting. `/readyz` intentionally still succeeds
  when no worker is alive - see `docs/SAAS_READINESS_AUDIT.md`.
- `POST /v1/keys` accepts a `scopes` array.
- `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `.github/CODEOWNERS`.
- `docs/SAAS_READINESS_AUDIT.md` - product, platform, security and
  engineering-practice gap analysis with a prioritised roadmap.
- ESLint 10 (flat config) and Prettier, with `npm run lint`,
  `npm run format:check` and `npm run check` scripts.

### Changed

- Delivery attempt numbering, endpoint listing and audit listing are now
  stable, ordered by `(created_at DESC, id DESC)`.
- `npm audit` is now a blocking CI job at the `high` severity threshold
  (previously non-blocking).
- The JSON store now refuses to start when `SIGNALMESH_ENV=production`.
- The whole codebase was normalised with Prettier.

## [0.1.0] - 2026-11-11

- Initial MVP: tenant isolation, API-key auth, event ingestion with
  idempotency, endpoint CRUD, fan-out delivery with retries and
  dead-lettering, replay/cancel, audit log, Prometheus metrics, Docker
  Compose, PostgreSQL backend with `FOR UPDATE SKIP LOCKED` claiming,
  API/worker split, SSRF protection at registration and delivery time.

[Unreleased]: https://github.com/your-org/signalmesh/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/your-org/signalmesh/releases/tag/v0.1.0
