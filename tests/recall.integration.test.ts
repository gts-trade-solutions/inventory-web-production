import { randomUUID } from 'node:crypto'
import { BatchStatus, MovementSource, SerialStatus } from '@prisma/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildRecallPack } from '@/lib/services/recall'
import { runNightlySweep, rebuildStockProjection } from '@/lib/services/maintenance'
import { recordMovement } from '@/lib/services/movements'
import { findProjectionDrift } from '@/lib/services/projection'
import { prisma, seedWarehouse, type Warehouse } from './helpers/warehouse'

/**
 * The recall pack and the nightly sweep.
 *
 * The exit criterion for this phase is that the business can answer a recall
 * question without a developer. What makes that true is not that the pack
 * exists but that it is HONEST: one that quietly omits the units it could not
 * account for is worse than none, because somebody signs it off believing the
 * batch is contained.
 */

let wh: Warehouse

beforeEach(async () => {
  wh = await seedWarehouse()
})

afterAll(async () => {
  await prisma.$disconnect()
})

const move = (action: Parameters<typeof recordMovement>[1]['action']) =>
  recordMovement(
    prisma,
    { id: randomUUID(), siteId: wh.siteId, action, source: MovementSource.WEB },
    { userId: wh.userId },
  )

describe('the recall pack', () => {
  beforeEach(async () => {
    await move({
      kind: 'RECEIVE',
      itemId: wh.adhesiveId,
      toLocationId: wh.locationA,
      quantity: 100,
      batchId: wh.freshBatchId,
    })
  })

  it('says where the batch is now', async () => {
    await move({
      kind: 'MOVE',
      itemId: wh.adhesiveId,
      fromLocationId: wh.locationA,
      toLocationId: wh.locationB,
      quantity: 30,
      batchId: wh.freshBatchId,
    })

    const pack = await buildRecallPack(prisma, wh.freshBatchId)

    expect(pack.onHand).toBe(100)
    expect(pack.locations.map((location) => location.code).sort()).toEqual(['A-01', 'B-01'])
  })

  it('lists every movement it has been part of', async () => {
    await move({
      kind: 'ISSUE',
      itemId: wh.adhesiveId,
      fromLocationId: wh.locationA,
      quantity: 10,
      batchId: wh.freshBatchId,
    })

    const pack = await buildRecallPack(prisma, wh.freshBatchId)

    expect(pack.movements).toHaveLength(2)
    expect(pack.movements.map((movement) => movement.type).sort()).toEqual(['ISSUE', 'RECEIVE'])
  })

  it('balances the ledger against what is on the shelf', async () => {
    await move({
      kind: 'ISSUE',
      itemId: wh.adhesiveId,
      fromLocationId: wh.locationA,
      quantity: 40,
      batchId: wh.freshBatchId,
    })

    const pack = await buildRecallPack(prisma, wh.freshBatchId)

    expect(pack.reconciliation).toMatchObject({
      received: 100,
      issued: 40,
      expectedOnHand: 60,
      actualOnHand: 60,
      balanced: true,
    })
  })

  it('does not count a MOVE as a change in quantity', async () => {
    // Moving stock changes where it is, not how much there is. Counting it
    // would make every moved batch look unbalanced.
    await move({
      kind: 'MOVE',
      itemId: wh.adhesiveId,
      fromLocationId: wh.locationA,
      toLocationId: wh.locationB,
      quantity: 50,
      batchId: wh.freshBatchId,
    })

    const pack = await buildRecallPack(prisma, wh.freshBatchId)

    expect(pack.reconciliation.balanced).toBe(true)
  })

  it('says so, in the pack, when the arithmetic does not close', async () => {
    // Somebody signing this off has to see that it does not add up. Planting
    // the discrepancy directly is the only way to produce one, and is exactly
    // what the real system never does.
    await prisma.$executeRaw`
      UPDATE stock_levels SET quantity = quantity - 7
      WHERE itemId = ${wh.adhesiveId} AND batchId = ${wh.freshBatchId}
    `

    const pack = await buildRecallPack(prisma, wh.freshBatchId)

    expect(pack.reconciliation.balanced).toBe(false)
    const warning = pack.lines.find((line) => line.reference === 'RECONCILIATION')
    expect(warning?.detail).toMatch(/Investigate before relying on this pack/)
  })

  it('names the units that have left stock', async () => {
    // These are the rows somebody has to make phone calls about.
    const unit = await prisma.serialUnit.create({
      data: {
        id: randomUUID(),
        itemId: wh.adhesiveId,
        serialNo: 'SN-GONE',
        batchId: wh.freshBatchId,
        status: SerialStatus.ISSUED,
      },
    })

    const pack = await buildRecallPack(prisma, wh.freshBatchId)

    expect(pack.issued.map((row) => row.id)).toContain(unit.id)
    const line = pack.lines.find((row) => row.reference === 'SN-GONE')
    expect(line?.section).toBe('UNACCOUNTED')
    expect(line?.detail).toMatch(/no longer in stock/)
  })

  it('flattens to one sheet somebody can send on', async () => {
    const pack = await buildRecallPack(prisma, wh.freshBatchId)

    expect(pack.lines.length).toBeGreaterThan(0)
    expect(new Set(pack.lines.map((line) => line.section))).toContain('MOVEMENT')
  })

  it('refuses a batch that does not exist', async () => {
    await expect(buildRecallPack(prisma, randomUUID())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })
})

describe('the nightly sweep', () => {
  it('reports a clean system as clean', async () => {
    await move({ kind: 'RECEIVE', itemId: wh.tapeId, toLocationId: wh.locationA, quantity: 10 })

    const result = await runNightlySweep(prisma, 'DEMO')

    expect(result.drift.rows).toBe(0)
  })

  it('finds drift the ledger cannot explain', async () => {
    // Until this existed, the only thing that ever checked was a test — on a
    // throwaway database, never on the one the business runs on.
    await move({ kind: 'RECEIVE', itemId: wh.tapeId, toLocationId: wh.locationA, quantity: 10 })
    await prisma.$executeRaw`
      UPDATE stock_levels SET quantity = 999 WHERE itemId = ${wh.tapeId}
    `

    const result = await runNightlySweep(prisma, 'DEMO')

    expect(result.drift.rows).toBeGreaterThan(0)
    expect(result.drift.examples[0]).toMatchObject({ projected: 999 })
  })

  it('reports drift rather than repairing it', async () => {
    // A rebuild that runs unattended erases the evidence of whatever caused the
    // drift, which is the part worth investigating.
    await move({ kind: 'RECEIVE', itemId: wh.tapeId, toLocationId: wh.locationA, quantity: 10 })
    await prisma.$executeRaw`
      UPDATE stock_levels SET quantity = 999 WHERE itemId = ${wh.tapeId}
    `

    await runNightlySweep(prisma, 'DEMO')

    const still = await prisma.stockLevel.findFirstOrThrow({ where: { itemId: wh.tapeId } })
    expect(still.quantity).toBe(999)
  })

  it('marks a batch whose date has passed', async () => {
    await prisma.batch.update({
      where: { id: wh.soonBatchId },
      data: { expiryDate: new Date('2020-01-01'), status: BatchStatus.ACTIVE },
    })

    const result = await runNightlySweep(prisma, 'DEMO')

    expect(result.expiry.markedExpired).toBeGreaterThan(0)
    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: wh.soonBatchId } })
    expect(batch.status).toBe(BatchStatus.EXPIRED)
  })

  it('leaves a batch expiring today alone', async () => {
    // Whole days, matching the domain: a batch expiring today is usable today.
    // Anything narrower makes expiry depend on when the sweep happened to run.
    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)
    await prisma.batch.update({
      where: { id: wh.soonBatchId },
      data: { expiryDate: today, status: BatchStatus.ACTIVE },
    })

    await runNightlySweep(prisma, 'DEMO')

    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: wh.soonBatchId } })
    expect(batch.status).toBe(BatchStatus.ACTIVE)
  })

  it('records that it ran, even when it found nothing', async () => {
    // "Was this checked?" is answered by the entry being there.
    await prisma.auditLog.deleteMany()

    await runNightlySweep(prisma, 'DEMO')

    const entry = await prisma.auditLog.findFirstOrThrow({ where: { entity: 'NightlySweep' } })
    expect(entry.after).toMatchObject({ driftRows: 0 })
  })

  it('is safe to run twice', async () => {
    await runNightlySweep(prisma, 'DEMO')
    await expect(runNightlySweep(prisma, 'DEMO')).resolves.toMatchObject({
      expiry: { markedExpired: 0 },
    })
  })
})

describe('the manual rebuild', () => {
  it('repairs drift and records what it found', async () => {
    await move({ kind: 'RECEIVE', itemId: wh.tapeId, toLocationId: wh.locationA, quantity: 10 })
    await prisma.$executeRaw`
      UPDATE stock_levels SET quantity = 999 WHERE itemId = ${wh.tapeId}
    `

    const result = await rebuildStockProjection(prisma, { userId: wh.userId })

    expect(result.driftBefore).toBeGreaterThan(0)
    expect(await findProjectionDrift(prisma)).toEqual([])

    const entry = await prisma.auditLog.findFirstOrThrow({ where: { entity: 'StockProjection' } })
    expect(entry.actorUserId).toBe(wh.userId)
  })
})
