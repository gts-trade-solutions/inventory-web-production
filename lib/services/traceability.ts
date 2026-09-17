import 'server-only'
import { BatchStatus, TrackingMode } from '@prisma/client'
import type { PrismaClient, SerialStatus } from '@prisma/client'
import { NO_BATCH, fromBatchKey } from '@/lib/domain/types'
import { isEpc } from '@/lib/domain/sgtin96'

/**
 * Reads for the traceability screens.
 *
 * The question a quality incident actually asks is "where did batch X go?", and
 * it has to answer in one call — not by clicking through twenty movements. That
 * is the whole reason batch and serial live in the ledger's grain (WADR-018).
 */

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

export type ExpiryState = 'EXPIRED' | 'NEAR' | 'OK' | 'NONE'

export interface BatchRow {
  id: string
  batchNo: string
  itemId: string
  itemSku: string
  itemName: string
  unit: string
  expiryDate: Date | null
  status: BatchStatus
  supplierRef: string | null
  onHand: number
  expiryState: ExpiryState
  daysToExpiry: number | null
}

const DAY = 86_400_000

function startOfUtcDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

/**
 * Expiry is a whole-day concept: a batch dated the 12th is good all day on the
 * 12th. Comparing instants expires stock a day early for anyone west of UTC.
 */
export function expiryStateOf(
  expiryDate: Date | null,
  now: Date,
  nearDays: number,
): { state: ExpiryState; daysToExpiry: number | null } {
  if (!expiryDate) return { state: 'NONE', daysToExpiry: null }

  const days = Math.round((startOfUtcDay(expiryDate) - startOfUtcDay(now)) / DAY)

  if (days < 0) return { state: 'EXPIRED', daysToExpiry: days }
  if (days <= nearDays) return { state: 'NEAR', daysToExpiry: days }
  return { state: 'OK', daysToExpiry: days }
}

export interface BatchFilter {
  itemId?: string
  status?: BatchStatus
  expiryState?: ExpiryState
  search?: string
}

