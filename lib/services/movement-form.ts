import 'server-only'
import { BatchStatus, TrackingMode } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import { proposeBatchFefo } from '@/lib/domain/movement'
import { NO_BATCH } from '@/lib/domain/types'
import { expiryStateOf, type ExpiryState } from './traceability'

/**
 * Everything a movement form needs to be filled in correctly.
 *
 * Loaded server-side and passed down, so the form never guesses what is
 * available. The alternative — letting the operator type a quantity and finding
 * out on submit that the batch expired — wastes a trip to the shelf.
 */

export interface BatchOption {
  id: string
  batchNo: string
  expiryDate: Date | null
  expiryState: ExpiryState
  daysToExpiry: number | null
  status: BatchStatus
  available: number
  /** Why this batch cannot be used, or null when it can. */
  blockedReason: string | null
}

export interface SerialOption {
  id: string
  serialNo: string
  epc: string | null
  batchNo: string | null
}

export interface MovementFormData {
  item: {
    id: string
    sku: string
    name: string
    unit: string
    trackingMode: TrackingMode
    expiryRequired: boolean
  }
  locations: Array<{ id: string; code: string; name: string; zone: string }>
  /** On-hand per location, for the "available" hint next to the source. */
  onHandByLocation: Record<string, number>
  batches: BatchOption[]
  /** The FEFO proposal for the given location and quantity, if one fits. */
  proposedBatchId: string | null
  serials: SerialOption[]
  reasonCodes: Array<{ id: string; code: string; label: string; appliesTo: string; requiresNote: boolean }>
}

export async function loadMovementForm(
  db: PrismaClient,
  options: {
    itemId: string
    siteId: string
    fromLocationId?: string
    quantity?: number
  },
  now: Date = new Date(),
): Promise<MovementFormData | null> {
  const item = await db.item.findFirst({
    where: { id: options.itemId, deletedAt: null },
    select: {
      id: true,
      sku: true,
      name: true,
      unit: true,
      trackingMode: true,
      expiryRequired: true,
      nearExpiryDays: true,
    },
  })
  if (!item) return null

  const [locations, levels, batchRows, reasonCodes] = await Promise.all([
    db.location.findMany({
      where: { siteId: options.siteId, deletedAt: null, active: true },
      select: { id: true, code: true, name: true, zone: true },
      orderBy: { code: 'asc' },
    }),
    db.stockLevel.findMany({
      where: { itemId: item.id },
      select: { locationId: true, batchId: true, quantity: true },
    }),
    item.trackingMode === TrackingMode.NONE
      ? []
      : db.batch.findMany({
          where: { itemId: item.id },
          select: { id: true, batchNo: true, expiryDate: true, status: true },
          orderBy: [{ expiryDate: 'asc' }, { batchNo: 'asc' }],
        }),
    db.reasonCode.findMany({
      where: { active: true },
      select: { id: true, code: true, label: true, appliesTo: true, requiresNote: true },
      orderBy: { label: 'asc' },
    }),
  ])

  const onHandByLocation: Record<string, number> = {}
  for (const level of levels) {
    onHandByLocation[level.locationId] = (onHandByLocation[level.locationId] ?? 0) + level.quantity
  }

  // Availability is per location when one is chosen, because "20 in stock" is
  // misleading when 18 of them are in another aisle.
  const availabilityOf = (batchId: string) =>
    levels
      .filter(
        (level) =>
          level.batchId === batchId &&
          (!options.fromLocationId || level.locationId === options.fromLocationId),
      )
      .reduce((sum, level) => sum + level.quantity, 0)

  const batches: BatchOption[] = batchRows.map((batch) => {
    const { state, daysToExpiry } = expiryStateOf(batch.expiryDate, now, item.nearExpiryDays)
    const available = availabilityOf(batch.id)

    return {
      id: batch.id,
      batchNo: batch.batchNo,
      expiryDate: batch.expiryDate,
      expiryState: state,
      daysToExpiry,
      status: batch.status,
      available,
      blockedReason:
        batch.status === BatchStatus.QUARANTINE
          ? 'Quarantined'
          : batch.status === BatchStatus.BLOCKED
            ? 'Blocked'
            : state === 'EXPIRED'
              ? 'Expired'
              : null,
    }
  })

  // FEFO proposal. Only a proposal — the operator may override it, and the
  // override is recorded on the movement (ARCHITECTURE §5.2).
  const proposed =
    options.quantity && options.quantity > 0
      ? proposeBatchFefo(
          batches.map((batch) => ({
            batch: {
              id: batch.id,
              itemId: item.id,
              batchNo: batch.batchNo,
              expiryDate: batch.expiryDate,
              status: batch.status,
            },
            available: batch.available,
          })),
          options.quantity,
          now,
        )
      : null

  const serials =
    item.trackingMode === TrackingMode.SERIAL && options.fromLocationId
      ? await db.serialUnit.findMany({
          where: { itemId: item.id, status: 'IN_STOCK', locationId: options.fromLocationId },
          select: { id: true, serialNo: true, epc: true, batch: { select: { batchNo: true } } },
          orderBy: { serialNo: 'asc' },
          take: 200,
        })
      : []

  return {
    item: {
      id: item.id,
      sku: item.sku,
      name: item.name,
      unit: item.unit,
      trackingMode: item.trackingMode,
      expiryRequired: item.expiryRequired,
    },
    locations,
    onHandByLocation,
    batches,
    proposedBatchId: proposed?.id ?? null,
    serials: serials.map((unit) => ({
      id: unit.id,
      serialNo: unit.serialNo,
      epc: unit.epc,
      batchNo: unit.batch?.batchNo ?? null,
    })),
    reasonCodes,
  }
}

export { NO_BATCH, TrackingMode }
