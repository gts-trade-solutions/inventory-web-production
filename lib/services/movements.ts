import 'server-only'
import { randomUUID } from 'node:crypto'
import { MovementSource, SerialStatus } from '@prisma/client'
// Type-only, so it cannot construct a client and bypass the mode resolver.
import type { PrismaClient } from '@prisma/client'
import type { Db } from '@/lib/db'
import {
  MovementErrorCode,
  planMovement,
  type MovementError,
  type StockAction,
} from '@/lib/domain/movement'
import { resolveNewBatch, type NewBatchInput } from '@/lib/domain/batch'
import {
  NO_BATCH,
  toBatchKey,
  type Batch,
  type Item,
  type SerialUnit,
  type StockLevel,
} from '@/lib/domain/types'
import { publishMovement } from '@/lib/events/publish'
import { modeOf } from '@/lib/mode'
import { allocateDocNo, docKeyForMovement } from './numbering'
import { getSetting } from './settings'
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
  /**
   * Creates the batch as part of the receipt.
   *
   * A batch-tracked item cannot be received into a batch that does not exist,
   * and the batch does not exist until the stock does. Requiring a separate
   * "create batch" step first would be a step nobody remembers on a dock.
   */
  newBatch?: NewBatchInput
  occurredAt?: Date
  source?: MovementSource
  deviceId?: string | null
  countSessionId?: string | null
  /** A supervisor issuing expired stock, recorded on the movement. */
  allowExpiredOverride?: boolean
}

/** What a live console needs to describe the movement, already in scope. */
export interface MovementDescription {
  itemName: string
  fromCode: string | null
  toCode: string | null
}

export type RecordOutcome =
  | ({ status: 'RECORDED'; movementId: string; docNo: string } & MovementDescription)
  | { status: 'DUPLICATE'; movementId: string; docNo: string }
  | { status: 'REJECTED'; error: MovementError }
  /** Written, but it drove stock negative. A supervisor now owns it (WADR-007). */
  | ({
      status: 'FLAGGED'
      movementId: string
      docNo: string
      reason: 'NEGATIVE_STOCK'
      details: unknown
    } & MovementDescription)

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
  const outcome = await withDeadlockRetry(
    prisma,
    (tx) => recordMovementInTx(tx, input, actor, options),
    { label: `record ${input.action.kind}` },
  )

  // AFTER the transaction commits, never inside it. A live console announcing a
  // movement that then rolled back would be reporting something that never
  // happened — and a deadlock retry would announce it twice.
  //
  // `recordMovementInTx` deliberately does not do this: its caller owns the
  // transaction and we cannot know from in there whether it will commit.
  if (outcome.status === 'RECORDED' || outcome.status === 'FLAGGED') {
    publishMovement({
      mode: modeOf(prisma),
      siteId: input.siteId,
      docNo: outcome.docNo,
      type: input.action.kind,
      quantity: quantityOf(input.action),
      itemName: outcome.itemName,
      from: outcome.fromCode,
      to: outcome.toCode,
    })
  }

  return outcome
}

