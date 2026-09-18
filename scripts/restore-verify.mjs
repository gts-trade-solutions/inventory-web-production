#!/usr/bin/env node
/**
 * Proves the backup works by actually restoring it.
 *
 *   npm run restore:verify            # round-trips the demo database
 *   npm run restore:verify -- live    # or the live one, read-only against it
 *
 * This is the point of the whole exercise. A backup script that has never been
 * restored is a file of unknown value: the failures that matter — a dump
 * truncated at 40 MB, a missing table, a character set that mangles every
 * non-ASCII name — all produce a plausible-looking .sql and a zero exit code.
 * The only test that distinguishes a backup from a large text file is loading
 * it into a database and comparing what comes back.
 *
 * Nothing here touches the source database beyond reading it. The restore goes
 * into a scratch database, which is dropped afterwards.
 */

import 'dotenv/config'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { parseDatabaseUrl } from './backup.mjs'
import { mysql } from './restore.mjs'

const SOURCES = { live: 'DATABASE_URL', demo: 'DATABASE_URL_DEMO', test: 'DATABASE_URL_TEST' }

/** Tables and their row counts, as the server sees them right now. */
export function tableCounts(connection, database) {
  const names = mysql(connection, {
    sql: `SELECT TABLE_NAME FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = '${database}' AND TABLE_TYPE = 'BASE TABLE'
          ORDER BY TABLE_NAME;`,
  })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  if (names.length === 0) return new Map()

  // information_schema.TABLE_ROWS is an estimate for InnoDB and can be out by
  // a wide margin, so the counts are real COUNT(*) queries. One statement so
  // it is one round trip rather than one per table.
  const query = names
    .map((name) => `SELECT '${name}' AS t, COUNT(*) AS n FROM \`${name}\``)
    .join(' UNION ALL ')

  const counts = new Map()
  for (const line of mysql(connection, { database, sql: `${query};` }).split('\n')) {
    const [name, count] = line.trim().split('\t')
    if (name && count) counts.set(name, Number(count))
  }

  return counts
}

/** Content checksums, which catch a table that restored with the wrong bytes. */
export function checksums(connection, database, tables) {
  const sums = new Map()

  for (const table of tables) {
    const line = mysql(connection, { database, sql: `CHECKSUM TABLE \`${table}\`;` }).trim()
    const parts = line.split('\t')
    sums.set(table, parts[1] ?? '')
  }

  return sums
}

function main() {
  const source = process.argv[2] ?? 'demo'
  const variable = SOURCES[source]

  if (!variable) {
    console.error(`Usage: npm run restore:verify -- <${Object.keys(SOURCES).join('|')}>`)
    process.exit(1)
  }

  const url = process.env[variable]
  if (!url) {
    console.error(`${variable} is not set. See .env.example.`)
    process.exit(1)
  }

  const parsed = parseDatabaseUrl(url)
  const connection = { ...parsed, env: process.env }
  const scratch = `${parsed.database}_restore_check`

  if (scratch === parseDatabaseUrl(process.env.DATABASE_URL ?? url).database) {
    // Belt and braces. The name is derived, but a derived name that collides
    // with the live database would be a very expensive surprise.
    console.error('The scratch database name collides with the live one. Refusing.')
    process.exit(1)
  }

  console.log(`Round-tripping ${parsed.database} through ${scratch}`)

  // 1. Back it up.
  const backup = spawnSync(process.execPath, ['scripts/backup.mjs', source], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
  })
  if (backup.status !== 0) process.exit(1)

  // The dump just written is the newest file for this database.
  const file = newestBackup(parsed.database)
  if (!file) {
    console.error('The backup reported success but no file was found.')
    process.exit(1)
  }

  // 2. What we expect to find afterwards, read BEFORE the restore so a bug in
  //    the restore cannot influence the expectation.
  const expected = tableCounts(connection, parsed.database)
  const expectedSums = checksums(connection, parsed.database, [...expected.keys()])

  if (expected.size === 0) {
    console.error(`${parsed.database} has no tables. There is nothing to prove.`)
    process.exit(1)
  }

  // 3. Restore into the scratch database, from empty.
  mysql(connection, { sql: `DROP DATABASE IF EXISTS \`${scratch}\`;` })

  const restore = spawnSync(process.execPath, ['scripts/restore.mjs', file, scratch], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
  })
  if (restore.status !== 0) process.exit(1)

  // 4. Compare.
  const actual = tableCounts(connection, scratch)
  const actualSums = checksums(connection, scratch, [...actual.keys()])

  const problems = []

  for (const [table, count] of expected) {
    if (!actual.has(table)) {
      problems.push(`${table}: missing from the restore`)
      continue
    }
    if (actual.get(table) !== count) {
      problems.push(`${table}: ${count} rows backed up, ${actual.get(table)} restored`)
      continue
    }
    if (expectedSums.get(table) !== actualSums.get(table)) {
      // Same number of rows, different contents. Exactly the failure a row
      // count alone would wave through.
      problems.push(`${table}: ${count} rows both sides, but the contents differ`)
    }
  }

  for (const table of actual.keys()) {
    if (!expected.has(table)) problems.push(`${table}: in the restore but not in the source`)
  }

  // 5. Clean up whatever the outcome, so a failed run does not leave a
  //    half-restored database sitting on the server looking official.
  mysql(connection, { sql: `DROP DATABASE IF EXISTS \`${scratch}\`;` })

  if (process.env.KEEP_BACKUP !== 'yes') rmSync(file, { force: true })

  const rows = [...expected.values()].reduce((sum, n) => sum + n, 0)

  if (problems.length > 0) {
    console.error(`\nThe restore does NOT match the source:`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }

  console.log(
    `\nRestore verified: ${expected.size} tables, ${rows} rows, contents identical by checksum.`,
  )
}

/** The most recently written dump for a database. */
function newestBackup(database) {
  const directory = process.env.BACKUP_DIR ?? 'backups'

  if (!existsSync(directory)) return null

  const files = readdirSync(directory)
    .filter((name) => name.startsWith(`${database}-`) && name.endsWith('.sql'))
    .map((name) => `${directory}/${name}`)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)

  return files[0] ?? null
}

// A full URL comparison, not a suffix test — see the note in backup.mjs.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main()
