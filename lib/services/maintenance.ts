import 'server-only'
import { BatchStatus } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import { findProjectionDrift, rebuildProjections } from './projection'
import { AuditAction, writeAudit } from '@/lib/audit'
import { publishDevice } from '@/lib/events/publish'
import type { AppMode } from '@/lib/mode'

/**
 * The nightly sweep (PROJECT_PLAN 8.7).
 *
 * Two jobs that need to run whether or not anybody remembers to look.
 *
 * **Drift.** `stock_levels` is a projection of the ledger, and the two agreeing
 * is the system's central claim. Until now the only thing that ever checked was
 * a test — which means it was checked on a throwaway database and never on the
 * one the business runs on. A drift that appears at 3am should not wait for
 * somebody to notice a number looks wrong.
 *
 * **Expiry.** A batch whose date has passed stays ACTIVE until something marks
 * it, and an ACTIVE expired batch is one FEFO will happily propose.
 *
 * Deliberately REPORTS drift rather than fixing it. A rebuild is a real
 * operation with a real cost, and one that runs unattended would erase the
 * evidence of whatever caused the drift — the thing worth investigating.
 */

export interface SweepResult {
  ranAt: Date
  drift: {
    rows: number
    /** A few, so the log says what rather than only how many. */
    examples: Array<{ itemId: string; locationId: string; projected: number; fromLedger: number }>
  }
  expiry: { markedExpired: number }
  ms: number
}

export async function runNightlySweep(
  db: PrismaClient,
  mode: AppMode,
  now: Date = new Date(),
): Promise<SweepResult> {
  const started = Date.now()

  const drift = await findProjectionDrift(db)
  const markedExpired = await markExpiredBatches(db, now)

  const result: SweepResult = {
    ranAt: now,
    drift: {
      rows: drift.length,
      examples: drift.slice(0, 10).map((row) => ({
        itemId: row.itemId,
        locationId: row.locationId,
        projected: row.projected ?? 0,
        fromLedger: row.fromLedger ?? 0,
      })),
    },
    expiry: { markedExpired },
    ms: Date.now() - started,
  }

  // Recorded whether or not anything was found. "The sweep ran and found
  // nothing" is the answer to "was this checked?", and its absence is itself
  // information.
  await writeAudit(db, {
    actorUserId: null,
    action: AuditAction.REBUILD,
    entity: 'NightlySweep',
    entityId: 'sweep',
    after: { driftRows: result.drift.rows, markedExpired, ms: result.ms },
  })

  publishDevice({
    mode,
    siteId: null,
    device: 'Nightly sweep',
    detail:
      drift.length === 0
        ? `ran clean in ${(result.ms / 1000).toFixed(1)}s, ${markedExpired} batches expired`
        : `found ${drift.length} drifted stock rows — the ledger and the projection disagree`,
    ok: drift.length === 0,
  })

  return result
}

/**
 * Marks batches whose expiry date has passed.
 *
 * Whole days in UTC, matching the domain's `isExpired`: a batch expiring today
 * is usable today. Anything narrower makes expiry depend on the time of day the
 * sweep happened to run.
 */
async function markExpiredBatches(db: PrismaClient, now: Date): Promise<number> {
  const startOfToday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  )

  const result = await db.batch.updateMany({
    where: {
      status: BatchStatus.ACTIVE,
      expiryDate: { not: null, lt: startOfToday },
    },
    data: { status: BatchStatus.EXPIRED },
  })

  return result.count
}

/**
 * Rebuilds the projection from the ledger.
 *
 * Manual and audited, never automatic. It is the correct repair for drift, and
 * running it unattended would erase the evidence of what caused the drift —
 * which is the part worth investigating.
 */
export async function rebuildStockProjection(
  db: PrismaClient,
  actor: { userId: string },
): Promise<{ rows: number; driftBefore: number }> {
  const before = await findProjectionDrift(db)
  const { rows } = await rebuildProjections(db)

  await writeAudit(db, {
    actorUserId: actor.userId,
    action: AuditAction.REBUILD,
    entity: 'StockProjection',
    entityId: 'stock_levels',
    before: { driftRows: before.length },
    after: { rows },
  })

  return { rows, driftBefore: before.length }
}
