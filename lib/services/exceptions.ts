import 'server-only'
import { BatchStatus, CountStatus } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import { fromBatchKey } from '@/lib/domain/types'
import { findProjectionDrift } from './projection'
import { expiryStateOf } from './traceability'

/**
 * Everything that needs a person to look at it.
 *
 * Deliberately one screen rather than warnings scattered through the app: a
 * supervisor should be able to open one page and see whether the warehouse is
 * telling the truth today.
 *
 * Note what is NOT here — a nightly job that flips batches to status EXPIRED.
 * Expiry is derivable from `expiryDate` and is computed on read, so storing it
 * as well would be a second copy of the same fact, free to drift the moment
 * somebody corrects a date. The same reasoning that keeps `stock_levels`
 * rebuildable from the ledger applies (WADR-003). This report IS the sweep.
 */

export interface ExceptionGroup<T> {
  count: number
  rows: T[]
}

export interface NegativeStockRow {
  itemId: string
  itemSku: string
  itemName: string
  locationCode: string
  batchNo: string | null
  quantity: number
}

export interface ExpiredStockRow {
  batchId: string
  batchNo: string
  itemId: string
  itemName: string
  expiryDate: Date | null
  daysAgo: number
  onHand: number
  unit: string
}

export interface PendingCountRow {
  id: string
  docNo: string
  locationCode: string
  submittedAt: Date | null
  netUnits: number
  lines: number
}

export interface QuarantinedRow {
  batchId: string
  batchNo: string
  itemName: string
  onHand: number
  status: BatchStatus
}

export interface DriftRow {
  itemId: string
  locationId: string
  batchId: string
  projected: number
  fromLedger: number
}

export interface Exceptions {
  negativeStock: ExceptionGroup<NegativeStockRow>
  expiredOnHand: ExceptionGroup<ExpiredStockRow>
  countsAwaitingApproval: ExceptionGroup<PendingCountRow>
  quarantined: ExceptionGroup<QuarantinedRow>
  projectionDrift: ExceptionGroup<DriftRow>
  /** True when nothing needs attention — worth saying explicitly. */
  clean: boolean
}

const DAY = 86_400_000

export async function loadExceptions(
  db: PrismaClient,
  now: Date = new Date(),
): Promise<Exceptions> {
  const [negative, batches, counts, drift] = await Promise.all([
    // A negative row means stock was issued that the system did not think was
    // there — almost always two devices issuing the same units offline
    // (WADR-007). It is accepted deliberately and surfaced here.
    db.stockLevel.findMany({
      where: { quantity: { lt: 0 } },
      select: {
        itemId: true,
        batchId: true,
        quantity: true,
        item: { select: { sku: true, name: true } },
        location: { select: { code: true } },
      },
      orderBy: { quantity: 'asc' },
      take: 100,
    }),

    db.batch.findMany({
      where: { status: { in: [BatchStatus.ACTIVE, BatchStatus.QUARANTINE, BatchStatus.BLOCKED] } },
      select: {
        id: true,
        batchNo: true,
        expiryDate: true,
        status: true,
        itemId: true,
        item: { select: { name: true, unit: true, nearExpiryDays: true } },
      },
    }),

    db.countSession.findMany({
      where: { status: CountStatus.SUBMITTED },
      select: {
        id: true,
        docNo: true,
        submittedAt: true,
        location: { select: { code: true } },
        lines: { select: { expected: true, counted: true } },
      },
      orderBy: { submittedAt: 'asc' },
    }),

    findProjectionDrift(db),
  ])

  // On-hand per batch, so an expired batch with nothing left is not reported.
  // It is history, and listing it buries the ones that matter.
  const batchIds = batches.map((batch) => batch.id)
  const levels = batchIds.length
    ? await db.stockLevel.groupBy({
        by: ['batchId'],
        where: { batchId: { in: batchIds } },
        _sum: { quantity: true },
      })
    : []
  const onHandByBatch = new Map(levels.map((level) => [level.batchId, level._sum.quantity ?? 0]))

  const expiredOnHand: ExpiredStockRow[] = batches
    .map((batch) => {
      const { state } = expiryStateOf(batch.expiryDate, now, batch.item.nearExpiryDays)
      const onHand = onHandByBatch.get(batch.id) ?? 0
      if (state !== 'EXPIRED' || onHand <= 0) return null

      return {
        batchId: batch.id,
        batchNo: batch.batchNo,
        itemId: batch.itemId,
        itemName: batch.item.name,
        expiryDate: batch.expiryDate,
        daysAgo: batch.expiryDate
          ? Math.round((startOfUtcDay(now) - startOfUtcDay(batch.expiryDate)) / DAY)
          : 0,
        onHand,
        unit: batch.item.unit,
      }
    })
    .filter((row): row is ExpiredStockRow => row !== null)
    .sort((a, b) => b.daysAgo - a.daysAgo)

  const quarantined: QuarantinedRow[] = batches
    .filter((batch) => batch.status !== BatchStatus.ACTIVE)
    .map((batch) => ({
      batchId: batch.id,
      batchNo: batch.batchNo,
      itemName: batch.item.name,
      onHand: onHandByBatch.get(batch.id) ?? 0,
      status: batch.status,
    }))

  const negativeStock: NegativeStockRow[] = negative.map((level) => ({
    itemId: level.itemId,
    itemSku: level.item.sku,
    itemName: level.item.name,
    locationCode: level.location.code,
    batchNo: fromBatchKey(level.batchId),
    quantity: level.quantity,
  }))

  const countsAwaitingApproval: PendingCountRow[] = counts.map((session) => ({
    id: session.id,
    docNo: session.docNo,
    locationCode: session.location.code,
    submittedAt: session.submittedAt,
    netUnits: session.lines.reduce((sum, line) => sum + (line.counted - line.expected), 0),
    lines: session.lines.filter((line) => line.counted !== line.expected).length,
  }))

  const projectionDrift = drift.map((row) => ({
    itemId: row.itemId,
    locationId: row.locationId,
    batchId: row.batchId,
    projected: row.projected,
    fromLedger: row.fromLedger,
  }))

  return {
    negativeStock: { count: negativeStock.length, rows: negativeStock },
    expiredOnHand: { count: expiredOnHand.length, rows: expiredOnHand },
    countsAwaitingApproval: {
      count: countsAwaitingApproval.length,
      rows: countsAwaitingApproval,
    },
    quarantined: { count: quarantined.length, rows: quarantined },
    projectionDrift: { count: projectionDrift.length, rows: projectionDrift },
    clean:
      negativeStock.length === 0 &&
      expiredOnHand.length === 0 &&
      countsAwaitingApproval.length === 0 &&
      projectionDrift.length === 0,
  }
}

function startOfUtcDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}
