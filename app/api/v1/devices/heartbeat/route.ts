import { z } from 'zod'
import { apiRoute } from '@/lib/api/handler'

const schema = z.object({
  appVersion: z.string().max(40).optional(),
  pendingCount: z.number().int().min(0).optional(),
  batteryPercent: z.number().int().min(0).max(100).optional(),
})

/**
 * Keeps `lastSeenAt` current, and reports how much the device is still holding.
 *
 * `pendingCount` is the useful field: a phone with 40 unsynced movements and a
 * recent heartbeat is reaching the server but failing to push, which looks
 * nothing like a phone that is simply out of range.
 */
export const POST = apiRoute({ schema }, async ({ db, body, claims }) => {
  if (!claims.deviceId) {
    return { ok: true, note: 'This token is not bound to a device, so nothing was recorded.' }
  }

  await db.device.update({
    where: { id: claims.deviceId },
    data: { lastSeenAt: new Date(), appVersion: body.appVersion ?? undefined },
  })

  return { ok: true, deviceId: claims.deviceId, pendingCount: body.pendingCount ?? null }
})
