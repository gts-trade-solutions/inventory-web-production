import { randomUUID } from 'node:crypto'
import { LocationZone, MovementSource, TrackingMode } from '@prisma/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { suggestPutaway } from '@/lib/services/putaway'
import { createLocation, updateLocation } from '@/lib/services/locations'
import { recordMovement } from '@/lib/services/movements'
import { prisma, seedWarehouse, type Warehouse } from './helpers/warehouse'

/**
 * Putaway suggestions.
 *
 * Advisory in every case. Nothing here refuses a movement — the operator is
 * standing in front of the shelf and the system is not.
 *
 * The ranking is deliberately boring, because a clever suggestion nobody can
 * predict is one nobody trusts: consolidate where the item already is, then
 * follow the rules, then say nothing and explain why.
 *
 * The rule that matters most is the quiet one: an UNMEASURED location is not
 * full. Treating "nobody recorded a capacity" as an obstacle would rule out
 * every bay in a warehouse that has not been measured — which is most of them —
 * and the feature would suggest nothing, for ever, while looking like it worked.
 */

let wh: Warehouse
const actor = () => ({ userId: wh.userId })

beforeEach(async () => {
  wh = await seedWarehouse()

  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0')
  await prisma.$executeRawUnsafe('DELETE FROM putaway_rules')
  await prisma.$executeRawUnsafe('DELETE FROM locations WHERE code NOT IN (?, ?)', 'A-01', 'B-01')
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

const measure = (itemId: string) =>
  prisma.item.update({
    where: { id: itemId },
    // 10 × 10 × 10 cm = 1000 cm³ each, 500 g each.
    data: { lengthMm: 100, widthMm: 100, heightMm: 100, weightGrams: 500 },
  })

const rule = (data: {
  priority?: number
  categoryId?: string | null
  trackingMode?: TrackingMode | null
  targetLocationId?: string | null
  targetZone?: LocationZone | null
  note?: string
}) =>
  prisma.putawayRule.create({
    data: {
      id: randomUUID(),
      siteId: wh.siteId,
      priority: data.priority ?? 100,
      categoryId: data.categoryId ?? null,
      trackingMode: data.trackingMode ?? null,
      targetLocationId: data.targetLocationId ?? null,
      targetZone: data.targetZone ?? null,
      note: data.note ?? null,
    },
  })

const suggest = (quantity = 10) =>
  suggestPutaway(prisma, { itemId: wh.tapeId, siteId: wh.siteId, quantity })

// ---------------------------------------------------------------------------

describe('consolidation comes first', () => {
  it('suggests where the item already is', async () => {
    // Splitting a SKU across six bays is how a count comes out wrong.
    await receive(wh.tapeId, wh.locationB, 5)

    const advice = await suggest()

    expect(advice.suggestion?.locationId).toBe(wh.locationB)
    expect(advice.suggestion?.reason).toMatch(/already stored here/i)
  })

  it('prefers the bay holding most of it', async () => {
    await receive(wh.tapeId, wh.locationA, 5)
    await receive(wh.tapeId, wh.locationB, 50)

    expect((await suggest()).suggestion?.locationId).toBe(wh.locationB)
  })

  it('moves on when the bay it lives in is genuinely full', async () => {
    await updateLocation(prisma, wh.locationB, { capacityUnits: 10 }, actor())
    await receive(wh.tapeId, wh.locationB, 9)
    await rule({ targetZone: LocationZone.STORAGE })

    const advice = await suggest(10)

    expect(advice.suggestion?.locationId).not.toBe(wh.locationB)
    // And it says which place was passed over, and why.
    expect(advice.tight.some((entry) => entry.reason.includes('%'))).toBe(true)
  })
})

describe('rules', () => {
  it('sends stock to the zone a rule names', async () => {
    const dock = await createLocation(
      prisma,
      { siteId: wh.siteId, code: 'IN-01', name: 'Inbound bay', zone: LocationZone.INBOUND },
      actor(),
    )
    await rule({ targetZone: LocationZone.INBOUND })

    expect((await suggest()).suggestion?.locationId).toBe(dock.id)
  })

  it('sends stock to a specific location when a rule names one', async () => {
    await rule({ targetLocationId: wh.locationA })

    expect((await suggest()).suggestion?.locationId).toBe(wh.locationA)
  })

  it('prefers a NARROWER rule over a catch-all at the same priority', async () => {
    // A rule naming a tracking mode was written on purpose; a catch-all is a
    // default. The deliberate one should win.
    const special = await createLocation(
      prisma,
      { siteId: wh.siteId, code: 'SP-01', name: 'Special', zone: LocationZone.OUTBOUND },
      actor(),
    )

    await rule({ targetZone: LocationZone.STORAGE })
    await rule({ trackingMode: TrackingMode.NONE, targetLocationId: special.id })

    expect((await suggest()).suggestion?.locationId).toBe(special.id)
  })

  it('respects priority ahead of narrowness', async () => {
    const first = await createLocation(
      prisma,
      { siteId: wh.siteId, code: 'PR-01', name: 'First', zone: LocationZone.OUTBOUND },
      actor(),
    )

    await rule({ priority: 1, targetLocationId: first.id })
    await rule({ priority: 50, trackingMode: TrackingMode.NONE, targetLocationId: wh.locationA })

    expect((await suggest()).suggestion?.locationId).toBe(first.id)
  })

  it('ignores a rule for a different tracking mode', async () => {
    await rule({ trackingMode: TrackingMode.SERIAL, targetLocationId: wh.locationA })

    const advice = await suggest()

    expect(advice.suggestion).toBeNull()
    expect(advice.because).toMatch(/no putaway rule covers this item/i)
  })

  it('uses the note as the reason when one is written', async () => {
    await rule({ targetLocationId: wh.locationA, note: 'Fast movers go by the door' })

    expect((await suggest()).suggestion?.reason).toBe('Fast movers go by the door')
  })

  it('spreads across a zone rather than filling one bay', async () => {
    const second = await createLocation(
      prisma,
      {
        siteId: wh.siteId,
        code: 'ST-02',
        name: 'Second',
        zone: LocationZone.STORAGE,
        capacityUnits: 100,
      },
      actor(),
    )
    await updateLocation(prisma, wh.locationA, { capacityUnits: 100 }, actor())
    await updateLocation(prisma, wh.locationB, { capacityUnits: 100 }, actor())

    // A DIFFERENT item, so consolidation does not fire and the ranking is
    // being tested rather than the shortcut in front of it. Written straight
    // into the projection: the adhesive is batch-tracked, so a bare receive
    // for it is correctly refused, and the fixture is about how full the bay
    // is rather than about how the stock got there.
    await prisma.stockLevel.create({
      data: {
        itemId: wh.adhesiveId,
        locationId: wh.locationA,
        batchId: wh.freshBatchId,
        quantity: 80,
      },
    })

    await rule({ targetZone: LocationZone.STORAGE })

    // NOT the 90%-full one. Which of the two empty bays it picks is arbitrary
    // and stays arbitrary — asserting a particular one would pin down ordering
    // that carries no meaning, and would break the moment a code changed.
    const chosen = (await suggest()).suggestion?.locationId

    expect(chosen).not.toBe(wh.locationA)
    expect([wh.locationB, second.id]).toContain(chosen)
  })
})

describe('an unmeasured location is not a full one', () => {
  it('suggests a location with no capacity recorded at all', async () => {
    // The quiet rule the whole feature depends on. Most bays in most
    // warehouses have never been measured; treating that as an obstacle would
    // make this suggest nothing for ever while appearing to work.
    await rule({ targetLocationId: wh.locationA })

    const advice = await suggest(999_999)

    expect(advice.suggestion?.locationId).toBe(wh.locationA)
    expect(advice.suggestion?.fit).toBe('UNKNOWN')
    expect(advice.suggestion?.fillAfterPercent).toBeNull()
  })

  it('does not claim a fill figure it cannot compute', async () => {
    await rule({ targetLocationId: wh.locationA })

    expect((await suggest()).suggestion?.fillAfterPercent).toBeNull()
  })
})

describe('physical capacity, when both sides are measured', () => {
  it('uses cube rather than units when it can', async () => {
    await measure(wh.tapeId)
    // 20 L of room, and each unit is 1 L.
    await prisma.location.update({
      where: { id: wh.locationA },
      data: { capacityVolumeCm3: 20_000 },
    })
    await rule({ targetLocationId: wh.locationA })

    const advice = await suggest(10)

    expect(advice.suggestion?.fit).toBe('FITS')
    expect(advice.suggestion?.fillAfterPercent).toBe(50)
  })

  it('calls it tight when the cube does not fit', async () => {
    await measure(wh.tapeId)
    await prisma.location.update({
      where: { id: wh.locationA },
      data: { capacityVolumeCm3: 5000 },
    })
    await rule({ targetLocationId: wh.locationA })

    const advice = await suggest(10)

    expect(advice.suggestion).toBeNull()
    expect(advice.tight[0]?.reason).toMatch(/200% full by volume/)
  })

  it('catches a weight limit even when the volume is fine', async () => {
    // Lead and feathers: a bay with room can still be over its weight limit.
    await measure(wh.tapeId)
    await prisma.location.update({
      where: { id: wh.locationA },
      data: { capacityVolumeCm3: 10_000_000, capacityWeightGrams: 1000 },
    })
    await rule({ targetLocationId: wh.locationA })

    const advice = await suggest(10)

    expect(advice.suggestion).toBeNull()
    expect(advice.tight[0]?.reason).toMatch(/weight limit/)
  })

  it('falls back to unit capacity when the item is not measured', async () => {
    // Item has no dimensions, so cube cannot answer — but a unit capacity can.
    await prisma.location.update({
      where: { id: wh.locationA },
      data: { capacityVolumeCm3: 20_000, capacityUnits: 50 },
    })
    await rule({ targetLocationId: wh.locationA })

    const advice = await suggest(10)

    expect(advice.suggestion?.fit).toBe('FITS')
    expect(advice.suggestion?.fillAfterPercent).toBe(20)
  })
})

describe('when there is nothing useful to say', () => {
  it('says so, rather than suggesting the first location it finds', async () => {
    const advice = await suggest()

    expect(advice.suggestion).toBeNull()
    expect(advice.because).toMatch(/no putaway rule covers this item/i)
  })

  it('explains when every rule target is tight', async () => {
    await updateLocation(prisma, wh.locationA, { capacityUnits: 5 }, actor())
    await prisma.location.update({ where: { id: wh.locationB }, data: { active: false } })
    await rule({ targetLocationId: wh.locationA })

    const advice = await suggest(50)

    expect(advice.suggestion).toBeNull()
    expect(advice.because).toMatch(/already tight/i)
  })

  it('never offers a grouping, only the places inside it', async () => {
    const aisle = await createLocation(
      prisma,
      { siteId: wh.siteId, code: 'AIS-1', name: 'Aisle', zone: LocationZone.STORAGE },
      actor(),
    )
    const shelf = await createLocation(
      prisma,
      {
        siteId: wh.siteId,
        code: 'AIS-1-1',
        name: 'Shelf',
        zone: LocationZone.STORAGE,
        parentId: aisle.id,
      },
      actor(),
    )
    await rule({ targetZone: LocationZone.STORAGE })

    const advice = await suggest()

    expect(advice.suggestion?.locationId).not.toBe(aisle.id)
    expect([wh.locationA, wh.locationB, shelf.id]).toContain(advice.suggestion?.locationId)
  })
})
