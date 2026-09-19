import 'server-only'
import { randomUUID } from 'node:crypto'
import { BatchStatus, MovementSource } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import { ApiError, ErrorCode } from '@/lib/api/errors'
import { AuditAction, writeAudit } from '@/lib/audit'
import { recordMovement } from './movements'
import { submitPrintJob } from './printing'
import type { AppMode } from '@/lib/mode'

/**
 * Doing the same thing to many rows (PROJECT_PLAN 8.5).
 *
 * Three rules hold across all of it, and they are the difference between a
 * bulk tool and a way to lose an afternoon's work.
 *
 * **Every row gets its own verdict.** One bad line never blocks the rest, in
 * exactly the way a phone's outbox is applied: a bulk action that fails
 * wholesale because of one typo is one nobody will use twice, and the work it
 * refused still has to be done by hand.
 *
 * **Nothing is one transaction.** Fifty adjustments in a single transaction
 * hold fifty row locks for the duration, and on a busy floor that is a stall
 * everybody feels. Each row is its own transaction, already idempotent by its
 * movement id.
 *
 * **A ceiling, deliberately low.** Not because more would break, but because a
 * bulk action is aimed at a screenful of rows somebody has looked at. A
 * thousand-row paste is an import, and the import has a dry run and a per-row
 * error report built for exactly that.
 */

/** Rows per bulk action. An import is the tool for more than this. */
export const BULK_LIMIT = 200

export type RowOutcome =
  | { status: 'DONE'; detail: string }
  | { status: 'SKIPPED'; detail: string }
  | { status: 'FAILED'; detail: string }

/**
 * An intersection rather than an interface extending RowOutcome: a union
 * cannot be extended, and the union is what keeps `status` and `detail`
 * meaningful together.
 */
export type BulkRowResult = RowOutcome & {
  /** Whatever identifies the row on screen: a SKU, a batch number, a code. */
  ref: string
}

export interface BulkResult {
  rows: BulkRowResult[]
  done: number
  skipped: number
  failed: number
}

function summarise(rows: BulkRowResult[]): BulkResult {
  return {
    rows,
    done: rows.filter((row) => row.status === 'DONE').length,
    skipped: rows.filter((row) => row.status === 'SKIPPED').length,
    failed: rows.filter((row) => row.status === 'FAILED').length,
  }
}

function checkSize(count: number): void {
  if (count === 0) throw new ApiError(ErrorCode.VALIDATION_FAILED, 'Nothing was selected.')
  if (count > BULK_LIMIT) {
    throw new ApiError(
      ErrorCode.VALIDATION_FAILED,
      `That is ${count} rows, and a bulk action takes at most ${BULK_LIMIT}. For more than that, use Admin → Import, which previews every row before it writes anything.`,
    )
  }
}

// --- Bulk adjust -----------------------------------------------------------

export interface BulkAdjustLine {
  itemId: string
  locationId: string
  batchId?: string | null
  countedQuantity: number
}

export interface BulkAdjustPreviewRow {
  ref: string
  itemName: string
  locationCode: string
  batchNo: string | null
  before: number
  after: number
  difference: number
}

/**
 * What a bulk adjustment WOULD do, writing nothing.
 *
 * The same shape as the CSV import's dry run, and for the same reason: an
 * adjustment is a correction to what the business believes it owns, and
 * somebody should see the differences before they are real. The numbers can
 * still move between the preview and the apply — this is a preview, not a
 * lock — so the apply re-reads everything under its own row locks.
 */