function quantityOf(action: StockAction): number {
  return 'quantity' in action ? action.quantity : action.countedQuantity
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
  let action = input.action

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

  // A batch named on a receipt is created before validation, so the rest of the
  // transaction sees it like any other. Upserted rather than inserted: a retried
  // push that already created it must not fail on the unique key.
  if (input.newBatch) {
    const resolved = resolveNewBatch(toDomainItem(item), input.newBatch, input.occurredAt)
    if (!resolved.ok) return { status: 'REJECTED', error: resolved.error }

    const batch = await tx.batch.upsert({
      where: { itemId_batchNo: { itemId: item.id, batchNo: resolved.batch.batchNo } },
      update: {},
      create: {
        id: randomUUID(),
        itemId: item.id,
        batchNo: resolved.batch.batchNo,
        mfgDate: resolved.batch.mfgDate,
        expiryDate: resolved.batch.expiryDate,
        supplierRef: resolved.batch.supplierRef,
      },
      select: { id: true },
    })

    action = { ...action, batchId: batch.id }
  }

  const locationIds = locationsTouchedBy(action)
  const locations = await tx.location.findMany({
    where: { id: { in: locationIds }, deletedAt: null },
    // The code costs nothing on a query already being made, and saves a second
    // one to describe the movement afterwards. siteId is here for the check
    // immediately below.
    select: { id: true, code: true, siteId: true },
  })

  /**
   * Every location must belong to the movement's own site.
   *
   * Without this, a caller supplying its own `siteId` — which the sync push
   * endpoint does, straight from the client — could move stock between two
   * warehouses while the ledger recorded it all happening in one. Both sites'
   * totals would then be wrong, and every report split by site would disagree
   * with the ledger it was derived from.
   *
   * Checked HERE rather than at the API boundary because this is the single
   * write path: the web form, the sync push and the CSV import all arrive
   * through it. A check at one entrance is a check the other two do not have.
   *
   * The web form never trips this — it only offers locations from the user's
   * own site — which is exactly why the gap survived so long.
   */
  const foreign = locations.filter((location) => location.siteId !== input.siteId)
  if (foreign.length > 0) {
    return {
      status: 'REJECTED',
      error: {
        code: MovementErrorCode.LOCATION_WRONG_SITE,
        message: `${foreign.map((location) => location.code).join(', ')} ${foreign.length === 1 ? 'belongs' : 'belong'} to a different site. Stock cannot be moved between sites in one movement.`,
        details: { locationIds: foreign.map((location) => location.id) },
      },
    }
  }

  /**
   * Stock sits at the bottom of the tree, never in a grouping.
   *
   * A location that contains other locations is "Aisle A", not a shelf. Putting
   * a pallet directly in it would make every rollup below it ambiguous — is
   * Aisle A's total its own stock, its racks', or both? — and the answer would
   * differ depending on which screen asked.
   *
   * Checked here for the same reason as the site check above: this is the one
   * write path, and the movement form already hides branches from its picker,
   * so only the API and the importer can reach this.
   */
  const branches = await tx.location.findMany({
    where: { parentId: { in: locationIds }, deletedAt: null },
    select: { parentId: true },
    distinct: ['parentId'],
  })

  if (branches.length > 0) {
    const codes = locations
      .filter((location) => branches.some((branch) => branch.parentId === location.id))
      .map((location) => location.code)

    return {
      status: 'REJECTED',
      error: {
        code: MovementErrorCode.LOCATION_NOT_A_PLACE,
        message: `${codes.join(', ')} ${codes.length === 1 ? 'contains' : 'contain'} other locations, so ${codes.length === 1 ? 'it is' : 'they are'} a grouping rather than somewhere stock goes. Pick one of the places inside.`,
        details: { locationCodes: codes },
      },
    }
  }

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
    policy: { issuePolicy: await getSetting(tx, 'expiry.issuePolicy', input.siteId) },
    allowExpiredOverride: input.allowExpiredOverride,
  })

  // Checked against the LOCKED stock, like everything else in this transaction:
  // a limit judged on a stale read is a limit that can be walked past.
  const tooLarge = await assertWithinAdjustmentLimit(tx, action, input.siteId, stock)
  if (tooLarge) return { status: 'REJECTED', error: tooLarge }

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
      ...describe(item, action, locations),
    }
  }

  return { status: 'RECORDED', movementId, docNo, ...describe(item, action, locations) }
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
    VALUES (${itemId}, ${locationId}, ${batchKey}, ${delta}, NOW(3))
    ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity), updatedAt = NOW(3)
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

/**
 * The cap on a single adjustment.
 *
 * An adjustment is the one movement with no physical counterpart — nothing
 * arrived, nothing left, the number simply changed. A typo in that box is the
 * cheapest way to destroy stock accuracy, so an administrator can cap it.
 *
 * Applied to the DIFFERENCE, not the counted total: setting a shelf of 500 to
 * 498 is a correction of two, and capping it at the total would block every
 * adjustment in a busy bin.
 */
async function assertWithinAdjustmentLimit(
  tx: Db,
  action: StockAction,
  siteId: string,
  stock: StockLevel[],
): Promise<MovementError | null> {
  if (action.kind !== 'ADJUST') return null

  const limit = await getSetting(tx, 'adjust.maxQuantity', siteId)
  if (limit === null) return null

  const onHand = stock
    .filter((level) => level.locationId === action.locationId)
    .reduce((sum, level) => sum + level.quantity, 0)
  const difference = Math.abs(action.countedQuantity - onHand)

  if (difference <= limit) return null

  return {
    code: 'ADJUSTMENT_TOO_LARGE',
    message: `That adjustment changes stock by ${difference}, and the limit is ${limit}. Count the location instead, or ask an administrator to raise the limit.`,
  }
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

/**
 * The movement in words, from what the transaction already loaded.
 *
 * Built here rather than by the caller so a console line never costs an extra
 * query on the write path — which matters when a phone pushes fifty at once.
 */
function describe(
  item: { name: string },
  action: StockAction,
  locations: Array<{ id: string; code: string }>,
): MovementDescription {
  const codeOf = (id: string | null | undefined) =>
    id ? (locations.find((location) => location.id === id)?.code ?? null) : null

  return {
    itemName: item.name,
    fromCode: codeOf('fromLocationId' in action ? action.fromLocationId : null),
    toCode: codeOf(
      'toLocationId' in action
        ? action.toLocationId
        : 'locationId' in action
          ? action.locationId
          : null,
    ),
  }
}

function rejected(code: MovementError['code'], message: string): RecordOutcome {
  return { status: 'REJECTED', error: { code, message } }
}

export { NO_BATCH }
