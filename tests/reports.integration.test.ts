import { randomUUID } from 'node:crypto'
import { MovementSource, MovementType } from '@prisma/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  countAccuracy,
  movementSummary,
  reorderReport,
  stockAgeing,
  stockOnHand,
} from '@/lib/services/reports'
import { recordMovement } from '@/lib/services/movements'
import { startCount, submitCount } from '@/lib/services/counts'
import { prisma, seedWarehouse, type Warehouse } from './helpers/warehouse'

/**
 * Operational reports (8.2).
 *
 * A report is believed. That is what makes a wrong one expensive: nobody
 * re-derives a number they were shown on a screen, so a figure that is quietly
 * off by a batch becomes the basis of a purchase order or a write-off.
 *
 * So these tests check the arithmetic against stock that was actually moved,
 * and they check the places where a plausible-looking number would be a lie:
 * netting to zero, stock that has gone negative, and stock whose age cannot be
 * known.
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

const receive = (itemId: string, locationId: string, quantity: number) =>
  move({ kind: 'RECEIVE', itemId, toLocationId: locationId, quantity })

const issue = (itemId: string, locationId: string, quantity: number) =>
  move({ kind: 'ISSUE', itemId, fromLocationId: locationId, quantity })

/**
 * An issue that drives stock negative, as an offline push does.
 *
 * A web issue with nothing on the shelf is rejected outright. Only a movement
 * arriving from a phone that was offline is accepted and flagged (WADR-007),
 * because the work physically happened and discarding it loses it — so that is
 * the only route by which a negative line reaches a report.
 */
const overIssue = (itemId: string, locationId: string, quantity: number) =>
  recordMovement(
    prisma,
    {
      id: randomUUID(),
      siteId: wh.siteId,
      action: { kind: 'ISSUE', itemId, fromLocationId: locationId, quantity },
      source: MovementSource.MOBILE,
    },
    { userId: wh.userId },
    { acceptNegative: true },
  )

const ALL_TIME = { from: new Date('2000-01-01'), to: new Date('2100-01-01') }

// ---------------------------------------------------------------------------

