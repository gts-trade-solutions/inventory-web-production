import { randomUUID } from 'node:crypto'
import { MovementSource } from '@prisma/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { clearSetting, getSetting, listSettings, setSetting } from '@/lib/services/settings'
import { recordMovement } from '@/lib/services/movements'
import { startCount, submitCount } from '@/lib/services/counts'
import { onHand, prisma, seedWarehouse, type Warehouse } from './helpers/warehouse'

/**
 * Operating policy.
 *
 * The entry requirement for a setting is that it CHANGES BEHAVIOUR. A settings
 * screen full of switches that do nothing is worse than no settings screen,
 * because somebody will set one and believe it took effect — so every setting
 * here is tested by doing the thing it governs, not by reading the value back.
 */

let wh: Warehouse

beforeEach(async () => {
  wh = await seedWarehouse()
  await prisma.setting.deleteMany()
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

const adjust = (itemId: string, locationId: string, countedQuantity: number) =>
  recordMovement(
    prisma,
    {
      id: randomUUID(),
      siteId: wh.siteId,
      action: {
        kind: 'ADJUST',
        itemId,
        locationId,
        countedQuantity,
        reasonCodeId: wh.reasonCodeId,
      },
      source: MovementSource.WEB,
    },
    { userId: wh.userId },
  )

describe('resolution', () => {
  it('uses the shipped default when nothing is stored', async () => {
    expect(await getSetting(prisma, 'expiry.issuePolicy', wh.siteId)).toBe('BLOCK')
    expect(await getSetting(prisma, 'adjust.maxQuantity', wh.siteId)).toBeNull()
  })

  it('prefers a site value over the global one', async () => {
    // A cold store and a dry goods warehouse do not share an expiry policy.
    await setSetting(prisma, 'expiry.issuePolicy', 'BLOCK', '')
    await setSetting(prisma, 'expiry.issuePolicy', 'WARN', wh.siteId)

    expect(await getSetting(prisma, 'expiry.issuePolicy', wh.siteId)).toBe('WARN')
    expect(await getSetting(prisma, 'expiry.issuePolicy', '')).toBe('BLOCK')
  })

  it('falls back to the default when a stored value cannot be read', async () => {
    // An old shape, or a hand-edited row. Policy that cannot be understood must
    // not be obeyed, and the safest reading is what the system shipped with.
    await prisma.setting.create({
      data: { key: 'expiry.issuePolicy', siteId: wh.siteId, value: 'NONSENSE' },
    })

    expect(await getSetting(prisma, 'expiry.issuePolicy', wh.siteId)).toBe('BLOCK')
  })

  it('refuses to store a value the setting does not accept', async () => {
    await expect(setSetting(prisma, 'adjust.maxQuantity', -5)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    })
    await expect(setSetting(prisma, 'expiry.issuePolicy', 'MAYBE')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    })
  })

  it('returns to the default when an override is cleared', async () => {
    await setSetting(prisma, 'adjust.maxQuantity', 10, wh.siteId)
    await clearSetting(prisma, 'adjust.maxQuantity', wh.siteId)

    expect(await getSetting(prisma, 'adjust.maxQuantity', wh.siteId)).toBeNull()
  })

  it('says which values are defaults and which were set', async () => {
    await setSetting(prisma, 'adjust.maxQuantity', 25, wh.siteId)

    const settings = await listSettings(prisma, wh.siteId)
    const limit = settings.find((setting) => setting.key === 'adjust.maxQuantity')
    const expiry = settings.find((setting) => setting.key === 'expiry.issuePolicy')

    expect(limit).toMatchObject({ value: 25, isDefault: false })
    expect(expiry).toMatchObject({ value: 'BLOCK', isDefault: true })
  })
})

