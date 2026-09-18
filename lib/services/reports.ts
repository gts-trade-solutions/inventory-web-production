import 'server-only'
import { MovementType } from '@prisma/client'
// A type-only import: the lint rule that keeps LIVE and DEMO isolated (WADR-024)
// forbids pulling the client itself in here. The caller passes the database it
// already resolved through lib/mode.ts.
import type { PrismaClient } from '@prisma/client'
import { NO_BATCH } from '@/lib/domain/types'

/**
 * Operational reports (PROJECT_PLAN 8.2).
 *
 * Read-only, and deliberately blunt about where each number comes from.
 *
 * **Stock figures read `stock_levels`, which is a projection of the ledger.**
 * The ledger is the truth; the projection is the fast copy, rebuilt from it and
 * checked against it by the nightly sweep. Reports use the projection because a
 * report that re-sums the whole ledger takes minutes and would be run less
 * often — but every screen says which it used, because a number whose
 * provenance is unclear is a number somebody will argue with.
 *
 * **Movement figures read the ledger directly**, which is exact by definition:
 * the ledger is append-only, so a historical total cannot change after the fact.
 */

export interface ReportFilters {
  siteId?: string | null
  categoryId?: string | null
}

export interface DateRange {
  from: Date
  to: Date
}

// --- Stock on hand ---------------------------------------------------------

export type StockGrain = 'ITEM' | 'LOCATION' | 'BATCH'

export interface StockOnHandRow {
  itemId: string
  sku: string
  itemName: string
  unit: string
  categoryName: string | null
  /** Present at LOCATION and BATCH grain. */
  locationCode: string | null
  /** Present at BATCH grain. Null means the item is not batch-tracked. */
  batchNo: string | null
  expiryDate: Date | null
  quantity: number
}

export interface StockOnHandReport {
  grain: StockGrain
  rows: StockOnHandRow[]
  totals: { lines: number; quantity: number; items: number }
}

/**
 * What is on hand, at the chosen grain.
 *
 * Zero-quantity rows are excluded. A projection row hangs around at zero after
 * the last unit leaves, and a stock report padded with lines reading 0 is a
 * report people stop reading.
 *
 * Negative rows are NOT excluded. Stock can go negative when an offline
 * over-issue syncs (WADR-007), and hiding that from the stock report is hiding
 * the one line somebody needs to act on.
 */
export async function stockOnHand(
  db: PrismaClient,
  grain: StockGrain,
  filters: ReportFilters = {},
): Promise<StockOnHandReport> {
  const levels = await db.stockLevel.findMany({
    where: {
      quantity: { not: 0 },
      ...(filters.siteId ? { location: { siteId: filters.siteId } } : {}),
      ...(filters.categoryId ? { item: { categoryId: filters.categoryId } } : {}),
    },
    select: {
      itemId: true,
      locationId: true,
      batchId: true,
      quantity: true,
      item: {
        select: { sku: true, name: true, unit: true, category: { select: { name: true } } },
      },
      location: { select: { code: true } },
    },
  })

  // Batch numbers in one query rather than a join per row. The sentinel is
  // skipped: it is not a batch, it is the absence of one.
  const batchIds = [...new Set(levels.map((row) => row.batchId))].filter((id) => id !== NO_BATCH)
  const batches = await db.batch.findMany({
    where: { id: { in: batchIds } },
    select: { id: true, batchNo: true, expiryDate: true },
  })
  const batchById = new Map(batches.map((batch) => [batch.id, batch]))

  const grouped = new Map<string, StockOnHandRow>()

  for (const level of levels) {
    const batch = batchById.get(level.batchId)

    const key =
      grain === 'ITEM'
        ? level.itemId
        : grain === 'LOCATION'
          ? `${level.itemId}~${level.locationId}`
          : `${level.itemId}~${level.locationId}~${level.batchId}`

    const existing = grouped.get(key)
    if (existing) {
      existing.quantity += level.quantity
      continue
    }

    grouped.set(key, {
      itemId: level.itemId,
      sku: level.item.sku,
      itemName: level.item.name,
      unit: level.item.unit,
      categoryName: level.item.category?.name ?? null,
      locationCode: grain === 'ITEM' ? null : level.location.code,
      batchNo: grain === 'BATCH' ? (batch?.batchNo ?? null) : null,
      expiryDate: grain === 'BATCH' ? (batch?.expiryDate ?? null) : null,
      quantity: level.quantity,
    })
  }

  const rows = [...grouped.values()]
    // Summing can land a grouped row on zero — five in one place and five out
    // of another nets to nothing, and a line reading 0 in a stock report is
    // noise. The underlying rows are still there at a finer grain.
    .filter((row) => row.quantity !== 0)
    .sort(
      (a, b) =>
        a.sku.localeCompare(b.sku) || (a.locationCode ?? '').localeCompare(b.locationCode ?? ''),
    )

  return {
    grain,
    rows,
    totals: {
      lines: rows.length,
      quantity: rows.reduce((sum, row) => sum + row.quantity, 0),
      items: new Set(rows.map((row) => row.itemId)).size,
    },
  }
}

