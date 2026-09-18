import 'server-only'
import { randomUUID } from 'node:crypto'
import { BarcodeType, LocationZone, MovementSource, TrackingMode } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import { ApiError, ErrorCode } from '@/lib/api/errors'
import { isValidEan13, normaliseBarcode } from '@/lib/domain/gtin'
import { parseCsv, requireColumns, CsvError, type CsvRow } from '@/lib/import/csv'
import { recordMovement } from './movements'

/**
 * Bringing data in from a spreadsheet.
 *
 * Two rules shape all of it.
 *
 * **Dry run first, always.** An import is the one operation that can be wrong
 * five hundred times before anybody notices. Every import is validated in full
 * and reported row by row BEFORE anything is written, so the decision to commit
 * is made with the errors already on screen.
 *
 * **Opening balances go through the ledger.** It would be far simpler to write
 * `stock_levels` directly, and it would be wrong: the projection is rebuildable
 * from the ledger (WADR-002), so stock that no movement explains is corruption
 * that `findProjectionDrift` is built to detect. Opening balances are RECEIVE
 * movements like any other, with a document number somebody can point at.
 */

export type ImportKind = 'items' | 'locations' | 'balances'

export interface RowProblem {
  line: number
  message: string
}

export interface ImportPlan {
  kind: ImportKind
  /** Rows that would be created. */
  create: number
  /** Rows that would update something already there. */
  update: number
  /** Rows that cannot be used, with why. */
  problems: RowProblem[]
  /** A few rows as they would be applied, for the operator to sanity-check. */
  sample: string[]
}

export interface ImportOutcome extends ImportPlan {
  applied: number
  /** Rows that failed while applying, despite passing the dry run. */
  failures: RowProblem[]
}

const COLUMNS: Record<ImportKind, readonly string[]> = {
  items: ['sku', 'name'],
  locations: ['code', 'name'],
  balances: ['sku', 'location', 'quantity'],
}

/**
 * Validates a file and reports what it would do.
 *
 * Never writes. The apply step re-validates rather than trusting this, because
 * the database can change between the two.
 */
export async function planImport(
  db: PrismaClient,
  kind: ImportKind,
  text: string,
): Promise<ImportPlan> {
  const rows = read(kind, text)

  switch (kind) {
    case 'items':
      return planItems(db, rows)
    case 'locations':
      return planLocations(db, rows)
    case 'balances':
      return planBalances(db, rows)
  }
}

