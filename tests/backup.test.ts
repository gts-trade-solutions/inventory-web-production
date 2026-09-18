import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// A plain .mjs operations script, deliberately not TypeScript: it has to run
// from cron on a server with nothing installed but node and the MySQL client.
import { looksComplete, parseDatabaseUrl } from '../scripts/backup.mjs'

/**
 * The backup scripts.
 *
 * The round trip itself is proved by `npm run restore:verify`, which actually
 * restores into a scratch database and compares checksums — no unit test can
 * stand in for that. What is worth pinning here are the two pure functions
 * whose failures would be silent: a password parsed wrongly gives an
 * authentication error that blames the credentials, and a truncated dump that
 * passes for complete is a backup that does not exist.
 */

describe('parseDatabaseUrl', () => {
  it('pulls the parts out of a connection URL', () => {
    const parsed = parseDatabaseUrl('mysql://app:secret@db.example.test:3307/inventory')

    expect(parsed).toEqual({
      host: 'db.example.test',
      port: '3307',
      user: 'app',
      password: 'secret',
      database: 'inventory',
    })
  })

  it('defaults the port', () => {
    expect(parseDatabaseUrl('mysql://app:secret@localhost/inventory').port).toBe('3306')
  })

  it('decodes an encoded password', () => {
    // .env.example tells people to encode @ # : in passwords, so the script has
    // to decode them again. Skipping this sends the literal "%40" to MySQL and
    // produces an access-denied error that looks like the wrong password.
    const parsed = parseDatabaseUrl('mysql://app:p%40ss%23word@localhost:3306/inventory')

    expect(parsed.password).toBe('p@ss#word')
  })

  it('decodes an encoded user', () => {
    expect(parseDatabaseUrl('mysql://in%2Dapp:x@localhost/inventory').user).toBe('in-app')
  })
})

describe('looksComplete', () => {
  const directory = mkdtempSync(join(tmpdir(), 'backup-test-'))

  function dump(name: string, contents: string) {
    const path = join(directory, name)
    writeFileSync(path, contents)
    return path
  }

  it('accepts a dump that ends the way mysqldump ends one', () => {
    const path = dump(
      'good.sql',
      '-- MySQL dump 10.13\nINSERT INTO `items` VALUES (1);\n-- Dump completed on 2026-09-18 10:47:29\n',
    )

    expect(looksComplete(path)).toBe(true)
  })

  it('rejects a dump cut off part way', () => {
    // The failure this exists for: mysqldump can exit zero having written a
    // truncated file when the connection drops, leaving a plausible .sql and a
    // successful-looking backup job.
    const path = dump('truncated.sql', '-- MySQL dump 10.13\nINSERT INTO `items` VALUES (1),(2')

    expect(looksComplete(path)).toBe(false)
  })

  it('rejects an empty file', () => {
    expect(looksComplete(dump('empty.sql', ''))).toBe(false)
  })

  it('rejects a file that is not there', () => {
    expect(looksComplete(join(directory, 'absent.sql'))).toBe(false)
  })

  it('looks at the end, not anywhere in the file', () => {
    // A dump whose data happens to contain the marker text must not pass on
    // that alone — the marker has to be where mysqldump puts it.
    const path = dump(
      'sneaky.sql',
      "INSERT INTO `notes` VALUES ('-- Dump completed');\nINSERT INTO `items` VALUES (1),(2",
    )

    expect(looksComplete(path)).toBe(false)
  })
})
