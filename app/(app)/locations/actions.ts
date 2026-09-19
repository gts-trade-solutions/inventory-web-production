'use server'

import { revalidatePath } from 'next/cache'
import { LocationZone, UserRole } from '@prisma/client'
import { z } from 'zod'
import { requireRole } from '@/lib/auth/guards'
import { ApiError } from '@/lib/api/errors'
import { createLocation, deleteLocation, updateLocation } from '@/lib/services/locations'

/**
 * Location administration.
 *
 * Thin: every rule lives in `lib/services/locations.ts`, so the same rules hold
 * when a location arrives by CSV import or over the API. A guard that exists
 * only in a Server Action is a guard the other routes into the data do not have.
 */

export interface LocationState {
  /** When this result was produced, so the newest one wins the notice. */
  at?: number
  error?: string
  message?: string
}

function explain(error: unknown, fallback: string): LocationState {
  if (error instanceof ApiError) return { error: error.message, at: Date.now() }

  console.error(error)
  return { error: fallback, at: Date.now() }
}

const createSchema = z.object({
  siteId: z.string().uuid('Choose a site.'),
  code: z.string().trim().min(1, 'Enter a location code.').max(32),
  name: z.string().trim().min(1, 'Enter a location name.').max(120),
  zone: z.nativeEnum(LocationZone),
})

export async function createLocationAction(
  _prev: LocationState,
  formData: FormData,
): Promise<LocationState> {
  const user = await requireRole(UserRole.ADMIN)

  const parsed = createSchema.safeParse({
    siteId: formData.get('siteId'),
    code: formData.get('code'),
    name: formData.get('name'),
    zone: formData.get('zone'),
  })
  if (!parsed.success)
    return { error: parsed.error.issues[0]?.message ?? 'Check the form.', at: Date.now() }

  try {
    const created = await createLocation(user.db, parsed.data, { userId: user.userId })
    revalidatePath('/locations')
    return { message: `${created.code} added.`, at: Date.now() }
  } catch (error) {
    return explain(error, 'The location could not be created.')
  }
}

export async function updateLocationAction(
  _prev: LocationState,
  formData: FormData,
): Promise<LocationState> {
  const user = await requireRole(UserRole.ADMIN)

  const id = String(formData.get('id') ?? '')
  if (!id) return { error: 'That location does not exist.', at: Date.now() }

  // Only the fields this particular form carried, so a small form can rename
  // without also reasserting a zone it never showed.
  const changes: Parameters<typeof updateLocation>[2] = {}
  if (formData.has('code')) changes.code = String(formData.get('code') ?? '')
  if (formData.has('name')) changes.name = String(formData.get('name') ?? '')
  if (formData.has('active')) changes.active = formData.get('active') === 'true'
  if (formData.has('zone')) {
    const zone = String(formData.get('zone') ?? '')
    if (zone in LocationZone) changes.zone = zone as LocationZone
  }

  try {
    await updateLocation(user.db, id, changes, { userId: user.userId })
  } catch (error) {
    return explain(error, 'The location could not be changed.')
  }

  revalidatePath('/locations')
  return { message: 'Location updated.', at: Date.now() }
}

export async function deleteLocationAction(
  _prev: LocationState,
  formData: FormData,
): Promise<LocationState> {
  const user = await requireRole(UserRole.ADMIN)

  const id = String(formData.get('id') ?? '')
  if (!id) return { error: 'That location does not exist.', at: Date.now() }

  try {
    await deleteLocation(user.db, id, { userId: user.userId })
  } catch (error) {
    return explain(error, 'The location could not be removed.')
  }

  revalidatePath('/locations')
  return { message: 'Location removed.', at: Date.now() }
}
