import { z } from 'zod'
import { apiRoute } from '@/lib/api/handler'
import { push } from '@/lib/services/sync'

const movementSchema = z.object({
  id: z.string().uuid(),
  itemId: z.string().uuid(),
  type: z.enum(['RECEIVE', 'ISSUE', 'MOVE', 'ADJUST', 'SCRAP', 'COUNT']),
  quantity: z.number().int().min(0),
  batchId: z.string().uuid().nullable().optional(),
  serialUnitIds: z.array(z.string().uuid()).max(500).optional(),
  fromLocationId: z.string().uuid().nullable().optional(),
  toLocationId: z.string().uuid().nullable().optional(),
  reasonCodeId: z.string().uuid().nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
  reference: z.string().max(120).nullable().optional(),
  occurredAt: z.string().datetime({ offset: true }),
  siteId: z.string().uuid(),
  deviceId: z.string().uuid().nullable().optional(),
  countSessionId: z.string().uuid().nullable().optional(),
})

const schema = z.object({
  // Batched, but judged per row. 200 is the documented ceiling; a bigger batch
  // holds locks longer than a warehouse wants to wait.
  movements: z.array(movementSchema).max(200),
})

export const POST = apiRoute({ schema }, async ({ db, body, claims }) =>
  // siteIds comes from the SIGNED token, never from the body. Each movement
  // names its own site and is checked against this before it is recorded.
  push(db, body.movements, {
    userId: claims.userId,
    deviceId: claims.deviceId,
    siteIds: claims.siteIds,
  }),
)
