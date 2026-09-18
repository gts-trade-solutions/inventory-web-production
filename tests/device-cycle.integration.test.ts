import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { pull, push, type PushMovement, type PushResult } from '@/lib/services/sync'
import { findProjectionDrift } from '@/lib/services/projection'
import { onHand, prisma, seedSerialUnits, seedWarehouse, type Warehouse } from './helpers/warehouse'

/**
 * A whole shift, offline and then reconnected — plan item 4.11.
 *
 * The per-row tests prove each verdict in isolation. This proves the thing a
 * device actually does: work for hours with no signal, queue everything, and
 * push it as one batch. The failures that only appear at this scale are ordering
 * (row 30 depends on row 12), numbering under load, and one bad row poisoning
 * the batch — a phone that cannot sync because of a single malformed entry is a
 * phone that stops being used.
 */

let wh: Warehouse

beforeEach(async () => {
  wh = await seedWarehouse()
})

afterAll(async () => {
  await prisma.$disconnect()
})

const actor = () => ({ userId: wh.userId, deviceId: null })

/** Movements timestamped in sequence, the way a client's outbox orders them. */
function outbox(base: Date) {
  let tick = 0
  return (overrides: Partial<PushMovement> & { type: PushMovement['type'] }): PushMovement => ({
    id: randomUUID(),
    itemId: wh.tapeId,
    quantity: 1,
    siteId: wh.siteId,
    occurredAt: new Date(base.getTime() + tick++ * 60_000).toISOString(),
    ...overrides,
  })
}

/**
 * A realistic shift: receipts, put-aways, picks, a batch receipt and serial
 * moves — 50 rows, interdependent, in the order they physically happened.
 */
async function buildShift(): Promise<{
  movements: PushMovement[]
  units: string[]
  serialIssueIndex: number
}> {
  const at = outbox(new Date('2026-09-16T06:00:00.000Z'))
  const movements: PushMovement[] = []

  // The unit records exist; nothing has been received against them yet. They get
  // onto the shelf through the ledger below, like any other stock — planting
  // stock_levels directly would be testing against a state the system cannot
  // actually reach.
  const units = await seedSerialUnits(wh.drillId, wh.locationA, 2)

  // Goods in: ten receipts of untracked stock.
  for (let i = 0; i < 10; i++) {
    movements.push(at({ type: 'RECEIVE', toLocationId: wh.locationA, quantity: 12 }))
  }

  // Put-away: half of it crosses to the other aisle.
  for (let i = 0; i < 10; i++) {
    movements.push(
      at({ type: 'MOVE', fromLocationId: wh.locationA, toLocationId: wh.locationB, quantity: 6 }),
    )
  }

  // Batch-tracked receipts against both lots, then picks from them.
  for (let i = 0; i < 6; i++) {
    movements.push(
      at({
        type: 'RECEIVE',
        itemId: wh.adhesiveId,
        batchId: i % 2 === 0 ? wh.freshBatchId : wh.soonBatchId,
        toLocationId: wh.locationA,
        quantity: 20,
      }),
    )
  }
  for (let i = 0; i < 6; i++) {
    movements.push(
      at({
        type: 'ISSUE',
        itemId: wh.adhesiveId,
        batchId: wh.soonBatchId,
        fromLocationId: wh.locationA,
        quantity: 5,
      }),
    )
  }

  // Goods in for the serial-tracked item, each unit named on its own receipt.
  for (const unitId of units) {
    movements.push(
      at({
        type: 'RECEIVE',
        itemId: wh.drillId,
        toLocationId: wh.locationA,
        quantity: 1,
        serialUnitIds: [unitId],
      }),
    )
  }

  // Then moved between aisles, still named individually.
  for (const unitId of units) {
    movements.push(
      at({
        type: 'MOVE',
        itemId: wh.drillId,
        fromLocationId: wh.locationA,
        toLocationId: wh.locationB,
        quantity: 1,
        serialUnitIds: [unitId],
      }),
    )
  }

  // And one of them picked out of aisle B.
  const serialIssueIndex = movements.length
  movements.push(
    at({
      type: 'ISSUE',
      itemId: wh.drillId,
      fromLocationId: wh.locationB,
      quantity: 1,
      serialUnitIds: [units[0]!],
    }),
  )

  // Picks against what the receipts above put there.
  for (let i = 0; i < 7; i++) {
    movements.push(at({ type: 'ISSUE', fromLocationId: wh.locationA, quantity: 3 }))
  }

  // Scrap with a reason, and adjustments.
  for (let i = 0; i < 3; i++) {
    movements.push(
      at({
        type: 'SCRAP',
        fromLocationId: wh.locationB,
        quantity: 2,
        reasonCodeId: wh.reasonCodeId,
      }),
    )
  }
  for (let i = 0; i < 3; i++) {
    movements.push(
      at({
        type: 'ADJUST',
        toLocationId: wh.locationB,
        quantity: 55 + i,
        reasonCodeId: wh.reasonCodeId,
      }),
    )
  }

  return { movements, units, serialIssueIndex }
}

