import { randomUUID } from 'node:crypto'
import { BatchStatus, MovementSource } from '@prisma/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  BULK_LIMIT,
  applyBulkAdjust,
  bulkSetBatchStatus,
  previewBulkAdjust,
} from '@/lib/services/bulk'
import { recordMovement } from '@/lib/services/movements'
import { setSetting } from '@/lib/services/settings'
import { prisma, onHand, seedWarehouse, type Warehouse } from './helpers/warehouse'

/**
 * Bulk operations.
 *
 * Three properties matter more than the features themselves.
 *
 * ONE BAD ROW MUST NOT BLOCK THE REST. A bulk action that fails wholesale over
 * a single typo is one nobody uses twice, and the work it refused still has to
 * be done by hand.
 *
 * THE RULES STILL APPLY. Going through recordMovement means the adjustment cap
 * and the reason-code requirement hold exactly as they do for one adjustment
 * typed into the form. A bulk path that skipped them would be a way around
 * every limit an administrator set.
 *
 * A CORRECT COUNT IS NOT AN ERROR. Counting a shelf and finding it exactly as
 * expected is the good outcome, and reporting it as a failure teaches people
 * that being right looks like being broken.
 */

let wh: Warehouse
const actor = () => ({ userId: wh.userId })

beforeEach(async () => {
  wh = await seedWarehouse()
  await prisma.setting.deleteMany()
})

afterAll(async () => {
  await prisma.$disconnect()
})

const receive = (itemId: string, locationId: string, quantity: number) =>
  recordMovement(
    prisma,
    {
      id: randomUUID(),
      siteId: wh.siteId,
      action: { kind: 'RECEIVE', itemId, toLocationId: locationId, quantity },
      source: MovementSource.WEB,
    },
    { userId: wh.userId },
  )

const adjust = (lines: Parameters<typeof applyBulkAdjust>[1]) =>
  applyBulkAdjust(prisma, lines, { reasonCodeId: wh.reasonCodeId, siteId: wh.siteId }, actor())

// ---------------------------------------------------------------------------

describe('bulk adjust · the preview', () => {
  it('shows the difference each line would make, and writes nothing', async () => {
    await receive(wh.tapeId, wh.locationA, 10)

    const preview = await previewBulkAdjust(prisma, [
      { itemId: wh.tapeId, locationId: wh.locationA, countedQuantity: 7 },
    ])

    expect(preview[0]?.before).toBe(10)
    expect(preview[0]?.after).toBe(7)
    expect(preview[0]?.difference).toBe(-3)

    // The whole point of a dry run: nothing moved.
    expect(await onHand(wh.tapeId, wh.locationA)).toBe(10)
  })

  it('names the item and location, so the rows can be read', async () => {
    await receive(wh.tapeId, wh.locationA, 5)

    const preview = await previewBulkAdjust(prisma, [
      { itemId: wh.tapeId, locationId: wh.locationA, countedQuantity: 5 },
    ])

    expect(preview[0]?.ref).toBeTruthy()
    expect(preview[0]?.itemName).toBeTruthy()
    expect(preview[0]?.locationCode).toBeTruthy()
  })

  it('shows an empty place as zero rather than failing', async () => {
    const preview = await previewBulkAdjust(prisma, [
      { itemId: wh.tapeId, locationId: wh.locationB, countedQuantity: 4 },
    ])

    expect(preview[0]?.before).toBe(0)
    expect(preview[0]?.difference).toBe(4)
  })
})

