import { randomUUID } from 'node:crypto'
import { MovementSource, SerialStatus } from '@prisma/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { recordMovement, type RecordOutcome } from '@/lib/services/movements'
import { findProjectionDrift, rebuildProjections } from '@/lib/services/projection'
import type { StockAction } from '@/lib/domain/movement'
import {
  ledgerCount,
  onHand,
  prisma,
  seedSerialUnits,
  seedWarehouse,
  type Warehouse,
} from './helpers/warehouse'

/**
 * The ledger under concurrency.
 *
 * This is the suite the whole design exists for. The numbering service already
 * proved that a plausible-looking implementation deadlocks the moment two
 * callers arrive together, and the write path takes far more locks than that
 * one did. Everything here runs real parallel transactions against real MySQL.
 */

let wh: Warehouse

beforeEach(async () => {
  wh = await seedWarehouse()
})

afterAll(async () => {
  await prisma.$disconnect()
})

const record = (
  action: StockAction,
  options: Parameters<typeof recordMovement>[3] = {},
  id?: string,
) =>
  recordMovement(
    prisma,
    { id, siteId: wh.siteId, action, source: MovementSource.WEB },
    { userId: wh.userId },
    options,
  )

const receive = (itemId: string, locationId: string, quantity: number, batchId?: string) =>
  record({ kind: 'RECEIVE', itemId, toLocationId: locationId, quantity, batchId })

const statusesOf = (outcomes: RecordOutcome[]) => outcomes.map((o) => o.status)

describe('the write path', () => {
  it('records a receipt and raises the projection', async () => {
    const outcome = await receive(wh.tapeId, wh.locationA, 24)

    expect(outcome.status).toBe('RECORDED')
    if (outcome.status === 'RECORDED') expect(outcome.docNo).toMatch(/^RCV-\d{4}-\d{6}$/)
    expect(await onHand(wh.tapeId, wh.locationA)).toBe(24)
  })

  it('lowers the projection on issue', async () => {
    await receive(wh.tapeId, wh.locationA, 24)
    await record({ kind: 'ISSUE', itemId: wh.tapeId, fromLocationId: wh.locationA, quantity: 10 })

    expect(await onHand(wh.tapeId, wh.locationA)).toBe(14)
  })

  it('moves stock between locations in one transaction', async () => {
    await receive(wh.tapeId, wh.locationA, 20)
    await record({
      kind: 'MOVE',
      itemId: wh.tapeId,
      fromLocationId: wh.locationA,
      toLocationId: wh.locationB,
      quantity: 8,
    })

    expect(await onHand(wh.tapeId, wh.locationA)).toBe(12)
    expect(await onHand(wh.tapeId, wh.locationB)).toBe(8)
  })

  it('rejects an over-issue and writes nothing', async () => {
    await receive(wh.tapeId, wh.locationA, 5)

    const outcome = await record({
      kind: 'ISSUE',
      itemId: wh.tapeId,
      fromLocationId: wh.locationA,
      quantity: 9,
    })

    expect(outcome.status).toBe('REJECTED')
    if (outcome.status === 'REJECTED') expect(outcome.error.code).toBe('INSUFFICIENT_STOCK')
    expect(await onHand(wh.tapeId, wh.locationA)).toBe(5)
    expect(await ledgerCount(wh.tapeId)).toBe(1)
  })

  it('rolls back the document number when a movement is rejected', async () => {
    await receive(wh.tapeId, wh.locationA, 5)
    await record({ kind: 'ISSUE', itemId: wh.tapeId, fromLocationId: wh.locationA, quantity: 99 })

    // The rejected attempt must not have consumed ISS-0001.
    const outcome = await record({
      kind: 'ISSUE',
      itemId: wh.tapeId,
      fromLocationId: wh.locationA,
      quantity: 1,
    })

    expect(outcome.status).toBe('RECORDED')
    if (outcome.status === 'RECORDED') expect(outcome.docNo).toMatch(/-000001$/)
  })
})

