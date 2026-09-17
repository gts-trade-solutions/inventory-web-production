/**
 * Domain types.
 *
 * Deliberately declared here rather than imported from `@prisma/client`, because
 * `lib/domain` must not depend on the database layer (ARCHITECTURE §3 — the lint
 * config enforces it). The string values are identical to the Prisma enums, so a
 * service passes them straight through with no runtime mapping; TypeScript
 * checks the two stay in step because a service assigning one to the other would
 * fail to compile if a value were ever renamed.
 *
 * These mirror the mobile app's Kotlin `:core:domain` models, extended with the
 * traceability fields decided for v1 (WADR-017, WADR-018).
 */

export const MovementType = {
  RECEIVE: 'RECEIVE',
  ISSUE: 'ISSUE',
  MOVE: 'MOVE',
  ADJUST: 'ADJUST',
  COUNT: 'COUNT',
  SCRAP: 'SCRAP',
} as const
export type MovementType = (typeof MovementType)[keyof typeof MovementType]

export const TrackingMode = {
  NONE: 'NONE',
  BATCH: 'BATCH',
  SERIAL: 'SERIAL',
} as const
export type TrackingMode = (typeof TrackingMode)[keyof typeof TrackingMode]

export const BatchStatus = {
  ACTIVE: 'ACTIVE',
  QUARANTINE: 'QUARANTINE',
  EXPIRED: 'EXPIRED',
  BLOCKED: 'BLOCKED',
  CONSUMED: 'CONSUMED',
} as const
export type BatchStatus = (typeof BatchStatus)[keyof typeof BatchStatus]

export const SerialStatus = {
  IN_STOCK: 'IN_STOCK',
  ISSUED: 'ISSUED',
  SCRAPPED: 'SCRAPPED',
  QUARANTINE: 'QUARANTINE',
} as const
export type SerialStatus = (typeof SerialStatus)[keyof typeof SerialStatus]

export const LocationZone = {
  INBOUND: 'INBOUND',
  STORAGE: 'STORAGE',
  OUTBOUND: 'OUTBOUND',
} as const
export type LocationZone = (typeof LocationZone)[keyof typeof LocationZone]

/**
 * The all-zero UUID standing in for "no batch" in the stock projection.
 *
 * `stock_levels` is keyed (item, location, batch) and MySQL treats NULLs as
 * distinct in a unique key, which would silently break the ON DUPLICATE KEY
 * UPDATE that maintains the projection. A sentinel keeps the key total. It never
 * crosses the API boundary — callers see `batchId: null` (API_CONTRACT §2).
 */
export const NO_BATCH = '00000000-0000-0000-0000-000000000000'

export function toBatchKey(batchId: string | null | undefined): string {
  return batchId ?? NO_BATCH
}

export function fromBatchKey(batchKey: string): string | null {
  return batchKey === NO_BATCH ? null : batchKey
}

// ---------------------------------------------------------------------------
// Entities, as the domain sees them
// ---------------------------------------------------------------------------

export interface Item {
  id: string
  sku: string
  name: string
  barcode: string | null
  unit: string
  reorderPoint: number
  trackingMode: TrackingMode
  expiryRequired: boolean
  shelfLifeDays: number | null
  nearExpiryDays: number
}

export interface Location {
  id: string
  code: string
  zone: LocationZone
}

export interface Batch {
  id: string
  itemId: string
  batchNo: string
  /** Date only; time of day is meaningless for an expiry and invites off-by-one. */
  expiryDate: Date | null
  status: BatchStatus
}

export interface SerialUnit {
  id: string
  itemId: string
  serialNo: string
  batchId: string | null
  epc: string | null
  status: SerialStatus
  locationId: string | null
}

/** One entry in the append-only stock ledger. */
export interface Movement {
  id: string
  itemId: string
  type: MovementType
  /** Always positive; direction comes from the locations. */
  quantity: number
  batchId: string | null
  fromLocationId: string | null
  toLocationId: string | null
}

export interface StockLevel {
  itemId: string
  locationId: string
  /** Sentinel-keyed, never null — see NO_BATCH. */
  batchKey: string
  quantity: number
}
