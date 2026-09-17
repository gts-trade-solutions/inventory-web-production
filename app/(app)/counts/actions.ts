'use server'

import { randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { CountMethod, UserRole } from '@prisma/client'
import { z } from 'zod'
import { requireRole, requireUser } from '@/lib/auth/guards'
import { approveCount, rejectCount, startCount, submitCount } from '@/lib/services/counts'
import { resolveScan } from '@/lib/services/scan'

/**
 * Server Actions for the cycle-count lifecycle.
 *
 * Submitting and approving are separate on purpose: submitting stores the
 * variance and writes nothing to the ledger, and only an approval posts the
 * COUNT movements (WADR-008). The role gate is on approval, not on counting —
 * anyone can count, but only a supervisor decides the result is true.
 */

export interface CountActionState {
  error?: string
  message?: string
}

// --- starting -------------------------------------------------------------

export async function startCountAction(
  _prev: CountActionState,
  formData: FormData,
): Promise<CountActionState> {
  const user = await requireUser()

  const parsed = z
    .object({
      locationId: z.string().uuid('Choose a location to count.'),
      method: z.nativeEnum(CountMethod).default(CountMethod.BARCODE),
    })
    .safeParse({
      locationId: formData.get('locationId'),
      method: formData.get('method') || undefined,
    })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form.' }
  }

  const siteId = user.defaultSiteId ?? user.siteIds[0]
  if (!siteId) return { error: 'Your account is not assigned to a site.' }

  let sessionId: string
  try {
    const result = await startCount(
      user.db,
      { id: randomUUID(), siteId, locationId: parsed.data.locationId, method: parsed.data.method },
      { userId: user.userId },
    )
    sessionId = result.sessionId
  } catch (error) {
    return { error: messageOf(error, 'That count could not be started.') }
  }

  revalidatePath('/counts')
  redirect(`/counts/${sessionId}`)
}

// --- counting -------------------------------------------------------------

/** Resolves a scan while counting, so the operator sees what they just picked up. */
export async function resolveCountScanAction(code: string) {
  const user = await requireUser()
  const siteId = user.defaultSiteId ?? user.siteIds[0]
  if (!siteId) return null

  return resolveScan(user.db, code, siteId)
}

const countedSchema = z.array(
  z.object({
    itemId: z.string().uuid(),
    batchId: z.string().uuid().nullable(),
    quantity: z.coerce.number().int().min(0),
  }),
)

export async function submitCountAction(
  _prev: CountActionState,
  formData: FormData,
): Promise<CountActionState> {
  const user = await requireUser()

  const sessionId = String(formData.get('sessionId') ?? '')
  if (!z.string().uuid().safeParse(sessionId).success) {
    return { error: 'That count session does not exist.' }
  }

  let counted: z.infer<typeof countedSchema>
  try {
    counted = countedSchema.parse(JSON.parse(String(formData.get('counted') ?? '[]')))
  } catch {
    return { error: 'The counted figures could not be read. Nothing was submitted.' }
  }

  try {
    await submitCount(user.db, sessionId, counted)
  } catch (error) {
    return { error: messageOf(error, 'That count could not be submitted.') }
  }

  revalidatePath(`/counts/${sessionId}`)
  revalidatePath('/counts')

  return { message: 'Submitted for approval. No stock has changed yet.' }
}

// --- approving ------------------------------------------------------------

export async function approveCountAction(
  _prev: CountActionState,
  formData: FormData,
): Promise<CountActionState> {
  // Counting is open to anyone; deciding the count is true is not.
  const user = await requireRole(UserRole.SUPERVISOR)
  const sessionId = String(formData.get('sessionId') ?? '')

  try {
    const result = await approveCount(user.db, sessionId, { userId: user.userId })

    revalidatePath(`/counts/${sessionId}`)
    revalidatePath('/counts')
    revalidatePath('/movements')
    revalidatePath('/inventory')

    return {
      message:
        result.postings === 0
          ? 'Approved. The count matched, so nothing was posted.'
          : `Approved. ${result.postings} correction${result.postings === 1 ? '' : 's'} posted to the ledger.`,
    }
  } catch (error) {
    return { error: messageOf(error, 'That count could not be approved.') }
  }
}

export async function rejectCountAction(
  _prev: CountActionState,
  formData: FormData,
): Promise<CountActionState> {
  const user = await requireRole(UserRole.SUPERVISOR)
  const sessionId = String(formData.get('sessionId') ?? '')
  const note = String(formData.get('note') ?? '').trim() || undefined

  try {
    await rejectCount(user.db, sessionId, { userId: user.userId }, note)

    revalidatePath(`/counts/${sessionId}`)
    revalidatePath('/counts')

    return { message: 'Rejected. Nothing was posted; the location needs recounting.' }
  } catch (error) {
    return { error: messageOf(error, 'That count could not be rejected.') }
  }
}

/**
 * Surfaces the service's own message where it has one.
 *
 * ApiError carries copy written for the person reading it — "only a submitted
 * count can be approved" is more use than "something went wrong".
 */
function messageOf(error: unknown, fallback: string): string {
  if (error instanceof Error && 'code' in error && typeof error.message === 'string') {
    return error.message
  }
  return fallback
}