// --- Movement summary ------------------------------------------------------

export interface MovementSummaryRow {
  type: MovementType
  movements: number
  quantity: number
  /** Distinct items touched, which is a better measure of reach than lines. */
  items: number
}

export interface MovementSummaryReport {
  range: DateRange
  rows: MovementSummaryRow[]
  totals: { movements: number; quantity: number }
}

/**
 * What moved, by type, over a period.
 *
 * Straight from the ledger. Quantities are summed unsigned, as recorded: the
 * direction is the type, and adding a RECEIVE to an ISSUE to get a net figure
 * would be meaningless across items with different units.
 */
export async function movementSummary(
  db: PrismaClient,
  range: DateRange,
  filters: ReportFilters = {},
): Promise<MovementSummaryReport> {
  const where = {
    recordedAt: { gte: range.from, lte: range.to },
    ...(filters.siteId ? { siteId: filters.siteId } : {}),
    ...(filters.categoryId ? { item: { categoryId: filters.categoryId } } : {}),
  }

  const [grouped, distinctItems] = await Promise.all([
    db.movement.groupBy({
      by: ['type'],
      where,
      _count: { _all: true },
      _sum: { quantity: true },
    }),
    db.movement.findMany({
      where,
      select: { type: true, itemId: true },
      distinct: ['type', 'itemId'],
    }),
  ])

  const itemsPerType = new Map<MovementType, number>()
  for (const row of distinctItems) {
    itemsPerType.set(row.type, (itemsPerType.get(row.type) ?? 0) + 1)
  }

  // Every type, including the ones with nothing in the period. "No scraps this
  // month" is a finding; a missing row is ambiguous.
  const rows = Object.values(MovementType).map((type) => {
    const found = grouped.find((row) => row.type === type)

    return {
      type,
      movements: found?._count._all ?? 0,
      quantity: found?._sum.quantity ?? 0,
      items: itemsPerType.get(type) ?? 0,
    }
  })

  return {
    range,
    rows,
    totals: {
      movements: rows.reduce((sum, row) => sum + row.movements, 0),
      quantity: rows.reduce((sum, row) => sum + row.quantity, 0),
    },
  }
}

// --- Count accuracy --------------------------------------------------------

export interface CountAccuracyRow {
  sessionId: string
  locationCode: string
  startedAt: Date
  status: string
  method: string
  linesCounted: number
  linesWithVariance: number
  /** Percentage of counted lines that matched, 0-100. */
  accuracy: number
  /** Sum of |variance| across the session, in units. */
  unitsOut: number
}

export interface CountAccuracyReport {
  range: DateRange
  rows: CountAccuracyRow[]
  totals: { sessions: number; lines: number; linesWithVariance: number; accuracy: number }
}

/**
 * How well counts matched the system, per session.
 *
 * Accuracy is counted in LINES, not units. One line out by 500 and one line out
 * by 1 are both one thing somebody has to investigate, and a unit-weighted
 * figure lets a single bulk item hide a dozen genuine discrepancies. The units
 * are reported alongside rather than instead.
 */
