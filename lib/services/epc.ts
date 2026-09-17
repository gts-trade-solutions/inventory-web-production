import 'server-only'
import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import type { Db } from '@/lib/db'
import { ApiError, ErrorCode } from '@/lib/api/errors'
import { isValidEan13 } from '@/lib/domain/gtin'
import { MAX_SERIAL, fromGtin13 } from '@/lib/domain/sgtin96'
import { withDeadlockRetry } from './tx'

/**
 * RFID serial-block allocation.
 *
 * The server owns serial numbers because devices encode labels offline. Left to
 * themselves, two phones printing tags for the same item will eventually mint
 * the same EPC — and two physical tags claiming to be the same unit is
 * effectively unrecoverable: you cannot tell which box is which without
 * unpacking both (WADR-009).
 *
 * So a device asks for a BLOCK, draws from it offline, and comes back for
 * another when it runs low. Blocks are never reissued, and the allocation is
 * serialised per item.
 */

export interface EpcBlock {
  itemId: string
  gtin13: string
  serialFrom: number
  serialTo: number
  expiresAt: Date | null
  /** A worked example, so a client can check its own encoder against ours. */
  sampleEpc: string
}

const DEFAULT_COUNT = 200
const MAX_COUNT = 10_000
/** Unused blocks are not recycled, but they do stop counting as outstanding. */
const BLOCK_TTL_DAYS = 90

export async function allocateEpcBlock(
  prisma: PrismaClient,
  input: { itemId: string; count?: number; deviceId?: string | null },
): Promise<EpcBlock> {
  const count = Math.min(Math.max(input.count ?? DEFAULT_COUNT, 1), MAX_COUNT)

  return withDeadlockRetry(
    prisma,
    async (tx) => {
      const item = await lockItem(tx, input.itemId)

      const gtin13 = await primaryGtin(tx, input.itemId)
      if (!gtin13) {
        throw new ApiError(
          ErrorCode.VALIDATION_FAILED,
          'This item has no valid EAN-13 barcode, so an SGTIN EPC cannot be built for it. Add one first.',
          { itemId: input.itemId },
        )
      }

      // The item row is locked, so this maximum cannot move underneath us. Two
      // devices asking at the same moment queue rather than overlap.
      const [highest] = await tx.$queryRaw<Array<{ maxTo: bigint | null }>>`
        SELECT MAX(serialTo) AS maxTo FROM epc_serial_blocks WHERE itemId = ${item.id}
      `

      const serialFrom = Number(highest?.maxTo ?? 0) + 1
      const serialTo = serialFrom + count - 1

      if (serialTo > MAX_SERIAL) {
        // 2^38 serials per GTIN. Reaching this means something is wrong with how
        // blocks are being requested, not that the warehouse is enormous.
        throw new ApiError(
          ErrorCode.CONFLICT,
          'This item has exhausted its SGTIN-96 serial range. Investigate before allocating more.',
          { serialFrom, max: MAX_SERIAL },
        )
      }

      const expiresAt = new Date(Date.now() + BLOCK_TTL_DAYS * 86_400_000)

      await tx.epcSerialBlock.create({
        data: {
          id: randomUUID(),
          itemId: item.id,
          deviceId: input.deviceId ?? null,
          serialFrom: BigInt(serialFrom),
          serialTo: BigInt(serialTo),
          expiresAt,
        },
      })

      return {
        itemId: item.id,
        gtin13,
        serialFrom,
        serialTo,
        expiresAt,
        sampleEpc: fromGtin13(gtin13, serialFrom),
      }
    },
    { label: 'allocate EPC block' },
  )
}

/**
 * Locks the item row for the duration of the allocation.
 *
 * Locking the item rather than the block table is what serialises two devices
 * asking for the same item at the same instant. Without it both read the same
 * maximum and receive overlapping blocks — the exact failure this service
 * exists to prevent.
 */
async function lockItem(tx: Db, itemId: string): Promise<{ id: string }> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM items WHERE id = ${itemId} AND deletedAt IS NULL FOR UPDATE
  `

  const item = rows[0]
  if (!item) throw new ApiError(ErrorCode.NOT_FOUND, 'That item does not exist.')
  return item
}

/** The item's primary EAN-13, which the SGTIN is built from. */
async function primaryGtin(tx: Db, itemId: string): Promise<string | null> {
  const barcodes = await tx.itemBarcode.findMany({
    where: { itemId, type: 'EAN13' },
    select: { barcode: true, isPrimary: true },
    orderBy: { isPrimary: 'desc' },
  })

  return barcodes.find((barcode) => isValidEan13(barcode.barcode))?.barcode ?? null
}

/** What a device still holds, so it can decide whether to ask for more. */
export async function outstandingBlocks(prisma: PrismaClient, deviceId: string) {
  return prisma.epcSerialBlock.findMany({
    where: { deviceId, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    select: {
      itemId: true,
      serialFrom: true,
      serialTo: true,
      consumedTo: true,
      expiresAt: true,
    },
    orderBy: { allocatedAt: 'desc' },
  })
}