function read(kind: ImportKind, text: string): CsvRow[] {
  try {
    const parsed = parseCsv(text)
    requireColumns(parsed, COLUMNS[kind])
    return parsed.rows
  } catch (error) {
    if (error instanceof CsvError) throw new ApiError(ErrorCode.VALIDATION_FAILED, error.message)
    throw error
  }
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

interface PlannedItem {
  line: number
  sku: string
  name: string
  unit: string
  reorderPoint: number
  trackingMode: TrackingMode
  barcode: string | null
  existingId: string | null
}

async function planItems(db: PrismaClient, rows: CsvRow[]): Promise<ImportPlan> {
  const problems: RowProblem[] = []
  const planned: PlannedItem[] = []
  const seen = new Map<string, number>()

  const existing = new Map(
    (await db.item.findMany({ select: { id: true, sku: true } })).map((item) => [item.sku, item.id]),
  )

  for (const row of rows) {
    const sku = row.values.sku?.trim() ?? ''
    const name = row.values.name?.trim() ?? ''

    if (!sku) {
      problems.push({ line: row.line, message: 'No SKU.' })
      continue
    }
    if (!name) {
      problems.push({ line: row.line, message: `${sku} has no name.` })
      continue
    }

    // A file that lists the same SKU twice would apply both and leave whichever
    // came last, silently. Saying so is better than picking one.
    const duplicate = seen.get(sku)
    if (duplicate !== undefined) {
      problems.push({ line: row.line, message: `${sku} also appears on row ${duplicate}.` })
      continue
    }
    seen.set(sku, row.line)

    const tracking = (row.values.tracking ?? 'NONE').trim().toUpperCase()
    if (!(tracking in TrackingMode)) {
      problems.push({
        line: row.line,
        message: `${sku}: "${tracking}" is not a tracking mode. Use NONE, BATCH or SERIAL.`,
      })
      continue
    }

    const reorderRaw = row.values.reorderPoint ?? '0'
    const reorderPoint = Number.parseInt(reorderRaw || '0', 10)
    if (!Number.isFinite(reorderPoint) || reorderPoint < 0) {
      problems.push({ line: row.line, message: `${sku}: "${reorderRaw}" is not a reorder point.` })
      continue
    }

    let barcode: string | null = null
    const barcodeRaw = row.values.barcode?.trim()
    if (barcodeRaw) {
      const normalised = normaliseBarcode(barcodeRaw)
      if (!normalised || !isValidEan13(normalised)) {
        // A barcode with a bad check digit is one no scanner will read, and
        // importing it produces an item nobody can find by scanning.
        problems.push({
          line: row.line,
          message: `${sku}: "${barcodeRaw}" is not a valid EAN-13 — check the last digit.`,
        })
        continue
      }
      barcode = normalised
    }

    planned.push({
      line: row.line,
      sku,
      name,
      unit: row.values.unit?.trim() || 'pcs',
      reorderPoint,
      trackingMode: tracking as TrackingMode,
      barcode,
      existingId: existing.get(sku) ?? null,
    })
  }

  return {
    kind: 'items',
    create: planned.filter((item) => !item.existingId).length,
    update: planned.filter((item) => item.existingId).length,
    problems,
    sample: planned.slice(0, 5).map(
      (item) =>
        `${item.existingId ? 'update' : 'create'} ${item.sku} — ${item.name} (${item.trackingMode.toLowerCase()})`,
    ),
  }
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

async function planLocations(db: PrismaClient, rows: CsvRow[]): Promise<ImportPlan> {
  const problems: RowProblem[] = []
  const planned: Array<{ line: number; code: string; name: string; zone: LocationZone; existing: boolean }> = []
  const seen = new Map<string, number>()

  const existing = new Set(
    (await db.location.findMany({ select: { code: true } })).map((location) => location.code),
  )

  for (const row of rows) {
    const code = row.values.code?.trim().toUpperCase() ?? ''
    const name = row.values.name?.trim() ?? ''

    if (!code) {
      problems.push({ line: row.line, message: 'No code.' })
      continue
    }
    if (!name) {
      problems.push({ line: row.line, message: `${code} has no name.` })
      continue
    }

    const duplicate = seen.get(code)
    if (duplicate !== undefined) {
      problems.push({ line: row.line, message: `${code} also appears on row ${duplicate}.` })
      continue
    }
    seen.set(code, row.line)

    const zone = (row.values.zone ?? 'STORAGE').trim().toUpperCase()
    if (!(zone in LocationZone)) {
      problems.push({
        line: row.line,
        message: `${code}: "${zone}" is not a zone. Use ${Object.keys(LocationZone).join(', ')}.`,
      })
      continue
    }

    planned.push({ line: row.line, code, name, zone: zone as LocationZone, existing: existing.has(code) })
  }

  return {
    kind: 'locations',
    create: planned.filter((location) => !location.existing).length,
    update: planned.filter((location) => location.existing).length,
    problems,
    sample: planned.slice(0, 5).map((location) => `${location.code} — ${location.name}`),
  }
}

// ---------------------------------------------------------------------------
// Opening balances
// ---------------------------------------------------------------------------

interface PlannedBalance {
  line: number
  itemId: string
  sku: string
  locationId: string
  location: string
  quantity: number
  batchId: string | null
}

async function planBalances(db: PrismaClient, rows: CsvRow[]): Promise<ImportPlan> {
  const problems: RowProblem[] = []
  const planned: PlannedBalance[] = []

  const [items, locations, batches] = await Promise.all([
    db.item.findMany({ select: { id: true, sku: true, trackingMode: true } }),
    db.location.findMany({ where: { deletedAt: null }, select: { id: true, code: true } }),
    db.batch.findMany({ select: { id: true, itemId: true, batchNo: true } }),
  ])

  const itemBySku = new Map(items.map((item) => [item.sku, item]))
  const locationByCode = new Map(locations.map((location) => [location.code, location.id]))

  for (const row of rows) {
    const sku = row.values.sku?.trim() ?? ''
    const code = row.values.location?.trim().toUpperCase() ?? ''
    const quantityRaw = row.values.quantity?.trim() ?? ''

    const item = itemBySku.get(sku)
    if (!item) {
      problems.push({ line: row.line, message: `No item with SKU "${sku}". Import items first.` })
      continue
    }

    const locationId = locationByCode.get(code)
    if (!locationId) {
      problems.push({ line: row.line, message: `No location "${code}".` })
      continue
    }

    const quantity = Number.parseInt(quantityRaw, 10)
    if (!Number.isFinite(quantity) || quantity <= 0) {
      problems.push({
        line: row.line,
        message: `${sku}: "${quantityRaw}" is not an opening quantity. It must be a whole number above zero.`,
      })
      continue
    }

    let batchId: string | null = null
    const batchNo = row.values.batch?.trim()

    if (item.trackingMode === TrackingMode.BATCH) {
      if (!batchNo) {
        problems.push({ line: row.line, message: `${sku} is batch-tracked, so it needs a batch.` })
        continue
      }
      const batch = batches.find((candidate) => candidate.itemId === item.id && candidate.batchNo === batchNo)
      if (!batch) {
        problems.push({
          line: row.line,
          message: `${sku} has no batch "${batchNo}". Create it first, or receive it with an expiry date.`,
        })
        continue
      }
      batchId = batch.id
    }

    if (item.trackingMode === TrackingMode.SERIAL) {
      // A serial item's opening balance is a list of units, not a number. A
      // quantity alone would create stock with no units behind it, and the next
      // RFID count would report all of it missing.
      problems.push({
        line: row.line,
        message: `${sku} is serial-tracked. Import its units with serial numbers rather than a quantity.`,
      })
      continue
    }

    planned.push({
      line: row.line,
      itemId: item.id,
      sku,
      locationId,
      location: code,
      quantity,
      batchId,
    })
  }

  return {
    kind: 'balances',
    create: planned.length,
    update: 0,
    problems,
    sample: planned
      .slice(0, 5)
      .map((balance) => `receive ${balance.quantity} × ${balance.sku} into ${balance.location}`),
  }
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

export async function applyImport(
  db: PrismaClient,
  kind: ImportKind,
  text: string,
  actor: { userId: string; siteId: string },
): Promise<ImportOutcome> {
  // Re-read and re-validate. The dry run may have been minutes ago, and a
  // second administrator may have changed something since.
  const plan = await planImport(db, kind, text)
  const rows = read(kind, text)

  const failures: RowProblem[] = []
  let applied = 0

  const badLines = new Set(plan.problems.map((problem) => problem.line))
  const usable = rows.filter((row) => !badLines.has(row.line))

  for (const row of usable) {
    try {
      if (kind === 'items') await applyItem(db, row)
      else if (kind === 'locations') await applyLocation(db, row, actor.siteId)
      else await applyBalance(db, row, actor)
      applied++
    } catch (error) {
      // One bad row does not abandon the rest. An import that stops half way
      // leaves somebody working out which rows landed.
      failures.push({
        line: row.line,
        message: error instanceof Error ? error.message : 'That row could not be applied.',
      })
    }
  }

  return { ...plan, applied, failures }
}

async function applyItem(db: PrismaClient, row: CsvRow): Promise<void> {
  const sku = row.values.sku!.trim()
  const tracking = (row.values.tracking ?? 'NONE').trim().toUpperCase() as TrackingMode

  const item = await db.item.upsert({
    where: { sku },
    update: {
      name: row.values.name!.trim(),
      unit: row.values.unit?.trim() || 'pcs',
      reorderPoint: Number.parseInt(row.values.reorderPoint || '0', 10),
      trackingMode: tracking,
      deletedAt: null,
      active: true,
    },
    create: {
      id: randomUUID(),
      sku,
      name: row.values.name!.trim(),
      unit: row.values.unit?.trim() || 'pcs',
      reorderPoint: Number.parseInt(row.values.reorderPoint || '0', 10),
      trackingMode: tracking,
    },
    select: { id: true },
  })

  const barcodeRaw = row.values.barcode?.trim()
  if (barcodeRaw) {
    const barcode = normaliseBarcode(barcodeRaw)!
    await db.itemBarcode.upsert({
      where: { barcode },
      update: { itemId: item.id, isPrimary: true },
      create: {
        id: randomUUID(),
        itemId: item.id,
        barcode,
        type: BarcodeType.EAN13,
        isPrimary: true,
      },
    })
  }
}

async function applyLocation(db: PrismaClient, row: CsvRow, siteId: string): Promise<void> {
  const code = row.values.code!.trim().toUpperCase()
  const zone = (row.values.zone ?? 'STORAGE').trim().toUpperCase() as LocationZone

  await db.location.upsert({
    where: { siteId_code: { siteId, code } },
    update: { name: row.values.name!.trim(), zone, deletedAt: null, active: true },
    create: { id: randomUUID(), siteId, code, name: row.values.name!.trim(), zone },
  })
}

/**
 * An opening balance is a RECEIVE, through the same write path as everything
 * else.
 *
 * It would be simpler to write `stock_levels` directly. It would also produce
 * stock the ledger cannot explain — the corruption `findProjectionDrift` exists
 * to catch — and leave nobody able to say where the number came from.
 */
async function applyBalance(
  db: PrismaClient,
  row: CsvRow,
  actor: { userId: string; siteId: string },
): Promise<void> {
  const sku = row.values.sku!.trim()
  const code = row.values.location!.trim().toUpperCase()

  const [item, location] = await Promise.all([
    db.item.findUniqueOrThrow({ where: { sku }, select: { id: true } }),
    db.location.findFirstOrThrow({ where: { code, deletedAt: null }, select: { id: true } }),
  ])

  const batchNo = row.values.batch?.trim()
  const batch = batchNo
    ? await db.batch.findFirst({
        where: { itemId: item.id, batchNo },
        select: { id: true },
      })
    : null

  const outcome = await recordMovement(
    db,
    {
      id: randomUUID(),
      siteId: actor.siteId,
      action: {
        kind: 'RECEIVE',
        itemId: item.id,
        toLocationId: location.id,
        quantity: Number.parseInt(row.values.quantity!, 10),
        batchId: batch?.id ?? null,
        reference: 'Opening balance',
      },
      source: MovementSource.IMPORT,
    },
    { userId: actor.userId },
  )

  if (outcome.status === 'REJECTED') throw new Error(outcome.error.message)
}
