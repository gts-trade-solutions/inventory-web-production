#!/usr/bin/env node
/**
 * Restores a dump into a database.
 *
 *   npm run restore -- backups/inventory_demo-2026-09-18-10-00-00.sql inventory_scratch
 *
 * The target database is named EXPLICITLY, as a second argument. It is never
 * inferred from the dump and never defaults to the live database, because the
 * moment a restore can pick its own target, the day somebody runs it to check
 * something is the day production is overwritten.
 *
 * The live database additionally requires RESTORE_ALLOW_LIVE=yes in the
 * environment. Restoring over production is a real operation people do have to
 * perform — the guard is not there to forbid it, only to make sure it is being
 * done on purpose rather than by a command recalled from history.
 */

import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseDatabaseUrl } from './backup.mjs'

const CANDIDATES = [
  'mysql',
  'C:/Program Files/MySQL/MySQL Server 8.0/bin/mysql.exe',
  'C:/Program Files/MySQL/MySQL Server 8.4/bin/mysql.exe',
  '/usr/bin/mysql',
  '/usr/local/bin/mysql',
]

export function findMysql() {
  for (const candidate of CANDIDATES) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', shell: false })
    if (probe.status === 0) return candidate
  }
  return null
}

/**
 * Runs SQL against a server, optionally inside a named database.
 *
 * Shared by the restore itself and by the row counting the verifier does, so
 * there is exactly one place that knows how to hand MySQL a password safely.
 */
export function mysql(connection, { database, sql, file }) {
  const binary = findMysql()
  if (!binary) throw new Error('mysql client not found. Install the MySQL client tools.')

  const args = [
    `--host=${connection.host}`,
    `--port=${connection.port}`,
    `--user=${connection.user}`,
    '--batch',
    // Column names would have to be stripped back out of every count.
    '--skip-column-names',
  ]
  if (database) args.push(`--database=${database}`)

  const result = spawnSync(binary, args, {
    // Through the environment: an argument is visible in the process list.
    env: { ...connection.env, MYSQL_PWD: connection.password },
    input: file ? readFileSync(file, 'utf8') : sql,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 512,
  })

  if (result.status !== 0) {
    // stderr can echo back a line of the SQL, which is fine, but never the URL.
    throw new Error(`mysql exited ${result.status}: ${(result.stderr ?? '').trim()}`)
  }

  return result.stdout ?? ''
}

function main() {
  const [file, target] = process.argv.slice(2)

  if (!file || !target) {
    console.error('Usage: npm run restore -- <dump.sql> <target-database>')
    console.error('The target is named explicitly. It is never guessed from the dump.')
    process.exit(1)
  }

  if (!existsSync(file)) {
    console.error(`${file} does not exist.`)
    process.exit(1)
  }

  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is not set. See .env.example.')
    process.exit(1)
  }

  const connection = { ...parseDatabaseUrl(url), env: process.env }

  if (target === connection.database && process.env.RESTORE_ALLOW_LIVE !== 'yes') {
    console.error(
      `"${target}" is the live database. If you mean to overwrite it, run again with RESTORE_ALLOW_LIVE=yes.`,
    )
    process.exit(1)
  }

  console.log(`Restoring ${file} into ${target}`)

  // Created if absent so a restore into a fresh server works; the dump's own
  // DROP TABLE statements clear anything already there.
  mysql(connection, { sql: `CREATE DATABASE IF NOT EXISTS \`${target}\`;\n` })
  mysql(connection, { database: target, file })

  console.log('Restored. Verify it with: npm run restore:verify')
}

// A full URL comparison, not a suffix test — see the note in backup.mjs.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main()