describe('idempotency', () => {
  it('treats a repeated id as a duplicate and applies the change once', async () => {
    const id = randomUUID()

    const first = await record(
      { kind: 'RECEIVE', itemId: wh.tapeId, toLocationId: wh.locationA, quantity: 24 },
      {},
      id,
    )
    const second = await record(
      { kind: 'RECEIVE', itemId: wh.tapeId, toLocationId: wh.locationA, quantity: 24 },
      {},
      id,
    )

    expect(first.status).toBe('RECORDED')
    expect(second.status).toBe('DUPLICATE')
    expect(await onHand(wh.tapeId, wh.locationA)).toBe(24)
    expect(await ledgerCount(wh.tapeId)).toBe(1)
  })

  it('survives the same id pushed twice at once', async () => {
    // A phone retrying a sync push while the first attempt is still in flight.
    const id = randomUUID()
    const action: StockAction = {
      kind: 'RECEIVE',
      itemId: wh.tapeId,
      toLocationId: wh.locationA,
      quantity: 10,
    }

    const outcomes = await Promise.allSettled([record(action, {}, id), record(action, {}, id)])

    const settled = outcomes
      .filter((o): o is PromiseFulfilledResult<RecordOutcome> => o.status === 'fulfilled')
      .map((o) => o.value)

    // Whatever the interleaving, the stock moved exactly once.
    expect(await onHand(wh.tapeId, wh.locationA)).toBe(10)
    expect(await ledgerCount(wh.tapeId)).toBe(1)
    expect(settled.filter((o) => o.status === 'RECORDED')).toHaveLength(1)
  })
})

describe('concurrency', () => {
  it('never lets parallel issues take more than exists', async () => {
    // THE test. Ten operators, each issuing 10, against 50 on the shelf.
    // Without FOR UPDATE they all read "50 available" and all succeed.
    await receive(wh.tapeId, wh.locationA, 50)

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () =>
        record({ kind: 'ISSUE', itemId: wh.tapeId, fromLocationId: wh.locationA, quantity: 10 }),
      ),
    )

    const recorded = outcomes.filter((o) => o.status === 'RECORDED').length
    const rejected = outcomes.filter((o) => o.status === 'REJECTED').length

    expect(recorded).toBe(5)
    expect(rejected).toBe(5)
    expect(await onHand(wh.tapeId, wh.locationA)).toBe(0)
  })

  it('leaves the projection exact after many parallel receipts', async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => receive(wh.tapeId, wh.locationA, 3)),
    )

    expect(statusesOf(outcomes).every((s) => s === 'RECORDED')).toBe(true)
    // A lost update would show up as anything less than 60.
    expect(await onHand(wh.tapeId, wh.locationA)).toBe(60)
  })

  it('survives opposing moves between the same two locations', async () => {
    // A->B and B->A concurrently is the classic deadlock. Sorting the lock order
    // is what stops it; withDeadlockRetry catches whatever still collides.
    await receive(wh.tapeId, wh.locationA, 100)
    await receive(wh.tapeId, wh.locationB, 100)

    const moves = Array.from({ length: 12 }, (_, i) =>
      record({
        kind: 'MOVE',
        itemId: wh.tapeId,
        fromLocationId: i % 2 === 0 ? wh.locationA : wh.locationB,
        toLocationId: i % 2 === 0 ? wh.locationB : wh.locationA,
        quantity: 5,
      }),
    )

    const outcomes = await Promise.all(moves)

    expect(outcomes.every((o) => o.status === 'RECORDED')).toBe(true)
    // Stock only moved sideways, so the total is unchanged.
    expect((await onHand(wh.tapeId, wh.locationA)) + (await onHand(wh.tapeId, wh.locationB))).toBe(
      200,
    )
  })

  it('keeps batches independent under concurrent issues', async () => {
    await receive(wh.adhesiveId, wh.locationA, 20, wh.freshBatchId)
    await receive(wh.adhesiveId, wh.locationA, 20, wh.soonBatchId)

    const outcomes = await Promise.all([
      ...Array.from({ length: 5 }, () =>
        record({
          kind: 'ISSUE',
          itemId: wh.adhesiveId,
          fromLocationId: wh.locationA,
          quantity: 4,
          batchId: wh.freshBatchId,
        }),
      ),
      ...Array.from({ length: 5 }, () =>
        record({
          kind: 'ISSUE',
          itemId: wh.adhesiveId,
          fromLocationId: wh.locationA,
          quantity: 4,
          batchId: wh.soonBatchId,
        }),
      ),
    ])

    expect(outcomes.every((o) => o.status === 'RECORDED')).toBe(true)

    const levels = await prisma.stockLevel.findMany({
      where: { itemId: wh.adhesiveId, locationId: wh.locationA },
    })
    expect(levels.every((level) => level.quantity === 0)).toBe(true)
  })
})

