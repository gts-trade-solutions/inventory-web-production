import 'server-only'
import { randomUUID } from 'node:crypto'
import { MovementSource, SerialStatus } from '@prisma/client'
// Type-only, so it cannot construct a client and bypass the mode resolver.
import type { PrismaClient } from '@prisma/client'
import type { Db } from '@/lib/db'
import { planMovement, type MovementError, type StockAction } from '@/lib/domain/movement'
import {
  NO_BATCH,
  toBatchKey,
  type Batch,
  type Item,
  type SerialUnit,
  type StockLevel,
} from '@/lib/domain/types'
import { allocateDocNo, docKeyForMovement } from './numbering'
import { deterministicLockOrder, withDeadlockRetry } from './tx'

/**
 * The one write path. Every stock change — web form, web scan, mobile sync push,
 * CSV import, ERP feed — goes through here (ARCHITECTURE §4.3).
 *
 * The transaction, in order:
 *   1. lock the affected stock rows, sorted, so opposing MOVEs cannot deadlock
 *   2. lock the named serial units
 *   3. validate in lib/domain against the LOCKED state, never a stale read
 *   4. append the ledger entry (duplicate id means already recorded)
 *   5. move the projections atomically
 *
 * Steps 1 and 3 are inseparable. Validating before taking the locks is the
 * classic check-then-act race: two operators both read "12 available", both
 * issue 8, and the shelf goes to -4.
 */

export interface RecordMovementInput {
  /** Client-generated UUID. It is the primary key AND the idempotency key. */
  id?: string
  siteId: string
  action: StockAction
  occurredAt?: Date
  source?: MovementSource
  deviceId?: string | null
  countSessionId?: string | null
  /** A supervisor issuing expired stock, recorded on the movement. */
  allowExpiredOverride?: boolean
}

export type RecordOutcome =
  | { status: 'RECORDED'; movementId: string; docNo: string }
  | { status: 'DUPLICATE'; movementId: string; docNo: string }
  | { status: 'REJECTED'; error: MovementError }
  /** Written, but it drove stock negative. A supervisor now owns it (WADR-007). */
  | {
      status: 'FLAGGED'
      movementId: string
      docNo: string
      reason: 'NEGATIVE_STOCK'
      details: unknown
    }

export class MovementRejected extends Error {
  readonly code = 'MOVEMENT_REJECTED'

  constructor(readonly error: MovementError) {
    super(error.message)
    this.name = 'MovementRejected'
  }
}

/**
 * Records one movement.
 *
 * `acceptNegative` is the online/offline split (WADR-007). An online caller is
 * told "insufficient stock" before it commits. A movement queued offline is
 * accepted even when it drives stock negative, because rejecting it would
 * discard work an operator physically did on the floor.
 */
export async function recordMovement(
  prisma: PrismaClient,
  input: RecordMovementInput,
  actor: { userId: string | null },
  options: { acceptNegative?: boolean } = {},
): Promise<RecordOutcome> {
  return withDeadlockRetry(prisma, (tx) => recordMovementInTx(tx, input, actor, options), {
    label: `record ${input.action.kind}`,
  })
}

/**
 * Records a movement inside a transaction the CALLER already opened.
 *
 * Count approval needs this: every COUNT posting for a session must land in one
 * transaction, so a half-approved count is impossible. The caller owns the
 * retry-on-deadlock wrapper.
 */