describe('the adjustment cap actually caps adjustments', () => {
  it('allows one within the limit', async () => {
    await receive(wh.tapeId, wh.locationA, 100)
    await setSetting(prisma, 'adjust.maxQuantity', 10, wh.siteId)

    const outcome = await adjust(wh.tapeId, wh.locationA, 95)

    expect(outcome.status).toBe('RECORDED')
    expect(await onHand(wh.tapeId, wh.locationA)).toBe(95)
  })

  it('refuses one beyond it', async () => {
    await receive(wh.tapeId, wh.locationA, 100)
    await setSetting(prisma, 'adjust.maxQuantity', 10, wh.siteId)

    const outcome = await adjust(wh.tapeId, wh.locationA, 50)

    expect(outcome.status).toBe('REJECTED')
    if (outcome.status === 'REJECTED') {
      expect(outcome.error.code).toBe('ADJUSTMENT_TOO_LARGE')
      // The message says what to do instead, not just that it failed.
      expect(outcome.error.message).toMatch(/Count the location|raise the limit/)
    }
    expect(await onHand(wh.tapeId, wh.locationA)).toBe(100)
  })

  it('caps the DIFFERENCE, not the counted total', async () => {
    // Setting a shelf of 500 to 498 is a correction of two. Capping the total
    // would block every adjustment in a busy bin.
    await receive(wh.tapeId, wh.locationA, 500)
    await setSetting(prisma, 'adjust.maxQuantity', 10, wh.siteId)

    expect((await adjust(wh.tapeId, wh.locationA, 498)).status).toBe('RECORDED')
  })

  it('caps a correction in either direction', async () => {
    await receive(wh.tapeId, wh.locationA, 10)
    await setSetting(prisma, 'adjust.maxQuantity', 5, wh.siteId)

    expect((await adjust(wh.tapeId, wh.locationA, 100)).status).toBe('REJECTED')
  })

  it('does not cap anything when no limit is set', async () => {
    await receive(wh.tapeId, wh.locationA, 10)

    expect((await adjust(wh.tapeId, wh.locationA, 9_000)).status).toBe('RECORDED')
  })

  it('leaves other movement types alone', async () => {
    await setSetting(prisma, 'adjust.maxQuantity', 1, wh.siteId)

    // A receipt of 500 is not an adjustment; the cap must not touch it.
    expect((await receive(wh.tapeId, wh.locationA, 500)).status).toBe('RECORDED')
  })
})

describe('the auto-approve threshold actually reports on counts', () => {
  const startAndSubmit = async (counted: number) => {
    const { sessionId } = await startCount(
      prisma,
      { id: randomUUID(), siteId: wh.siteId, locationId: wh.locationA, method: 'MANUAL' },
      { userId: wh.userId },
    )
    return submitCount(prisma, sessionId, [
      { itemId: wh.tapeId, batchId: null, quantity: counted },
    ])
  }

  it('is off by default — a count that posts itself is a count nobody checked', async () => {
    await receive(wh.tapeId, wh.locationA, 100)

    expect((await startAndSubmit(99)).autoApprovable).toBe(false)
  })

  it('reports a small variance as auto-approvable once switched on', async () => {
    await receive(wh.tapeId, wh.locationA, 100)
    await setSetting(prisma, 'count.autoApproveThreshold', 5, wh.siteId)

    expect((await startAndSubmit(98)).autoApprovable).toBe(true)
  })

  it('does not report a large one', async () => {
    await receive(wh.tapeId, wh.locationA, 100)
    await setSetting(prisma, 'count.autoApproveThreshold', 5, wh.siteId)

    expect((await startAndSubmit(50)).autoApprovable).toBe(false)
  })

  it('never auto-approves a count with an uncounted line', async () => {
    // An uncounted line is a proposed write-off, whatever its size. Nobody
    // should be able to set a threshold that posts those unseen.
    await receive(wh.tapeId, wh.locationA, 2)
    // Batch-tracked, so it needs a batch — a receipt without one is refused,
    // which is why the first attempt at this test produced no second line.
    await recordMovement(
      prisma,
      {
        id: randomUUID(),
        siteId: wh.siteId,
        action: {
          kind: 'RECEIVE',
          itemId: wh.adhesiveId,
          toLocationId: wh.locationA,
          quantity: 2,
          batchId: wh.freshBatchId,
        },
        source: MovementSource.WEB,
      },
      { userId: wh.userId },
    )
    await setSetting(prisma, 'count.autoApproveThreshold', 100, wh.siteId)

    const { sessionId } = await startCount(
      prisma,
      { id: randomUUID(), siteId: wh.siteId, locationId: wh.locationA, method: 'MANUAL' },
      { userId: wh.userId },
    )
    // Only the tape is counted; the adhesive line is never looked at.
    const result = await submitCount(prisma, sessionId, [
      { itemId: wh.tapeId, batchId: null, quantity: 2 },
    ])

    expect(result.summary.missing).toBeGreaterThan(0)
    expect(result.autoApprovable).toBe(false)
  })

  it('still writes nothing to the ledger on submit', async () => {
    // Auto-approvable is a REPORT, not an action. Submitting stores the
    // variance and posts nothing, whatever the threshold says (WADR-008).
    await receive(wh.tapeId, wh.locationA, 100)
    await setSetting(prisma, 'count.autoApproveThreshold', 50, wh.siteId)

    await startAndSubmit(99)

    expect(await onHand(wh.tapeId, wh.locationA)).toBe(100)
  })
})