describe('a device reconnecting after a shift offline', () => {
  it('applies fifty queued movements and gives every one a verdict', async () => {
    const { movements } = await buildShift()
    expect(movements).toHaveLength(50)

    const { results } = await push(prisma, movements, actor())

    // Every row, exactly once, in the order sent. A dropped row is silent data
    // loss: the phone clears its outbox on a verdict it never received.
    expect(results).toHaveLength(50)
    expect(results.map((r) => r.id)).toEqual(movements.map((m) => m.id))
    expect(results.every((r) => accepted(r))).toBe(true)
  })

  it('leaves the projection exactly equal to the ledger', async () => {
    // The single strongest check in the suite. stock_levels is a projection of
    // an append-only ledger (WADR-002), so after fifty interdependent writes the
    // two must still agree to the unit. Any lost update shows up here.
    const { movements } = await buildShift()
    await push(prisma, movements, actor())

    expect(await findProjectionDrift(prisma)).toEqual([])
  })

  it('issues one unique document number per accepted row', async () => {
    const { movements } = await buildShift()
    const { results } = await push(prisma, movements, actor())

    const docNos = results.filter(accepted).map((r) => r.docNo)

    expect(new Set(docNos).size).toBe(docNos.length)
    expect(docNos.every((no) => /^[A-Z]{3}-\d{4}-\d{6}$/.test(no))).toBe(true)
  })

  it('arrives at the arithmetic the shift describes', async () => {
    const { movements } = await buildShift()
    await push(prisma, movements, actor())

    // Aisle A, untracked: 10 receipts of 12 = 120, less 10 put-aways of 6 = 60,
    // less 7 picks of 3 = 21. 120 - 60 - 21 = 39.
    expect(await onHand(wh.tapeId, wh.locationA)).toBe(39)

    // Aisle B: 60 in, 3 scraps of 2, then three adjustments — and an ADJUST sets
    // the count rather than adding to it, so the last one wins.
    expect(await onHand(wh.tapeId, wh.locationB)).toBe(57)

    // Batch-tracked: three receipts of 20 each lot, six picks of 5 from LOT-SOON.
    const fresh = await batchQuantity(wh.freshBatchId)
    const soon = await batchQuantity(wh.soonBatchId)
    expect(fresh).toBe(60)
    expect(soon).toBe(30)
  })

  it('does not let one impossible row poison the batch', async () => {
    // Two handsets in the same aisle, out of contact, both scanning the same
    // unit out. The second is physically impossible, so arithmetic cannot
    // reconcile it (WADR-020) — it must be refused on its own while the other
    // fifty still land.
    const { movements, units, serialIssueIndex } = await buildShift()

    const conflict: PushMovement = {
      ...movements[serialIssueIndex]!,
      id: randomUUID(),
      serialUnitIds: [units[0]!],
    }
    const withConflict = [
      ...movements.slice(0, serialIssueIndex + 1),
      conflict,
      ...movements.slice(serialIssueIndex + 1),
    ]

    const { results } = await push(prisma, withConflict, actor())

    expect(results).toHaveLength(51)
    const rejected = results.filter((r) => r.status === 'REJECTED')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.id).toBe(conflict.id)
    expect(results.filter(accepted)).toHaveLength(50)

    // And the ledger is still consistent after a mid-batch refusal.
    expect(await findProjectionDrift(prisma)).toEqual([])
  })

  it('flags rather than rejects work that drives stock negative', async () => {
    // WADR-007: somebody physically issued this. Refusing it discards the record
    // of real work and leaves the phone holding a row it can never clear.
    const at = outbox(new Date('2026-09-16T06:00:00.000Z'))
    const { results } = await push(
      prisma,
      [at({ type: 'ISSUE', fromLocationId: wh.locationA, quantity: 5 })],
      actor(),
    )

    expect(results[0]?.status).toBe('FLAGGED')
    expect(results[0]).toMatchObject({ reason: 'NEGATIVE_STOCK' })
  })

  it('is safe to replay the whole outbox', async () => {
    // A phone that loses the response resends. Every row must come back
    // DUPLICATE with its original document number, and nothing may move.
    const { movements } = await buildShift()
    const first = await push(prisma, movements, actor())

    const before = await onHand(wh.tapeId, wh.locationA)
    const replay = await push(prisma, movements, actor())

    expect(replay.results.every((r) => r.status === 'DUPLICATE')).toBe(true)
    expect(replay.results.map((r) => accepted(r) && r.docNo)).toEqual(
      first.results.map((r) => accepted(r) && r.docNo),
    )
    expect(await onHand(wh.tapeId, wh.locationA)).toBe(before)
    expect(await prisma.movement.count()).toBe(50)
  })

  it('hands the device a cursor that then returns nothing new', async () => {
    // Closing the loop: push, pull, and the client is up to date. If the cursor
    // came back behind the writes, the next pull replays work the phone already
    // has and stock appears to jump on the screen.
    const { movements } = await buildShift()
    await push(prisma, movements, actor())

    const first = await pull(prisma, {})
    expect(first.nextCursor).toBeTruthy()
    expect(first.stockLevels.length).toBeGreaterThan(0)

    const second = await pull(prisma, { since: first.nextCursor })
    expect(second.stockLevels).toHaveLength(0)
    expect(second.items).toHaveLength(0)
  })
})

function accepted(result: PushResult): result is Extract<PushResult, { docNo: string }> {
  return result.status === 'ACCEPTED' || result.status === 'DUPLICATE'
}

async function batchQuantity(batchId: string): Promise<number> {
  const rows = await prisma.stockLevel.findMany({ where: { batchId } })
  return rows.reduce((sum, row) => sum + row.quantity, 0)
}
