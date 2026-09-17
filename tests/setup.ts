import 'dotenv/config'

/**
 * Integration tests run against a real MySQL database — the ledger's correctness
 * depends on row locking, transaction isolation and MySQL's own semantics, none
 * of which a mocked client can demonstrate.
 *
 * They get their OWN database and truncate freely between cases. Pointing them
 * at the demo one would destroy the demo dataset on every run, and Demo mode is
 * a product feature and the training environment — not a scratchpad.
 */
if (!process.env.DATABASE_URL_TEST) {
  throw new Error('DATABASE_URL_TEST must be set to run integration tests. See .env.example.')
}

if (process.env.DATABASE_URL_TEST === process.env.DATABASE_URL_DEMO) {
  throw new Error(
    'DATABASE_URL_TEST points at the demo database. Tests truncate, so this would wipe the demo dataset.',
  )
}
