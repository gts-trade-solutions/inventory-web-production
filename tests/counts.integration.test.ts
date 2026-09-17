import { randomUUID } from 'node:crypto'
import { CountStatus, MovementSource, MovementType } from '@prisma/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  approveCount,
  recordTagReads,
  rejectCount,
  startCount,
  submitCount,
} from '@/lib/services/counts'
import { recordMovement } from '@/lib/services/movements'
import { findProjectionDrift } from '@/lib/services/projection'
import { fromGtin13 } from '@/lib/domain/sgtin96'
import { ean13 } from '@/lib/domain/gtin'
import type { StockAction } from '@/lib/domain/movement'
import { onHand, prisma, seedWarehouse, type Warehouse } from './helpers/warehouse'

/**
 * The count lifecycle: submit stores the variance, approval posts the ledger.
 *
 * The behaviour worth protecting here is that submitting changes NO stock
 * (WADR-008). The mobile MVP posts adjustments on submit, and every test below
 * that checks stock is unchanged after a submit is guarding against that
 * behaviour creeping back in.
 */

let wh: Warehouse

beforeEach(async () => {
  wh = await seedWarehouse()
})

afterAll(async () => {
  await prisma.$disconnect()
})

const actor = () => ({ userId: wh.userId })

const record = (action: StockAction) =>
  recordMovement(prisma, { siteId: wh.siteId, action, source: MovementSource.WEB }, actor())

const receive = (itemId: string, locationId: string, quantity: number, batchId?: string) =>
  record({ kind: 'RECEIVE', itemId, toLocationId: locationId, quantity, batchId })

const startAt = (locationId = wh.locationA) =>
  startCount(prisma, { siteId: wh.siteId, locationId }, actor())

describe('submitting a count', () => {
  it('stores the variance and changes no stock', async () => {
    await receive(wh.tapeId, wh.locationA, 10)
    const { sessionId } = await startAt()

    const result = await submitCount(prisma, sessionId, [
      { itemId: wh.tapeId, batchId: null, quantity: 8 },
    ])

    expect(result.status).toBe(CountStatus.SUBMITTED)
    expect(result.summary).toMatchObject({ short: 1, over: 0, netUnits: -2 })

    // The whole point: nothing has moved yet.
    expect(await onHand(wh.tapeId, wh.locationA)).toBe(10)
    expect(await prisma.movement.count({ where: { type: MovementType.COUNT } })).toBe(0)
  })

  it('reports items expected but not found, and strays not expected', async () => {
    await receive(wh.tapeId, wh.locationA, 10)
    const { sessionId } = await startAt()

    const result = await submitCount(prisma, sessionId, [
      { itemId: wh.adhesiveId, batchId: wh.freshBatchId, quantity: 3 },
    ])

    expect(result.lines).toHaveLength(2)
    expect(result.lines.find((l) => l.itemId === wh.tapeId)).toMatchObject({
      expected: 10,
      counted: 0,
    })
    expect(result.lines.find((l) => l.itemId === wh.adhesiveId)).toMatchObject({
      expected: 0,
      counted: 3,
    })
  })

  it('reconciles per batch, so the right total in the wrong batch is still a variance', async () => {
    await receive(wh.adhesiveId, wh.locationA, 10, wh.freshBatchId)
    const { sessionId } = await startAt()

    const result = await submitCount(prisma, sessionId, [
      { itemId: wh.adhesiveId, batchId: wh.soonBatchId, quantity: 10 },
    ])

    expect(result.summary.netUnits).toBe(0)
    // Net zero is not accurate: one batch is 10 short and another 10 over.
    expect(result.summary.short + result.summary.over).toBe(2)
  })

  it('refuses a second submission of the same session', async () => {
    const { sessionId } = await startAt()
    await submitCount(prisma, sessionId, [])

    await expect(submitCount(prisma, sessionId, [])).rejects.toMatchObject({
      code: 'SESSION_ALREADY_SUBMITTED',
    })
  })
})

