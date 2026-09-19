import { randomUUID } from 'node:crypto'
import { LocationZone, MovementSource } from '@prisma/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createLocation,
  deleteLocation,
  listLocations,
  updateLocation,
} from '@/lib/services/locations'
import { createSite } from '@/lib/services/sites'
import { recordMovement } from '@/lib/services/movements'
import { loadMovementForm } from '@/lib/services/movement-form'
import { prisma, seedWarehouse, type Warehouse } from './helpers/warehouse'

/**
 * Warehouse structure and capacity.
 *
 * Locations nest, so a warehouse can be described the way it is built rather
 * than encoded in a code string where no query can reach it. Two rules carry
 * the risk and neither can be expressed in the database: stock sits at the
 * LEAVES, and a location cannot become its own ancestor.
 *
 * Capacity warns and never blocks. A receipt past capacity is accepted, because
 * if the goods are physically on the shelf then refusing it makes the ledger
 * disagree with the building — the failure this whole system avoids.
 */

let wh: Warehouse
const actor = () => ({ userId: wh.userId })

beforeEach(async () => {
  wh = await seedWarehouse()

  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0')
  await prisma.$executeRawUnsafe('DELETE FROM locations WHERE code NOT IN (?, ?)', 'A-01', 'B-01')
  await prisma.$executeRawUnsafe('DELETE FROM sites WHERE code <> ?', 'TEST')
  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1')
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

const place = (code: string, options: { parentId?: string; capacityUnits?: number } = {}) =>
  createLocation(
    prisma,
    {
      siteId: wh.siteId,
      code,
      name: `Place ${code}`,
      zone: LocationZone.STORAGE,
      ...options,
    },
    actor(),
  )

const find = async (id: string) => (await listLocations(prisma)).find((row) => row.id === id)

// ---------------------------------------------------------------------------

describe('the tree', () => {
  it('nests a location inside another and reports its depth', async () => {
    const aisle = await place('AISLE-A')
    const shelf = await place('AA-01', { parentId: aisle.id })

    const tree = await listLocations(prisma)
    const parent = tree.find((row) => row.id === aisle.id)
    const child = tree.find((row) => row.id === shelf.id)

    expect(parent?.depth).toBe(0)
    expect(child?.depth).toBe(1)
    // Order matters: a child listed above its parent reads as a sibling.
    expect(tree.indexOf(parent!)).toBeLessThan(tree.indexOf(child!))
  })

  it('marks a location that holds others as not a leaf', async () => {
    const aisle = await place('AISLE-B')
    await place('BB-01', { parentId: aisle.id })

    expect((await find(aisle.id))?.isLeaf).toBe(false)
  })

  it('rolls stock up from the shelves to the aisle', async () => {
    // The whole reason structure is worth having: "how full is aisle A" has to
    // be answerable, and a flat list cannot answer it.
    const aisle = await place('AISLE-C')
    const shelf = await place('CC-01', { parentId: aisle.id })
    await receive(wh.tapeId, shelf.id, 30)

    expect((await find(shelf.id))?.onHand).toBe(30)
    expect((await find(aisle.id))?.onHand).toBe(30)
  })

  it('rolls up across several levels', async () => {
    const zone = await place('Z')
    const aisle = await place('Z-A', { parentId: zone.id })
    const shelf = await place('Z-A-1', { parentId: aisle.id })
    await receive(wh.tapeId, shelf.id, 12)

    expect((await find(zone.id))?.onHand).toBe(12)
    expect((await find(zone.id))?.depth).toBe(0)
    expect((await find(shelf.id))?.depth).toBe(2)
  })

  it('refuses a location that would become its own ancestor', async () => {
    const aisle = await place('AISLE-D')
    const shelf = await place('DD-01', { parentId: aisle.id })

    await expect(updateLocation(prisma, aisle.id, { parentId: shelf.id }, actor())).rejects.toThrow(
      /already contains/i,
    )
  })

  it('refuses a deeper cycle, not just the immediate one', async () => {
    const a = await place('N-A')
    const b = await place('N-B', { parentId: a.id })
    const c = await place('N-C', { parentId: b.id })

    await expect(updateLocation(prisma, a.id, { parentId: c.id }, actor())).rejects.toThrow(
      /already contains/i,
    )
  })

  it('refuses a location put inside itself', async () => {
    const one = await place('SELF-1')

    await expect(updateLocation(prisma, one.id, { parentId: one.id }, actor())).rejects.toThrow(
      /inside itself/i,
    )
  })

  it('refuses a parent in a different site', async () => {
    // A tree spanning two warehouses describes neither.
    const second = await createSite(prisma, { code: 'WH9', name: 'Ninth' }, actor())
    const elsewhere = await createLocation(
      prisma,
      { siteId: second.id, code: 'W-01', name: 'Far', zone: LocationZone.STORAGE },
      actor(),
    )

    await expect(place('X-01', { parentId: elsewhere.id })).rejects.toThrow(/different site/i)
  })

  it('refuses turning a location that HOLDS STOCK into a parent', async () => {
    // Stock sits at the bottom. A branch with its own pallets makes every
    // rollup below it ambiguous.
    await receive(wh.tapeId, wh.locationA, 5)

    await expect(place('UNDER-A', { parentId: wh.locationA })).rejects.toThrow(
      /cannot also contain/i,
    )
  })

  it('refuses removing a location that contains others', async () => {
    const aisle = await place('AISLE-E')
    await place('EE-01', { parentId: aisle.id })

    await expect(deleteLocation(prisma, aisle.id, actor())).rejects.toThrow(
      /contains 1 other location/i,
    )
  })

  it('leaves a flat warehouse working — every location is simply a root', async () => {
    const tree = await listLocations(prisma)
    const seeded = tree.filter((row) => row.code === 'A-01' || row.code === 'B-01')

    expect(seeded).toHaveLength(2)
    for (const row of seeded) {
      expect(row.depth).toBe(0)
      expect(row.isLeaf).toBe(true)
      expect(row.parentId).toBeNull()
    }
  })
})

describe('stock goes to leaves, never to a grouping', () => {
  it('refuses a receipt into a location that contains others', async () => {
    const aisle = await place('AISLE-G')
    await place('GG-01', { parentId: aisle.id })

    const outcome = await receive(wh.tapeId, aisle.id, 5)

    expect(outcome.status).toBe('REJECTED')
    if (outcome.status !== 'REJECTED') throw new Error('expected a rejection')
    expect(outcome.error.code).toBe('LOCATION_NOT_A_PLACE')
    expect(outcome.error.message).toMatch(/pick one of the places inside/i)
  })

  it('accepts a receipt into the leaf below it', async () => {
    const aisle = await place('AISLE-H')
    const shelf = await place('HH-01', { parentId: aisle.id })

    expect((await receive(wh.tapeId, shelf.id, 5)).status).toBe('RECORDED')
  })

  it('keeps groupings out of the movement form picker entirely', async () => {
    // Offering one would invite a rejection the operator could be spared.
    const aisle = await place('AISLE-I')
    const shelf = await place('II-01', { parentId: aisle.id })

    const form = await loadMovementForm(prisma, { itemId: wh.tapeId, siteId: wh.siteId })
    const offered = form!.locations.map((location) => location.id)

    expect(offered).toContain(shelf.id)
    expect(offered).not.toContain(aisle.id)
  })
})

describe('capacity', () => {
  it('records one and reports how full the place is', async () => {
    const created = await place('CAP-1', { capacityUnits: 100 })
    await receive(wh.tapeId, created.id, 25)

    const row = await find(created.id)
    expect(row?.capacityUnits).toBe(100)
    expect(row?.fillPercent).toBe(25)
  })

  it('reports fill as UNKNOWN when nobody has set one', async () => {
    // Not 0%. "Empty" and "nobody has measured this" are different facts, and
    // only one of them means there is room.
    await receive(wh.tapeId, wh.locationA, 10)

    const row = await find(wh.locationA)
    expect(row?.capacityUnits).toBeNull()
    expect(row?.fillPercent).toBeNull()
  })

  it('WARNS rather than blocks: a receipt past capacity is still recorded', async () => {
    // The rule the whole feature hangs on. If the goods are physically on the
    // shelf, refusing the receipt makes the ledger disagree with the building.
    const created = await place('CAP-2', { capacityUnits: 10 })

    const outcome = await receive(wh.tapeId, created.id, 25)

    expect(outcome.status).toBe('RECORDED')
    expect((await find(created.id))?.fillPercent).toBe(250)
  })

  it('sums up the tree across only the places that have one', async () => {
    // A branch with one measured shelf out of ten must not report a capacity
    // ten times too small and show as wildly overfull.
    const aisle = await place('AISLE-F')
    await place('FF-01', { parentId: aisle.id, capacityUnits: 60 })
    await place('FF-02', { parentId: aisle.id })

    const row = await find(aisle.id)
    expect(row?.capacityUnits).toBe(60)
    // And a branch has none of its own to edit.
    expect(row?.ownCapacityUnits).toBeNull()
  })

  it('refuses a capacity of zero', async () => {
    // "Holds nothing" is not a real place, and every unit landing there would
    // read as infinitely overfull. Blank means unknown; deactivate means unusable.
    await expect(place('CAP-3', { capacityUnits: 0 })).rejects.toThrow(/from 1 up/i)
  })

  it('can be cleared back to unknown', async () => {
    const created = await place('CAP-4', { capacityUnits: 50 })

    await updateLocation(prisma, created.id, { capacityUnits: null }, actor())

    expect((await find(created.id))?.capacityUnits).toBeNull()
  })

  it('is offered to the movement form, so fill can be shown before choosing', async () => {
    const created = await place('CAP-5', { capacityUnits: 40 })
    await receive(wh.tapeId, created.id, 10)

    const form = await loadMovementForm(prisma, { itemId: wh.tapeId, siteId: wh.siteId })
    const offered = form!.locations.find((location) => location.id === created.id)

    expect(offered?.capacityUnits).toBe(40)
    // Fill is about the PLACE, so it counts everything there rather than just
    // the item being moved.
    expect(form!.totalOnHandByLocation[created.id]).toBe(10)
  })
})

describe('deactivating a branch', () => {
  it('is refused when a rack INSIDE it holds stock', async () => {
    // An aisle's own stock is always zero, because stock sits at the leaves.
    // Checking only the location itself let a branch holding a thousand units
    // be switched off without a murmur, hiding every rack inside it.
    const aisle = await place('AISLE-J')
    const shelf = await place('JJ-01', { parentId: aisle.id })
    await receive(wh.tapeId, shelf.id, 40)

    await expect(updateLocation(prisma, aisle.id, { active: false }, actor())).rejects.toThrow(
      /still holds 40 units inside it/i,
    )
  })

  it('is allowed when everything inside it is empty', async () => {
    const aisle = await place('AISLE-K')
    await place('KK-01', { parentId: aisle.id })

    await expect(
      updateLocation(prisma, aisle.id, { active: false }, actor()),
    ).resolves.toBeUndefined()
  })

  it('still names the units when a leaf itself holds them', async () => {
    await receive(wh.tapeId, wh.locationA, 7)

    await expect(updateLocation(prisma, wh.locationA, { active: false }, actor())).rejects.toThrow(
      /still holds 7 units\./i,
    )
  })
})
