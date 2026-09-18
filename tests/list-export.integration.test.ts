import { randomUUID } from 'node:crypto'
import { MovementSource, TrackingMode } from '@prisma/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { prepareListExport, type ListKey } from '@/lib/services/list-export'
import { recordMovement } from '@/lib/services/movements'
import { prisma, seedWarehouse, type Warehouse } from './helpers/warehouse'

/**
 * Exporting the list screens (8.4).
 *
 * Everything here is one question: does the file match what the person was
 * looking at? An export that quietly ignores a filter hands somebody a
 * plausible spreadsheet of the wrong rows, and nothing about the file itself
 * says so — they find out when they act on it.
 */

let wh: Warehouse

beforeEach(async () => {
  wh = await seedWarehouse()
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

const issue = (itemId: string, locationId: string, quantity: number) =>
  recordMovement(
    prisma,
    {
      id: randomUUID(),
      siteId: wh.siteId,
      action: { kind: 'ISSUE', itemId, fromLocationId: locationId, quantity },
      source: MovementSource.WEB,
    },
    { userId: wh.userId },
  )

async function rowsOf(
  key: ListKey,
  request: Parameters<typeof prepareListExport>[2] = {},
): Promise<Array<Record<string, unknown>>> {
  const prepared = prepareListExport(prisma, key, request)

  const out: Array<Record<string, unknown>> = []
  for await (const row of prepared.rows) out.push(row)
  return out
}

/** The exported value of one named column, which is what lands in the file. */
function cell(
  key: ListKey,
  header: string,
  row: Record<string, unknown>,
): string | number | boolean | Date | null | undefined {
  const column = prepareListExport(prisma, key, {}).columns.find((c) => c.header === header)
  if (!column) throw new Error(`no column called ${header}`)

  return column.value(row)
}

// ---------------------------------------------------------------------------

describe('items', () => {
  it('exports every item when nothing is filtered', async () => {
    const rows = await rowsOf('items')

    expect(rows.length).toBeGreaterThanOrEqual(3)
  })

  it('honours the search box', async () => {
    const rows = await rowsOf('items', { q: 'tape' })

    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(String(row.name).toLowerCase()).toContain('tape')
    }
  })

  it('honours the tracking filter, in the case the URL actually uses', async () => {
    // The screen links to ?tracking=serial, lower case. Matching case
    // sensitively would export every item while the screen showed one kind.
    const rows = await rowsOf('items', { tracking: 'serial' })

    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row.trackingMode).toBe(TrackingMode.SERIAL)
  })

  it('honours the low-stock filter, which is derived rather than a column', async () => {
    await prisma.item.update({
      where: { id: wh.tapeId },
      data: { reorderPoint: 1000 },
    })
    await receive(wh.tapeId, wh.locationA, 5)

    // One item comfortably stocked, so the filter has something to exclude.
    // It goes in with its batch, because the adhesive is batch-tracked and a
    // bare receive for it is refused.
    await prisma.item.update({ where: { id: wh.adhesiveId }, data: { reorderPoint: 5 } })
    await recordMovement(
      prisma,
      {
        id: randomUUID(),
        siteId: wh.siteId,
        action: {
          kind: 'RECEIVE',
          itemId: wh.adhesiveId,
          toLocationId: wh.locationA,
          quantity: 50,
          batchId: wh.freshBatchId,
        },
        source: MovementSource.WEB,
      },
      { userId: wh.userId },
    )

    const low = await rowsOf('items', { low: true })
    const all = await rowsOf('items')

    // The filter narrows, and every row it keeps really is at or below its
    // point — the same comparison the screen makes, `onHand <= reorderPoint`.
    expect(low.length).toBeLessThan(all.length)
    for (const row of low) {
      expect(Number(row.onHand)).toBeLessThanOrEqual(Number(row.reorderPoint))
    }

    // Tape is short: 5 on hand against a point of 1000.
    expect(low.map((row) => row.id)).toContain(wh.tapeId)
  })

  it('reports on hand as the sum across every location', async () => {
    await receive(wh.tapeId, wh.locationA, 7)
    await receive(wh.tapeId, wh.locationB, 8)

    const rows = await rowsOf('items', { q: 'tape' })
    const tape = rows.find((row) => row.id === wh.tapeId)

    expect(cell('items', 'On hand', tape!)).toBe(15)
  })
})

describe('movements', () => {
  it('exports the ledger rows', async () => {
    await receive(wh.tapeId, wh.locationA, 10)
    await issue(wh.tapeId, wh.locationA, 4)

    const rows = await rowsOf('movements-detail')

    expect(rows.length).toBe(2)
  })

  it('honours the type filter in the case the URL uses', async () => {
    await receive(wh.tapeId, wh.locationA, 10)
    await issue(wh.tapeId, wh.locationA, 4)

    const rows = await rowsOf('movements-detail', { type: 'issue' })

    expect(rows).toHaveLength(1)
    expect(rows[0]?.type).toBe('ISSUE')
  })

  it('honours the search box', async () => {
    await receive(wh.tapeId, wh.locationA, 10)

    const all = await rowsOf('movements-detail')
    const docNo = String(all[0]?.docNo)

    const found = await rowsOf('movements-detail', { q: docNo })

    expect(found).toHaveLength(1)
    expect(found[0]?.docNo).toBe(docNo)
  })

  it('carries BOTH clocks, because they differ for anything that synced late', async () => {
    // An auditor asking "when did this happen" means occurredAt, on the floor.
    // recordedAt is when the server heard about it, which for a phone that was
    // offline can be hours later.
    await receive(wh.tapeId, wh.locationA, 1)

    const rows = await rowsOf('movements-detail')

    expect(cell('movements-detail', 'Occurred', rows[0]!)).toBeInstanceOf(Date)
    expect(cell('movements-detail', 'Recorded', rows[0]!)).toBeInstanceOf(Date)
  })

  it('names the person, by name and by account', async () => {
    // The file outlives the account, and a name alone stops being unique the
    // moment two people share one.
    await receive(wh.tapeId, wh.locationA, 1)

    const rows = await rowsOf('movements-detail')

    expect(cell('movements-detail', 'By', rows[0]!)).toBeTruthy()
    expect(String(cell('movements-detail', 'Account', rows[0]!))).toContain('@')
  })

  it('keeps quantity as a number so a spreadsheet can total it', async () => {
    await receive(wh.tapeId, wh.locationA, 10)

    const rows = await rowsOf('movements-detail')

    expect(typeof cell('movements-detail', 'Quantity', rows[0]!)).toBe('number')
  })
})

describe('batches and serials', () => {
  it('exports batches with their dates as dates', async () => {
    const rows = await rowsOf('batches')

    expect(rows.length).toBeGreaterThan(0)
    const withExpiry = rows.find((row) => row.expiryDate !== null)
    expect(cell('batches', 'Expires', withExpiry!)).toBeInstanceOf(Date)
  })

  it('honours the batch search', async () => {
    const all = await rowsOf('batches')
    const batchNo = String(all[0]?.batchNo)

    const found = await rowsOf('batches', { q: batchNo })

    expect(found.length).toBeGreaterThan(0)
    for (const row of found) expect(String(row.batchNo)).toContain(batchNo)
  })

  it('exports serial units', async () => {
    const rows = await rowsOf('serials')

    expect(Array.isArray(rows)).toBe(true)
  })
})