describe('approving a count', () => {
  it('posts one COUNT movement per variance and corrects the stock', async () => {
    await receive(wh.tapeId, wh.locationA, 10)
    const { sessionId } = await startAt()
    await submitCount(prisma, sessionId, [{ itemId: wh.tapeId, batchId: null, quantity: 8 }])

    const result = await approveCount(prisma, sessionId, actor())

    expect(result.status).toBe(CountStatus.APPROVED)
    expect(result.postings).toBe(1)
    expect(await onHand(wh.tapeId, wh.locationA)).toBe(8)
  })

  it('ties every posting back to its session and document number', async () => {
    await receive(wh.tapeId, wh.locationA, 10)
    const { sessionId, docNo } = await startAt()
    await submitCount(prisma, sessionId, [{ itemId: wh.tapeId, batchId: null, quantity: 4 }])
    await approveCount(prisma, sessionId, actor())

    const posted = await prisma.movement.findFirstOrThrow({ where: { countSessionId: sessionId } })

    expect(posted.quantity).toBe(6)
    expect(posted.fromLocationId).toBe(wh.locationA)
    expect(posted.note).toContain(docNo)
    // A controlled reason code, not free text (WADR-022).
    expect(posted.reasonCodeId).not.toBeNull()
  })

  it('records postings as COUNT movements, not ADJUST', async () => {
    // A count correction has to be distinguishable from a typed adjustment: they
    // carry different weight in a stock-accuracy report, and only one is
    // evidence. This shipped as ADJUST until a browser run showed the ledger
    // filter for COUNT returning nothing after an approval.
    await receive(wh.tapeId, wh.locationA, 10)
    const { sessionId } = await startAt()
    await submitCount(prisma, sessionId, [{ itemId: wh.tapeId, batchId: null, quantity: 7 }])
    await approveCount(prisma, sessionId, actor())

    const posted = await prisma.movement.findFirstOrThrow({ where: { countSessionId: sessionId } })

    expect(posted.type).toBe(MovementType.COUNT)
    expect(await prisma.movement.count({ where: { type: MovementType.ADJUST } })).toBe(0)
  })

  it('posts nothing when the count matched', async () => {
    await receive(wh.tapeId, wh.locationA, 10)
    const { sessionId } = await startAt()
    await submitCount(prisma, sessionId, [{ itemId: wh.tapeId, batchId: null, quantity: 10 }])

    const result = await approveCount(prisma, sessionId, actor())

    expect(result.postings).toBe(0)
    expect(await onHand(wh.tapeId, wh.locationA)).toBe(10)
  })

  it('records a stray that was not expected at the location', async () => {
    const { sessionId } = await startAt()
    await submitCount(prisma, sessionId, [{ itemId: wh.tapeId, batchId: null, quantity: 4 }])

    await approveCount(prisma, sessionId, actor())

    expect(await onHand(wh.tapeId, wh.locationA)).toBe(4)
  })

  it('leaves the projection consistent with the ledger', async () => {
    await receive(wh.tapeId, wh.locationA, 100)
    await receive(wh.adhesiveId, wh.locationA, 50, wh.freshBatchId)
    const { sessionId } = await startAt()
    await submitCount(prisma, sessionId, [
      { itemId: wh.tapeId, batchId: null, quantity: 93 },
      { itemId: wh.adhesiveId, batchId: wh.freshBatchId, quantity: 55 },
    ])

    await approveCount(prisma, sessionId, actor())

    expect(await findProjectionDrift(prisma)).toEqual([])
  })

  it('records a count even where it drives stock negative', async () => {
    // A count is the authority on what is physically there. Refusing it because
    // the number would go negative would discard the only reliable evidence.
    await receive(wh.tapeId, wh.locationA, 5)
    await record({ kind: 'ISSUE', itemId: wh.tapeId, fromLocationId: wh.locationA, quantity: 5 })

    const { sessionId } = await startAt()
    await submitCount(prisma, sessionId, [{ itemId: wh.tapeId, batchId: null, quantity: 0 }])
    const result = await approveCount(prisma, sessionId, actor())

    expect(result.postings).toBe(0)
  })

  it('refuses to approve a count that was never submitted', async () => {
    const { sessionId } = await startAt()

    await expect(approveCount(prisma, sessionId, actor())).rejects.toMatchObject({
      code: 'CONFLICT',
    })
  })

  it('refuses to approve twice', async () => {
    await receive(wh.tapeId, wh.locationA, 10)
    const { sessionId } = await startAt()
    await submitCount(prisma, sessionId, [{ itemId: wh.tapeId, batchId: null, quantity: 9 }])
    await approveCount(prisma, sessionId, actor())

    await expect(approveCount(prisma, sessionId, actor())).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    // The correction applied exactly once.
    expect(await onHand(wh.tapeId, wh.locationA)).toBe(9)
  })

  it('writes an audit entry', async () => {
    await receive(wh.tapeId, wh.locationA, 10)
    const { sessionId } = await startAt()
    await submitCount(prisma, sessionId, [{ itemId: wh.tapeId, batchId: null, quantity: 8 }])
    await approveCount(prisma, sessionId, actor())

    const audit = await prisma.auditLog.findFirst({ where: { entityId: sessionId } })

    expect(audit).toMatchObject({ action: 'APPROVE', entity: 'CountSession' })
  })
})

