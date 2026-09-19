import { randomUUID } from 'node:crypto'
import { LocationZone, MovementSource } from '@prisma/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { recordMovement } from '@/lib/services/movements'
import { push } from '@/lib/services/sync'
import { createSite } from '@/lib/services/sites'
import { createLocation } from '@/lib/services/locations'
import { statusFor } from '@/lib/api/errors'
import { prisma, seedWarehouse, type Warehouse } from './helpers/warehouse'

/**
 * Site scope on the WRITE path.
 *
 * Site scope was enforced on every read and on nothing that writes. The sync
 * push endpoint takes `siteId` from the request body — it has to, because a
 * phone records which warehouse it was standing in — and passed it straight
 * through to the ledger without checking it against the token, or checking
 * that the locations named were even in that site.
 *
 * Two separate failures, so two separate guards:
 *
 *   - AUTHORIZATION: a device recording work at a site its operator has no
 *     access to.
 *   - INTEGRITY: stock crossing between warehouses inside one movement, with
 *     the ledger recording it as having happened entirely in one of them. Both
 *     sites' totals are then wrong and every site report disagrees with the
 *     ledger it came from.
 *
 * The web form never hit either, because it only ever offers locations from
 * the user's own site. That is precisely why this survived: the path people
 * use is not the path that was open.
 */

let wh: Warehouse
let otherSiteId: string
let otherLocationId: string

beforeEach(async () => {
  wh = await seedWarehouse()

  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0')
  await prisma.$executeRawUnsafe('DELETE FROM locations WHERE code NOT IN (?, ?)', 'A-01', 'B-01')
  await prisma.$executeRawUnsafe('DELETE FROM sites WHERE code <> ?', 'TEST')
  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1')

  const other = await createSite(
    prisma,
    { code: 'FAR', name: 'Far warehouse' },
    {
      userId: wh.userId,
    },
  )
  otherSiteId = other.id

  const location = await createLocation(
    prisma,
    { siteId: other.id, code: 'F-01', name: 'Far rack 01', zone: LocationZone.STORAGE },
    { userId: wh.userId },
  )
  otherLocationId = location.id
})

afterAll(async () => {
  await prisma.$disconnect()
})

const pushOne = (
  movement: Partial<Parameters<typeof push>[1][number]> & { siteId: string },
  siteIds: string[],
) =>
  push(
    prisma,
    [
      {
        id: randomUUID(),
        type: 'RECEIVE',
        itemId: wh.tapeId,
        quantity: 5,
        toLocationId: wh.locationA,
        occurredAt: new Date().toISOString(),
        ...movement,
      } as Parameters<typeof push>[1][number],
    ],
    { userId: wh.userId, deviceId: null, siteIds },
  )

// ---------------------------------------------------------------------------

