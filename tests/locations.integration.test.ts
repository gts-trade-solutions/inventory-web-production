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
import { prisma, seedWarehouse, type Warehouse } from './helpers/warehouse'

/**
 * Location administration.
 *
 * The guards are the point, and they are all one idea: deactivating or removing
 * a place does not remove what is in it. The ledger still balances, every total
 * still adds up, and nobody can find the goods — which is worse than an error,
 * because nothing looks wrong.
 */

let wh: Warehouse
const actor = () => ({ userId: wh.userId })

beforeEach(async () => {
  wh = await seedWarehouse()

  // Master data survives seedWarehouse, so locations and sites made by name in
  // one test would collide with the next.
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

// ---------------------------------------------------------------------------

describe('creating', () => {
  it('adds a location to a site', async () => {
    const created = await createLocation(
      prisma,
      { siteId: wh.siteId, code: 'C-01', name: 'Aisle C · Rack 01', zone: LocationZone.STORAGE },
      actor(),
    )

    expect(created.code).toBe('C-01')
    expect((await listLocations(prisma)).map((row) => row.code)).toContain('C-01')
  })

  it('uppercases the code, so one rack cannot become two', async () => {
    const created = await createLocation(
      prisma,
      { siteId: wh.siteId, code: 'c-99', name: 'Lower case', zone: LocationZone.STORAGE },
      actor(),
    )

    expect(created.code).toBe('C-99')
  })

  it('refuses a duplicate code within the same site', async () => {
    await expect(
      createLocation(
        prisma,
        { siteId: wh.siteId, code: 'A-01', name: 'Clash', zone: LocationZone.STORAGE },
        actor(),
      ),
    ).rejects.toThrow(/already used in this site/i)
  })

  it('ALLOWS the same code in a different site', async () => {
    // Two warehouses both having an A-01 is normal. The database's own
    // constraint is (siteId, code), and the check has to match it.
    const second = await createSite(prisma, { code: 'WH2', name: 'Second' }, actor())

    await expect(
      createLocation(
        prisma,
        { siteId: second.id, code: 'A-01', name: 'Aisle A · Rack 01', zone: LocationZone.STORAGE },
        actor(),
      ),
    ).resolves.toBeTruthy()
  })

  it('refuses a code that would not survive being printed on a label', async () => {
    await expect(
      createLocation(
        prisma,
        { siteId: wh.siteId, code: 'A 01!', name: 'Bad', zone: LocationZone.STORAGE },
        actor(),
      ),
    ).rejects.toThrow(/letters, digits and hyphens/i)
  })

  it('refuses to add a location to a deactivated site', async () => {
    // Otherwise it is created somewhere nothing can use, and the problem
    // surfaces much later as "why can I not receive into this".
    const second = await createSite(prisma, { code: 'WH3', name: 'Third' }, actor())
    await prisma.site.update({ where: { id: second.id }, data: { active: false } })

    await expect(
      createLocation(
        prisma,
        { siteId: second.id, code: 'X-01', name: 'Orphan', zone: LocationZone.STORAGE },
        actor(),
      ),
    ).rejects.toThrow(/deactivated/i)
  })

  it('refuses an empty name', async () => {
    await expect(
      createLocation(
        prisma,
        { siteId: wh.siteId, code: 'D-01', name: '   ', zone: LocationZone.STORAGE },
        actor(),
      ),
    ).rejects.toThrow(/needs a name/i)
  })
})

describe('changing', () => {
  it('renames and rezones', async () => {
    const created = await createLocation(
      prisma,
      { siteId: wh.siteId, code: 'E-01', name: 'Old name', zone: LocationZone.STORAGE },
      actor(),
    )

    await updateLocation(
      prisma,
      created.id,
      { name: 'New name', zone: LocationZone.OUTBOUND },
      actor(),
    )

    const row = (await listLocations(prisma)).find((line) => line.id === created.id)
    expect(row?.name).toBe('New name')
    expect(row?.zone).toBe(LocationZone.OUTBOUND)
  })

  it('refuses to deactivate a location still holding stock', async () => {
    await receive(wh.tapeId, wh.locationA, 12)

    await expect(updateLocation(prisma, wh.locationA, { active: false }, actor())).rejects.toThrow(
      /still holds 12 units/i,
    )
  })

  it('refuses to deactivate the only active location in a site', async () => {
    // With none active there is nowhere to receive into, and the site is
    // unusable until somebody edits the database.
    const second = await createSite(prisma, { code: 'WH4', name: 'Fourth' }, actor())
    const only = await createLocation(
      prisma,
      { siteId: second.id, code: 'Z-01', name: 'The only one', zone: LocationZone.STORAGE },
      actor(),
    )

    await expect(updateLocation(prisma, only.id, { active: false }, actor())).rejects.toThrow(
      /only active location/i,
    )
  })

  it('allows deactivating an empty location when another is active', async () => {
    await expect(
      updateLocation(prisma, wh.locationB, { active: false }, actor()),
    ).resolves.toBeUndefined()
  })

  it('records the change, so a renamed rack can be explained later', async () => {
    await updateLocation(prisma, wh.locationB, { name: 'Renamed rack' }, actor())

    const entry = await prisma.auditLog.findFirst({
      where: { entity: 'Location', entityId: wh.locationB },
      orderBy: { at: 'desc' },
    })

    expect(entry?.after).toMatchObject({ name: 'Renamed rack' })
  })
})

describe('removing', () => {
  it('refuses to remove one that still holds stock', async () => {
    await receive(wh.tapeId, wh.locationA, 3)

    await expect(deleteLocation(prisma, wh.locationA, actor())).rejects.toThrow(
      /still holds stock/i,
    )
  })

  it('refuses to remove one with movement history, and says to deactivate instead', async () => {
    // Every document naming this location would be left pointing at nothing.
    await receive(wh.tapeId, wh.locationA, 3)
    await recordMovement(
      prisma,
      {
        id: randomUUID(),
        siteId: wh.siteId,
        action: {
          kind: 'ISSUE',
          itemId: wh.tapeId,
          fromLocationId: wh.locationA,
          quantity: 3,
        },
        source: MovementSource.WEB,
      },
      { userId: wh.userId },
    )

    await expect(deleteLocation(prisma, wh.locationA, actor())).rejects.toThrow(
      /movements recorded against it/i,
    )
    await expect(deleteLocation(prisma, wh.locationA, actor())).rejects.toThrow(/Deactivate it/i)
  })

  it('removes one nothing depends on, and keeps the row for the audit trail', async () => {
    const created = await createLocation(
      prisma,
      { siteId: wh.siteId, code: 'F-01', name: 'Never used', zone: LocationZone.STORAGE },
      actor(),
    )

    await deleteLocation(prisma, created.id, actor())

    expect((await listLocations(prisma)).map((row) => row.id)).not.toContain(created.id)
    expect(await prisma.location.findUnique({ where: { id: created.id } })).not.toBeNull()
  })

  it('does not let a removed code be reused', async () => {
    const created = await createLocation(
      prisma,
      { siteId: wh.siteId, code: 'G-01', name: 'Short lived', zone: LocationZone.STORAGE },
      actor(),
    )
    await deleteLocation(prisma, created.id, actor())

    await expect(
      createLocation(
        prisma,
        { siteId: wh.siteId, code: 'G-01', name: 'Reused', zone: LocationZone.STORAGE },
        actor(),
      ),
    ).rejects.toThrow(/not reused/i)
  })
})

describe('the list', () => {
  it('reports what each location is holding', async () => {
    await receive(wh.tapeId, wh.locationA, 12)

    const row = (await listLocations(prisma)).find((line) => line.id === wh.locationA)

    expect(row?.onHand).toBe(12)
    expect(row?.stockedLines).toBeGreaterThan(0)
  })

  it('names the site each location belongs to', async () => {
    const row = (await listLocations(prisma)).find((line) => line.id === wh.locationA)

    expect(row?.siteCode).toBe('TEST')
  })

  it('can be narrowed to one site', async () => {
    const second = await createSite(prisma, { code: 'WH5', name: 'Fifth' }, actor())
    await createLocation(
      prisma,
      { siteId: second.id, code: 'Y-01', name: 'Elsewhere', zone: LocationZone.STORAGE },
      actor(),
    )

    const rows = await listLocations(prisma, { siteId: second.id })

    expect(rows).toHaveLength(1)
    expect(rows[0]?.code).toBe('Y-01')
  })

  it('leaves out removed locations', async () => {
    const created = await createLocation(
      prisma,
      { siteId: wh.siteId, code: 'H-01', name: 'Gone', zone: LocationZone.STORAGE },
      actor(),
    )
    await deleteLocation(prisma, created.id, actor())

    expect((await listLocations(prisma)).map((row) => row.code)).not.toContain('H-01')
  })
})
