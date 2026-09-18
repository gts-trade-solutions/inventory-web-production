import { afterAll, describe, expect, it } from 'vitest'
import { resetDemoData } from '@/lib/services/demo-reset'
import { ModeViolationError } from '@/lib/mode'
import { prisma, seedWarehouse } from './helpers/warehouse'

/**
 * The demo reset.
 *
 * The property that matters is the one that cannot be walked back: this must
 * never run against live data. The seed script has its own refusal, and the
 * service asserts the mode on its first line, so there are two independent
 * guards — these tests cover the one this file owns.
 *
 * The happy path is not exercised here on purpose. It would shell out to
 * `npm run db:seed:demo`, which wipes and reseeds the DEMO database — running
 * that from the test suite would destroy whatever the developer had on screen,
 * which is exactly the kind of surprise the test database exists to prevent.
 * The browser smoke test clicks the real button instead.
 */

afterAll(async () => {
  await prisma.$disconnect()
})

describe('mode enforcement', () => {
  it('refuses in LIVE mode before doing anything', async () => {
    const wh = await seedWarehouse()
    const before = await prisma.item.count()

    await expect(resetDemoData(prisma, 'LIVE', { userId: wh.userId })).rejects.toBeInstanceOf(
      ModeViolationError,
    )

    // Nothing was touched. The assertion is the first line of the function
    // precisely so that a LIVE call cannot get far enough to matter.
    expect(await prisma.item.count()).toBe(before)
  })

  it('names the operation it refused', async () => {
    const wh = await seedWarehouse()

    await expect(resetDemoData(prisma, 'LIVE', { userId: wh.userId })).rejects.toThrow(
      /Resetting the demo data.*DEMO mode/i,
    )
  })

  it('writes no audit entry for a refused reset', async () => {
    // The refusal happens before anything is recorded, so a LIVE attempt leaves
    // no trace suggesting a reset was considered against live data.
    const wh = await seedWarehouse()
    await prisma.auditLog.deleteMany()

    await expect(resetDemoData(prisma, 'LIVE', { userId: wh.userId })).rejects.toThrow()

    expect(await prisma.auditLog.count({ where: { action: 'DEMO_RESET' } })).toBe(0)
  })
})