describe('bulk adjust · applying', () => {
  it('posts every line and moves the stock', async () => {
    await receive(wh.tapeId, wh.locationA, 10)
    await receive(wh.tapeId, wh.locationB, 20)

    const result = await adjust([
      { itemId: wh.tapeId, locationId: wh.locationA, countedQuantity: 8 },
      { itemId: wh.tapeId, locationId: wh.locationB, countedQuantity: 25 },
    ])

    expect(result.done).toBe(2)
    expect(await onHand(wh.tapeId, wh.locationA)).toBe(8)
    expect(await onHand(wh.tapeId, wh.locationB)).toBe(25)
  })

  it('keeps going when one line fails, and says which', async () => {
    // The property the whole thing hangs on.
    await receive(wh.tapeId, wh.locationA, 10)

    const result = await adjust([
      { itemId: wh.tapeId, locationId: wh.locationA, countedQuantity: 8 },
      { itemId: randomUUID(), locationId: wh.locationA, countedQuantity: 3 },
      { itemId: wh.tapeId, locationId: wh.locationB, countedQuantity: 4 },
    ])

    expect(result.done).toBe(2)
    expect(result.failed).toBe(1)
    // And the good lines really were applied.
    expect(await onHand(wh.tapeId, wh.locationA)).toBe(8)
    expect(await onHand(wh.tapeId, wh.locationB)).toBe(4)
  })

  it('treats a line that needed no change as SKIPPED, not failed', async () => {
    // Counting a shelf and finding it right is the good outcome. Colouring it
    // red teaches people that being correct looks like being broken.
    await receive(wh.tapeId, wh.locationA, 10)

    const result = await adjust([
      { itemId: wh.tapeId, locationId: wh.locationA, countedQuantity: 10 },
    ])

    expect(result.skipped).toBe(1)
    expect(result.failed).toBe(0)
    expect(result.rows[0]?.detail).toMatch(/already correct/i)
  })

  it('STILL honours the adjustment cap an administrator set', async () => {
    // A bulk path that skipped the limits would be a way around every one of
    // them. The cap is checked by recordMovement, which this goes through.
    await setSetting(prisma, 'adjust.maxQuantity', 5)
    await receive(wh.tapeId, wh.locationA, 100)

    const result = await adjust([
      { itemId: wh.tapeId, locationId: wh.locationA, countedQuantity: 10 },
    ])

    expect(result.failed).toBe(1)
    expect(result.rows[0]?.detail).toMatch(/cap|limit|too large|larger/i)
    // And nothing moved.
    expect(await onHand(wh.tapeId, wh.locationA)).toBe(100)
  })

  it('refuses a batch bigger than the ceiling, and points at the import', async () => {
    const lines = Array.from({ length: BULK_LIMIT + 1 }, () => ({
      itemId: wh.tapeId,
      locationId: wh.locationA,
      countedQuantity: 1,
    }))

    await expect(adjust(lines)).rejects.toThrow(/at most 200/i)
    await expect(adjust(lines)).rejects.toThrow(/Import/i)
  })

  it('refuses an empty selection rather than reporting success over nothing', async () => {
    await expect(adjust([])).rejects.toThrow(/nothing was selected/i)
  })
})

describe('bulk quarantine', () => {
  it('freezes several batches at once', async () => {
    const result = await bulkSetBatchStatus(
      prisma,
      [wh.freshBatchId, wh.soonBatchId],
      BatchStatus.QUARANTINE,
      { note: 'Supplier defect notice 2026-114' },
      actor(),
    )

    expect(result.done).toBe(2)

    const batches = await prisma.batch.findMany({
      where: { id: { in: [wh.freshBatchId, wh.soonBatchId] } },
      select: { status: true, notes: true },
    })
    expect(batches.every((batch) => batch.status === BatchStatus.QUARANTINE)).toBe(true)
    expect(batches[0]?.notes).toMatch(/2026-114/)
  })

  it('does NOT move the stock', async () => {
    // Quarantine freezes; it does not relocate. Moving it would destroy the
    // evidence of where it was, which is the thing an investigation needs.
    await recordMovement(
      prisma,
      {
        id: randomUUID(),
        siteId: wh.siteId,
        action: {
          kind: 'RECEIVE',
          itemId: wh.adhesiveId,
          toLocationId: wh.locationA,
          quantity: 6,
          batchId: wh.freshBatchId,
        },
        source: MovementSource.WEB,
      },
      { userId: wh.userId },
    )

    await bulkSetBatchStatus(prisma, [wh.freshBatchId], BatchStatus.QUARANTINE, {}, actor())

    expect(await onHand(wh.adhesiveId, wh.locationA)).toBe(6)
  })

  it('skips a batch already in that state rather than calling it a failure', async () => {
    // Re-running a recall list must not report half of it as broken.
    await bulkSetBatchStatus(prisma, [wh.freshBatchId], BatchStatus.QUARANTINE, {}, actor())

    const again = await bulkSetBatchStatus(
      prisma,
      [wh.freshBatchId],
      BatchStatus.QUARANTINE,
      {},
      actor(),
    )

    expect(again.skipped).toBe(1)
    expect(again.failed).toBe(0)
  })

  it('reports an unknown batch without stopping the rest', async () => {
    const result = await bulkSetBatchStatus(
      prisma,
      [wh.freshBatchId, randomUUID()],
      BatchStatus.QUARANTINE,
      {},
      actor(),
    )

    expect(result.done).toBe(1)
    expect(result.failed).toBe(1)
  })

  it('records who froze what, for the recall trail', async () => {
    await bulkSetBatchStatus(prisma, [wh.freshBatchId], BatchStatus.QUARANTINE, {}, actor())

    const entry = await prisma.auditLog.findFirst({
      where: { entity: 'Batch', entityId: wh.freshBatchId },
      orderBy: { at: 'desc' },
    })

    expect(entry?.action).toBe('QUARANTINE')
    expect(entry?.actorUserId).toBe(wh.userId)
  })

  it('releases them again', async () => {
    await bulkSetBatchStatus(prisma, [wh.freshBatchId], BatchStatus.QUARANTINE, {}, actor())

    const result = await bulkSetBatchStatus(
      prisma,
      [wh.freshBatchId],
      BatchStatus.ACTIVE,
      {},
      actor(),
    )

    expect(result.done).toBe(1)
    const batch = await prisma.batch.findUnique({ where: { id: wh.freshBatchId } })
    expect(batch?.status).toBe(BatchStatus.ACTIVE)
  })
})
