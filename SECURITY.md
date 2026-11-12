# Security Policy

## Reporting a vulnerability

Please **do not open a public GitHub issue** for security problems.

Report privately via GitHub's **Security Advisories** tab on this repository
("Report a vulnerability"), or by email to the maintainers if advisories are
not enabled for this repo.

Include, where possible:

- what the issue is and which component is affected (`src/api.js`, `src/security.js`, ...)
- steps to reproduce, or a proof of concept
- the impact you believe it has
- any suggested mitigation

You will get an acknowledgement within 72 hours and a status update within 7
days. Please give the maintainers a reasonable window to ship a fix before
disclosing publicly.

## Supported versions

Security fixes are applied to the latest released version. Older tags are not
patched - please upgrade.

## Security posture of the current release

SignalMesh is designed so that a self-hosted operator can reason about the
trust boundary:

| Area | Behaviour |
|---|---|
| API keys | Stored as a keyed HMAC-SHA256 hash (`SIGNALMESH_API_KEY_PEPPER`). The raw key is returned exactly once, at creation |
| Signing secrets | Encrypted at rest with AES-256-GCM (`SIGNALMESH_SECRET_ENCRYPTION_KEY`). Returned exactly once, at creation |
| Tenant isolation | Every query is scoped by `organization_id`. Cross-tenant reads return `404`, not `403`, so existence is not leaked |
| Key scopes | Enforced per route. A key without the required scope receives `403` |
| SSRF | Private/loopback/link-local/multicast ranges and sensitive ports are blocked; the destination is re-resolved at delivery time and the **actual connection address** is validated, which closes the DNS-rebinding window. Redirects are never followed |
| Secrets in logs | API keys and signing secrets are never logged. The destination's response body is stored (capped by `SIGNALMESH_MAX_RESPONSE_BYTES`) and is visible to the tenant through the API - treat it as tenant data |
| Transport | HTTPS is required for endpoints in production (`SIGNALMESH_ENV=production`). TLS termination for the API itself is expected at the ingress |

### Known limitations

- The encryption key is a single static secret. Rotating it invalidates every stored endpoint secret. A KMS-backed, versioned key is on the roadmap.
- The rate limiter is in-process. In a multi-replica deployment the effective limit is a multiple of the configured one. A shared limiter is on the roadmap.
- The audit log is append-only but not tamper-evident (no hash chaining).
- There is no per-key IP allowlist.
