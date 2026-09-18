import { z } from 'zod'
import { DeviceConnection, DeviceKind, UserRole } from '@prisma/client'
import { apiRoute } from '@/lib/api/handler'
import { listDevices, registerDevice } from '@/lib/services/devices'

const schema = z.object({
  label: z.string().min(1).max(120),
  kind: z.nativeEnum(DeviceKind),
  connection: z.nativeEnum(DeviceConnection),
  address: z.string().max(120).nullable().optional(),
  vendor: z.string().max(60).nullable().optional(),
  model: z.string().max(60).nullable().optional(),
  serial: z.string().max(120).nullable().optional(),
  siteId: z.string().uuid().nullable().optional(),
})

/** The registry, so a phone can show what hardware is available at its site. */
export const GET = apiRoute({}, async ({ db, request }) => {
  const kind = new URL(request.url).searchParams.get('kind')?.toUpperCase()

  return {
    devices: await listDevices(db, {
      kind: kind && kind in DeviceKind ? (kind as DeviceKind) : undefined,
    }),
  }
})

/**
 * Registering a printer or fixed reader is an admin job: it is shared hardware
 * with a network address. Scanners and handsets self-register on sign-in
 * instead (DEVICE_INTEGRATION §7).
 */
export const POST = apiRoute({ schema, minimumRole: UserRole.ADMIN }, async ({ db, body }) =>
  registerDevice(db, body),
)
