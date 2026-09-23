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
 * Opaque because the client must never construct one from its own clock: device
 * clocks drift, and a cursor built from a fast clock silently skips every change
 * in the gap. That is data loss with no error and no symptom until a count
 * disagrees.
 *
 * It holds a position PER ENTITY, not one position for the whole sync. A single
 * shared position is wrong whenever one entity pages and another does not: the
 * cursor advances to the newest row across all of them, and the rest of the
 * paging entity's rows fall behind it and are never sent again. That is not
 * theoretical — with a 500-row limit and 600 changed items, a first sync
 * silently dropped a hundred items while reporting itself complete.
 *
 * Each position is a keyset: `(updatedAt, id)`. The id breaks ties so rows
 * written in the same millisecond are neither repeated forever nor skipped —
 * which is also why every timestamp column is DATETIME(3). MySQL will happily
 * store microseconds that JavaScript's Date cannot represent, and a cursor that
 * cannot express the value it is pointing at can never move past it.
 */
export interface EntityPosition {
  at: Date
  id: string
}

export type Cursor = Partial<Record<SyncEntity, EntityPosition>>

export type SyncEntity =
  | 'items'
  | 'locations'
  | 'batches'
  | 'serialUnits'
  | 'stockLevels'
  | 'reasonCodes'
  | 'labelTemplates'

const SYNC_ENTITIES: SyncEntity[] = [
  'items',
  'locations',
  'batches',
  'serialUnits',
  'stockLevels',
  'reasonCodes',
  'labelTemplates',
]

const CURSOR_VERSION = 'v2'

export function encodeCursor(cursor: Cursor): string {
  const parts = SYNC_ENTITIES.filter((entity) => cursor[entity]).map((entity) => {
    const position = cursor[entity]!
    return `${entity}:${position.at.toISOString()}:${position.id}`
  })

  return Buffer.from([CURSOR_VERSION, ...parts].join('|')).toString('base64url')
}

export function decodeCursor(value: string | null | undefined): Cursor | null {
  if (!value) return null

  try {
    const [version, ...parts] = Buffer.from(value, 'base64url').toString('utf8').split('|')
    // A cursor from an older server encodes a position we can no longer place.
    // Refusing it costs one full resync; guessing costs rows nobody notices.
    if (version !== CURSOR_VERSION) throw new Error('unknown cursor version')

    const cursor: Cursor = {}
    for (const part of parts) {
      const separator = part.indexOf(':')
      const entity = part.slice(0, separator) as SyncEntity
      if (!SYNC_ENTITIES.includes(entity)) throw new Error('unknown entity')

      const rest = part.slice(separator + 1)
      const split = rest.lastIndexOf(':')
      const at = new Date(rest.slice(0, split))
      const id = rest.slice(split + 1)
      if (Number.isNaN(at.getTime()) || !id) throw new Error('malformed position')

      cursor[entity] = { at, id }
    }

    return cursor
  } catch {
    throw new ApiError(
      ErrorCode.INVALID_CURSOR,
      'That cursor is not one we issued. Omit it to resynchronise from the start.',
    )
  }
}

/**
 * The keyset predicate: everything strictly after this position.
 *
 * `updatedAt > at OR (updatedAt = at AND id > id)` — the standard form, and the
 * only one that neither repeats the boundary row forever nor steps over rows
 * that share its timestamp.
 */
function after(position: EntityPosition | undefined) {
  if (!position) return {}

  return {
    OR: [{ updatedAt: { gt: position.at } }, { updatedAt: position.at, id: { gt: position.id } }],
  }
}

/** The position of the last row in a page, or the position we came in with. */
function positionOf<T extends { id: string; updatedAt: Date }>(
  rows: readonly T[],
  previous: EntityPosition | undefined,
): EntityPosition | undefined {
  const last = rows[rows.length - 1]
  return last ? { at: last.updatedAt, id: last.id } : previous
}

// ---------------------------------------------------------------------------
// Stock levels have no id — their key is (item, location, batch)
// ---------------------------------------------------------------------------

interface StockLevelKey {
  itemId: string
  locationId: string
  batchId: string
  updatedAt: Date
}

const STOCK_KEY_SEPARATOR = '~'

function stockLevelId(row: Pick<StockLevelKey, 'itemId' | 'locationId' | 'batchId'>): string {
  return [row.itemId, row.locationId, row.batchId].join(STOCK_KEY_SEPARATOR)
}

/**
 * The same keyset predicate, over a three-part key.
 *
 * Written out lexicographically rather than with a row-value comparison, which
 * Prisma cannot express: equal on the parts before, greater on the part here.
 */
function afterStockLevel(position: EntityPosition | undefined) {
  if (!position) return {}

  const [itemId, locationId, batchId] = position.id.split(STOCK_KEY_SEPARATOR)
  if (!itemId || !locationId || !batchId) {
    // A key we cannot parse would silently filter to nothing, which reads as
    // "up to date" on the phone. Resending from this timestamp costs a few
    // duplicate rows the client upserts away.
    return { updatedAt: { gte: position.at } }
  }

  return {
    OR: [
      { updatedAt: { gt: position.at } },
      { updatedAt: position.at, itemId: { gt: itemId } },
      { updatedAt: position.at, itemId, locationId: { gt: locationId } },
      { updatedAt: position.at, itemId, locationId, batchId: { gt: batchId } },
    ],
  }
}