export async function previewBulkAdjust(
  db: PrismaClient,
  lines: readonly BulkAdjustLine[],
): Promise<BulkAdjustPreviewRow[]> {
  checkSize(lines.length)

  const [items, locations, batches] = await Promise.all([
    db.item.findMany({
      where: { id: { in: lines.map((line) => line.itemId) } },
      select: { id: true, sku: true, name: true },
    }),
    db.location.findMany({
      where: { id: { in: lines.map((line) => line.locationId) } },
      select: { id: true, code: true },
    }),
    db.batch.findMany({
      where: {
        id: { in: lines.map((line) => line.batchId).filter((id): id is string => Boolean(id)) },
      },
      select: { id: true, batchNo: true },
    }),
  ])

  const itemById = new Map(items.map((item) => [item.id, item]))
  const locationById = new Map(locations.map((location) => [location.id, location]))
  const batchById = new Map(batches.map((batch) => [batch.id, batch]))

  const levels = await db.stockLevel.findMany({
    where: {
      itemId: { in: lines.map((line) => line.itemId) },
      locationId: { in: lines.map((line) => line.locationId) },
    },
    select: { itemId: true, locationId: true, batchId: true, quantity: true },
  })

  return lines.map((line) => {
    const item = itemById.get(line.itemId)
    const location = locationById.get(line.locationId)

    const before = levels
      .filter(
        (level) =>
          level.itemId === line.itemId &&
          level.locationId === line.locationId &&
          (line.batchId ? level.batchId === line.batchId : true),
      )
      .reduce((sum, level) => sum + level.quantity, 0)

    return {
      ref: item?.sku ?? line.itemId,
      itemName: item?.name ?? 'Unknown item',
      locationCode: location?.code ?? 'Unknown location',
      batchNo: line.batchId ? (batchById.get(line.batchId)?.batchNo ?? null) : null,
      before,
      after: line.countedQuantity,
      difference: line.countedQuantity - before,
    }
  })
}

/**
 * Applies a bulk adjustment, one movement at a time.
 *
 * Goes through `recordMovement` like every other stock change, so the
 * adjustment cap, the reason code requirement and the ledger rules all apply
 * exactly as they do to a single adjustment typed into the form. A bulk path
 * that skipped them would be a way around every limit an administrator set.
 */
export async function applyBulkAdjust(
  db: PrismaClient,
  lines: readonly BulkAdjustLine[],
  options: { reasonCodeId: string; note?: string | null; siteId: string },
  actor: { userId: string },
): Promise<BulkResult> {
  checkSize(lines.length)

  const items = await db.item.findMany({
    where: { id: { in: lines.map((line) => line.itemId) } },
    select: { id: true, sku: true },
  })
  const skuById = new Map(items.map((item) => [item.id, item.sku]))

  const rows: BulkRowResult[] = []

  for (const line of lines) {
    const ref = skuById.get(line.itemId) ?? line.itemId

    const outcome = await recordMovement(
      db,
      {
        id: randomUUID(),
        siteId: options.siteId,
        action: {
          kind: 'ADJUST',
          itemId: line.itemId,
          locationId: line.locationId,
          batchId: line.batchId ?? null,
          countedQuantity: line.countedQuantity,
          reasonCodeId: options.reasonCodeId,
          note: options.note ?? null,
        },
        source: MovementSource.WEB,
      },
      actor,
    )

    if (outcome.status === 'RECORDED' || outcome.status === 'FLAGGED') {
      rows.push({ ref, status: 'DONE', detail: outcome.docNo })
    } else if (outcome.status === 'DUPLICATE') {
      rows.push({ ref, status: 'SKIPPED', detail: 'Already recorded.' })
    } else {
      // NO_CHANGE is not a failure. Counting a shelf and finding it exactly as
      // expected is the good outcome, and colouring it red teaches people that
      // a correct count looks like an error.
      const noChange = outcome.error.code === 'NO_CHANGE'
      rows.push({
        ref,
        status: noChange ? 'SKIPPED' : 'FAILED',
        detail: noChange ? 'Already correct — nothing to adjust.' : outcome.error.message,
      })
    }
  }

  return summarise(rows)
}

// --- Bulk quarantine and release -------------------------------------------

/**
 * Freezes or releases many batches.
 *
 * Quarantining does NOT move stock: the units stay where they are and keep
 * counting towards on-hand. It makes them unusable, which is what an
 * investigation needs — find it, freeze it, decide later. Moving it would
 * destroy the evidence of where it was.
 *
 * This is the operation a recall actually needs in bulk, which is why it is
 * here: a quality manager holding a supplier's defect notice has a list of lot
 * numbers, not one.
 */