export async function countAccuracy(
  db: PrismaClient,
  range: DateRange,
  filters: ReportFilters = {},
): Promise<CountAccuracyReport> {
  const sessions = await db.countSession.findMany({
    where: {
      startedAt: { gte: range.from, lte: range.to },
      ...(filters.siteId ? { siteId: filters.siteId } : {}),
    },
    orderBy: { startedAt: 'desc' },
    select: {
      id: true,
      startedAt: true,
      status: true,
      method: true,
      location: { select: { code: true } },
      // Lines exist only once a count is submitted: reconciliation creates one
      // per item/batch that was expected OR found, so every row here is a line
      // somebody actually counted. A session still in progress has none, which
      // is why it scores zero rather than 100%.
      lines: { select: { expected: true, counted: true } },
    },
  })

  const rows = sessions.map((session) => {
    const variances = session.lines.filter((line) => line.counted !== line.expected)
    const lines = session.lines.length

    return {
      sessionId: session.id,
      locationCode: session.location?.code ?? '—',
      startedAt: session.startedAt,
      status: String(session.status),
      method: String(session.method),
      linesCounted: lines,
      linesWithVariance: variances.length,
      accuracy: lines === 0 ? 0 : ((lines - variances.length) / lines) * 100,
      unitsOut: variances.reduce((sum, line) => sum + Math.abs(line.counted - line.expected), 0),
    }
  })

  const lines = rows.reduce((sum, row) => sum + row.linesCounted, 0)
  const withVariance = rows.reduce((sum, row) => sum + row.linesWithVariance, 0)

  return {
    range,
    rows,
    totals: {
      sessions: rows.length,
      lines,
      linesWithVariance: withVariance,
      // Across all lines, not an average of per-session percentages: a session
      // with four lines would otherwise weigh as much as one with four hundred.
      accuracy: lines === 0 ? 0 : ((lines - withVariance) / lines) * 100,
    },
  }
}

// --- Stock ageing ----------------------------------------------------------

export const AGEING_BUCKETS = [30, 60, 90, 180] as const

export interface AgeingRow {
  itemId: string
  sku: string
  itemName: string
  batchNo: string | null
  locationCode: string
  quantity: number
  receivedAt: Date | null
  ageDays: number | null
  /** "0-30", "31-60", …, "180+", or "Unknown". */
  bucket: string
}

export interface AgeingReport {
  rows: AgeingRow[]
  buckets: Array<{ label: string; lines: number; quantity: number }>
  /** Stock whose age cannot be known. Reported, never hidden. */
  unknown: { lines: number; quantity: number }
}

/**
 * How long stock has been sitting.
 *
 * **Only batch-tracked stock has a knowable age.** For an item tracked as NONE
 * the ledger records quantities, not units: ten received in March and ten in
 * September are one number, and nothing says which ten are still on the shelf.
 * Picking the earliest receipt would assume FIFO, which the system does not
 * enforce and the warehouse may not follow.
 *
 * So untracked stock is reported in an "Unknown" bucket rather than given a
 * plausible-looking age. A confident wrong number in an ageing report is how
 * stock gets written off, and the honest answer — "turn on batch tracking for
 * this item if you need its age" — is actionable.
 */
export async function stockAgeing(
  db: PrismaClient,
  filters: ReportFilters = {},
  now: Date = new Date(),
): Promise<AgeingReport> {
  const levels = await db.stockLevel.findMany({
    where: {
      quantity: { gt: 0 },
      ...(filters.siteId ? { location: { siteId: filters.siteId } } : {}),
      ...(filters.categoryId ? { item: { categoryId: filters.categoryId } } : {}),
    },
    select: {
      itemId: true,
      batchId: true,
      quantity: true,
      item: { select: { sku: true, name: true } },
      location: { select: { code: true } },
    },
  })

  const batchIds = [...new Set(levels.map((row) => row.batchId))].filter((id) => id !== NO_BATCH)
  const batches = await db.batch.findMany({
    where: { id: { in: batchIds } },
    select: { id: true, batchNo: true, receivedAt: true },
  })
  const batchById = new Map(batches.map((batch) => [batch.id, batch]))

  const rows: AgeingRow[] = levels.map((level) => {
    const batch = batchById.get(level.batchId)
    const receivedAt = batch?.receivedAt ?? null
    const ageDays =
      receivedAt === null
        ? null
        : Math.max(0, Math.floor((now.getTime() - receivedAt.getTime()) / 86_400_000))

    return {
      itemId: level.itemId,
      sku: level.item.sku,
      itemName: level.item.name,
      batchNo: batch?.batchNo ?? null,
      locationCode: level.location.code,
      quantity: level.quantity,
      receivedAt,
      ageDays,
      bucket: bucketFor(ageDays),
    }
  })

  rows.sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1))

  const labels = [...bucketLabels()]
  const buckets = labels.map((label) => {
    const inBucket = rows.filter((row) => row.bucket === label)
    return {
      label,
      lines: inBucket.length,
      quantity: inBucket.reduce((sum, row) => sum + row.quantity, 0),
    }
  })

  const unknownRows = rows.filter((row) => row.ageDays === null)

  return {
    rows,
    buckets,
    unknown: {
      lines: unknownRows.length,
      quantity: unknownRows.reduce((sum, row) => sum + row.quantity, 0),
    },
  }
}