describe('stock on hand', () => {
  it('sums a single item across locations at item grain', async () => {
    await receive(wh.tapeId, wh.locationA, 7)
    await receive(wh.tapeId, wh.locationB, 8)

    const report = await stockOnHand(prisma, 'ITEM')
    const tape = report.rows.find((row) => row.itemId === wh.tapeId)

    expect(tape?.quantity).toBe(15)
    // One line, not two: that is what "by item" means.
    expect(report.rows.filter((row) => row.itemId === wh.tapeId)).toHaveLength(1)
  })

  it('keeps locations apart at location grain', async () => {
    await receive(wh.tapeId, wh.locationA, 7)
    await receive(wh.tapeId, wh.locationB, 8)

    const report = await stockOnHand(prisma, 'LOCATION')
    const lines = report.rows.filter((row) => row.itemId === wh.tapeId)

    expect(lines).toHaveLength(2)
    expect(lines.map((row) => row.quantity).sort((a, b) => a - b)).toEqual([7, 8])
  })

  it('leaves out lines that are empty', async () => {
    // The projection row survives at zero after the last unit leaves, and a
    // stock report padded with lines reading 0 stops being read.
    await receive(wh.tapeId, wh.locationA, 5)
    await issue(wh.tapeId, wh.locationA, 5)

    const report = await stockOnHand(prisma, 'LOCATION')

    expect(report.rows.find((row) => row.itemId === wh.tapeId)).toBeUndefined()
  })

  it('leaves out a grouped line that nets to zero', async () => {
    // Five in one place and five short in another is not "ten of something".
    await receive(wh.tapeId, wh.locationA, 5)
    await overIssue(wh.tapeId, wh.locationB, 5)

    const report = await stockOnHand(prisma, 'ITEM')

    expect(report.rows.find((row) => row.itemId === wh.tapeId)).toBeUndefined()
  })

  it('SHOWS negative stock rather than hiding it', async () => {
    // Stock goes negative when an offline over-issue syncs (WADR-007). That is
    // the one line in the whole report somebody needs to act on, so filtering
    // to "quantity > 0" would hide exactly the wrong thing.
    await overIssue(wh.tapeId, wh.locationA, 3)

    const report = await stockOnHand(prisma, 'LOCATION')
    const tape = report.rows.find((row) => row.itemId === wh.tapeId)

    expect(tape?.quantity).toBe(-3)
  })

  it('counts distinct items, not lines, in the totals', async () => {
    await receive(wh.tapeId, wh.locationA, 7)
    await receive(wh.tapeId, wh.locationB, 8)

    const report = await stockOnHand(prisma, 'LOCATION')

    expect(report.totals.lines).toBeGreaterThanOrEqual(2)
    expect(report.totals.items).toBeLessThan(report.totals.lines)
  })

  it('names the batch at batch grain', async () => {
    await move({
      kind: 'RECEIVE',
      itemId: wh.adhesiveId,
      toLocationId: wh.locationA,
      quantity: 4,
      batchId: wh.freshBatchId,
    })

    const report = await stockOnHand(prisma, 'BATCH')
    const line = report.rows.find((row) => row.itemId === wh.adhesiveId)

    expect(line?.batchNo).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------

describe('movement summary', () => {
  it('counts movements and quantities by type', async () => {
    await receive(wh.tapeId, wh.locationA, 10)
    await receive(wh.tapeId, wh.locationB, 5)
    await issue(wh.tapeId, wh.locationA, 4)

    const report = await movementSummary(prisma, ALL_TIME)
    const received = report.rows.find((row) => row.type === MovementType.RECEIVE)
    const issued = report.rows.find((row) => row.type === MovementType.ISSUE)

    expect(received?.movements).toBe(2)
    expect(received?.quantity).toBe(15)
    expect(issued?.movements).toBe(1)
    expect(issued?.quantity).toBe(4)
  })

  it('lists every type, including ones with nothing in the period', async () => {
    // "No scraps this month" is a finding. A missing row is ambiguous.
    await receive(wh.tapeId, wh.locationA, 1)

    const report = await movementSummary(prisma, ALL_TIME)

    expect(report.rows.map((row) => row.type)).toContain(MovementType.SCRAP)
    expect(report.rows.find((row) => row.type === MovementType.SCRAP)?.movements).toBe(0)
  })

  it('respects the date range', async () => {
    await receive(wh.tapeId, wh.locationA, 10)

    const past = { from: new Date('2000-01-01'), to: new Date('2000-12-31') }
    const report = await movementSummary(prisma, past)

    expect(report.totals.movements).toBe(0)
  })

  it('counts distinct items touched, not movement lines', async () => {
    await receive(wh.tapeId, wh.locationA, 1)
    await receive(wh.tapeId, wh.locationB, 1)

    const report = await movementSummary(prisma, ALL_TIME)
    const received = report.rows.find((row) => row.type === MovementType.RECEIVE)

    expect(received?.movements).toBe(2)
    expect(received?.items).toBe(1)
  })
})

// ---------------------------------------------------------------------------

describe('count accuracy', () => {
  it('scores a perfect count at 100%', async () => {
    await receive(wh.tapeId, wh.locationA, 10)

    const { sessionId } = await startCount(
      prisma,
      { siteId: wh.siteId, locationId: wh.locationA, method: 'MANUAL' },
      { userId: wh.userId },
    )
    await submitCount(prisma, sessionId, [{ itemId: wh.tapeId, batchId: null, quantity: 10 }])

    const report = await countAccuracy(prisma, ALL_TIME)

    expect(report.totals.accuracy).toBe(100)
    expect(report.totals.linesWithVariance).toBe(0)
  })

  it('scores a variance and reports the units out', async () => {
    await receive(wh.tapeId, wh.locationA, 10)

    const { sessionId } = await startCount(
      prisma,
      { siteId: wh.siteId, locationId: wh.locationA, method: 'MANUAL' },
      { userId: wh.userId },
    )
    await submitCount(prisma, sessionId, [{ itemId: wh.tapeId, batchId: null, quantity: 7 }])

    const report = await countAccuracy(prisma, ALL_TIME)
    const row = report.rows[0]

    expect(row?.linesWithVariance).toBe(1)
    expect(row?.unitsOut).toBe(3)
    expect(row?.accuracy).toBe(0)
  })

  it('weighs accuracy by lines, so one bulk line cannot hide many small ones', async () => {
    // A unit-weighted figure would let a single item out by 500 swamp a dozen
    // genuine discrepancies. Each line is one thing somebody investigates.
    await receive(wh.tapeId, wh.locationA, 1000)
    await move({
      kind: 'RECEIVE',
      itemId: wh.adhesiveId,
      toLocationId: wh.locationA,
      quantity: 5,
      batchId: wh.freshBatchId,
    })

    const { sessionId } = await startCount(
      prisma,
      { siteId: wh.siteId, locationId: wh.locationA, method: 'MANUAL' },
      { userId: wh.userId },
    )
    await submitCount(prisma, sessionId, [
      { itemId: wh.tapeId, batchId: null, quantity: 500 },
      { itemId: wh.adhesiveId, batchId: wh.freshBatchId, quantity: 5 },
    ])

    const report = await countAccuracy(prisma, ALL_TIME)

    // One of two lines matched: 50%, not 500/1005 units.
    expect(report.totals.accuracy).toBe(50)
  })

  it('weighs the overall figure across all lines, not across sessions', async () => {
    // Averaging per-session percentages would let a four-line session weigh as
    // much as a four-hundred-line one.
    await receive(wh.tapeId, wh.locationA, 10)
    await receive(wh.tapeId, wh.locationB, 10)

    const first = await startCount(
      prisma,
      { siteId: wh.siteId, locationId: wh.locationA, method: 'MANUAL' },
      { userId: wh.userId },
    )
    await submitCount(prisma, first.sessionId, [{ itemId: wh.tapeId, batchId: null, quantity: 9 }])

    const second = await startCount(
      prisma,
      { siteId: wh.siteId, locationId: wh.locationB, method: 'MANUAL' },
      { userId: wh.userId },
    )
    await submitCount(prisma, second.sessionId, [
      { itemId: wh.tapeId, batchId: null, quantity: 10 },
    ])

    const report = await countAccuracy(prisma, ALL_TIME)

    expect(report.totals.sessions).toBe(2)
    expect(report.totals.lines).toBe(2)
    expect(report.totals.accuracy).toBe(50)
  })
})

// ---------------------------------------------------------------------------

describe('stock ageing', () => {
  it('ages batch-tracked stock from when the batch was received', async () => {
    const eightyDaysAgo = new Date(Date.now() - 80 * 86_400_000)
    await prisma.batch.update({
      where: { id: wh.freshBatchId },
      data: { receivedAt: eightyDaysAgo },
    })

    await move({
      kind: 'RECEIVE',
      itemId: wh.adhesiveId,
      toLocationId: wh.locationA,
      quantity: 4,
      batchId: wh.freshBatchId,
    })

    const report = await stockAgeing(prisma)
    const line = report.rows.find((row) => row.itemId === wh.adhesiveId)

    expect(line?.ageDays).toBeGreaterThanOrEqual(79)
    expect(line?.bucket).toBe('61-90')
  })

  it('reports untracked stock as Unknown rather than guessing', async () => {
    // For an item tracked as NONE the ledger records quantities, not units. Ten
    // received in March and ten in September are one number, and nothing says
    // which ten are still there. Assuming FIFO would produce a confident wrong
    // age, and an ageing report is how stock gets written off.
    await receive(wh.tapeId, wh.locationA, 10)

    const report = await stockAgeing(prisma)
    const line = report.rows.find((row) => row.itemId === wh.tapeId)

    expect(line?.bucket).toBe('Unknown')
    expect(line?.ageDays).toBeNull()
    expect(report.unknown.quantity).toBeGreaterThanOrEqual(10)
  })

  it('puts very old stock in the open-ended bucket', async () => {
    await prisma.batch.update({
      where: { id: wh.freshBatchId },
      data: { receivedAt: new Date(Date.now() - 400 * 86_400_000) },
    })
    await move({
      kind: 'RECEIVE',
      itemId: wh.adhesiveId,
      toLocationId: wh.locationA,
      quantity: 1,
      batchId: wh.freshBatchId,
    })

    const report = await stockAgeing(prisma)

    expect(report.rows.find((row) => row.itemId === wh.adhesiveId)?.bucket).toBe('180+')
  })

  it('every bucket label is reported, so an empty one reads as empty', async () => {
    const report = await stockAgeing(prisma)

    expect(report.buckets.map((bucket) => bucket.label)).toEqual([
      '0-30',
      '31-60',
      '61-90',
      '91-180',
      '180+',
    ])
  })
})

// ---------------------------------------------------------------------------

describe('reorder', () => {
  it('lists an item at or below its reorder point', async () => {
    await prisma.item.update({
      where: { id: wh.tapeId },
      data: { reorderPoint: 20, maxLevel: 100 },
    })
    await receive(wh.tapeId, wh.locationA, 5)

    const report = await reorderReport(prisma)
    const row = report.rows.find((line) => line.itemId === wh.tapeId)

    expect(row?.onHand).toBe(5)
    expect(row?.shortBy).toBe(15)
    expect(row?.suggested).toBe(95)
  })

  it('leaves out an item that is comfortably stocked', async () => {
    await prisma.item.update({ where: { id: wh.tapeId }, data: { reorderPoint: 5 } })
    await receive(wh.tapeId, wh.locationA, 50)

    const report = await reorderReport(prisma)

    expect(report.rows.find((line) => line.itemId === wh.tapeId)).toBeUndefined()
  })

  it('includes an item exactly AT its reorder point', async () => {
    // "At or below" — the point is the level at which you reorder, not the
    // level below which you reorder. Off by one here is a stockout.
    await prisma.item.update({ where: { id: wh.tapeId }, data: { reorderPoint: 10 } })
    await receive(wh.tapeId, wh.locationA, 10)

    const report = await reorderReport(prisma)

    expect(report.rows.find((line) => line.itemId === wh.tapeId)).toBeTruthy()
  })

  it('ignores items with no reorder point set', async () => {
    // 0 means nobody set one. A report listing every item that happens to be
    // empty is not a purchase list.
    await prisma.item.updateMany({ data: { reorderPoint: 0 } })

    const report = await reorderReport(prisma)

    expect(report.rows).toHaveLength(0)
  })

  it('suggests nothing when no maximum is set', async () => {
    await prisma.item.update({
      where: { id: wh.tapeId },
      data: { reorderPoint: 20, maxLevel: null },
    })

    const report = await reorderReport(prisma)

    expect(report.rows.find((line) => line.itemId === wh.tapeId)?.suggested).toBeNull()
  })

  it('counts what is actually out of stock, not merely low', async () => {
    await prisma.item.update({ where: { id: wh.tapeId }, data: { reorderPoint: 20 } })
    await receive(wh.tapeId, wh.locationA, 5)

    const report = await reorderReport(prisma)

    expect(report.totals.items).toBeGreaterThanOrEqual(1)
    expect(report.rows.find((line) => line.itemId === wh.tapeId)?.onHand).toBe(5)
  })
})
