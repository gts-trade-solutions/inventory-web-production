import { z } from 'zod'
import { apiRoute } from '@/lib/api/handler'
import { allocateEpcBlock } from '@/lib/services/epc'

const schema = z.object({
  itemId: z.string().uuid(),
  count: z.number().int().positive().max(10_000).optional(),
})

/**
 * A block of RFID serials the device encodes from while offline.
 *
 * Blocks are never reissued, which is what stops two phones minting the same
 * EPC (WADR-009).
 */
export const POST = apiRoute({ schema }, async ({ db, body, claims }) =>
  allocateEpcBlock(db, {
    itemId: body.itemId,
    count: body.count,
    deviceId: claims.deviceId,
  }),
)