/** The batch register, with on-hand summed from the projection. */
export async function listBatches(
  db: PrismaClient,
  filter: BatchFilter = {},
  now: Date = new Date(),
): Promise<BatchRow[]> {
  const batches = await db.batch.findMany({
    where: {
      itemId: filter.itemId,
      status: filter.status,
      ...(filter.search
        ? {
            OR: [
              { batchNo: { contains: filter.search } },
              { item: { name: { contains: filter.search } } },
              { item: { sku: { contains: filter.search } } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      batchNo: true,
      expiryDate: true,
      status: true,
      supplierRef: true,
      itemId: true,
      item: { select: { sku: true, name: true, unit: true, nearExpiryDays: true } },
    },
    orderBy: [{ expiryDate: 'asc' }, { batchNo: 'asc' }],
  })

  if (batches.length === 0) return []

  const levels = await db.stockLevel.groupBy({
    by: ['batchId'],
    where: { batchId: { in: batches.map((batch) => batch.id) } },
    _sum: { quantity: true },
  })
  const onHandByBatch = new Map(levels.map((level) => [level.batchId, level._sum.quantity ?? 0]))

  const rows = batches.map((batch) => {
    const { state, daysToExpiry } = expiryStateOf(batch.expiryDate, now, batch.item.nearExpiryDays)

    return {
      id: batch.id,
      batchNo: batch.batchNo,
      itemId: batch.itemId,
      itemSku: batch.item.sku,
      itemName: batch.item.name,
      unit: batch.item.unit,
      expiryDate: batch.expiryDate,
      status: batch.status,
      supplierRef: batch.supplierRef,
      onHand: onHandByBatch.get(batch.id) ?? 0,
      expiryState: state,
      daysToExpiry,
    }
  })

  return filter.expiryState ? rows.filter((row) => row.expiryState === filter.expiryState) : rows
}

export interface ExpirySummary {
  expired: { batches: number; units: number }
  near: { batches: number; units: number }
  quarantined: { batches: number; units: number }
}

/**
 * The expiry board.
 *
 * Counts only batches that still HOLD stock: an expired batch with nothing left
 * is history, not a problem, and listing it buries the ones that matter.
 */
export async function expirySummary(
  db: PrismaClient,
  now: Date = new Date(),
): Promise<ExpirySummary> {
  const rows = (await listBatches(db, {}, now)).filter((row) => row.onHand > 0)

  const tally = (predicate: (row: BatchRow) => boolean) => {
    const matched = rows.filter(predicate)
    return {
      batches: matched.length,
      units: matched.reduce((sum, row) => sum + row.onHand, 0),
    }
  }

  return {
    expired: tally((row) => row.expiryState === 'EXPIRED'),
    near: tally((row) => row.expiryState === 'NEAR'),
    quarantined: tally((row) => row.status === BatchStatus.QUARANTINE),
  }
}

// ---------------------------------------------------------------------------
// Batch genealogy — the recall query
// ---------------------------------------------------------------------------

export interface BatchTrace {
  batch: BatchRow
  /** Where the batch's stock currently sits. */
  locations: Array<{ locationId: string; code: string; name: string; quantity: number }>
  movements: Array<{
    id: string
    docNo: string
    type: string
    quantity: number
    from: string | null
    to: string | null
    occurredAt: Date
    user: string | null
    device: string | null
  }>
  /** Units produced from this batch, for serial-tracked items. */
  units: Array<{ id: string; serialNo: string; status: string; location: string | null }>
}

/**
 * Everything about one batch: current locations, full movement history, and the
 * units it produced. This is the recall pack.
 */
export async function traceBatch(
  db: PrismaClient,
  batchId: string,
  now: Date = new Date(),
): Promise<BatchTrace | null> {
  const [row] = await listBatches(db, {}, now).then((rows) =>
    rows.filter((candidate) => candidate.id === batchId),
  )
  if (!row) return null

  const [levels, movements, units] = await Promise.all([
    db.stockLevel.findMany({
      where: { batchId, quantity: { not: 0 } },
      select: {
        locationId: true,
        quantity: true,
        location: { select: { code: true, name: true } },
      },
    }),
    db.movement.findMany({
      where: { batchId },
      select: {
        id: true,
        docNo: true,
        type: true,
        quantity: true,
        occurredAt: true,
        fromLocation: { select: { code: true } },
        toLocation: { select: { code: true } },
        user: { select: { name: true } },
        device: { select: { label: true } },
      },
      orderBy: { occurredAt: 'desc' },
    }),
    db.serialUnit.findMany({
      where: { batchId },
      select: { id: true, serialNo: true, status: true, location: { select: { code: true } } },
      orderBy: { serialNo: 'asc' },
    }),
  ])

  return {
    batch: row,
    locations: levels.map((level) => ({
      locationId: level.locationId,
      code: level.location.code,
      name: level.location.name,
      quantity: level.quantity,
    })),
    movements: movements.map((movement) => ({
      id: movement.id,
      docNo: movement.docNo,
      type: movement.type,
      quantity: movement.quantity,
      from: movement.fromLocation?.code ?? null,
      to: movement.toLocation?.code ?? null,
      occurredAt: movement.occurredAt,
      user: movement.user?.name ?? null,
      device: movement.device?.label ?? null,
    })),
    units: units.map((unit) => ({
      id: unit.id,
      serialNo: unit.serialNo,
      status: unit.status,
      location: unit.location?.code ?? null,
    })),
  }
}

// ---------------------------------------------------------------------------
// Serial units
// ---------------------------------------------------------------------------

export interface SerialHistoryEntry {
  docNo: string
  type: string
  from: string | null
  to: string | null
  occurredAt: Date
  user: string | null
  device: string | null
  note: string | null
}

export interface SerialTrace {
  unit: {
    id: string
    serialNo: string
    epc: string | null
    status: string
    itemId: string
    itemSku: string
    itemName: string
    batchNo: string | null
    batchId: string | null
    location: string | null
    receivedAt: Date
    issuedAt: Date | null
  }
  history: SerialHistoryEntry[]
}

/**
 * The full life of one physical unit: received on this document, moved twice,
 * counted once, issued on that document.
 *
 * `serial_units.locationId` is a projection; this history is the ledger behind
 * it, reconstructed from every movement the unit appears in.
 */
export async function traceSerialUnit(
  db: PrismaClient,
  unitId: string,
): Promise<SerialTrace | null> {
  const unit = await db.serialUnit.findUnique({
    where: { id: unitId },
    select: {
      id: true,
      serialNo: true,
      epc: true,
      status: true,
      itemId: true,
      receivedAt: true,
      issuedAt: true,
      batchId: true,
      batch: { select: { batchNo: true } },
      item: { select: { sku: true, name: true } },
      location: { select: { code: true } },
    },
  })
  if (!unit) return null

  const links = await db.movementSerial.findMany({
    where: { serialUnitId: unitId },
    select: {
      movement: {
        select: {
          docNo: true,
          type: true,
          quantity: true,
          occurredAt: true,
          note: true,
          fromLocation: { select: { code: true } },
          toLocation: { select: { code: true } },
          user: { select: { name: true } },
          device: { select: { label: true } },
        },
      },
    },
    orderBy: { movement: { occurredAt: 'asc' } },
  })

  return {
    unit: {
      id: unit.id,
      serialNo: unit.serialNo,
      epc: unit.epc,
      status: unit.status,
      itemId: unit.itemId,
      itemSku: unit.item.sku,
      itemName: unit.item.name,
      batchNo: unit.batch?.batchNo ?? null,
      batchId: unit.batchId,
      location: unit.location?.code ?? null,
      receivedAt: unit.receivedAt,
      issuedAt: unit.issuedAt,
    },
    history: links.map(({ movement }) => ({
      docNo: movement.docNo,
      type: movement.type,
      from: movement.fromLocation?.code ?? null,
      to: movement.toLocation?.code ?? null,
      occurredAt: movement.occurredAt,
      user: movement.user?.name ?? null,
      device: movement.device?.label ?? null,
      note: movement.note,
    })),
  }
}

export interface SerialUnitRow {
  id: string
  serialNo: string
  epc: string | null
  status: SerialStatus
  itemId: string
  itemSku: string
  itemName: string
  batchId: string | null
  batchNo: string | null
  location: string | null
}

export interface SerialUnitFilter {
  itemId?: string
  batchId?: string
  status?: SerialStatus
  /** A serial number, item, batch — or a scanned EPC, which is matched exactly. */
  search?: string
  limit?: number
}

const SERIAL_PAGE_SIZE = 100

/**
 * The serial unit register.
 *
 * Search accepts a scanned RFID tag as readily as a typed serial number: an
 * operator holding a reader has the EPC, not the serial, and making them
 * translate it by hand wastes the point of tagging the unit. An EPC is matched
 * exactly rather than by substring — a partial EPC match is never a real hit,
 * and one that resolved to the wrong unit would be worse than no hit at all.
 */
export async function listSerialUnits(
  db: PrismaClient,
  filter: SerialUnitFilter = {},
): Promise<SerialUnitRow[]> {
  const search = filter.search?.trim() ?? ''

  const units = await db.serialUnit.findMany({
    where: {
      ...(filter.itemId ? { itemId: filter.itemId } : {}),
      ...(filter.batchId ? { batchId: filter.batchId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      ...(search
        ? isEpc(search)
          ? { epc: search.toUpperCase() }
          : {
              OR: [
                { serialNo: { contains: search } },
                { item: { name: { contains: search } } },
                { item: { sku: { contains: search } } },
                { batch: { batchNo: { contains: search } } },
              ],
            }
        : {}),
    },
    select: {
      id: true,
      serialNo: true,
      epc: true,
      status: true,
      itemId: true,
      item: { select: { sku: true, name: true } },
      batch: { select: { id: true, batchNo: true } },
      location: { select: { code: true } },
    },
    orderBy: [{ item: { sku: 'asc' } }, { serialNo: 'asc' }],
    take: Math.min(Math.max(filter.limit ?? SERIAL_PAGE_SIZE, 1), 500),
  })

  return units.map((unit) => ({
    id: unit.id,
    serialNo: unit.serialNo,
    epc: unit.epc,
    status: unit.status,
    itemId: unit.itemId,
    itemSku: unit.item.sku,
    itemName: unit.item.name,
    batchId: unit.batch?.id ?? null,
    batchNo: unit.batch?.batchNo ?? null,
    location: unit.location?.code ?? null,
  }))
}

/** Resolves a scanned RFID tag straight to its unit. */
export async function findUnitByEpc(db: PrismaClient, epc: string) {
  return db.serialUnit.findUnique({
    where: { epc: epc.toUpperCase() },
    select: { id: true, serialNo: true, itemId: true, status: true },
  })
}

// ---------------------------------------------------------------------------
// Item stock, at the tracking grain
// ---------------------------------------------------------------------------

export interface ItemStockRow {
  locationId: string
  locationCode: string
  locationName: string
  batchId: string | null
  batchNo: string | null
  expiryDate: Date | null
  expiryState: ExpiryState
  quantity: number
}

/**
 * Where an item's stock is, broken down the way the item is tracked: one row per
 * location for an untracked item, one per location AND batch for a tracked one.
 */
export async function itemStock(
  db: PrismaClient,
  itemId: string,
  now: Date = new Date(),
): Promise<ItemStockRow[]> {
  const [item, levels] = await Promise.all([
    db.item.findUnique({
      where: { id: itemId },
      select: { nearExpiryDays: true, trackingMode: true },
    }),
    db.stockLevel.findMany({
      where: { itemId, quantity: { not: 0 } },
      select: {
        locationId: true,
        batchId: true,
        quantity: true,
        location: { select: { code: true, name: true } },
      },
    }),
  ])
  if (!item) return []

  const batchIds = [...new Set(levels.map((level) => level.batchId))].filter(
    (id) => id !== NO_BATCH,
  )
  const batches = batchIds.length
    ? await db.batch.findMany({
        where: { id: { in: batchIds } },
        select: { id: true, batchNo: true, expiryDate: true },
      })
    : []
  const byId = new Map(batches.map((batch) => [batch.id, batch]))

  return levels
    .map((level) => {
      const batch = byId.get(level.batchId)
      const { state } = expiryStateOf(batch?.expiryDate ?? null, now, item.nearExpiryDays)

      return {
        locationId: level.locationId,
        locationCode: level.location.code,
        locationName: level.location.name,
        batchId: fromBatchKey(level.batchId),
        batchNo: batch?.batchNo ?? null,
        expiryDate: batch?.expiryDate ?? null,
        expiryState: state,
        quantity: level.quantity,
      }
    })
    .sort(
      (a, b) =>
        a.locationCode.localeCompare(b.locationCode) ||
        (a.batchNo ?? '').localeCompare(b.batchNo ?? ''),
    )
}

export { TrackingMode }
