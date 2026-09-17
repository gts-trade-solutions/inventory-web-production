import { spawnSync } from 'node:child_process'
import 'dotenv/config'

/**
 * Applies migrations to the demo or test database.
 *
 * `prisma migrate deploy` only ever reads DATABASE_URL, and all three
 * connection strings live in one .env. The previous script passed
 * `dotenv -e .env.demo`, a file that does not exist — dotenv-cli fell back to
 * .env without complaint, so the command reported "no pending migrations"
 * while pointing at the DEV database the whole time. A migration tool that
 * silently targets the wrong database is worse than one that fails.
 *
 * Usage:  node scripts/migrate-db.mjs demo|test|live
 */

const TARGETS = {
  demo: 'DATABASE_URL_DEMO',
  test: 'DATABASE_URL_TEST',
  live: 'DATABASE_URL',
}

const target = process.argv[2]
const variable = TARGETS[target]

if (!variable) {
  console.error(`Usage: node scripts/migrate-db.mjs <${Object.keys(TARGETS).join('|')}>`)
  process.exit(1)
}

const url = process.env[variable]
if (!url) {
  console.error(`${variable} is not set. See .env.example.`)
  process.exit(1)
}

// Names only — a connection string carries the password.
console.log(`Applying migrations to the ${target} database (${variable}).`)

// Prisma loads .env itself, but dotenv does not overwrite variables that are
// already set — so the DATABASE_URL passed here is the one it uses.
const result = spawnSync('npx prisma migrate deploy', {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, DATABASE_URL: url },
})

if (result.error) {
  console.error(`Could not run prisma: ${result.error.message}`)
  process.exit(1)
}

process.exit(result.status ?? 1)
