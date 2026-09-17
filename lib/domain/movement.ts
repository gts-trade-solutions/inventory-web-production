import { quantityAt } from './stock'
import {
  BatchStatus,
  MovementType,
  SerialStatus,
  TrackingMode,
  toBatchKey,
  type Batch,
  type Item,
  type Movement,
  type SerialUnit,
} from './types'

/**
 * Movement validation: the single definition of "is this stock change allowed?"
 *
 * Ported from the mobile app's `core/domain/usecase/RecordMovement.kt` and
 * extended for batch, serial and expiry (WADR-018). The Kotlin version reached
 * into repositories; this one is pure — it takes a snapshot of the relevant
 * state and returns a decision. The service loads the snapshot under row locks
 * and writes the result (ARCHITECTURE §4.3).
 *
 * That purity is the point: the same function runs for a web form, a mobile
 * sync push, a CSV import and an ERP feed, so a movement means the same thing
 * wherever it was created (ARCHITECTURE §1.2).
 */

// ---------------------------------------------------------------------------
// What the caller asked for
// ---------------------------------------------------------------------------

interface BaseAction {
  itemId: string
  /** Required for BATCH items. Ignored for NONE. */
  batchId?: string | null
  /** Exactly `quantity` ids for SERIAL items. */
  serialUnitIds?: readonly string[]
  reasonCodeId?: string | null
  note?: string | null
  reference?: string | null
}

export interface ReceiveAction extends BaseAction {
  kind: 'RECEIVE'
  toLocationId: string
  quantity: number
}

export interface IssueAction extends BaseAction {
  kind: 'ISSUE'
  fromLocationId: string
  quantity: number
}

export interface MoveAction extends BaseAction {
  kind: 'MOVE'
  fromLocationId: string
  toLocationId: string
  quantity: number
}

/** Sets the shelf quantity to `countedQuantity`; the ledger records the difference. */
export interface AdjustAction extends BaseAction {
  kind: 'ADJUST'
  locationId: string
  countedQuantity: number
  reasonCodeId: string
}

export interface ScrapAction extends BaseAction {
  kind: 'SCRAP'
  fromLocationId: string
  quantity: number
  reasonCodeId: string
}

export type StockAction = ReceiveAction | IssueAction | MoveAction | AdjustAction | ScrapAction

// ---------------------------------------------------------------------------
// What the domain needs to know to decide
// ---------------------------------------------------------------------------

export interface ExpiryPolicy {
  /** BLOCK refuses to issue expired stock; WARN allows it with an override. */
  issuePolicy: 'BLOCK' | 'WARN'
}

