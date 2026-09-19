import 'server-only'
import type { Prisma, PrismaClient } from '@prisma/client'
import { MovementType, TrackingMode } from '@prisma/client'
import type { XlsxColumn } from '@/lib/export/xlsx'

/**
 * Exporting the list screens (PROJECT_PLAN 8.4).
 *
 * The reports summarise; these are the underlying rows, which is what somebody
 * asks for when the summary raises a question. The movement list in particular
 * is the one that gets sent to an auditor, and it is the one large enough to
 * matter: a busy year is hundreds of thousands of rows.
 *
 * **Read in pages and yielded row by row.** `findMany` over a year of movements
 * would build one enormous array before a single byte reached the browser, and
 * the process would be holding the rows, the formatted strings and the response
 * buffer at once. Paging by a keyset keeps memory flat and, unlike `skip`, does
 * not get slower as it goes or skip rows when something is inserted mid-export.
 */

/** Rows per database round trip. Large enough to be few trips, small enough to stay flat. */
const PAGE = 500

export const LIST_KEYS = ['items', 'movements-detail', 'batches', 'serials', 'locations'] as const
export type ListKey = (typeof LIST_KEYS)[number]

export function isListKey(value: string): value is ListKey {
  return (LIST_KEYS as readonly string[]).includes(value)
}

/**
 * Every filter the list screens offer.
 *
 * All of them, deliberately. An export that quietly ignores a filter the screen
 * is showing hands somebody a file that does not match what they were looking
 * at — and they will not notice, because the file looks fine on its own.
 */
export interface ListExportRequest {
  /** Free-text search, matching the list screen's own box. */
  q?: string | null
  /** Movement type, for the movement list. */
  type?: string | null
  /** Tracking mode, for the item list. */
  tracking?: string | null
  /** Item list: only items at or below their reorder point. */
  low?: boolean
  siteId?: string | null
}

export interface PreparedListExport {
  name: string
  sheetName: string
  columns: ReadonlyArray<XlsxColumn<Record<string, unknown>>>
  rows: AsyncIterable<Record<string, unknown>>
}

type Cell = string | number | boolean | Date | null

function column<T>(
  header: string,
  value: (row: T) => Cell,
  width?: number,
): XlsxColumn<Record<string, unknown>> {
  return {
    header,
    value: (row) => value(row as T),
    ...(width === undefined ? {} : { width }),
  }
}

/**
 * Pages through a table by ascending id.
 *
 * The id is the keyset because every table here has one and it is unique and
 * immutable — which is exactly what a stable cursor needs. Ordering by anything
 * editable would let a row move between pages mid-export and be emitted twice
 * or not at all.
 */
export async function* byId<T extends { id: string }>(
  fetchPage: (after: string | null) => Promise<T[]>,
  pageSize: number = PAGE,
): AsyncGenerator<T> {
  let after: string | null = null

  for (;;) {
    const page: T[] = await fetchPage(after)
    if (page.length === 0) return

    for (const row of page) yield row

    const last = page[page.length - 1]

    // A short page means the end. A FULL page does not mean there is more —
    // a table whose row count is an exact multiple of the page size gives one
    // last full page and then an empty one, which is why the loop asks again
    // rather than stopping here.
    if (!last || page.length < pageSize) return
    after = last.id
  }
}

