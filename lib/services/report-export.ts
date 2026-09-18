import 'server-only'
import type { PrismaClient } from '@prisma/client'
import type { XlsxColumn } from '@/lib/export/xlsx'
import {
  countAccuracy,
  movementSummary,
  reorderReport,
  stockAgeing,
  stockOnHand,
  type ReportFilters,
  type StockGrain,
} from './reports'

/**
 * One definition per report, feeding both export formats and nothing else.
 *
 * The columns live here rather than beside each format so a CSV and an XLSX of
 * the same report cannot drift into disagreeing about what is in it. They are
 * built from the SAME service call the screen renders, with the same filters,
 * for the same reason: two queries meant to agree eventually stop agreeing, and
 * the export is the copy that leaves the building.
 */

export const REPORT_KEYS = ['stock', 'movements', 'counts', 'ageing', 'reorder'] as const
export type ReportKey = (typeof REPORT_KEYS)[number]

export function isReportKey(value: string): value is ReportKey {
  return (REPORT_KEYS as readonly string[]).includes(value)
}

export interface ExportRequest extends ReportFilters {
  grain?: StockGrain
  from?: Date
  to?: Date
}

export interface PreparedExport {
  /** Without an extension; the caller adds one. */
  name: string
  sheetName: string
  columns: ReadonlyArray<XlsxColumn<Record<string, unknown>>>
  rows: ReadonlyArray<Record<string, unknown>>
}

/**
 * Cell values keep their real type.
 *
 * A date stays a Date and a quantity stays a number, so XLSX can write them as
 * a date and a number rather than as text. The CSV writer stringifies them on
 * its own way out.
 */
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

export async function prepareExport(
  db: PrismaClient,
  key: ReportKey,
  request: ExportRequest,
): Promise<PreparedExport> {
  const filters: ReportFilters = {
    siteId: request.siteId ?? null,
    categoryId: request.categoryId ?? null,
  }

  switch (key) {
    case 'stock': {
      const grain = request.grain ?? 'ITEM'
      const report = await stockOnHand(db, grain, filters)

      return {
        name: `stock-on-hand-${grain.toLowerCase()}`,
        sheetName: 'Stock on hand',
        rows: report.rows as unknown as Array<Record<string, unknown>>,
        columns: [
          column<(typeof report.rows)[number]>('SKU', (row) => row.sku, 18),
          column<(typeof report.rows)[number]>('Item', (row) => row.itemName, 36),
          column<(typeof report.rows)[number]>('Category', (row) => row.categoryName),
          column<(typeof report.rows)[number]>('Location', (row) => row.locationCode),
          column<(typeof report.rows)[number]>('Batch', (row) => row.batchNo),
          column<(typeof report.rows)[number]>('Expiry', (row) => row.expiryDate),
          column<(typeof report.rows)[number]>('Quantity', (row) => row.quantity),
          column<(typeof report.rows)[number]>('Unit', (row) => row.unit),
        ],
      }
    }

    case 'movements': {
      const range = { from: request.from ?? new Date(0), to: request.to ?? new Date() }
      const report = await movementSummary(db, range, filters)

      return {
        name: `movement-summary-${iso(range.from)}-to-${iso(range.to)}`,
        sheetName: 'Movement summary',
        rows: report.rows as unknown as Array<Record<string, unknown>>,
        columns: [
          column<(typeof report.rows)[number]>('Type', (row) => row.type),
          column<(typeof report.rows)[number]>('Movements', (row) => row.movements),
          column<(typeof report.rows)[number]>('Quantity', (row) => row.quantity),
          column<(typeof report.rows)[number]>('Items touched', (row) => row.items),
        ],
      }
    }

    case 'counts': {
      const range = { from: request.from ?? new Date(0), to: request.to ?? new Date() }
      const report = await countAccuracy(db, range, filters)

      return {
        name: `count-accuracy-${iso(range.from)}-to-${iso(range.to)}`,
        sheetName: 'Count accuracy',
        rows: report.rows as unknown as Array<Record<string, unknown>>,
        columns: [
          column<(typeof report.rows)[number]>('Started', (row) => row.startedAt, 20),
          column<(typeof report.rows)[number]>('Location', (row) => row.locationCode),
          column<(typeof report.rows)[number]>('Method', (row) => row.method),
          column<(typeof report.rows)[number]>('Status', (row) => row.status),
          column<(typeof report.rows)[number]>('Lines counted', (row) => row.linesCounted),
          column<(typeof report.rows)[number]>(
            'Lines with variance',
            (row) => row.linesWithVariance,
          ),
          // A number, not "97.3%": a percentage written as text cannot be
          // averaged, sorted or charted by whoever receives the file.
          column<(typeof report.rows)[number]>('Accuracy %', (row) =>
            Number(row.accuracy.toFixed(1)),
          ),
          column<(typeof report.rows)[number]>('Units out', (row) => row.unitsOut),
        ],
      }
    }

    case 'ageing': {
      const report = await stockAgeing(db, filters)

      return {
        name: 'stock-ageing',
        sheetName: 'Stock ageing',
        rows: report.rows as unknown as Array<Record<string, unknown>>,
        columns: [
          column<(typeof report.rows)[number]>('SKU', (row) => row.sku, 18),
          column<(typeof report.rows)[number]>('Item', (row) => row.itemName, 36),
          column<(typeof report.rows)[number]>('Batch', (row) => row.batchNo),
          column<(typeof report.rows)[number]>('Location', (row) => row.locationCode),
          column<(typeof report.rows)[number]>('Quantity', (row) => row.quantity),
          column<(typeof report.rows)[number]>('Received', (row) => row.receivedAt, 20),
          // null, never 0. An untracked item has no age, and a 0 here would
          // read as "arrived today" and sort to the top of a fresh-first sort.
          column<(typeof report.rows)[number]>('Age (days)', (row) => row.ageDays),
          column<(typeof report.rows)[number]>('Bucket', (row) => row.bucket),
        ],
      }
    }

    case 'reorder': {
      const report = await reorderReport(db, filters)

      return {
        name: 'reorder',
        sheetName: 'Reorder',
        rows: report.rows as unknown as Array<Record<string, unknown>>,
        columns: [
          column<(typeof report.rows)[number]>('SKU', (row) => row.sku, 18),
          column<(typeof report.rows)[number]>('Item', (row) => row.itemName, 36),
          column<(typeof report.rows)[number]>('Category', (row) => row.categoryName),
          column<(typeof report.rows)[number]>('On hand', (row) => row.onHand),
          column<(typeof report.rows)[number]>('Reorder point', (row) => row.reorderPoint),
          column<(typeof report.rows)[number]>('Short by', (row) => row.shortBy),
          column<(typeof report.rows)[number]>('Max level', (row) => row.maxLevel),
          column<(typeof report.rows)[number]>('Suggested order', (row) => row.suggested),
          column<(typeof report.rows)[number]>('Unit', (row) => row.unit),
        ],
      }
    }
  }
}

function iso(value: Date): string {
  return value.toISOString().slice(0, 10)
}
