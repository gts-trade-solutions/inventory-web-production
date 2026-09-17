import 'server-only'
import { CountStatus } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import { fromBatchKey } from '@/lib/domain/types'
import { summariseCount, type CountLine, type CountSummary } from '@/lib/domain/count'
import { expiryStateOf, type ExpiryState } from './traceability'

/**
 * Reads for the cycle-count screens.
 *
 * The counting screen needs what the system EXPECTS at a location before
 * anything is counted, so the operator works from a checklist rather than
 * building a list from nothing. The review screen needs the same rows with the
 * counted figures alongside.
 */

export interface CountSessionRow {
  id: string
  docNo: string
  status: CountStatus
  method: string
  locationCode: string
  locationName: string
  startedBy: string
  startedAt: Date
  submittedAt: Date | null
  approvedBy: string | null
  /** Null until submitted; there are no lines before that. */
  summary: CountSummary | null
}

export async function listCountSessions(
  db: PrismaClient,
  filter: { status?: CountStatus } = {},
): Promise<CountSessionRow[]> {
  const sessions = await db.countSession.findMany({
    where: { status: filter.status },
    select: {
      id: true,
      docNo: true,
      status: true,
      method: true,
      startedAt: true,
      submittedAt: true,
      location: { select: { code: true, name: true } },
      startedBy: { select: { name: true } },
      approvedBy: { select: { name: true } },
      lines: { select: { itemId: true, batchId: true, expected: true, counted: true } },
    },
    orderBy: [{ startedAt: 'desc' }],
    take: 100,
  })

  return sessions.map((session) => ({
    id: session.id,
    docNo: session.docNo,
    status: session.status,
    method: session.method,
    locationCode: session.location.code,
    locationName: session.location.name,
    startedBy: session.startedBy.name,
    startedAt: session.startedAt,
    submittedAt: session.submittedAt,
    approvedBy: session.approvedBy?.name ?? null,
    summary: session.lines.length
      ? summariseCount(
          session.lines.map((line) => ({
            itemId: line.itemId,
            batchId: fromBatchKey(line.batchId),
            expected: line.expected,
            counted: line.counted,
          })),
        )
      : null,
  }))
}

/** A row on the counting checklist or the review screen. */
export interface CountRow {
  itemId: string
  itemSku: string
  itemName: string
  unit: string
  trackingMode: string
  batchId: string | null
  batchNo: string | null
  expiryState: ExpiryState
  expected: number
  /** Only set once the count has been submitted. */
  counted: number | null
}

export interface CountSessionDetail {
  id: string
  docNo: string
  status: CountStatus
  method: string
  locationId: string
  locationCode: string
  locationName: string
  startedBy: string
  startedAt: Date
  submittedAt: Date | null
  approvedBy: string | null
  rejectedNote: string | null
  rows: CountRow[]
  summary: CountSummary | null
  tagsRead: number
}

export async function loadCountSession(
  db: PrismaClient,
  sessionId: string,
  now: Date = new Date(),
): Promise<CountSessionDetail | null> {
  const session = await db.countSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      docNo: true,
      status: true,
      method: true,
      locationId: true,
      startedAt: true,
      submittedAt: true,
      rejectedNote: true,
      location: { select: { code: true, name: true } },
      startedBy: { select: { name: true } },
      approvedBy: { select: { name: true } },
      lines: { select: { itemId: true, batchId: true, expected: true, counted: true } },
      _count: { select: { tags: true } },
    },
  })
  if (!session) return null

  // Before submission there are no lines, so the checklist comes from what the
  // projection says is at the location. After submission the stored lines are
  // the record of what was found — the shelf may have moved since, and a review
  // screen that silently re-derived "expected" would be reviewing a different
  // count from the one that was submitted.
  const rows =
    session.lines.length > 0
      ? await hydrateRows(
          db,
          session.lines.map((line) => ({
            itemId: line.itemId,
            batchId: fromBatchKey(line.batchId),
            expected: line.expected,
            counted: line.counted,
          })),
          now,
        )
      : await expectedRows(db, session.locationId, now)

  const lines: CountLine[] = session.lines.map((line) => ({
    itemId: line.itemId,
    batchId: fromBatchKey(line.batchId),
    expected: line.expected,
    counted: line.counted,
  }))

  return {
    id: session.id,
    docNo: session.docNo,
    status: session.status,
    method: session.method,
    locationId: session.locationId,
    locationCode: session.location.code,
    locationName: session.location.name,
    startedBy: session.startedBy.name,
    startedAt: session.startedAt,
    submittedAt: session.submittedAt,
    approvedBy: session.approvedBy?.name ?? null,
    rejectedNote: session.rejectedNote,
    rows,
    summary: lines.length ? summariseCount(lines) : null,
    tagsRead: session._count.tags,
  }
}

/** What the projection says should be at this location, as a starting checklist. */
async function expectedRows(db: PrismaClient, locationId: string, now: Date): Promise<CountRow[]> {
  const levels = await db.stockLevel.findMany({
    where: { locationId, quantity: { not: 0 } },
    select: { itemId: true, batchId: true, quantity: true },
  })

  return hydrateRows(
    db,
    levels.map((level) => ({
      itemId: level.itemId,
      batchId: fromBatchKey(level.batchId),
      expected: level.quantity,
      counted: null,
    })),
    now,
  )
}

/** Attaches item and batch detail to bare count lines. */
async function hydrateRows(
  db: PrismaClient,
  lines: Array<{
    itemId: string
    batchId: string | null
    expected: number
    counted: number | null
  }>,
  now: Date,
): Promise<CountRow[]> {
  if (lines.length === 0) return []

  const [items, batches] = await Promise.all([
    db.item.findMany({
      where: { id: { in: [...new Set(lines.map((line) => line.itemId))] } },
      select: {
        id: true,
        sku: true,
        name: true,
        unit: true,
        trackingMode: true,
        nearExpiryDays: true,
      },
    }),
    db.batch.findMany({
      where: {
        id: { in: lines.map((line) => line.batchId).filter((id): id is string => Boolean(id)) },
      },
      select: { id: true, batchNo: true, expiryDate: true },
    }),
  ])

  const itemById = new Map(items.map((item) => [item.id, item]))
  const batchById = new Map(batches.map((batch) => [batch.id, batch]))

  return lines
    .map((line) => {
      const item = itemById.get(line.itemId)
      const batch = line.batchId ? batchById.get(line.batchId) : undefined
      const { state } = expiryStateOf(batch?.expiryDate ?? null, now, item?.nearExpiryDays ?? 30)

      return {
        itemId: line.itemId,
        itemSku: item?.sku ?? '(unknown)',
        itemName: item?.name ?? '(unknown item)',
        unit: item?.unit ?? '',
        trackingMode: item?.trackingMode ?? 'NONE',
        batchId: line.batchId,
        batchNo: batch?.batchNo ?? null,
        expiryState: state,
        expected: line.expected,
        counted: line.counted,
      }
    })
    .sort(
      (a, b) =>
        a.itemName.localeCompare(b.itemName) || (a.batchNo ?? '').localeCompare(b.batchNo ?? ''),
    )
}

export { CountStatus }
