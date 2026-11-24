# SignalMesh operations

JSON is the only storage backend. One process runs the API and the worker and
owns one data file. There is no database server and no serverless deployment.

## Health and metrics

| Endpoint            | Meaning                                                                 | On failure                                                      |
| ------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------- |
| `GET /healthz`      | Process is alive.                                                       | Restart the process.                                            |
| `GET /readyz`       | Storage is reachable; reports worker count as information only.         | 503 means this process cannot persist requests; remove it from rotation. |
| `GET /healthz/workers` | At least one heartbeat is newer than `SIGNALMESH_WORKER_HEALTH_MAX_AGE_MS`. | 503 means delivery has stopped while ingestion may continue. Alert here. |
| `GET /metrics`      | Prometheus text exposition, including delivery duration histograms.     | Scrape for ingestion errors, dead letters and worker activity.  |

`/readyz` deliberately stays healthy when workers are stale: rejecting events
would turn a partial outage into a total one. Alert on `/healthz/workers`
instead.

## Data file

- Default: `data/db.json`; production requires an absolute
  `SIGNALMESH_DATA_FILE` on a persistent volume.
- Writes go to a temporary file in the same directory, are `fsync`ed, then
  renamed over the data file. The directory is also `fsync`ed where the OS
  permits it. A failed write leaves the previous file intact.
- Startup fails closed on a corrupt or unreadable file; it never starts with
  an empty state.
- Only one process may write this file. Do not run replicas or a separate
  API/worker process against the same volume.

The file contains encrypted webhook signing secrets and hashed API keys.
Backups need the same protection as the live data directory.

### Backup

Preferred: take a filesystem/volume snapshot of the directory containing the
data file. Because writes are atomic renames, a snapshot sees either the old
or the new complete file.

Without snapshots, stop the process cleanly and copy the file:

```bash
sudo systemctl stop signalmesh
sudo cp /var/lib/signalmesh/db.json /var/backups/signalmesh/db.json.<timestamp>
sudo systemctl start signalmesh
```

### Restore

1. Stop the process.
2. Replace the data file with the chosen backup, preserving ownership and
   permissions.
3. Start with the **same** `SIGNALMESH_SECRET_ENCRYPTION_KEY` (and
   `SIGNALMESH_SECRET_ENCRYPTION_KEY_PREVIOUS`, if a rotation is in progress)
   and the same `SIGNALMESH_API_KEY_PEPPER` used when the backup was taken.
4. Confirm `GET /readyz` returns 200, `GET /healthz/workers` returns 200, and
   spot-check `GET /v1/events`, `GET /v1/deliveries` and `GET /v1/keys`.

Restoring older state can replay events: delivery is at-least-once, so
receivers must deduplicate on `x-signalmesh-event-id`.

## Key rotation

### Webhook signing secrets

Encrypted secrets are tagged with a short key ID. The previous key stays
readable while it is configured.

1. Set `SIGNALMESH_SECRET_ENCRYPTION_KEY` to the new 32-byte hex key.
2. Set `SIGNALMESH_SECRET_ENCRYPTION_KEY_PREVIOUS` to the old key.
3. Restart the service. Existing secrets still decrypt; new writes use the new
   key.
4. Call `POST /v1/endpoints/:id/rotate-secret` for each endpoint so its stored
   secret is re-encrypted with the new key.
5. Once no ciphertext uses the old key ID, remove the `..._PREVIOUS` variable
   and restart. A missing required key fails loudly instead of producing
   invalid signatures.

### API-key pepper

`SIGNALMESH_API_KEY_PEPPER` hashes stored API keys. There is no rotation path:
changing it invalidates every key hash, so all clients would need new keys.
Treat it as permanent and back it up with the same care as the data file.

## Retention

The worker runs a maintenance sweep every `SIGNALMESH_SWEEP_INTERVAL_MS`
(default 15 minutes), including when the queue is idle. It removes:

- expired idempotency keys (`SIGNALMESH_IDEMPOTENCY_TTL_MS`),
- events older than `SIGNALMESH_RETENTION_EVENT_DAYS`,
- deliveries older than `SIGNALMESH_RETENTION_DELIVERY_DAYS`,
- audit records older than `SIGNALMESH_RETENTION_AUDIT_DAYS`.

Set a retention value to `0` to keep that category forever. Retention is also
the mechanism that bounds data-file size; there is no separate compaction
command.

## Audit failures

A domain mutation is committed before its audit record is written. If the
audit write fails, the request still returns its normal 2xx response with
`X-Audit-Write-Failed: 1`, and an `audit_write_failed` error log includes the
request ID and action. There is no automatic retry. After an incident, query
`GET /v1/audit` and reconcile missing actions manually.

## Receiver requirements

- Verify the HMAC over the exact raw request body and the
  `x-signalmesh-timestamp` header. Do not re-serialize JSON before verifying.
- Reject timestamps outside a short window (for example, five minutes). The
  engine signs the timestamp but does not enforce freshness for you.
- Deduplicate on `x-signalmesh-event-id`, because delivery is at-least-once.
- During secret rotation, verify against both `x-signalmesh-signature` and
  `x-signalmesh-signature-previous` while the old secret is still active.

The bundled `/demo/orders` receiver implements signature and rotation checks
over raw bytes; it is a local example, not a production receiver.

## Local verification

```bash
npm run check                 # lint, format, tests, OpenAPI route drift
npm run demo:reset
npm run demo:server
npm run smoke                 # end-to-end flow against localhost:8080
```
