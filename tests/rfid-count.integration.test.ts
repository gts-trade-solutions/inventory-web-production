import { randomUUID } from 'node:crypto'
import { DeviceConnection, DeviceKind, MovementSource, SerialStatus } from '@prisma/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sweepLocation } from '@/lib/services/rfid-count'
import { approveCount, startCount, submitCount } from '@/lib/services/counts'
import { recordMovement } from '@/lib/services/movements'
import { findProjectionDrift } from '@/lib/services/projection'
import { fromGtin13 } from '@/lib/domain/sgtin96'
import { ean13 } from '@/lib/domain/gtin'
import { onHand, prisma, seedWarehouse, type Warehouse } from './helpers/warehouse'

/**
 * The flagship workflow, end to end: sweep a bay with a reader, see the
 * variance, have a supervisor approve it, and find the ledger corrected.
 *
 * The point of doing it per tag rather than per quantity is that the variance
 * names units — "these two are missing" rather than "we are two short"
 * (ARCHITECTURE §5.4).
 */

let wh: Warehouse
let epcs: string[]
let sessionId: string

const GTIN = ean13('890123400004')

/**
 * A FIXED session id, so the first sweep is reproducible.
 *
 * The service seeds the first sweep of a session from its id precisely so a
 * demo can be rehearsed. Using a random id here would make these assertions
 * roll dice: at a 0.92 read rate, roughly one sweep in five finds all twenty
 * and there is no variance to assert on.
 */
const SESSION_ID = '5f2e1c44-9a7b-4d1e-8c30-7b1d9e4a2c61'

/** The test database is neither LIVE nor DEMO, so the tests say which they mean. */
const MODE = 'DEMO' as const

beforeEach(async () => {
  wh = await seedWarehouse()
  await prisma.device.deleteMany()

  await prisma.device.create({
    data: {
      id: randomUUID(),
      label: 'Aisle A reader',
      kind: DeviceKind.RFID_READER,
      connection: DeviceConnection.SIMULATED,
      siteId: wh.siteId,
    },
  })

  // Twenty tagged drills, each with a real SGTIN-96.
  epcs = []
  const unitIds: string[] = []
  for (let i = 1; i <= 20; i++) {
    const epc = fromGtin13(GTIN, i)
    epcs.push(epc)
    const unit = await prisma.serialUnit.create({
      data: {
        id: randomUUID(),
        itemId: wh.drillId,
        serialNo: `SN-${String(i).padStart(4, '0')}`,
        epc,
        status: SerialStatus.IN_STOCK,
      },
    })
    unitIds.push(unit.id)
  }

  // Received onto the shelf through the ledger, NOT by writing stock_levels.
  // Planting the projection directly creates rows the ledger cannot explain —
  // which is exactly the corruption findProjectionDrift() exists to catch, and
  // it duly caught it when I first wrote this fixture that way.
  await recordMovement(
    prisma,
    {
      id: randomUUID(),
      siteId: wh.siteId,
      action: {
        kind: 'RECEIVE',
        itemId: wh.drillId,
        toLocationId: wh.locationA,
        quantity: 20,
        serialUnitIds: unitIds,
      },
      source: MovementSource.WEB,
    },
    { userId: wh.userId },
  )

  const session = await startCount(
    prisma,
    { id: SESSION_ID, siteId: wh.siteId, locationId: wh.locationA, method: 'RFID' },
    { userId: wh.userId },
  )
  sessionId = session.sessionId
})

afterAll(async () => {
  await prisma.$disconnect()
})