describe('a movement cannot name a location in another site', () => {
  it('refuses a receipt into a location belonging to a different site', async () => {
    const outcome = await recordMovement(
      prisma,
      {
        id: randomUUID(),
        siteId: wh.siteId,
        action: {
          kind: 'RECEIVE',
          itemId: wh.tapeId,
          toLocationId: otherLocationId,
          quantity: 5,
        },
        source: MovementSource.WEB,
      },
      { userId: wh.userId },
    )

    expect(outcome.status).toBe('REJECTED')
    if (outcome.status !== 'REJECTED') throw new Error('expected a rejection')
    expect(outcome.error.code).toBe('LOCATION_WRONG_SITE')
  })

  it('refuses a MOVE that would carry stock between two warehouses', async () => {
    // The one that corrupts the books. Both sites' totals end up wrong and the
    // ledger claims it all happened in one of them.
    await recordMovement(
      prisma,
      {
        id: randomUUID(),
        siteId: wh.siteId,
        action: { kind: 'RECEIVE', itemId: wh.tapeId, toLocationId: wh.locationA, quantity: 10 },
        source: MovementSource.WEB,
      },
      { userId: wh.userId },
    )

    const outcome = await recordMovement(
      prisma,
      {
        id: randomUUID(),
        siteId: wh.siteId,
        action: {
          kind: 'MOVE',
          itemId: wh.tapeId,
          fromLocationId: wh.locationA,
          toLocationId: otherLocationId,
          quantity: 4,
        },
        source: MovementSource.WEB,
      },
      { userId: wh.userId },
    )

    expect(outcome.status).toBe('REJECTED')
    if (outcome.status !== 'REJECTED') throw new Error('expected a rejection')
    expect(outcome.error.code).toBe('LOCATION_WRONG_SITE')
    // Names the rack, so somebody can see which one is in the wrong place.
    expect(outcome.error.message).toContain('F-01')
  })

  it('says the location is in another site, not that it does not exist', async () => {
    // "Does not exist" sends somebody looking for a missing record. The rack is
    // real and is in another warehouse, which is a different thing to go and fix.
    const outcome = await recordMovement(
      prisma,
      {
        id: randomUUID(),
        siteId: wh.siteId,
        action: { kind: 'RECEIVE', itemId: wh.tapeId, toLocationId: otherLocationId, quantity: 1 },
        source: MovementSource.WEB,
      },
      { userId: wh.userId },
    )

    if (outcome.status !== 'REJECTED') throw new Error('expected a rejection')
    expect(outcome.error.message).toMatch(/different site/i)
  })

  it('still allows a movement entirely within one site', async () => {
    const outcome = await recordMovement(
      prisma,
      {
        id: randomUUID(),
        siteId: wh.siteId,
        action: { kind: 'RECEIVE', itemId: wh.tapeId, toLocationId: wh.locationA, quantity: 5 },
        source: MovementSource.WEB,
      },
      { userId: wh.userId },
    )

    expect(outcome.status).toBe('RECORDED')
  })

  it('is a 422, because it is understood and refused rather than broken', async () => {
    expect(statusFor('LOCATION_WRONG_SITE')).toBe(422)
  })
})

describe('a push cannot claim a site the token does not carry', () => {
  it('refuses a movement for a site outside the token', async () => {
    const { results } = await pushOne({ siteId: otherSiteId }, [wh.siteId])

    expect(results[0]?.status).toBe('REJECTED')
    if (results[0]?.status !== 'REJECTED') throw new Error('expected a rejection')
    expect(results[0].error.code).toBe('SITE_NOT_ALLOWED')
  })

  it('accepts one for a site the token does carry', async () => {
    const { results } = await pushOne({ siteId: wh.siteId }, [wh.siteId])

    expect(results[0]?.status).toBe('ACCEPTED')
  })

  it('refuses per row, so one bad movement does not block the outbox', async () => {
    // A phone that cannot sync because of a single bad entry is a phone that
    // stops being used, and the work in its outbox is lost.
    const { results } = await push(
      prisma,
      [
        {
          id: randomUUID(),
          type: 'RECEIVE',
          itemId: wh.tapeId,
          quantity: 5,
          toLocationId: wh.locationA,
          occurredAt: new Date().toISOString(),
          siteId: otherSiteId,
        },
        {
          id: randomUUID(),
          type: 'RECEIVE',
          itemId: wh.tapeId,
          quantity: 7,
          toLocationId: wh.locationA,
          occurredAt: new Date().toISOString(),
          siteId: wh.siteId,
        },
      ] as Parameters<typeof push>[1],
      { userId: wh.userId, deviceId: null, siteIds: [wh.siteId] },
    )

    expect(results[0]?.status).toBe('REJECTED')
    expect(results[1]?.status).toBe('ACCEPTED')
  })

  it('writes nothing for the refused row', async () => {
    const before = await prisma.movement.count()

    await pushOne({ siteId: otherSiteId }, [wh.siteId])

    expect(await prisma.movement.count()).toBe(before)
  })

  it('is a 403, because it is a permission problem rather than a bad request', async () => {
    expect(statusFor('SITE_NOT_ALLOWED')).toBe(403)
  })
})
