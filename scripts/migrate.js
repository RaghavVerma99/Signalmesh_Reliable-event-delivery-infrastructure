'use strict';

// Applies PostgreSQL migrations. Run before starting the API/worker against
// a fresh database:
//   SIGNALMESH_STORAGE=postgres DATABASE_URL=... npm run migrate
const config = require('../src/config');
const { createStore } = require('../src/storage/postgres');

async function main() {
  if (config.storage !== 'postgres') {
    console.log('SIGNALMESH_STORAGE is not "postgres"; nothing to migrate.');
    return;
  }
  const store = createStore(config.db);
  try {
    await store.init();
    console.log('Migrations applied.');
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err && err.message ? err.message : err);
  process.exit(1);
});