export async function bulkSetBatchStatus(
  db: PrismaClient,
  batchIds: readonly string[],
  status: BatchStatus,
  options: { note?: string | null },
  actor: { userId: string },
): Promise<BulkResult> {
  checkSize(batchIds.length)

  const batches = await db.batch.findMany({
    where: { id: { in: [...batchIds] } },
    select: { id: true, batchNo: true, status: true, notes: true },
  })
  const byId = new Map(batches.map((batch) => [batch.id, batch]))

  const rows: BulkRowResult[] = []

  for (const batchId of batchIds) {
    const batch = byId.get(batchId)

    if (!batch) {
      rows.push({ ref: batchId, status: 'FAILED', detail: 'That batch does not exist.' })
      continue
    }
    if (batch.status === status) {
      // Already where it needs to be. Not an error: somebody re-running a
      // recall list should not be told half of it failed.
      rows.push({
        ref: batch.batchNo,
        status: 'SKIPPED',
        detail: `Already ${status.toLowerCase()}.`,
      })
      continue
    }

    try {
      await db.$transaction(async (tx) => {
        await tx.batch.update({
          where: { id: batchId },
          data: { status, notes: options.note ?? batch.notes },
        })

        await writeAudit(tx, {
          actorUserId: actor.userId,
          action: status === BatchStatus.QUARANTINE ? AuditAction.QUARANTINE : AuditAction.RELEASE,
          entity: 'Batch',
          entityId: batchId,
          before: { status: batch.status },
          after: { status, note: options.note ?? null },
        })
      })

      rows.push({ ref: batch.batchNo, status: 'DONE', detail: status.toLowerCase() })
    } catch (error) {
      rows.push({
        ref: batch.batchNo,
        status: 'FAILED',
        detail: error instanceof Error ? error.message : 'That batch could not be changed.',
      })
    }
  }

  return summarise(rows)
}

// --- Bulk print and relabel ------------------------------------------------

export interface BulkPrintRequest {
  templateId: string
  printerDeviceId?: string | null
  copies?: number
  /** Items, batches or serial units — whichever the template is for. */
  itemIds?: readonly string[]
  batchIds?: readonly string[]
  serialUnitIds?: readonly string[]
}

/**
 * Prints one label per selected record.
 *
 * "Relabel" is this with a different template chosen, which is why there is no
 * separate operation for it: the difference is which template, and that is
 * already a field.
 *
 * Each label is its own print job, so one that fails — a bad placeholder, a
 * printer that refused — does not lose the rest of the run. A single job
 * carrying two hundred labels also cannot be partially reprinted, and
 * reprinting the three that smudged is the commonest thing anybody wants.
 */
export async function bulkPrint(
  db: PrismaClient,
  request: BulkPrintRequest,
  actor: { userId: string },
  mode: AppMode,
): Promise<BulkResult> {
  const targets = [
    ...(request.itemIds ?? []).map((id) => ({ kind: 'item' as const, id })),
    ...(request.batchIds ?? []).map((id) => ({ kind: 'batch' as const, id })),
    ...(request.serialUnitIds ?? []).map((id) => ({ kind: 'serial' as const, id })),
  ]

  checkSize(targets.length)

  const rows: BulkRowResult[] = []

  for (const target of targets) {
    try {
      const result = await submitPrintJob(
        db,
        {
          templateId: request.templateId,
          printerDeviceId: request.printerDeviceId ?? null,
          copies: request.copies ?? 1,
          itemId: target.kind === 'item' ? target.id : null,
          batchId: target.kind === 'batch' ? target.id : null,
          serialUnitId: target.kind === 'serial' ? target.id : null,
        },
        actor,
        mode,
      )

      rows.push({
        ref: result.docNo ?? target.id,
        status: 'DONE',
        detail: result.message,
      })
    } catch (error) {
      rows.push({
        ref: target.id,
        status: 'FAILED',
        detail: error instanceof Error ? error.message : 'That label could not be printed.',
      })
    }
  }

  return summarise(rows)
}

export { BatchStatus }