describe('sweeping a bay', () => {
  it('reads tags from the units actually on the shelf', async () => {
    const result = await sweepLocation(prisma, sessionId, { mode: MODE })

    expect(result.simulated).toBe(true)
    expect(result.distinctTags).toBeGreaterThan(0)
    // Every tag it reports must be one we actually put there — a simulator
    // inventing EPCs would make the whole demo meaningless.
    const tags = await prisma.countTag.findMany({ where: { sessionId }, select: { epc: true } })
    for (const tag of tags) expect(epcs).toContain(tag.epc)
  })

  it('finds a realistic shortfall rather than a perfect count', async () => {
    // A reader that returns everything every time teaches operators that an
    // exact count is normal, so a real one coming back short looks broken.
    const result = await sweepLocation(prisma, sessionId, { mode: MODE })

    const counted = result.counted.find((line) => line.itemId === wh.drillId)
    expect(counted!.quantity).toBeLessThan(20)
    expect(counted!.quantity).toBeGreaterThan(14)
  })

  it('resolves tags to items, with names the sheet can display', async () => {
    const result = await sweepLocation(prisma, sessionId, { mode: MODE })
    const line = result.counted.find((candidate) => candidate.itemId === wh.drillId)

    expect(line?.itemSku).toBe('TLS-0015')
    expect(line?.itemName).toBe('Cordless drill')
  })

  it('does not double-count a second sweep', async () => {
    // Tags are de-duplicated per session, so what comes back is everything the
    // count has read — not just this sweep. A client that added would double.
    const first = await sweepLocation(prisma, sessionId, { mode: MODE })
    const second = await sweepLocation(prisma, sessionId, { mode: MODE })

    const firstCount = first.counted.find((l) => l.itemId === wh.drillId)!.quantity
    const secondCount = second.counted.find((l) => l.itemId === wh.drillId)!.quantity

    expect(secondCount).toBeGreaterThanOrEqual(firstCount)
    expect(secondCount).toBeLessThanOrEqual(20)
  })

  it('picks up more on a second sweep, the way a real reader does', async () => {
    // Sweeping again genuinely finds tags the first pass missed. If it did not,
    // "sweep again" would be a button that does nothing.
    const first = await sweepLocation(prisma, sessionId, { mode: MODE })

    let total = first.counted.find((l) => l.itemId === wh.drillId)!.quantity
    for (let i = 0; i < 5 && total < 20; i++) {
      const next = await sweepLocation(prisma, sessionId, { mode: MODE })
      total = next.counted.find((l) => l.itemId === wh.drillId)!.quantity
    }

    expect(total).toBeGreaterThan(first.counted.find((l) => l.itemId === wh.drillId)!.quantity)
  })

  it('reports duplicates rather than treating a re-sweep as an error', async () => {
    await sweepLocation(prisma, sessionId, { mode: MODE })
    const second = await sweepLocation(prisma, sessionId, { mode: MODE })

    expect(second.duplicates).toBeGreaterThan(0)
  })

  it('picks up strays from neighbouring bays', async () => {
    // A stray is a real finding in the other direction: stock that is not where
    // the system thinks it is.
    const strayEpc = fromGtin13(GTIN, 900)
    await prisma.serialUnit.create({
      data: {
        id: randomUUID(),
        itemId: wh.tapeId,
        serialNo: 'SN-STRAY',
        epc: strayEpc,
        locationId: wh.locationB,
        status: SerialStatus.IN_STOCK,
      },
    })

    let sawStray = false
    for (let i = 0; i < 25 && !sawStray; i++) {
      const result = await sweepLocation(prisma, sessionId, { mode: MODE })
      sawStray = result.counted.some((line) => line.itemId === wh.tapeId)
    }

    expect(sawStray).toBe(true)
  })

  it('says plainly when it sees nothing', async () => {
    // Genuinely nothing anywhere. A bay that is merely empty still overhears
    // neighbouring stock, which is realistic — and is itself why this test has
    // to clear the whole site rather than just count an empty bay.
    await prisma.countTag.deleteMany()
    await prisma.serialUnit.updateMany({ data: { epc: null } })

    const empty = await startCount(
      prisma,
      { id: randomUUID(), siteId: wh.siteId, locationId: wh.locationB, method: 'RFID' },
      { userId: wh.userId },
    )

    const result = await sweepLocation(prisma, empty.sessionId, { mode: MODE })

    expect(result.distinctTags).toBe(0)
    // Tells the operator what to check, rather than just reporting zero.
    expect(result.message).toMatch(/RFID labels|antenna/i)
  })
})

describe('refusals', () => {
  it('will not sweep a count that is already submitted', async () => {
    await submitCount(prisma, sessionId, [])

    await expect(sweepLocation(prisma, sessionId, { mode: MODE })).rejects.toMatchObject({
      code: 'SESSION_ALREADY_SUBMITTED',
    })
  })

  it('says so when no reader is set up', async () => {
    await prisma.device.deleteMany({ where: { kind: DeviceKind.RFID_READER } })

    await expect(sweepLocation(prisma, sessionId, { mode: MODE })).rejects.toThrow(/No RFID reader/)
  })

  it('will not use a retired reader', async () => {
    const reader = await prisma.device.findFirstOrThrow({
      where: { kind: DeviceKind.RFID_READER },
    })
    await prisma.device.update({ where: { id: reader.id }, data: { active: false } })

    await expect(sweepLocation(prisma, sessionId, { deviceId: reader.id, mode: MODE })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    })
  })

  it('refuses an unknown session', async () => {
    await expect(sweepLocation(prisma, randomUUID(), { mode: MODE })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('the whole loop', () => {
  it('sweeps, submits a variance, and posts it on approval', async () => {
    const sweep = await sweepLocation(prisma, sessionId, { mode: MODE })
    const found = sweep.counted.find((line) => line.itemId === wh.drillId)!.quantity

    // Submitting writes nothing to the ledger (WADR-008).
    const submitted = await submitCount(prisma, sessionId, sweep.counted)
    expect(submitted.summary.netUnits).toBe(found - 20)
    expect(await onHand(wh.drillId, wh.locationA)).toBe(20)

    const approved = await approveCount(prisma, sessionId, { userId: wh.userId })

    expect(approved.postings).toBe(1)
    expect(await onHand(wh.drillId, wh.locationA)).toBe(found)
  })

  it('records the correction as a COUNT movement, not an adjustment', async () => {
    const sweep = await sweepLocation(prisma, sessionId, { mode: MODE })
    await submitCount(prisma, sessionId, sweep.counted)
    await approveCount(prisma, sessionId, { userId: wh.userId })

    const movement = await prisma.movement.findFirstOrThrow({
      where: { countSessionId: sessionId },
    })

    expect(movement.type).toBe('COUNT')
    expect(movement.docNo).toMatch(/^CNT-/)
  })

  it('leaves the projection matching the ledger afterwards', async () => {
    const sweep = await sweepLocation(prisma, sessionId, { mode: MODE })
    await submitCount(prisma, sessionId, sweep.counted)
    await approveCount(prisma, sessionId, { userId: wh.userId })

    expect(await findProjectionDrift(prisma)).toEqual([])
  })
})