export interface MovementContext {
  item: Item
  knownLocationIds: ReadonlySet<string>
  /** The ledger rows relevant to this item — enough to compute on-hand. */
  ledger: readonly Movement[]
  batches: readonly Batch[]
  serials: readonly SerialUnit[]
  now: Date
  policy: ExpiryPolicy
  /** A supervisor may issue expired stock or override the proposed batch. */
  allowExpiredOverride?: boolean
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export const MovementErrorCode = {
  UNKNOWN_ITEM: 'UNKNOWN_ITEM',
  UNKNOWN_LOCATION: 'UNKNOWN_LOCATION',
  INVALID_QUANTITY: 'INVALID_QUANTITY',
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  SAME_LOCATION: 'SAME_LOCATION',
  NO_CHANGE: 'NO_CHANGE',
  REASON_CODE_REQUIRED: 'REASON_CODE_REQUIRED',
  BATCH_REQUIRED: 'BATCH_REQUIRED',
  UNKNOWN_BATCH: 'UNKNOWN_BATCH',
  BATCH_EXPIRED: 'BATCH_EXPIRED',
  BATCH_BLOCKED: 'BATCH_BLOCKED',
  SERIALS_REQUIRED: 'SERIALS_REQUIRED',
  SERIAL_COUNT_MISMATCH: 'SERIAL_COUNT_MISMATCH',
  UNKNOWN_SERIAL: 'UNKNOWN_SERIAL',
  SERIAL_NOT_AT_LOCATION: 'SERIAL_NOT_AT_LOCATION',
  SERIAL_ALREADY_ISSUED: 'SERIAL_ALREADY_ISSUED',
} as const
export type MovementErrorCode = (typeof MovementErrorCode)[keyof typeof MovementErrorCode]

export interface MovementError {
  code: MovementErrorCode
  message: string
  details?: Record<string, unknown>
}

/** What the service should write. Ids and document numbers are its business. */
export interface PlannedMovement {
  itemId: string
  type: MovementType
  quantity: number
  batchId: string | null
  fromLocationId: string | null
  toLocationId: string | null
  serialUnitIds: string[]
  reasonCodeId: string | null
  note: string | null
  reference: string | null
}

export type MovementDecision =
  { ok: true; movement: PlannedMovement } | { ok: false; error: MovementError }

const reject = (
  code: MovementErrorCode,
  message: string,
  details?: Record<string, unknown>,
): MovementDecision => ({ ok: false, error: { code, message, details } })

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function planMovement(action: StockAction, context: MovementContext): MovementDecision {
  if (action.itemId !== context.item.id) {
    return reject(MovementErrorCode.UNKNOWN_ITEM, 'That item does not exist.')
  }

  switch (action.kind) {
    case 'RECEIVE':
      return planReceive(action, context)
    case 'ISSUE':
      return planIssue(action, context)
    case 'MOVE':
      return planMove(action, context)
    case 'ADJUST':
      return planAdjust(action, context)
    case 'SCRAP':
      return planScrap(action, context)
  }
}

function planReceive(action: ReceiveAction, context: MovementContext): MovementDecision {
  if (!context.knownLocationIds.has(action.toLocationId)) {
    return reject(MovementErrorCode.UNKNOWN_LOCATION, 'That location does not exist.')
  }
  if (!isPositiveInteger(action.quantity)) {
    return reject(MovementErrorCode.INVALID_QUANTITY, 'Quantity must be a positive whole number.')
  }

  // A receipt creates stock, so it checks that the batch exists but not that it
  // has anything in it — and it does NOT check expiry. Receiving short-dated
  // stock is a normal thing to do; issuing it is what needs a decision.
  const batch = resolveBatchForInbound(action, context)
  if (!batch.ok) return batch.decision

  const serials = resolveSerialsForReceive(action, context)
  if (!serials.ok) return serials.decision

  return plan(action, context, {
    type: MovementType.RECEIVE,
    quantity: action.quantity,
    batchId: batch.batchId,
    fromLocationId: null,
    toLocationId: action.toLocationId,
    serialUnitIds: serials.ids,
  })
}

function planIssue(action: IssueAction, context: MovementContext): MovementDecision {
  if (!context.knownLocationIds.has(action.fromLocationId)) {
    return reject(MovementErrorCode.UNKNOWN_LOCATION, 'That location does not exist.')
  }
  if (!isPositiveInteger(action.quantity)) {
    return reject(MovementErrorCode.INVALID_QUANTITY, 'Quantity must be a positive whole number.')
  }

  const outbound = resolveOutbound(action, action.fromLocationId, action.quantity, context)
  if (!outbound.ok) return outbound.decision

  return plan(action, context, {
    type: MovementType.ISSUE,
    quantity: action.quantity,
    batchId: outbound.batchId,
    fromLocationId: action.fromLocationId,
    toLocationId: null,
    serialUnitIds: outbound.serialUnitIds,
  })
}

function planMove(action: MoveAction, context: MovementContext): MovementDecision {
  if (
    !context.knownLocationIds.has(action.fromLocationId) ||
    !context.knownLocationIds.has(action.toLocationId)
  ) {
    return reject(MovementErrorCode.UNKNOWN_LOCATION, 'That location does not exist.')
  }
  if (action.fromLocationId === action.toLocationId) {
    return reject(MovementErrorCode.SAME_LOCATION, 'Pick a different destination.')
  }
  if (!isPositiveInteger(action.quantity)) {
    return reject(MovementErrorCode.INVALID_QUANTITY, 'Quantity must be a positive whole number.')
  }

  // A move keeps the stock in the building, so expired batches may be moved —
  // quarantining expired stock in a separate bin is exactly how you handle it.
  const outbound = resolveOutbound(action, action.fromLocationId, action.quantity, context, {
    ignoreExpiry: true,
  })
  if (!outbound.ok) return outbound.decision

  return plan(action, context, {
    type: MovementType.MOVE,
    quantity: action.quantity,
    batchId: outbound.batchId,
    fromLocationId: action.fromLocationId,
    toLocationId: action.toLocationId,
    serialUnitIds: outbound.serialUnitIds,
  })
}

function planAdjust(action: AdjustAction, context: MovementContext): MovementDecision {
  if (!context.knownLocationIds.has(action.locationId)) {
    return reject(MovementErrorCode.UNKNOWN_LOCATION, 'That location does not exist.')
  }
  if (!Number.isInteger(action.countedQuantity) || action.countedQuantity < 0) {
    return reject(MovementErrorCode.INVALID_QUANTITY, 'Counted quantity cannot be negative.')
  }
  if (!action.reasonCodeId?.trim()) {
    return reject(MovementErrorCode.REASON_CODE_REQUIRED, 'Choose a reason for this adjustment.')
  }

  const batch = resolveBatchForInbound(action, context)
  if (!batch.ok) return batch.decision

  const onHand = quantityAt(
    context.ledger,
    action.itemId,
    action.locationId,
    batch.batchId ?? undefined,
  )
  const difference = action.countedQuantity - onHand

  if (difference === 0) {
    return reject(MovementErrorCode.NO_CHANGE, 'The count already matches the system.')
  }

  // Direction comes from the sign, and the ledger stores the difference — not
  // the counted total. An adjustment up is stock arriving, down is leaving.
  return plan(action, context, {
    type: MovementType.ADJUST,
    quantity: Math.abs(difference),
    batchId: batch.batchId,
    fromLocationId: difference < 0 ? action.locationId : null,
    toLocationId: difference > 0 ? action.locationId : null,
    serialUnitIds: [],
  })
}

function planScrap(action: ScrapAction, context: MovementContext): MovementDecision {
  if (!context.knownLocationIds.has(action.fromLocationId)) {
    return reject(MovementErrorCode.UNKNOWN_LOCATION, 'That location does not exist.')
  }
  if (!isPositiveInteger(action.quantity)) {
    return reject(MovementErrorCode.INVALID_QUANTITY, 'Quantity must be a positive whole number.')
  }
  if (!action.reasonCodeId?.trim()) {
    return reject(MovementErrorCode.REASON_CODE_REQUIRED, 'Choose a reason for scrapping.')
  }

  // Scrapping expired stock is the whole point, so expiry never blocks it.
  const outbound = resolveOutbound(action, action.fromLocationId, action.quantity, context, {
    ignoreExpiry: true,
  })
  if (!outbound.ok) return outbound.decision

  return plan(action, context, {
    type: MovementType.SCRAP,
    quantity: action.quantity,
    batchId: outbound.batchId,
    fromLocationId: action.fromLocationId,
    toLocationId: null,
    serialUnitIds: outbound.serialUnitIds,
  })
}

// ---------------------------------------------------------------------------
// Batch and serial resolution
// ---------------------------------------------------------------------------

type Resolved<T> = ({ ok: true } & T) | { ok: false; decision: MovementDecision }

/**
 * Stock arriving: the batch must exist and belong to this item, but may be empty.
 *
 * Only BATCH mode REQUIRES a batch. A serial-tracked item may or may not belong
 * to one — a drill has a serial number and no lot, a serialised medical device
 * has both — so `SerialUnit.batchId` is nullable and a batch here is optional.
 */
function resolveBatchForInbound(
  action: StockAction,
  context: MovementContext,
): Resolved<{ batchId: string | null }> {
  const { trackingMode } = context.item

  if (trackingMode === TrackingMode.NONE) {
    return { ok: true, batchId: null }
  }

  if (!action.batchId) {
    if (trackingMode === TrackingMode.SERIAL) {
      return { ok: true, batchId: null }
    }
    return {
      ok: false,
      decision: reject(
        MovementErrorCode.BATCH_REQUIRED,
        'This item is batch-tracked; choose a batch.',
      ),
    }
  }

  const batch = context.batches.find((candidate) => candidate.id === action.batchId)
  if (!batch || batch.itemId !== context.item.id) {
    return {
      ok: false,
      decision: reject(MovementErrorCode.UNKNOWN_BATCH, 'That batch does not exist.'),
    }
  }

  return { ok: true, batchId: batch.id }
}

/**
 * Stock leaving: resolves the batch or named units, and checks there is enough
 * of it where the caller says it is.
 */
function resolveOutbound(
  action: StockAction,
  fromLocationId: string,
  quantity: number,
  context: MovementContext,
  options: { ignoreExpiry?: boolean } = {},
): Resolved<{ batchId: string | null; serialUnitIds: string[] }> {
  const { item } = context

  if (item.trackingMode === TrackingMode.SERIAL) {
    return resolveSerialsForOutbound(action, fromLocationId, quantity, context, options)
  }

  if (item.trackingMode === TrackingMode.NONE) {
    const available = quantityAt(context.ledger, item.id, fromLocationId)
    if (quantity > available) {
      return { ok: false, decision: insufficient(available) }
    }
    return { ok: true, batchId: null, serialUnitIds: [] }
  }

  // BATCH
  if (!action.batchId) {
    return {
      ok: false,
      decision: reject(
        MovementErrorCode.BATCH_REQUIRED,
        'This item is batch-tracked; choose a batch.',
      ),
    }
  }

  const batch = context.batches.find((candidate) => candidate.id === action.batchId)
  if (!batch || batch.itemId !== item.id) {
    return {
      ok: false,
      decision: reject(MovementErrorCode.UNKNOWN_BATCH, 'That batch does not exist.'),
    }
  }

  const blocked = checkBatchUsable(batch, context, options)
  if (blocked) return { ok: false, decision: blocked }

  const available = quantityAt(context.ledger, item.id, fromLocationId, batch.id)
  if (quantity > available) {
    return { ok: false, decision: insufficient(available, { batchNo: batch.batchNo }) }
  }

  return { ok: true, batchId: batch.id, serialUnitIds: [] }
}

function checkBatchUsable(
  batch: Batch,
  context: MovementContext,
  options: { ignoreExpiry?: boolean },
): MovementDecision | null {
  if (batch.status === BatchStatus.BLOCKED || batch.status === BatchStatus.QUARANTINE) {
    return reject(
      MovementErrorCode.BATCH_BLOCKED,
      `Batch ${batch.batchNo} is ${batch.status.toLowerCase()} and cannot be used.`,
      { batchNo: batch.batchNo, status: batch.status },
    )
  }

  if (options.ignoreExpiry) return null
  if (!isExpired(batch, context.now)) return null

  // WARN sites, and supervisors with an explicit override, may still issue it.
  if (context.policy.issuePolicy === 'WARN' || context.allowExpiredOverride) return null

  return reject(
    MovementErrorCode.BATCH_EXPIRED,
    `Batch ${batch.batchNo} expired on ${formatDate(batch.expiryDate)}.`,
    { batchNo: batch.batchNo, expiryDate: batch.expiryDate },
  )
}

function resolveSerialsForReceive(
  action: StockAction,
  context: MovementContext,
): Resolved<{ ids: string[] }> {
  if (context.item.trackingMode !== TrackingMode.SERIAL) {
    return { ok: true, ids: [] }
  }

  const ids = action.serialUnitIds ?? []
  const quantity = 'quantity' in action ? action.quantity : 0

  if (ids.length === 0) {
    return {
      ok: false,
      decision: reject(
        MovementErrorCode.SERIALS_REQUIRED,
        'This item is serial-tracked; provide a serial number per unit.',
      ),
    }
  }

  // Not a rounding difference — a mismatch means the caller has miscounted what
  // it is holding, so it must fail loudly (ARCHITECTURE §5.3).
  if (ids.length !== quantity) {
    return { ok: false, decision: serialCountMismatch(quantity, ids.length) }
  }

  const duplicate = firstDuplicate(ids)
  if (duplicate) {
    return {
      ok: false,
      decision: reject(MovementErrorCode.SERIAL_COUNT_MISMATCH, 'The same unit is listed twice.', {
        serialUnitId: duplicate,
      }),
    }
  }

  return { ok: true, ids: [...ids] }
}

function resolveSerialsForOutbound(
  action: StockAction,
  fromLocationId: string,
  quantity: number,
  context: MovementContext,
  options: { ignoreExpiry?: boolean },
): Resolved<{ batchId: string | null; serialUnitIds: string[] }> {
  const ids = action.serialUnitIds ?? []

  if (ids.length === 0) {
    return {
      ok: false,
      decision: reject(
        MovementErrorCode.SERIALS_REQUIRED,
        'This item is serial-tracked; choose which units to move.',
      ),
    }
  }
  if (ids.length !== quantity) {
    return { ok: false, decision: serialCountMismatch(quantity, ids.length) }
  }

  const duplicate = firstDuplicate(ids)
  if (duplicate) {
    return {
      ok: false,
      decision: reject(MovementErrorCode.SERIAL_COUNT_MISMATCH, 'The same unit is listed twice.', {
        serialUnitId: duplicate,
      }),
    }
  }

  const byId = new Map(context.serials.map((unit) => [unit.id, unit]))
  const batchIds = new Set<string | null>()

  for (const id of ids) {
    const unit = byId.get(id)

    if (!unit || unit.itemId !== context.item.id) {
      return {
        ok: false,
        decision: reject(MovementErrorCode.UNKNOWN_SERIAL, 'That unit is not on record.', {
          serialUnitId: id,
        }),
      }
    }

    if (unit.status !== SerialStatus.IN_STOCK) {
      return {
        ok: false,
        decision: reject(
          unit.status === SerialStatus.ISSUED
            ? MovementErrorCode.SERIAL_ALREADY_ISSUED
            : MovementErrorCode.UNKNOWN_SERIAL,
          `Unit ${unit.serialNo} is ${unit.status.toLowerCase().replace('_', ' ')}.`,
          { serialUnitId: id, serialNo: unit.serialNo, status: unit.status },
        ),
      }
    }

    if (unit.locationId !== fromLocationId) {
      return {
        ok: false,
        decision: reject(
          MovementErrorCode.SERIAL_NOT_AT_LOCATION,
          `Unit ${unit.serialNo} is not at that location.`,
          { serialUnitId: id, serialNo: unit.serialNo, actualLocationId: unit.locationId },
        ),
      }
    }

    if (unit.batchId) {
      const batch = context.batches.find((candidate) => candidate.id === unit.batchId)
      if (batch) {
        const blocked = checkBatchUsable(batch, context, options)
        if (blocked) return { ok: false, decision: blocked }
      }
    }

    batchIds.add(unit.batchId ?? null)
  }

  // A movement carries one batch id. Units from several batches have to be
  // recorded as separate movements, which the service splits them into.
  const batchId = batchIds.size === 1 ? ([...batchIds][0] ?? null) : null

  return { ok: true, batchId, serialUnitIds: [...ids] }
}

// ---------------------------------------------------------------------------
// FEFO
// ---------------------------------------------------------------------------

export interface BatchCandidate {
  batch: Batch
  available: number
}

/**
 * First-expired-first-out: the batch closest to expiry with enough stock at this
 * location. Undated batches come last — a known expiry should always go first.
 *
 * Only a proposal. The operator may override it, and the override is recorded on
 * the movement so the decision is auditable (ARCHITECTURE §5.2).
 */
export function proposeBatchFefo(
  candidates: readonly BatchCandidate[],
  quantity: number,
  now: Date,
): Batch | null {
  const usable = candidates
    .filter(({ batch, available }) => available >= quantity && batch.status === BatchStatus.ACTIVE)
    .filter(({ batch }) => !isExpired(batch, now))

  if (usable.length === 0) return null

  const sorted = [...usable].sort((a, b) => {
    const aExpiry = a.batch.expiryDate?.getTime()
    const bExpiry = b.batch.expiryDate?.getTime()

    if (aExpiry === undefined && bExpiry === undefined) {
      return a.batch.batchNo.localeCompare(b.batch.batchNo)
    }
    if (aExpiry === undefined) return 1
    if (bExpiry === undefined) return -1
    if (aExpiry !== bExpiry) return aExpiry - bExpiry

    // Same expiry: pick deterministically so two callers agree.
    return a.batch.batchNo.localeCompare(b.batch.batchNo)
  })

  return sorted[0]?.batch ?? null
}

/**
 * Expiry is a whole-day concept. A batch dated the 12th is good all day on the
 * 12th and expired from the 13th, regardless of the time a comparison happens.
 */
export function isExpired(batch: Batch, now: Date): boolean {
  if (!batch.expiryDate) return false
  return startOfUtcDay(now) > startOfUtcDay(batch.expiryDate)
}

export function isNearExpiry(batch: Batch, now: Date, withinDays: number): boolean {
  if (!batch.expiryDate || isExpired(batch, now)) return false

  const days = (startOfUtcDay(batch.expiryDate) - startOfUtcDay(now)) / 86_400_000
  return days <= withinDays
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function plan(
  action: StockAction,
  context: MovementContext,
  parts: Pick<
    PlannedMovement,
    'type' | 'quantity' | 'batchId' | 'fromLocationId' | 'toLocationId' | 'serialUnitIds'
  >,
): MovementDecision {
  return {
    ok: true,
    movement: {
      itemId: context.item.id,
      ...parts,
      reasonCodeId: action.reasonCodeId?.trim() || null,
      // The Kotlin version trims and drops empty notes; a note of "   " is no
      // note, and storing it makes the ledger harder to read.
      note: action.note?.trim() || null,
      reference: action.reference?.trim() || null,
    },
  }
}

function insufficient(available: number, details: Record<string, unknown> = {}): MovementDecision {
  return reject(
    MovementErrorCode.INSUFFICIENT_STOCK,
    available <= 0 ? 'There is none at that location.' : `Only ${available} available.`,
    { available, ...details },
  )
}

function serialCountMismatch(quantity: number, provided: number): MovementDecision {
  return reject(
    MovementErrorCode.SERIAL_COUNT_MISMATCH,
    `Quantity is ${quantity} but ${provided} unit${provided === 1 ? ' was' : 's were'} selected.`,
    { quantity, provided },
  )
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

function firstDuplicate(ids: readonly string[]): string | null {
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) return id
    seen.add(id)
  }
  return null
}

function startOfUtcDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

function formatDate(date: Date | null): string {
  return date ? (date.toISOString().split('T')[0] ?? 'an unknown date') : 'an unknown date'
}

export { toBatchKey }
