# Contributing to SignalMesh

Thanks for taking the time. This document covers the mechanics; the product
direction is tracked in `docs/SAAS_READINESS_AUDIT.md`.

## Development setup

```bash
git clone <repo>
cd signalmesh
npm install
npm test
```

You need Node.js >= 22 (`node --version`). A local PostgreSQL is optional - the
default JSON store is enough for development.

```bash
# PostgreSQL-backed development
export SIGNALMESH_STORAGE=postgres
export DATABASE_URL=postgres://signalmesh:signalmesh@localhost:5432/signalmesh
npm run migrate
npm start
```

Docker is also available:

```bash
docker compose up --build                    # all-in-one, JSON store
docker compose --profile split up --build    # API + worker + PostgreSQL
```

## Making a change

1. **Branch** off `main` with a descriptive name (`fix/lease-renewal`, `feat/attempts-api`).
2. **Write a test.** Every behavioural change needs a test that fails without it.
   The PostgreSQL-only paths need a case in `tests/postgres.integration.test.js`,
   which CI runs against a real database.
3. **Keep the store contract in sync.** `src/storage/json.js` and
   `src/storage/postgres.js` implement the same interface. If you add a method,
   add it to both.
4. **Update the API contract** in `api/openapi.yaml` when you change a request or
   response shape.
5. **Update the docs** you touched - `README.md`, `docs/CHECKLIST.md`.
6. **Add a changelog entry** under `CHANGELOG.md` -> `Unreleased`.

## Checks that must pass

```bash
npm test          # unit + integration (node:test)
npm run lint      # eslint
npm run format    # prettier --check
```

CI additionally runs the PostgreSQL integration suite, `npm audit`, a container
build and a secret scan. All of them must be green.

## Commit messages

Follow Conventional Commits:

```
feat(api): expose delivery attempt history
fix(worker): renew the lease while an attempt is in flight
docs(readme): document the new scope model
chore(deps): bump express to 4.21.2
```

## Security issues

Do not open a public issue. See `SECURITY.md`.

## Reporting bugs

Open an issue with:

- what you did, what you expected, what happened
- the SignalMesh version (commit SHA) and storage backend (`json` / `postgres`)
- the relevant log lines (redact API keys and signing secrets)
- a minimal reproduction if you have one

## Code style

- CommonJS, no build step for the application code.
- Structured JSON logging only - no `console.log` outside `src/logging.js`.
- No new runtime dependencies without discussion; the current tree has exactly
  two (`express`, `pg`).
- Security-sensitive code paths (signature verification, URL validation, key
  hashing) need a test that asserts the *secure* behaviour, not just the
  happy path.
