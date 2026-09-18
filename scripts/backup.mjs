#!/usr/bin/env node
/**
 * Backs up a database to a file.
 *
 *   npm run backup            # the live database
 *   npm run backup -- demo    # or demo / test
 *
 * Two things this deliberately does NOT do.
 *
 * It does not put the password on the command line. Anything passed as an
 * argument is visible in the process list to every user on the machine, so the
 * credentials go to mysqldump in its own environment instead.
 *
 * It does not claim success because the command exited zero. mysqldump can
 * write a truncated file and still exit cleanly if the connection drops part
 * way, so the result is checked for the marker mysqldump writes last. A backup
 * nobody has verified is a hope.
 */

import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const TARGETS = { live: 'DATABASE_URL', demo: 'DATABASE_URL_DEMO', test: 'DATABASE_URL_TEST' }

/** Where mysqldump lives when it is not on PATH, as on a default Windows install. */
const CANDIDATES = [
  'mysqldump',
  'C:/Program Files/MySQL/MySQL Server 8.0/bin/mysqldump.exe',
  'C:/Program Files/MySQL/MySQL Server 8.4/bin/mysqldump.exe',
  '/usr/bin/mysqldump',
  '/usr/local/bin/mysqldump',
]

export function findMysqldump() {
  for (const candidate of CANDIDATES) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', shell: false })
    if (probe.status === 0) return candidate
  }
  return null
}

/** Pulls the parts out without ever logging the password. */
export function parseDatabaseUrl(url) {
  const parsed = new URL(url)

  return {
    host: parsed.hostname,
    port: parsed.port || '3306',
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ''),
  }
}

/** mysqldump writes this as its final line when it finishes cleanly. */
const COMPLETION_MARKER = '-- Dump completed'

export function looksComplete(path) {
  if (!existsSync(path)) return false

  const size = statSync(path).size
  if (size === 0) return false

  // Only the tail is read: a dump of a real database is far too large to hold
  // in memory just to check how it ends.
  const tail = readFileSync(path, 'utf8').slice(-400)

  // The LAST line, not anywhere in the tail. A dump containing a row whose text
  // happens to include the marker would otherwise pass while truncated — and
  // this file exists precisely to catch a truncated dump.
  const lines = tail.split('\n').filter((line) => line.trim() !== '')
  const last = lines[lines.length - 1] ?? ''

  return last.startsWith(COMPLETION_MARKER)
}

function main() {
  const target = process.argv[2] ?? 'live'
  const variable = TARGETS[target]

  if (!variable) {
    console.error(`Usage: npm run backup -- <${Object.keys(TARGETS).join('|')}>`)
    process.exit(1)
  }

  const url = process.env[variable]
  if (!url) {
    console.error(`${variable} is not set. See .env.example.`)
    process.exit(1)
  }

  const mysqldump = findMysqldump()
  if (!mysqldump) {
    console.error('mysqldump was not found. Install the MySQL client tools, or add them to PATH.')
    process.exit(1)
  }

  const { host, port, user, password, database } = parseDatabaseUrl(url)

  const directory = process.env.BACKUP_DIR ?? 'backups'
  mkdirSync(directory, { recursive: true })

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const file = join(directory, `${database}-${stamp}.sql`)

  console.log(`Backing up ${database} (${variable}) to ${file}`)

  const result = spawnSync(
    mysqldump,
    [
      `--host=${host}`,
      `--port=${port}`,
      `--user=${user}`,
      // Consistent across tables without locking anybody out: InnoDB gives a
      // single transaction a stable view, so a backup taken mid-shift does not
      // stop the shift.
      '--single-transaction',
      // Routines and triggers are part of the schema; a restore without them
      // looks fine until something calls one.
      '--routines',
      '--triggers',
      '--events',
      // Without this a restore silently keeps whatever was already there.
      '--add-drop-table',
      `--result-file=${file}`,
      database,
    ],
    {
      // The password goes through the environment, never the argument list.
      env: { ...process.env, MYSQL_PWD: password },
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  )

  if (result.status !== 0) {
    console.error('mysqldump failed.')
    process.exit(1)
  }

  if (!looksComplete(file)) {
    // Exiting zero is not the same as finishing.
    console.error(
      `${file} does not end with "${COMPLETION_MARKER}", so the dump is incomplete. Do not rely on it.`,
    )
    process.exit(1)
  }

  const size = statSync(file).size
  console.log(`Backed up ${(size / 1024 / 1024).toFixed(2)} MB, and the dump ends cleanly.`)
  console.log('A backup is not a backup until it has been restored. Run: npm run restore:verify')
}

/**
 * Only when run directly, so the helpers above can be imported by the verifier.
 *
 * Compared as a full URL rather than by suffix: a suffix test also matches
 * anything whose filename merely ENDS with this one, which is how a throwaway
 * script called mutate-restore.mjs ended up running the restore CLI.
 */
export const runDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (runDirectly) main()
