import { ean13 } from './gtin'
import {
  BatchStatus,
  LocationZone,
  MovementType,
  SerialStatus,
  TrackingMode,
  type Batch,
  type Item,
  type Location,
  type Movement,
  type SerialUnit,
} from './types'
import type { ExpiryPolicy, MovementContext } from './movement'

/**
 * Test fixtures, ported from the mobile app's `commonTest/TestFixtures.kt` so
 * the two test suites describe the same warehouse. Same item, same locations,
 * same barcode — a failure in one is recognisable in the other.
 */

export const NOW = new Date('2026-09-17T00:00:00.000Z')

export const AISLE_A: Location = { id: 'loc-a', code: 'A-01', zone: LocationZone.STORAGE }
export const AISLE_B: Location = { id: 'loc-b', code: 'B-01', zone: LocationZone.STORAGE }

/** Untracked: behaves exactly as the mobile MVP's items do today. */
export const TAPE: Item = {
  id: 'item-tape',
  sku: 'PKG-1004',
  name: 'Packing tape 48 mm clear',
  barcode: ean13('890123400004'),
  unit: 'rolls',
  reorderPoint: 10,
  trackingMode: TrackingMode.NONE,
  expiryRequired: false,
  shelfLifeDays: null,
  nearExpiryDays: 30,
}

export const GLOVES: Item = {
  id: 'item-gloves',
  sku: 'SAF-1010',
  name: 'Nitrile gloves, size M',
  barcode: ean13('890123400010'),
  unit: 'boxes',
  reorderPoint: 30,
  trackingMode: TrackingMode.NONE,
  expiryRequired: false,
  shelfLifeDays: null,
  nearExpiryDays: 30,
}

export const ADHESIVE: Item = {
  id: 'item-adhesive',
  sku: 'CHM-2001',
  name: 'Industrial adhesive 5 L',
  barcode: ean13('890123400200'),
  unit: 'cans',
  reorderPoint: 5,
  trackingMode: TrackingMode.BATCH,
  expiryRequired: true,
  shelfLifeDays: 365,
  nearExpiryDays: 30,
}

export const DRILL: Item = {
  id: 'item-drill',
  sku: 'TLS-0015',
  name: 'Cordless drill 18 V',
  barcode: ean13('890123400015'),
  unit: 'pcs',
  reorderPoint: 3,
  trackingMode: TrackingMode.SERIAL,
  expiryRequired: false,
  shelfLifeDays: null,
  nearExpiryDays: 30,
}

export const FRESH_BATCH: Batch = {
  id: 'batch-fresh',
  itemId: ADHESIVE.id,
  batchNo: 'LOT-2026-0901',
  expiryDate: new Date('2027-09-01T00:00:00.000Z'),
  status: BatchStatus.ACTIVE,
}

/** Expires sooner than FRESH_BATCH, so FEFO must prefer it. */
export const SOON_BATCH: Batch = {
  id: 'batch-soon',
  itemId: ADHESIVE.id,
  batchNo: 'LOT-2026-0401',
  expiryDate: new Date('2026-10-01T00:00:00.000Z'),
  status: BatchStatus.ACTIVE,
}

export const EXPIRED_BATCH: Batch = {
  id: 'batch-expired',
  itemId: ADHESIVE.id,
  batchNo: 'LOT-2025-1201',
  expiryDate: new Date('2026-09-16T00:00:00.000Z'),
  status: BatchStatus.ACTIVE,
}

export const QUARANTINED_BATCH: Batch = {
  id: 'batch-quarantine',
  itemId: ADHESIVE.id,
  batchNo: 'LOT-2026-0715',
  expiryDate: new Date('2027-07-15T00:00:00.000Z'),
  status: BatchStatus.QUARANTINE,
}

export function serialUnit(overrides: Partial<SerialUnit> & { id: string }): SerialUnit {
  return {
    itemId: DRILL.id,
    serialNo: overrides.id.toUpperCase(),
    batchId: null,
    epc: null,
    status: SerialStatus.IN_STOCK,
    locationId: AISLE_A.id,
    ...overrides,
  }
}

let sequence = 0

/** A receipt, matching the Kotlin fixture's shape. */
export function receipt(
  quantity: number,
  at: Location = AISLE_A,
  item: Item = TAPE,
  batchId: string | null = null,
): Movement {
  return {
    id: `seed-${item.id}-${at.id}-${quantity}-${++sequence}`,
    itemId: item.id,
    type: MovementType.RECEIVE,
    quantity,
    batchId,
    fromLocationId: null,
    toLocationId: at.id,
  }
}

export function movement(overrides: Partial<Movement> & { id: string }): Movement {
  return {
    itemId: TAPE.id,
    type: MovementType.ISSUE,
    quantity: 1,
    batchId: null,
    fromLocationId: null,
    toLocationId: null,
    ...overrides,
  }
}

export const BLOCK_EXPIRED: ExpiryPolicy = { issuePolicy: 'BLOCK' }
export const WARN_EXPIRED: ExpiryPolicy = { issuePolicy: 'WARN' }

export function context(overrides: Partial<MovementContext> = {}): MovementContext {
  return {
    item: TAPE,
    knownLocationIds: new Set([AISLE_A.id, AISLE_B.id]),
    ledger: [],
    batches: [],
    serials: [],
    now: NOW,
    policy: BLOCK_EXPIRED,
    ...overrides,
  }
}
