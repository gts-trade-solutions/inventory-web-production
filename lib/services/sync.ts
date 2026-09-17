import 'server-only'
import { MovementSource } from '@prisma/client'
// Type-only: erased, so it cannot construct a client.
import type { PrismaClient } from '@prisma/client'
import { ApiError, ErrorCode } from '@/lib/api/errors'
import { fromBatchKey } from '@/lib/domain/types'
import type { StockAction } from '@/lib/domain/movement'
import { recordMovement } from './movements'

/**
 * The sync endpoints: pull changes down, push the outbox up.
 *
 * Reference: docs/API_CONTRACT.md §2 and §3.
 */

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

/**
 * An opaque, server-issued cursor.
 *
 * Encodes the server's `recordedAt` plus a tiebreaker id. Opaque because the
 * client must never construct one from its own clock: device clocks drift, and a
 * cursor built from a fast clock silently skips every change in the gap. That is
 * data loss with no error and no symptom until a count disagrees.
 */
export interface Cursor {
  at: Date
  id: string
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.at.toISOString()}|${cursor.id}`).toString('base64url')
}

export function decodeCursor(value: string | null | undefined): Cursor | null {
  if (!value) return null

  try {
    const [at, id] = Buffer.from(value, 'base64url').toString('utf8').split('|')
    if (!at || !id) throw new Error('malformed')

    const date = new Date(at)
    if (Number.isNaN(date.getTime())) throw new Error('bad date')

    return { at: date, id }
  } catch {
    throw new ApiError(
      ErrorCode.INVALID_CURSOR,
      'That cursor is not one we issued. Omit it to resynchronise from the start.',
    )
  }
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

export interface PullOptions {
  since?: string | null
  siteId?: string | null
  limit?: number
}

const DEFAULT_LIMIT = 500
const MAX_LIMIT = 2000

export async function pull(db: PrismaClient, options: PullOptions) {
  const cursor = decodeCursor(options.since)
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
  const changedSince = cursor?.at

  const where = changedSince ? { updatedAt: { gt: changedSince } } : {}

  const [items, locations, batches, serialUnits, reasonCodes, templates, settings] =
    await Promise.all([
      db.item.findMany({
        where,
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
          active: true,
          deletedAt: true,
          updatedAt: true,
          category: { select: { name: true } },
          barcodes: {
            select: { barcode: true, type: true, packSize: true, isPrimary: true },
          },
        },
        orderBy: { updatedAt: 'asc' },
        take: limit,
      }),

      db.location.findMany({
        where: { ...where, ...(options.siteId ? { siteId: options.siteId } : {}) },
        select: {
          id: true,
          code: true,
          name: true,
          zone: true,
          active: true,
          deletedAt: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: 'asc' },
        take: limit,
      }),

      db.batch.findMany({
        where,
        select: {
          id: true,
          itemId: true,
          batchNo: true,
          mfgDate: true,
          expiryDate: true,
          supplierRef: true,
          status: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: 'asc' },
        take: limit,
      }),

      // The largest payload in the system. A client may skip it and fetch units
      // per item on demand instead (API_CONTRACT §2).
      db.serialUnit.findMany({
        where,
        select: {
          id: true,
          itemId: true,
          serialNo: true,
          batchId: true,
          epc: true,
          status: true,
          locationId: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: 'asc' },
        take: limit,
      }),

      db.reasonCode.findMany({
        where,
        select: {
          id: true,
          code: true,
          label: true,
          appliesTo: true,
          requiresNote: true,
          active: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: 'asc' },
      }),

      db.labelTemplate.findMany({
        where: { ...where, active: true },
        select: {
          id: true,
          name: true,
          kind: true,
          zplBody: true,
          widthMm: true,
          heightMm: true,
          dpi: true,
          rfidEncode: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: 'asc' },
      }),

      db.setting.findMany({ select: { key: true, siteId: true, value: true } }),
    ])

  // Stock is sent as the server's projection. A client with unsynced movements
  // applies its own on top — the server value is not authoritative until the
  // outbox is empty, or stock appears to jump backwards on the phone.
  const stockLevels = await db.stockLevel.findMany({
    where: changedSince ? { updatedAt: { gt: changedSince } } : {},
    select: { itemId: true, locationId: true, batchId: true, quantity: true, updatedAt: true },
    orderBy: { updatedAt: 'asc' },
    take: limit,
  })

  const newest = [
    ...items.map((r) => r.updatedAt),
    ...locations.map((r) => r.updatedAt),
    ...batches.map((r) => r.updatedAt),
    ...serialUnits.map((r) => r.updatedAt),
    ...stockLevels.map((r) => r.updatedAt),
  ].reduce<Date | null>((max, at) => (!max || at > max ? at : max), null)

  const hasMore =
    items.length === limit ||
    locations.length === limit ||
    batches.length === limit ||
    serialUnits.length === limit ||
    stockLevels.length === limit

  return {
    // Soft-deleted and deactivated master data, so a client drops it rather than
    // showing a bin that no longer exists.
    items: items
      .filter((item) => !item.deletedAt)
      .map((item) => ({
        id: item.id,
        sku: item.sku,
        name: item.name,
        category: item.category?.name ?? null,
        unit: item.unit,
        reorderPoint: item.reorderPoint,
        trackingMode: item.trackingMode,
        expiryRequired: item.expiryRequired,
        shelfLifeDays: item.shelfLifeDays,
        nearExpiryDays: item.nearExpiryDays,
        barcodes: item.barcodes,
        active: item.active,
        updatedAt: item.updatedAt,
      })),

    locations: locations
      .filter((location) => !location.deletedAt)
      .map(({ deletedAt: _deletedAt, ...location }) => location),

    batches,
    serialUnits,
    reasonCodes,
    labelTemplates: templates,

    stockLevels: stockLevels.map((level) => ({
      itemId: level.itemId,
      locationId: level.locationId,
      // The sentinel is an implementation detail and never crosses the wire.
      batchId: fromBatchKey(level.batchId),
      quantity: level.quantity,
      updatedAt: level.updatedAt,
    })),

    settings: Object.fromEntries(settings.map((setting) => [setting.key, setting.value])),

    tombstones: [
      ...items.filter((item) => item.deletedAt).map((item) => ({ entity: 'ITEM', id: item.id })),
      ...locations
        .filter((location) => location.deletedAt)
        .map((location) => ({ entity: 'LOCATION', id: location.id })),
    ],

    nextCursor: newest ? encodeCursor({ at: newest, id: 'sync' }) : (options.since ?? null),
    hasMore,
  }
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

export interface PushMovement {
  id: string
  itemId: string
  type: 'RECEIVE' | 'ISSUE' | 'MOVE' | 'ADJUST' | 'SCRAP' | 'COUNT'
  quantity: number
  batchId?: string | null
  serialUnitIds?: string[]
  fromLocationId?: string | null
  toLocationId?: string | null
  reasonCodeId?: string | null
  note?: string | null
  reference?: string | null
  occurredAt: string
  siteId: string
  deviceId?: string | null
  countSessionId?: string | null
}

export type PushResult =
  | { id: string; status: 'ACCEPTED'; docNo: string }
  | { id: string; status: 'DUPLICATE'; docNo: string }
  | { id: string; status: 'FLAGGED'; docNo: string; reason: string; details: unknown }
  | { id: string; status: 'REJECTED'; error: { code: string; message: string } }

/**
 * Applies an outbox.
 *
 * Every row is judged independently and always returns a verdict, so one bad
 * movement never blocks the batch — a phone that cannot sync because of a single
 * malformed entry is a phone that stops being used.
 *
 * Rows are applied in the order given, which is `occurredAt` order on the
 * client. Issuing then receiving the same units gives a different intermediate
 * state from the reverse, and the ledger should read the way the work happened.
 */
export async function push(
  db: PrismaClient,
  movements: readonly PushMovement[],
  actor: { userId: string; deviceId: string | null },
): Promise<{ results: PushResult[]; serverTime: string }> {
  const results: PushResult[] = []

  for (const movement of movements) {
    try {
      const outcome = await recordMovement(
        db,
        {
          id: movement.id,
          siteId: movement.siteId,
          action: toStockAction(movement),
          occurredAt: new Date(movement.occurredAt),
          source: MovementSource.MOBILE,
          deviceId: movement.deviceId ?? actor.deviceId,
          countSessionId: movement.countSessionId ?? null,
        },
        { userId: actor.userId },
        // The offline half of WADR-007: a movement queued on the floor is
        // accepted even when it drives stock negative, because rejecting it
        // discards work somebody physically did.
        { acceptNegative: true },
      )

      switch (outcome.status) {
        case 'RECORDED':
          results.push({ id: movement.id, status: 'ACCEPTED', docNo: outcome.docNo })
          break
        case 'DUPLICATE':
          results.push({ id: movement.id, status: 'DUPLICATE', docNo: outcome.docNo })
          break
        case 'FLAGGED':
          results.push({
            id: movement.id,
            status: 'FLAGGED',
            docNo: outcome.docNo,
            reason: outcome.reason,
            details: outcome.details,
          })
          break
        case 'REJECTED':
          results.push({
            id: movement.id,
            status: 'REJECTED',
            error: { code: outcome.error.code, message: outcome.error.message },
          })
          break
      }
    } catch (error) {
      // An unexpected failure on one row still gets a verdict, so the client can
      // keep it for review rather than losing it or retrying forever.
      results.push({
        id: movement.id,
        status: 'REJECTED',
        error: {
          code: ErrorCode.INTERNAL,
          message:
            error instanceof ApiError ? error.message : 'That movement could not be applied.',
        },
      })
    }
  }

  return { results, serverTime: new Date().toISOString() }
}

function toStockAction(movement: PushMovement): StockAction {
  const shared = {
    itemId: movement.itemId,
    batchId: movement.batchId ?? null,
    serialUnitIds: movement.serialUnitIds,
    reasonCodeId: movement.reasonCodeId ?? null,
    note: movement.note ?? null,
    reference: movement.reference ?? null,
  }

  switch (movement.type) {
    case 'RECEIVE':
      return {
        ...shared,
        kind: 'RECEIVE',
        toLocationId: movement.toLocationId!,
        quantity: movement.quantity,
      }
    case 'ISSUE':
      return {
        ...shared,
        kind: 'ISSUE',
        fromLocationId: movement.fromLocationId!,
        quantity: movement.quantity,
      }
    case 'MOVE':
      return {
        ...shared,
        kind: 'MOVE',
        fromLocationId: movement.fromLocationId!,
        toLocationId: movement.toLocationId!,
        quantity: movement.quantity,
      }
    case 'SCRAP':
      return {
        ...shared,
        kind: 'SCRAP',
        fromLocationId: movement.fromLocationId!,
        quantity: movement.quantity,
        reasonCodeId: movement.reasonCodeId ?? '',
      }
    case 'ADJUST':
      return {
        ...shared,
        kind: 'ADJUST',
        locationId: movement.toLocationId ?? movement.fromLocationId!,
        countedQuantity: movement.quantity,
        reasonCodeId: movement.reasonCodeId ?? '',
      }
    case 'COUNT':
      return {
        ...shared,
        kind: 'COUNT',
        locationId: movement.toLocationId ?? movement.fromLocationId!,
        countedQuantity: movement.quantity,
      }
  }
}