export async function recordMovementInTx(
  tx: Db,
  input: RecordMovementInput,
  actor: { userId: string | null },
  options: { acceptNegative?: boolean } = {},
): Promise<RecordOutcome> {
  const movementId = input.id ?? randomUUID()
  const { action } = input

  // Idempotency first: a retry must be a cheap no-op, not a re-validation that
  // might now fail for unrelated reasons (ARCHITECTURE §5.6).
  const existing = await tx.movement.findUnique({
    where: { id: movementId },
    select: { id: true, docNo: true },
  })
  if (existing) {
    return { status: 'DUPLICATE', movementId: existing.id, docNo: existing.docNo }
  }

  const item = await tx.item.findUnique({
    where: { id: action.itemId },
    select: {
      id: true,
      sku: true,
      name: true,
      unit: true,
      reorderPoint: true,
      trackingMode: true,
      expiryRequired: true,
      shelfLifeDays: true,
      nearExpiryDays: true,
      deletedAt: true,
    },
  })

  if (!item || item.deletedAt) {
    return rejected('UNKNOWN_ITEM', 'That item does not exist.')
  }

  const locationIds = locationsTouchedBy(action)
  const locations = await tx.location.findMany({
    where: { id: { in: locationIds }, deletedAt: null },
    select: { id: true },
  })
  const knownLocationIds = new Set(locations.map((location) => location.id))

  // --- 1. Lock the stock rows -------------------------------------------
  // Sorted, so two transactions touching the same pair take them in the same
  // order. Without this, a MOVE A->B and a MOVE B->A deadlock constantly.
  const lockedLocationIds = deterministicLockOrder(locationIds)
  const stock = await lockStock(tx, item.id, lockedLocationIds)

  // --- 2. Lock the named serial units ------------------------------------
  const serialIds = deterministicLockOrder(action.serialUnitIds ?? [])
  const serials = serialIds.length > 0 ? await lockSerials(tx, serialIds) : []

  const batches = await loadBatches(tx, item.id)

  // --- 3. Validate against the locked state ------------------------------
  const decision = planMovement(action, {
    item: toDomainItem(item),
    knownLocationIds,
    stock,
    batches,
    serials,
    now: input.occurredAt ?? new Date(),
    policy: { issuePolicy: await expiryPolicy(tx, input.siteId) },
    allowExpiredOverride: input.allowExpiredOverride,
  })

  if (!decision.ok) {
    // An offline push that would go negative is accepted and flagged rather
    // than rejected. Everything else is a real error either way: a missing
    // location or an already-issued serial is not fixed by accepting it.
    const negativeOnly = decision.error.code === 'INSUFFICIENT_STOCK'
    if (!options.acceptNegative || !negativeOnly) {
      return { status: 'REJECTED', error: decision.error }
    }
  }

  const planned = decision.ok
    ? decision.movement
    : fallbackPlan(action, item.trackingMode === 'SERIAL' ? serialIds : [])

  // --- 4. Append the ledger entry ----------------------------------------
  const docNo = await allocateDocNo(tx, docKeyForMovement(planned.type))

  await tx.movement.create({
    data: {
      id: movementId,
      docNo,
      siteId: input.siteId,
      itemId: planned.itemId,
      type: planned.type,
      quantity: planned.quantity,
      batchId: planned.batchId,
      fromLocationId: planned.fromLocationId,
      toLocationId: planned.toLocationId,
      reasonCodeId: planned.reasonCodeId,
      note: planned.note,
      reference: planned.reference,
      occurredAt: input.occurredAt ?? new Date(),
      userId: actor.userId,
      deviceId: input.deviceId ?? null,
      countSessionId: input.countSessionId ?? null,
      source: input.source ?? MovementSource.WEB,
    },
  })

  if (planned.serialUnitIds.length > 0) {
    // Exactly `quantity` rows. The domain guarantees it; this is the database
    // saying so too, because a mismatch here corrupts the unit register.
    if (planned.serialUnitIds.length !== planned.quantity) {
      throw new Error(
        `Serial count mismatch writing ${docNo}: ${planned.serialUnitIds.length} units for quantity ${planned.quantity}.`,
      )
    }

    await tx.movementSerial.createMany({
      data: planned.serialUnitIds.map((serialUnitId) => ({ movementId, serialUnitId })),
    })
  }

  // --- 5. Move the projections -------------------------------------------
  const batchKey = toBatchKey(planned.batchId)

  if (planned.toLocationId) {
    await applyStockDelta(tx, planned.itemId, planned.toLocationId, batchKey, planned.quantity)
  }
  if (planned.fromLocationId) {
    await applyStockDelta(tx, planned.itemId, planned.fromLocationId, batchKey, -planned.quantity)
  }

  if (planned.serialUnitIds.length > 0) {
    await applySerialMoves(tx, planned)
  }

  const negative = await firstNegativeLevel(tx, planned)
  if (negative) {
    return {
      status: 'FLAGGED',
      movementId,
      docNo,
      reason: 'NEGATIVE_STOCK',
      details: {
        itemId: negative.itemId,
        locationId: negative.locationId,
        resultingQuantity: negative.quantity,
      },
    }
  }

  return { status: 'RECORDED', movementId, docNo }
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

/**
 * Reads the stock rows FOR UPDATE.
 *
 * Prisma has no FOR UPDATE, so this is raw SQL. It must stay raw: an ordinary
 * findMany takes no lock, and the validation that follows would then be racing
 * every other writer.
 */
async function lockStock(
  tx: Db,
  itemId: string,
  locationIds: readonly string[],
): Promise<StockLevel[]> {
  if (locationIds.length === 0) return []

  const rows = await tx.$queryRawUnsafe<
    Array<{ itemId: string; locationId: string; batchId: string; quantity: number }>
  >(
    `SELECT itemId, locationId, batchId, quantity
       FROM stock_levels
      WHERE itemId = ? AND locationId IN (${locationIds.map(() => '?').join(', ')})
      ORDER BY locationId, batchId
      FOR UPDATE`,
    itemId,
    ...locationIds,
  )

  return rows.map((row) => ({
    itemId: row.itemId,
    locationId: row.locationId,
    batchKey: row.batchId,
    quantity: Number(row.quantity),
  }))
}

/**
 * Locks the named units.
 *
 * This is what makes two devices issuing the same physical unit detectable: the
 * second transaction blocks here, and by the time it reads the row the status is
 * already ISSUED (WADR-020).
 */
async function lockSerials(tx: Db, serialIds: readonly string[]): Promise<SerialUnit[]> {
  const rows = await tx.$queryRawUnsafe<
    Array<{
      id: string
      itemId: string
      serialNo: string
      batchId: string | null
      epc: string | null
      status: SerialStatus
      locationId: string | null
    }>
  >(
    `SELECT id, itemId, serialNo, batchId, epc, status, locationId
       FROM serial_units
      WHERE id IN (${serialIds.map(() => '?').join(', ')})
      ORDER BY id
      FOR UPDATE`,
    ...serialIds,
  )

  return rows
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

/**
 * Moves one projection row atomically.
 *
 * Prisma's `upsert` is a non-atomic read-then-write, which under concurrency
 * loses updates. `ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity)`
 * is a single statement the database resolves itself (WADR-003).
 */
async function applyStockDelta(
  tx: Db,
  itemId: string,
  locationId: string,
  batchKey: string,
  delta: number,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO stock_levels (itemId, locationId, batchId, quantity, updatedAt)
    VALUES (${itemId}, ${locationId}, ${batchKey}, ${delta}, NOW(6))
    ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity), updatedAt = NOW(6)
  `
}

async function applySerialMoves(
  tx: Db,
  planned: { type: string; toLocationId: string | null; serialUnitIds: string[] },
): Promise<void> {
  const leaving = planned.toLocationId === null
  const status =
    planned.type === 'SCRAP'
      ? SerialStatus.SCRAPPED
      : leaving
        ? SerialStatus.ISSUED
        : SerialStatus.IN_STOCK

  await tx.serialUnit.updateMany({
    where: { id: { in: planned.serialUnitIds } },
    data: {
      status,
      locationId: planned.toLocationId,
      ...(leaving ? { issuedAt: new Date() } : {}),
    },
  })
}

/** The projection row this movement drove negative, if any. */
async function firstNegativeLevel(
  tx: Db,
  planned: { itemId: string; fromLocationId: string | null; batchId: string | null },
): Promise<{ itemId: string; locationId: string; quantity: number } | null> {
  if (!planned.fromLocationId) return null

  const rows = await tx.$queryRaw<Array<{ itemId: string; locationId: string; quantity: number }>>`
    SELECT itemId, locationId, quantity
      FROM stock_levels
     WHERE itemId = ${planned.itemId}
       AND locationId = ${planned.fromLocationId}
       AND batchId = ${toBatchKey(planned.batchId)}
       AND quantity < 0
     LIMIT 1
  `

  const row = rows[0]
  return row ? { ...row, quantity: Number(row.quantity) } : null
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function loadBatches(tx: Db, itemId: string): Promise<Batch[]> {
  const rows = await tx.batch.findMany({
    where: { itemId },
    select: { id: true, itemId: true, batchNo: true, expiryDate: true, status: true },
  })
  return rows
}

async function expiryPolicy(tx: Db, siteId: string): Promise<'BLOCK' | 'WARN'> {
  const setting = await tx.setting.findFirst({
    where: { key: 'expiry.issuePolicy', siteId: { in: [siteId, ''] } },
    // A site-specific row beats the global one, and '' sorts first.
    orderBy: { siteId: 'desc' },
  })

  return setting?.value === 'WARN' ? 'WARN' : 'BLOCK'
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function locationsTouchedBy(action: StockAction): string[] {
  switch (action.kind) {
    case 'RECEIVE':
      return [action.toLocationId]
    case 'ISSUE':
    case 'SCRAP':
      return [action.fromLocationId]
    case 'MOVE':
      return [action.fromLocationId, action.toLocationId]
    case 'ADJUST':
    case 'COUNT':
      return [action.locationId]
  }
}

/**
 * The plan for an offline movement being accepted despite insufficient stock.
 *
 * The domain refused it, so there is no plan to use — but the movement is real
 * work that happened, so it is recorded as stated and the resulting negative row
 * becomes a supervisor's problem (WADR-007).
 */
function fallbackPlan(action: StockAction, serialUnitIds: string[]) {
  const quantity = 'quantity' in action ? action.quantity : 0

  return {
    itemId: action.itemId,
    type: action.kind as never,
    quantity,
    batchId: action.batchId ?? null,
    fromLocationId:
      action.kind === 'ISSUE' || action.kind === 'SCRAP' || action.kind === 'MOVE'
        ? action.fromLocationId
        : null,
    toLocationId: action.kind === 'RECEIVE' || action.kind === 'MOVE' ? action.toLocationId : null,
    serialUnitIds,
    reasonCodeId: action.reasonCodeId ?? null,
    note: action.note?.trim() || null,
    reference: action.reference?.trim() || null,
  }
}

function toDomainItem(row: {
  id: string
  sku: string
  name: string
  unit: string
  reorderPoint: number
  trackingMode: string
  expiryRequired: boolean
  shelfLifeDays: number | null
  nearExpiryDays: number
}): Item {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    barcode: null,
    unit: row.unit,
    reorderPoint: row.reorderPoint,
    trackingMode: row.trackingMode as Item['trackingMode'],
    expiryRequired: row.expiryRequired,
    shelfLifeDays: row.shelfLifeDays,
    nearExpiryDays: row.nearExpiryDays,
  }
}

function rejected(code: MovementError['code'], message: string): RecordOutcome {
  return { status: 'REJECTED', error: { code, message } }
}

export { NO_BATCH }
