'use server'

import { revalidatePath } from 'next/cache'
import { DeviceConnection, DeviceKind, UserRole } from '@prisma/client'
import { z } from 'zod'
import { requireRole } from '@/lib/auth/guards'
import { reactivateDevice, registerDevice, retireDevice } from '@/lib/services/devices'
import { AuditAction, writeAudit } from '@/lib/audit'

/**
 * Registering and retiring shared hardware.
 *
 * Admin-only, because a printer or a fixed reader is shared equipment with a
 * network address — getting it wrong sends everybody's labels to the wrong bay.
 * Scanners and handsets register themselves on first connection instead
 * (DEVICE_INTEGRATION §7).
 */

const schema = z.object({
  label: z.string().trim().min(1, 'Give the device a name people will recognise.').max(120),
  kind: z.nativeEnum(DeviceKind),
  connection: z.nativeEnum(DeviceConnection),
  address: z.string().trim().max(120).optional(),
  vendor: z.string().trim().max(60).optional(),
  model: z.string().trim().max(60).optional(),
  siteId: z.string().uuid().optional(),
})

export interface DeviceFormState {
  error?: string
  message?: string
}

export async function registerDeviceAction(
  _prev: DeviceFormState,
  formData: FormData,
): Promise<DeviceFormState> {
  const user = await requireRole(UserRole.ADMIN)

  const parsed = schema.safeParse({
    label: formData.get('label'),
    kind: formData.get('kind'),
    connection: formData.get('connection'),
    address: formData.get('address') || undefined,
    vendor: formData.get('vendor') || undefined,
    model: formData.get('model') || undefined,
    siteId: formData.get('siteId') || undefined,
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form.' }
  }

  try {
    const device = await registerDevice(user.db, parsed.data)

    await writeAudit(user.db, {
      actorUserId: user.userId,
      action: AuditAction.CREATE,
      entity: 'Device',
      entityId: device.id,
      after: { label: device.label, kind: device.kind, address: device.address },
    })

    revalidatePath('/devices')
    return {
      message: device.simulated
        ? `${device.label} added. It has no network address, so it will stand in as a simulator until one is set.`
        : `${device.label} added at ${device.address}. Run its self-test to check it answers.`,
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'That device could not be registered.',
    }
  }
}

export async function setDeviceActiveAction(
  _prev: DeviceFormState,
  formData: FormData,
): Promise<DeviceFormState> {
  const user = await requireRole(UserRole.ADMIN)

  const deviceId = String(formData.get('deviceId') ?? '')
  const active = formData.get('active') === 'true'

  if (!z.string().uuid().safeParse(deviceId).success) {
    return { error: 'That device could not be identified.' }
  }

  const before = await user.db.device.findUnique({
    where: { id: deviceId },
    select: { label: true, active: true },
  })
  if (!before) return { error: 'That device is not registered.' }

  // Retiring deactivates rather than deletes: movements and print jobs point at
  // the row, and deleting it breaks the answer to "which scanner recorded
  // this?" — the only reason the column exists.
  if (active) await reactivateDevice(user.db, deviceId)
  else await retireDevice(user.db, deviceId)

  await writeAudit(user.db, {
    actorUserId: user.userId,
    action: active ? AuditAction.UPDATE : AuditAction.DELETE,
    entity: 'Device',
    entityId: deviceId,
    before: { active: before.active },
    after: { active },
  })

  revalidatePath('/devices')
  return {
    message: active
      ? `${before.label} is back in service.`
      : `${before.label} retired. Its history is kept, and it can be brought back.`,
  }
}
