import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { allocateEpcBlock } from '@/lib/services/epc'
import { decode, fromGtin13 } from '@/lib/domain/sgtin96'
import { ean13 } from '@/lib/domain/gtin'
import { prisma, seedWarehouse, type Warehouse } from './helpers/warehouse'

/**
 * RFID serial-block allocation.
 *
 * The property under test is that two blocks never overlap. An overlap means two
 * physical tags claiming to be the same unit, which cannot be resolved without
 * unpacking both boxes — so this is tested under real concurrency rather than
 * reasoned about (WADR-009).
 */

let wh: Warehouse
let gtin: string

beforeEach(async () => {
  wh = await seedWarehouse()

  // SGTIN-96 is built from the item's EAN-13, so the item needs a valid one.
  gtin = ean13('890123400004')
  await prisma.itemBarcode.create({
    data: { id: randomUUID(), itemId: wh.drillId, barcode: gtin, type: 'EAN13', isPrimary: true },
  })
})

afterAll(async () => {
  await prisma.$disconnect()
})

describe('allocateEpcBlock', () => {
  it('allocates a contiguous block starting at 1', async () => {
    const block = await allocateEpcBlock(prisma, { itemId: wh.drillId, count: 100 })

    expect(block.serialFrom).toBe(1)
    expect(block.serialTo).toBe(100)
    expect(block.gtin13).toBe(gtin)
  })

  it('continues where the previous block ended', async () => {
    const first = await allocateEpcBlock(prisma, { itemId: wh.drillId, count: 50 })
    const second = await allocateEpcBlock(prisma, { itemId: wh.drillId, count: 50 })

    expect(second.serialFrom).toBe(first.serialTo + 1)
  })

  it('never issues overlapping blocks under concurrency', async () => {
    // THE test. Twelve devices asking at once. Without the row lock they all
    // read the same maximum and receive the same serials.
    const blocks = await Promise.all(
      Array.from({ length: 12 }, () => allocateEpcBlock(prisma, { itemId: wh.drillId, count: 25 })),
    )

    const sorted = [...blocks].sort((a, b) => a.serialFrom - b.serialFrom)

    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]!.serialFrom).toBeGreaterThan(sorted[i - 1]!.serialTo)
    }

    // And together they cover a contiguous range with no gaps.
    expect(sorted[0]!.serialFrom).toBe(1)
    expect(sorted[sorted.length - 1]!.serialTo).toBe(12 * 25)
  })

  it('keeps items independent', async () => {
    const otherGtin = ean13('890123400010')
    await prisma.itemBarcode.create({
      data: {
        id: randomUUID(),
        itemId: wh.tapeId,
        barcode: otherGtin,
        type: 'EAN13',
        isPrimary: true,
      },
    })

    await allocateEpcBlock(prisma, { itemId: wh.drillId, count: 500 })
    const other = await allocateEpcBlock(prisma, { itemId: wh.tapeId, count: 10 })

    // Serials are scoped to the GTIN, so another item starts at 1 again.
    expect(other.serialFrom).toBe(1)
  })

  it('returns a sample EPC the client can check its own encoder against', async () => {
    const block = await allocateEpcBlock(prisma, { itemId: wh.drillId, count: 5 })

    expect(block.sampleEpc).toBe(fromGtin13(gtin, block.serialFrom))

    const decoded = decode(block.sampleEpc)
    expect(decoded?.serial).toBe(block.serialFrom)
  })

  it('refuses an item with no valid EAN-13', async () => {
    // Without a GTIN there is nothing to build an SGTIN from, and saying so
    // beats handing back serials that cannot become tags.
    await expect(allocateEpcBlock(prisma, { itemId: wh.adhesiveId })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    })
  })

  it('refuses an unknown item', async () => {
    await expect(allocateEpcBlock(prisma, { itemId: randomUUID() })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('records which device holds the block', async () => {
    const deviceId = randomUUID()
    await prisma.device.create({
      data: { id: deviceId, label: 'Test phone', kind: 'MOBILE_COMPUTER' },
    })

    await allocateEpcBlock(prisma, { itemId: wh.drillId, count: 10, deviceId })

    const stored = await prisma.epcSerialBlock.findFirstOrThrow({ where: { deviceId } })
    expect(Number(stored.serialFrom)).toBe(1)
  })

  it('caps an unreasonable request rather than refusing it', async () => {
    // A client asking for a million serials is misconfigured, not malicious.
    // Giving it the maximum keeps it working while the request gets fixed.
    const block = await allocateEpcBlock(prisma, { itemId: wh.drillId, count: 5_000_000 })

    expect(block.serialTo - block.serialFrom + 1).toBe(10_000)
  })
})