export function prepareListExport(
  db: PrismaClient,
  key: ListKey,
  request: ListExportRequest,
): PreparedListExport {
  const search = request.q?.trim() || null

  switch (key) {
    case 'items': {
      const tracking = (Object.values(TrackingMode) as string[]).includes(
        request.tracking?.toUpperCase() ?? '',
      )
        ? (request.tracking!.toUpperCase() as TrackingMode)
        : null

      const where: Prisma.ItemWhereInput = {
        deletedAt: null,
        ...(tracking ? { trackingMode: tracking } : {}),
        ...(search
          ? {
              OR: [
                { name: { contains: search } },
                { sku: { contains: search } },
                { barcodes: { some: { barcode: { contains: search } } } },
              ],
            }
          : {}),
      }

      const paged = byId((after) =>
        db.item.findMany({
          where: after ? { AND: [where, { id: { gt: after } }] } : where,
          orderBy: { id: 'asc' },
          take: PAGE,
          select: {
            id: true,
            sku: true,
            name: true,
            unit: true,
            trackingMode: true,
            reorderPoint: true,
            maxLevel: true,
            nearExpiryDays: true,
            active: true,
            category: { select: { name: true } },
            stockLevels: { select: { quantity: true } },
          },
        }),
      )

      type Row = {
        id: string
        sku: string
        name: string
        unit: string
        trackingMode: TrackingMode
        reorderPoint: number
        maxLevel: number | null
        nearExpiryDays: number
        active: boolean
        category: { name: string } | null
        onHand: number
      }

      // "Low stock" is derived from the projection sum rather than a column, so
      // it is applied here rather than in SQL — exactly as the list screen does
      // it. Filtering in a different place from the screen is how an export
      // ends up disagreeing with what somebody was looking at.
      const rows = (async function* (): AsyncGenerator<Row> {
        for await (const item of paged) {
          const onHand = item.stockLevels.reduce((sum, level) => sum + level.quantity, 0)
          if (request.low && onHand > item.reorderPoint) continue

          yield { ...item, onHand }
        }
      })()

      return {
        name: 'items',
        sheetName: 'Items',
        rows: rows as AsyncIterable<Record<string, unknown>>,
        columns: [
          column<Row>('SKU', (row) => row.sku, 18),
          column<Row>('Item', (row) => row.name, 36),
          column<Row>('Category', (row) => row.category?.name ?? null),
          column<Row>('Unit', (row) => row.unit),
          column<Row>('Tracking', (row) => String(row.trackingMode)),
          column<Row>('On hand', (row) => row.onHand),
          column<Row>('Reorder point', (row) => row.reorderPoint),
          column<Row>('Max level', (row) => row.maxLevel),
          column<Row>('Near-expiry days', (row) => row.nearExpiryDays),
          column<Row>('Active', (row) => row.active),
        ],
      }
    }

    case 'movements-detail': {
      // Uppercased, exactly as the list screen parses it. The filter arrives in
      // the URL as `?type=issue`, so matching case-sensitively would silently
      // export every type while the screen showed one.
      const upper = request.type?.toUpperCase() ?? ''
      const type = (Object.values(MovementType) as string[]).includes(upper)
        ? (upper as MovementType)
        : null

      const where: Prisma.MovementWhereInput = {
        ...(type ? { type } : {}),
        ...(request.siteId ? { siteId: request.siteId } : {}),
        ...(search
          ? {
              OR: [
                { docNo: { contains: search } },
                { reference: { contains: search } },
                { item: { name: { contains: search } } },
                { item: { sku: { contains: search } } },
              ],
            }
          : {}),
      }

      const rows = byId((after) =>
        db.movement.findMany({
          where: after ? { AND: [where, { id: { gt: after } }] } : where,
          orderBy: { id: 'asc' },
          take: PAGE,
          select: {
            id: true,
            docNo: true,
            type: true,
            quantity: true,
            occurredAt: true,
            recordedAt: true,
            reference: true,
            note: true,
            source: true,
            item: { select: { sku: true, name: true, unit: true } },
            batch: { select: { batchNo: true } },
            fromLocation: { select: { code: true } },
            toLocation: { select: { code: true } },
            reasonCode: { select: { code: true } },
            user: { select: { name: true, email: true } },
          },
        }),
      )

      type Row = {
        id: string
        docNo: string
        type: MovementType
        quantity: number
        occurredAt: Date
        recordedAt: Date
        reference: string | null
        note: string | null
        source: string
        item: { sku: string; name: string; unit: string }
        batch: { batchNo: string } | null
        fromLocation: { code: string } | null
        toLocation: { code: string } | null
        reasonCode: { code: string } | null
        user: { name: string; email: string } | null
      }

      return {
        name: 'movements',
        sheetName: 'Movements',
        rows: rows as AsyncIterable<Record<string, unknown>>,
        columns: [
          column<Row>('Document', (row) => row.docNo, 20),
          column<Row>('Type', (row) => String(row.type)),
          // Both clocks. `occurredAt` is when the work happened on the floor
          // and `recordedAt` is when the server heard about it; for anything
          // that synced late from a phone they differ, and an auditor asking
          // "when did this happen" means the first one.
          column<Row>('Occurred', (row) => row.occurredAt, 20),
          column<Row>('Recorded', (row) => row.recordedAt, 20),
          column<Row>('SKU', (row) => row.item.sku, 18),
          column<Row>('Item', (row) => row.item.name, 36),
          column<Row>('Batch', (row) => row.batch?.batchNo ?? null),
          column<Row>('Quantity', (row) => row.quantity),
          column<Row>('Unit', (row) => row.item.unit),
          column<Row>('From', (row) => row.fromLocation?.code ?? null),
          column<Row>('To', (row) => row.toLocation?.code ?? null),
          column<Row>('Reason', (row) => row.reasonCode?.code ?? null),
          column<Row>('Reference', (row) => row.reference),
          column<Row>('Note', (row) => row.note, 40),
          column<Row>('Source', (row) => String(row.source)),
          // The person, by name and address: a name alone is ambiguous once
          // two people share one, and this file outlives the account.
          column<Row>('By', (row) => row.user?.name ?? null),
          column<Row>('Account', (row) => row.user?.email ?? null),
        ],
      }
    }

    case 'batches': {
      const where: Prisma.BatchWhereInput = search
        ? { OR: [{ batchNo: { contains: search } }, { item: { name: { contains: search } } }] }
        : {}

      const rows = byId((after) =>
        db.batch.findMany({
          where: after ? { AND: [where, { id: { gt: after } }] } : where,
          orderBy: { id: 'asc' },
          take: PAGE,
          select: {
            id: true,
            batchNo: true,
            status: true,
            mfgDate: true,
            expiryDate: true,
            receivedAt: true,
            supplierRef: true,
            item: { select: { sku: true, name: true } },
          },
        }),
      )

      type Row = {
        id: string
        batchNo: string
        status: string
        mfgDate: Date | null
        expiryDate: Date | null
        receivedAt: Date
        supplierRef: string | null
        item: { sku: string; name: string }
      }

      return {
        name: 'batches',
        sheetName: 'Batches',
        rows: rows as AsyncIterable<Record<string, unknown>>,
        columns: [
          column<Row>('Batch', (row) => row.batchNo, 20),
          column<Row>('SKU', (row) => row.item.sku, 18),
          column<Row>('Item', (row) => row.item.name, 36),
          column<Row>('Status', (row) => String(row.status)),
          column<Row>('Manufactured', (row) => row.mfgDate, 16),
          column<Row>('Expires', (row) => row.expiryDate, 16),
          column<Row>('Received', (row) => row.receivedAt, 20),
          column<Row>('Supplier ref', (row) => row.supplierRef),
        ],
      }
    }

    case 'locations': {
      const where: Prisma.LocationWhereInput = {
        deletedAt: null,
        ...(request.siteId ? { siteId: request.siteId } : {}),
        ...(search ? { OR: [{ code: { contains: search } }, { name: { contains: search } }] } : {}),
      }

      const paged = byId((after) =>
        db.location.findMany({
          where: after ? { AND: [where, { id: { gt: after } }] } : where,
          orderBy: { id: 'asc' },
          take: PAGE,
          select: {
            id: true,
            code: true,
            name: true,
            zone: true,
            active: true,
            site: { select: { code: true } },
            stockLevels: { where: { quantity: { gt: 0 } }, select: { quantity: true } },
          },
        }),
      )

      type Row = {
        id: string
        code: string
        name: string
        zone: string
        active: boolean
        site: { code: string }
        onHand: number
        lines: number
      }

      // On hand summed here rather than in SQL, matching what the screen shows.
      const rows = (async function* (): AsyncGenerator<Row> {
        for await (const location of paged) {
          yield {
            ...location,
            zone: String(location.zone),
            onHand: location.stockLevels.reduce((sum, level) => sum + level.quantity, 0),
            lines: location.stockLevels.length,
          }
        }
      })()

      return {
        name: 'locations',
        sheetName: 'Locations',
        rows: rows as AsyncIterable<Record<string, unknown>>,
        columns: [
          column<Row>('Site', (row) => row.site.code),
          column<Row>('Code', (row) => row.code, 18),
          column<Row>('Name', (row) => row.name, 36),
          column<Row>('Zone', (row) => row.zone),
          column<Row>('Lines', (row) => row.lines),
          column<Row>('On hand', (row) => row.onHand),
          column<Row>('Active', (row) => row.active),
        ],
      }
    }

    case 'serials': {
      const where: Prisma.SerialUnitWhereInput = search
        ? {
            OR: [
              { serialNo: { contains: search } },
              { epc: { contains: search } },
              { item: { name: { contains: search } } },
            ],
          }
        : {}

      const rows = byId((after) =>
        db.serialUnit.findMany({
          where: after ? { AND: [where, { id: { gt: after } }] } : where,
          orderBy: { id: 'asc' },
          take: PAGE,
          select: {
            id: true,
            serialNo: true,
            epc: true,
            status: true,
            receivedAt: true,
            issuedAt: true,
            warrantyUntil: true,
            item: { select: { sku: true, name: true } },
            batch: { select: { batchNo: true } },
            location: { select: { code: true } },
          },
        }),
      )

      type Row = {
        id: string
        serialNo: string
        epc: string | null
        status: string
        receivedAt: Date
        issuedAt: Date | null
        warrantyUntil: Date | null
        item: { sku: string; name: string }
        batch: { batchNo: string } | null
        location: { code: string } | null
      }

      return {
        name: 'serial-units',
        sheetName: 'Serial units',
        rows: rows as AsyncIterable<Record<string, unknown>>,
        columns: [
          column<Row>('Serial', (row) => row.serialNo, 22),
          column<Row>('SKU', (row) => row.item.sku, 18),
          column<Row>('Item', (row) => row.item.name, 36),
          column<Row>('Batch', (row) => row.batch?.batchNo ?? null),
          column<Row>('Status', (row) => String(row.status)),
          column<Row>('Location', (row) => row.location?.code ?? null),
          // Kept as text: an EPC is 24 hex characters and a spreadsheet would
          // happily read one that is all digits as a number in scientific
          // notation, which cannot be turned back into the tag it names.
          column<Row>('EPC', (row) => row.epc, 26),
          column<Row>('Received', (row) => row.receivedAt, 20),
          column<Row>('Issued', (row) => row.issuedAt, 20),
          column<Row>('Warranty until', (row) => row.warrantyUntil, 16),
        ],
      }
    }
  }
}