describe('serial conflicts', () => {
  it('lets only one of two concurrent issues take the same physical unit', async () => {
    // Two devices claiming the same drill. Arithmetic cannot reconcile this —
    // one of the operators is wrong about what they are holding (WADR-020).
    const [unitId] = await seedSerialUnits(wh.drillId, wh.locationA, 1)
    await prisma.$executeRaw`
      INSERT INTO stock_levels (itemId, locationId, batchId, quantity, updatedAt)
      VALUES (${wh.drillId}, ${wh.locationA}, '00000000-0000-0000-0000-000000000000', 1, NOW(6))
    `

    const issue = () =>
      record({
        kind: 'ISSUE',
        itemId: wh.drillId,
        fromLocationId: wh.locationA,
        quantity: 1,
        serialUnitIds: [unitId!],
      })

    const outcomes = await Promise.all([issue(), issue()])

    expect(outcomes.filter((o) => o.status === 'RECORDED')).toHaveLength(1)
    expect(outcomes.filter((o) => o.status === 'REJECTED')).toHaveLength(1)

    const unit = await prisma.serialUnit.findUniqueOrThrow({ where: { id: unitId! } })
    expect(unit.status).toBe(SerialStatus.ISSUED)
    expect(unit.locationId).toBeNull()
  })

  it('moves named units and updates where they are', async () => {
    const units = await seedSerialUnits(wh.drillId, wh.locationA, 3)
    await prisma.$executeRaw`
      INSERT INTO stock_levels (itemId, locationId, batchId, quantity, updatedAt)
      VALUES (${wh.drillId}, ${wh.locationA}, '00000000-0000-0000-0000-000000000000', 3, NOW(6))
    `

    const outcome = await record({
      kind: 'MOVE',
      itemId: wh.drillId,
      fromLocationId: wh.locationA,
      toLocationId: wh.locationB,
      quantity: 2,
      serialUnitIds: [units[0]!, units[1]!],
    })

    expect(outcome.status).toBe('RECORDED')

    const moved = await prisma.serialUnit.findMany({ where: { locationId: wh.locationB } })
    expect(moved).toHaveLength(2)
    expect(await onHand(wh.drillId, wh.locationB)).toBe(2)
  })
})

describe('offline pushes that go negative', () => {
  it('accepts and flags rather than rejecting', async () => {
    // Two devices both issued the last units in a dead zone. Rejecting the
    // second would discard work an operator physically did (WADR-007).
    await receive(wh.tapeId, wh.locationA, 2)

    const outcome = await record(
      { kind: 'ISSUE', itemId: wh.tapeId, fromLocationId: wh.locationA, quantity: 5 },
      { acceptNegative: true },
    )

    expect(outcome.status).toBe('FLAGGED')
    if (outcome.status === 'FLAGGED') {
      expect(outcome.reason).toBe('NEGATIVE_STOCK')
      expect(outcome.details).toMatchObject({ resultingQuantity: -3 })
    }
    expect(await onHand(wh.tapeId, wh.locationA)).toBe(-3)
  })

  it('still rejects errors that acceptance cannot fix', async () => {
    // A missing location is not made correct by accepting it.
    const outcome = await record(
      { kind: 'ISSUE', itemId: wh.tapeId, fromLocationId: randomUUID(), quantity: 1 },
      { acceptNegative: true },
    )

    expect(outcome.status).toBe('REJECTED')
    if (outcome.status === 'REJECTED') expect(outcome.error.code).toBe('UNKNOWN_LOCATION')
  })
})

