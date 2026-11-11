'use strict';

const fs = require('fs');
const path = require('path');

// Stable advisory-lock key so concurrent cold starts cannot migrate at once.
const ADVISORY_LOCK_ID = 724001;

/**
 * Minimal SQL migration runner. Applies every *.sql file in ./migrations in
 * lexical order, recording applied filenames in schema_migrations.
 *
 * Uses a single client plus a PostgreSQL advisory lock so multiple serverless
 * instances (or workers) can start safely at the same time.
 */
async function runMigrations(pool, logger) {
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_ID]);

    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

    for (const file of files) {
      const applied = await client.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file]);
      if (applied.rowCount > 0) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        if (logger) logger('info', 'migration_applied', { filename: file });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]).catch(() => {});
    client.release();
  }
}

module.exports = { runMigrations };
