'use server'

import { UserRole } from '@prisma/client'
import { requireRole } from '@/lib/auth/guards'
import { toCsv } from '@/lib/export/csv'
import { endOfDay } from './range'
import {
  countAccuracy,
  movementSummary,
  reorderReport,
  stockAgeing,
  stockOnHand,
  type ReportFilters,
  type StockGrain,
} from '@/lib/services/reports'

/**
 * CSV for each operational report.
 *
 * The CSV is built from the SAME service call the screen renders, with the same
 * filters, rather than from a second query written to match. Two queries that
 * are supposed to agree eventually stop agreeing, and the export is what gets
 * sent to somebody outside the business — so the screen and the file have to be
 * the same numbers by construction.
 *
 * Returns a string rather than a Response: the browser turns it into a download
 * (see download.tsx), which keeps this on the session-authenticated Server
 * Action path instead of opening a second, separately-guarded route.
 */

export interface ReportCsv {
  filename: string
  csv: string
}

function filtersFrom(raw: { siteId?: string; categoryId?: string }): ReportFilters {
  return {
    siteId: raw.siteId || null,
    categoryId: raw.categoryId || null,
  }
}

const date = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : '')

export async function stockCsvAction(input: {
  grain: StockGrain
  siteId?: string
  categoryId?: string
}): Promise<ReportCsv> {
  const user = await requireRole(UserRole.USER)
  const report = await stockOnHand(user.db, input.grain, filtersFrom(input))

  return {
    filename: `stock-on-hand-${input.grain.toLowerCase()}`,
    csv: toCsv(report.rows, [
      { header: 'SKU', value: (row) => row.sku },
      { header: 'Item', value: (row) => row.itemName },
      { header: 'Category', value: (row) => row.categoryName ?? '' },
      { header: 'Location', value: (row) => row.locationCode ?? '' },
      { header: 'Batch', value: (row) => row.batchNo ?? '' },
      { header: 'Expiry', value: (row) => date(row.expiryDate) },
      { header: 'Quantity', value: (row) => row.quantity },
      { header: 'Unit', value: (row) => row.unit },
    ]),
  }
}

export async function movementsCsvAction(input: {
  from: string
  to: string
  siteId?: string
  categoryId?: string
}): Promise<ReportCsv> {
  const user = await requireRole(UserRole.USER)
  const report = await movementSummary(
    user.db,
    { from: new Date(input.from), to: endOfDay(input.to) },
    filtersFrom(input),
  )

  return {
    filename: `movement-summary-${input.from}-to-${input.to}`,
    csv: toCsv(report.rows, [
      { header: 'Type', value: (row) => row.type },
      { header: 'Movements', value: (row) => row.movements },
      { header: 'Quantity', value: (row) => row.quantity },
      { header: 'Items touched', value: (row) => row.items },
    ]),
  }
}

export async function countsCsvAction(input: {
  from: string
  to: string
  siteId?: string
}): Promise<ReportCsv> {
  const user = await requireRole(UserRole.USER)
  const report = await countAccuracy(
    user.db,
    { from: new Date(input.from), to: endOfDay(input.to) },
    filtersFrom(input),
  )

  return {
    filename: `count-accuracy-${input.from}-to-${input.to}`,
    csv: toCsv(report.rows, [
      { header: 'Started', value: (row) => row.startedAt.toISOString() },
      { header: 'Location', value: (row) => row.locationCode },
      { header: 'Method', value: (row) => row.method },
      { header: 'Status', value: (row) => row.status },
      { header: 'Lines counted', value: (row) => row.linesCounted },
      { header: 'Lines with variance', value: (row) => row.linesWithVariance },
      { header: 'Accuracy %', value: (row) => row.accuracy.toFixed(1) },
      { header: 'Units out', value: (row) => row.unitsOut },
    ]),
  }
}

export async function ageingCsvAction(input: {
  siteId?: string
  categoryId?: string
}): Promise<ReportCsv> {
  const user = await requireRole(UserRole.USER)
  const report = await stockAgeing(user.db, filtersFrom(input))

  return {
    filename: 'stock-ageing',
    csv: toCsv(report.rows, [
      { header: 'SKU', value: (row) => row.sku },
      { header: 'Item', value: (row) => row.itemName },
      { header: 'Batch', value: (row) => row.batchNo ?? '' },
      { header: 'Location', value: (row) => row.locationCode },
      { header: 'Quantity', value: (row) => row.quantity },
      { header: 'Received', value: (row) => date(row.receivedAt) },
      // Blank, not 0. An untracked item has no age, and writing 0 would read as
      // "arrived today".
      { header: 'Age (days)', value: (row) => row.ageDays ?? '' },
      { header: 'Bucket', value: (row) => row.bucket },
    ]),
  }
}

export async function reorderCsvAction(input: {
  siteId?: string
  categoryId?: string
}): Promise<ReportCsv> {
  const user = await requireRole(UserRole.USER)
  const report = await reorderReport(user.db, filtersFrom(input))

  return {
    filename: 'reorder',
    csv: toCsv(report.rows, [
      { header: 'SKU', value: (row) => row.sku },
      { header: 'Item', value: (row) => row.itemName },
      { header: 'Category', value: (row) => row.categoryName ?? '' },
      { header: 'On hand', value: (row) => row.onHand },
      { header: 'Reorder point', value: (row) => row.reorderPoint },
      { header: 'Short by', value: (row) => row.shortBy },
      { header: 'Max level', value: (row) => row.maxLevel ?? '' },
      { header: 'Suggested order', value: (row) => row.suggested ?? '' },
      { header: 'Unit', value: (row) => row.unit },
    ]),
  }
}