describe('rejecting a count', () => {
  it('posts nothing and leaves stock alone', async () => {
    await receive(wh.tapeId, wh.locationA, 10)
    const { sessionId } = await startAt()
    await submitCount(prisma, sessionId, [{ itemId: wh.tapeId, batchId: null, quantity: 2 }])

    const result = await rejectCount(prisma, sessionId, actor(), 'Recount this aisle')

    expect(result.status).toBe(CountStatus.REJECTED)
    expect(await onHand(wh.tapeId, wh.locationA)).toBe(10)
    expect(await prisma.movement.count({ where: { countSessionId: sessionId } })).toBe(0)
  })

  it('cannot be approved afterwards', async () => {
    const { sessionId } = await startAt()
    await submitCount(prisma, sessionId, [])
    await rejectCount(prisma, sessionId, actor())

    await expect(approveCount(prisma, sessionId, actor())).rejects.toMatchObject({
      code: 'CONFLICT',
    })
  })
})

describe('RFID tag reads', () => {
  const epcFor = (serial: number) => fromGtin13(ean13('890123400015'), serial)

  async function seedTaggedUnits(count: number): Promise<string[]> {
    const epcs: string[] = []
    for (let i = 0; i < count; i++) {
      const epc = epcFor(1000 + i)
      await prisma.serialUnit.create({
        data: {
          id: randomUUID(),
          itemId: wh.drillId,
          serialNo: `SN-${1000 + i}`,
          epc,
          locationId: wh.locationA,
        },
      })
      epcs.push(epc)
    }
    return epcs
  }

  it('de-duplicates repeated reads of the same tag', async () => {
    // An RFID reader sees the same tag dozens of times per sweep. Counting each
    // read would multiply the stock by the dwell time.
    const [epc] = await seedTaggedUnits(1)
    const { sessionId } = await startAt()

    const first = await recordTagReads(prisma, sessionId, [
      { epc: epc!, rssi: -52 },
      { epc: epc!, rssi: -48 },
      { epc: epc!, rssi: -55 },
    ])

    expect(first.accepted).toBe(1)
    expect(first.duplicates).toBe(2)
  })

  it('stays de-duplicated across separate sweeps', async () => {
    const [epc] = await seedTaggedUnits(1)
    const { sessionId } = await startAt()

    await recordTagReads(prisma, sessionId, [{ epc: epc! }])
    const second = await recordTagReads(prisma, sessionId, [{ epc: epc! }])

    expect(second.accepted).toBe(0)
    expect(await prisma.countTag.count({ where: { sessionId } })).toBe(1)
  })

  it('reports an EPC that decodes but matches no unit on record', async () => {
    const { sessionId } = await startAt()

    const result = await recordTagReads(prisma, sessionId, [{ epc: epcFor(999_999) }])

    expect(result.unknownEpcs).toBe(1)
  })

  it('derives the counted quantity from the tags when none is given', async () => {
    const epcs = await seedTaggedUnits(3)
    await prisma.$executeRaw`
      INSERT INTO stock_levels (itemId, locationId, batchId, quantity, updatedAt)
      VALUES (${wh.drillId}, ${wh.locationA}, '00000000-0000-0000-0000-000000000000', 5, NOW(3))
    `
    const { sessionId } = await startAt()
    await recordTagReads(
      prisma,
      sessionId,
      epcs.map((epc) => ({ epc })),
    )

    const result = await submitCount(prisma, sessionId)

    // Five expected, three tags read: two units are missing, by name.
    expect(result.lines.find((line) => line.itemId === wh.drillId)).toMatchObject({
      expected: 5,
      counted: 3,
    })
  })

  it('refuses reads once the count is submitted', async () => {
    const { sessionId } = await startAt()
    await submitCount(prisma, sessionId, [])

    await expect(recordTagReads(prisma, sessionId, [{ epc: epcFor(1) }])).rejects.toMatchObject({
      code: 'SESSION_ALREADY_SUBMITTED',
    })
  })
})
