import 'dotenv/config'

/**
 * Integration tests run against a real MySQL database — the ledger's correctness
 * depends on row locking, transaction isolation and MySQL's own semantics, none
 * of which a mocked client can demonstrate.
 *
 * They use the DEMO database, never the live one, so a test run can never touch
 * real stock.
 */
if (!process.env.DATABASE_URL_DEMO) {
  throw new Error('DATABASE_URL_DEMO must be set to run integration tests. See .env.example.')
}
