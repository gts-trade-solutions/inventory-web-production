/**
 * The nightly sweep, for cron.
 *
 *   npm run sweep            # the live database
 *   npm run sweep -- demo
 *
 * There is a `POST /api/v1/maintenance/sweep` that does the same thing, but
 * driving it from cron means keeping an administrator's credentials somewhere
 * cron can read them — a standing account with full rights, stored in plain
 * text, so a scheduled job can call a URL on the machine it is already running
 * on. This runs the service directly instead: it needs the database, which the
 * server needs anyway, and no account at all.
 *
 * Exits non-zero when drift is found, so cron's own failure mail is the alert
 * and there is no second thing to configure.
 */

import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { runNightlySweep } from '../lib/services/maintenance'
import type { AppMode } from '../lib/mode'

const TARGETS = { live: 'DATABASE_URL', demo: 'DATABASE_URL_DEMO' } as const

async function main() {
  const target = (process.argv[2] ?? 'live') as keyof typeof TARGETS
  const variable = TARGETS[target]

  if (!variable) {
    console.error(`Usage: npm run sweep -- <${Object.keys(TARGETS).join('|')}>`)
    process.exit(1)
  }

  const url = process.env[variable]
  if (!url) {
    console.error(`${variable} is not set. See .env.example.`)
    process.exit(1)
  }

  const db = new PrismaClient({ datasources: { db: { url } } })
  const mode: AppMode = target === 'demo' ? 'DEMO' : 'LIVE'

  try {
    const result = await runNightlySweep(db, mode)

    // One line, so a month of cron output can be read at a glance.
    console.log(
      `${result.ranAt.toISOString()} sweep ${mode}: ` +
        `drift=${result.drift.rows} expired=${result.expiry.markedExpired} ${result.ms}ms`,
    )

    for (const example of result.drift.examples) {
      console.error(
        `  drift item=${example.itemId} location=${example.locationId} ` +
          `projected=${example.projected} ledger=${example.fromLedger}`,
      )
    }

    if (result.drift.rows > 0) {
      // Deliberately a failure. Drift means the projection and the ledger
      // disagree about how much stock exists, and a job that reports that
      // quietly on success is a job nobody reads.
      console.error(
        `\n${result.drift.rows} row(s) of drift. Investigate before rebuilding: a rebuild ` +
          `erases the evidence of whatever caused it.`,
      )
      process.exitCode = 1
    }
  } finally {
    await db.$disconnect()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