describe('projection integrity', () => {
  it('matches the ledger after a randomised workload', async () => {
    // The property that matters: whatever sequence of operations ran, every
    // stock number is still explained by the movements behind it.
    await receive(wh.tapeId, wh.locationA, 500)
    await receive(wh.adhesiveId, wh.locationA, 200, wh.freshBatchId)

    const operations: Array<() => Promise<RecordOutcome>> = []
    for (let i = 0; i < 40; i++) {
      const roll = i % 4
      if (roll === 0) operations.push(() => receive(wh.tapeId, wh.locationA, 7))
      else if (roll === 1)
        operations.push(() =>
          record({ kind: 'ISSUE', itemId: wh.tapeId, fromLocationId: wh.locationA, quantity: 3 }),
        )
      else if (roll === 2)
        operations.push(() =>
          record({
            kind: 'MOVE',
            itemId: wh.tapeId,
            fromLocationId: wh.locationA,
            toLocationId: wh.locationB,
            quantity: 2,
          }),
        )
      else
        operations.push(() =>
          record({
            kind: 'ISSUE',
            itemId: wh.adhesiveId,
            fromLocationId: wh.locationA,
            quantity: 1,
            batchId: wh.freshBatchId,
          }),
        )
    }

    await Promise.all(operations.map((run) => run()))

    expect(await findProjectionDrift(prisma)).toEqual([])
  })

  it('rebuilds to exactly what the incremental writes produced', async () => {
    await receive(wh.tapeId, wh.locationA, 100)
    await record({ kind: 'ISSUE', itemId: wh.tapeId, fromLocationId: wh.locationA, quantity: 30 })
    await record({
      kind: 'MOVE',
      itemId: wh.tapeId,
      fromLocationId: wh.locationA,
      toLocationId: wh.locationB,
      quantity: 20,
    })
    await receive(wh.adhesiveId, wh.locationB, 15, wh.soonBatchId)

    const before = await prisma.stockLevel.findMany({
      orderBy: [{ itemId: 'asc' }, { locationId: 'asc' }],
    })
    await rebuildProjections(prisma)
    const after = await prisma.stockLevel.findMany({
      orderBy: [{ itemId: 'asc' }, { locationId: 'asc' }],
    })

    expect(
      after.map(({ itemId, locationId, batchId, quantity }) => ({
        itemId,
        locationId,
        batchId,
        quantity,
      })),
    ).toEqual(
      before.map(({ itemId, locationId, batchId, quantity }) => ({
        itemId,
        locationId,
        batchId,
        quantity,
      })),
    )
  })

  it('detects drift introduced behind the ledger’s back', async () => {
    // Someone edits stock_levels directly. The nightly job has to notice.
    await receive(wh.tapeId, wh.locationA, 10)
    await prisma.$executeRaw`
      UPDATE stock_levels SET quantity = 999 WHERE itemId = ${wh.tapeId}
    `

    const drift = await findProjectionDrift(prisma)

    expect(drift).toHaveLength(1)
    expect(drift[0]).toMatchObject({ projected: 999, fromLedger: 10 })

    await rebuildProjections(prisma)
    expect(await findProjectionDrift(prisma)).toEqual([])
  })

  it('drops a row that nets to zero rather than leaving a zero behind', async () => {
    await receive(wh.tapeId, wh.locationA, 10)
    await record({ kind: 'ISSUE', itemId: wh.tapeId, fromLocationId: wh.locationA, quantity: 10 })

    await rebuildProjections(prisma)

    expect(await prisma.stockLevel.findMany({ where: { itemId: wh.tapeId } })).toEqual([])
  })
})