function positionOfStockLevel(
  rows: readonly StockLevelKey[],
  previous: EntityPosition | undefined,
): EntityPosition | undefined {
  const last = rows[rows.length - 1]
  return last ? { at: last.updatedAt, id: stockLevelId(last) } : previous
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
  const cursor = decodeCursor(options.since) ?? {}
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)

  const [items, locations, batches, serialUnits, reasonCodes, templates, settings] =
    await Promise.all([
      db.item.findMany({
        where: after(cursor.items),
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
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        take: limit,
      }),

      db.location.findMany({
        where: {
          ...after(cursor.locations),
          ...(options.siteId ? { siteId: options.siteId } : {}),
        },
        select: {
          id: true,
          code: true,
          name: true,
          zone: true,
          active: true,
          /**
           * The two fields a client needs to avoid a rejection it cannot see
           * coming.
           *
           * `siteId`, because a movement names its own site and the server now
           * checks that every location in it belongs to that site. A client
           * that does not know which site a rack is in can pair the wrong two
           * and be refused with LOCATION_WRONG_SITE.
           *
           * `parentId`, because stock sits at the LEAVES. A location with
           * children is a grouping — "Aisle A" — and pushing a movement into
           * one is refused with LOCATION_NOT_A_PLACE. Without this field a
           * picker would happily offer Aisle A, and the operator would find out
           * only when the sync came back.
           *
           * Both are pure additions: a client that ignores unknown fields is
           * unaffected.
           */
          siteId: true,
          parentId: true,
          deletedAt: true,
          updatedAt: true,
        },
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        take: limit,
      }),

      db.batch.findMany({
        where: after(cursor.batches),
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
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        take: limit,
      }),

      // The largest payload in the system. A client may skip it and fetch units
      // per item on demand instead (API_CONTRACT §2).
      db.serialUnit.findMany({
        where: after(cursor.serialUnits),
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
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        take: limit,
      }),

      db.reasonCode.findMany({
        where: after(cursor.reasonCodes),
        select: {
          id: true,
          code: true,
          label: true,
          appliesTo: true,
          requiresNote: true,
          active: true,
          updatedAt: true,
        },
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        take: limit,
      }),

      db.labelTemplate.findMany({
        where: { ...after(cursor.labelTemplates), active: true },
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
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        take: limit,
      }),

      db.setting.findMany({ select: { key: true, siteId: true, value: true } }),
    ])

  // Stock is sent as the server's projection. A client with unsynced movements
  // applies its own on top — the server value is not authoritative until the
  // outbox is empty, or stock appears to jump backwards on the phone.
  //
  // Keyed by (item, location, batch) rather than an id, so its keyset is that
  // triple compared lexicographically after the timestamp.
  const stockLevels = await db.stockLevel.findMany({
    where: afterStockLevel(cursor.stockLevels),
    select: { itemId: true, locationId: true, batchId: true, quantity: true, updatedAt: true },
    orderBy: [{ updatedAt: 'asc' }, { itemId: 'asc' }, { locationId: 'asc' }, { batchId: 'asc' }],
    take: limit,
  })

  // Each entity carries its own position forward. An entity that returned a full
  // page resumes exactly where it stopped; one that returned nothing keeps the
  // position it came in with rather than being dragged forward by the others.
  const nextCursor = encodeCursor({
    items: positionOf(items, cursor.items),
    locations: positionOf(locations, cursor.locations),
    batches: positionOf(batches, cursor.batches),
    serialUnits: positionOf(serialUnits, cursor.serialUnits),
    reasonCodes: positionOf(reasonCodes, cursor.reasonCodes),
    labelTemplates: positionOf(templates, cursor.labelTemplates),
    stockLevels: positionOfStockLevel(stockLevels, cursor.stockLevels),
  })

  const hasMore =
    items.length === limit ||
    locations.length === limit ||
    batches.length === limit ||
    serialUnits.length === limit ||
    reasonCodes.length === limit ||
    templates.length === limit ||
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

    nextCursor,
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
  actor: { userId: string; deviceId: string | null; siteIds: readonly string[] },
): Promise<{ results: PushResult[]; serverTime: string }> {
  const results: PushResult[] = []
  const allowedSites = new Set(actor.siteIds)

  for (const movement of movements) {
    /**
     * The site is supplied BY THE CLIENT, so it has to be checked against the
     * token rather than trusted.
     *
     * Without this a device could record work against any warehouse in the
     * business, including ones its operator has no access to — and site scope
     * is the only thing separating them. It was enforced on every read and on
     * nothing that writes.
     *
     * Refused per row rather than for the whole batch, like every other
     * verdict here: one bad row must never block a phone's outbox.
     */
    if (!allowedSites.has(movement.siteId)) {
      results.push({
        id: movement.id,
        status: 'REJECTED',
        error: {
          code: 'SITE_NOT_ALLOWED',
          message: 'This device is not allowed to record work at that site.',
        },
      })
      continue
    }

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