function* bucketLabels(): Generator<string> {
  let low = 0
  for (const edge of AGEING_BUCKETS) {
    yield `${low}-${edge}`
    low = edge + 1
  }
  yield `${AGEING_BUCKETS[AGEING_BUCKETS.length - 1]}+`
}

function bucketFor(ageDays: number | null): string {
  if (ageDays === null) return 'Unknown'

  let low = 0
  for (const edge of AGEING_BUCKETS) {
    if (ageDays <= edge) return `${low}-${edge}`
    low = edge + 1
  }

  return `${AGEING_BUCKETS[AGEING_BUCKETS.length - 1]}+`
}

// --- Reorder ---------------------------------------------------------------

export interface ReorderRow {
  itemId: string
  sku: string
  itemName: string
  unit: string
  categoryName: string | null
  onHand: number
  reorderPoint: number
  maxLevel: number | null
  /** How far below the point it is. Positive means short. */
  shortBy: number
  /** Suggested order quantity to reach maxLevel, or null when none is set. */
  suggested: number | null
}

export interface ReorderReport {
  rows: ReorderRow[]
  totals: { items: number; outOfStock: number }
}

/**
 * Items at or below their reorder point.
 *
 * Site-filtered on hand, but the reorder point is per item rather than per
 * site, so a site filter here answers "what is short IN THIS SITE against the
 * item's overall point" — useful for a single-site business and misleading for
 * a multi-site one. Said plainly on the screen rather than left to be inferred.
 *
 * Items with a reorder point of 0 are excluded: 0 means nobody set one, and a
 * report listing every item that happens to be empty is not a purchase list.
 */
export async function reorderReport(
  db: PrismaClient,
  filters: ReportFilters = {},
): Promise<ReorderReport> {
  const items = await db.item.findMany({
    where: {
      active: true,
      deletedAt: null,
      reorderPoint: { gt: 0 },
      ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
    },
    select: {
      id: true,
      sku: true,
      name: true,
      unit: true,
      reorderPoint: true,
      maxLevel: true,
      category: { select: { name: true } },
    },
  })

  const onHandByItem = await db.stockLevel.groupBy({
    by: ['itemId'],
    where: {
      itemId: { in: items.map((item) => item.id) },
      ...(filters.siteId ? { location: { siteId: filters.siteId } } : {}),
    },
    _sum: { quantity: true },
  })

  const onHand = new Map(onHandByItem.map((row) => [row.itemId, row._sum.quantity ?? 0]))

  const rows = items
    .map((item) => {
      const quantity = onHand.get(item.id) ?? 0

      return {
        itemId: item.id,
        sku: item.sku,
        itemName: item.name,
        unit: item.unit,
        categoryName: item.category?.name ?? null,
        onHand: quantity,
        reorderPoint: item.reorderPoint,
        maxLevel: item.maxLevel,
        shortBy: item.reorderPoint - quantity,
        suggested: item.maxLevel === null ? null : Math.max(0, item.maxLevel - quantity),
      }
    })
    .filter((row) => row.onHand <= row.reorderPoint)
    // Most short first: this is a list somebody works down.
    .sort((a, b) => b.shortBy - a.shortBy || a.sku.localeCompare(b.sku))

  return {
    rows,
    totals: {
      items: rows.length,
      outOfStock: rows.filter((row) => row.onHand <= 0).length,
    },
  }
}
