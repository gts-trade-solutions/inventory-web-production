'use server'

import { revalidatePath } from 'next/cache'
import { BatchStatus, UserRole } from '@prisma/client'
import { z } from 'zod'
import { requireRole } from '@/lib/auth/guards'
import { ApiError } from '@/lib/api/errors'
import { bulkSetBatchStatus, type BulkResult } from '@/lib/services/bulk'

/**
 * Freezing or releasing many batches at once.
 *
 * The operation a recall actually needs: a quality manager holding a
 * supplier's defect notice has a list of lot numbers, not one. Doing them one
 * at a time is how the twelfth gets missed.
 *
 * Supervisor or above, exactly as the single-batch action is — a bulk path
 * with a lower bar would be a way around the role that guards the slow one.
 */

const schema = z.object({
  batchIds: z.array(z.string().uuid()).min(1, 'Nothing was selected.'),
  status: z.enum([BatchStatus.QUARANTINE, BatchStatus.BLOCKED, BatchStatus.ACTIVE]),
  note: z.string().max(1000).optional(),
})

export interface BulkBatchState {
  at?: number
  error?: string
  result?: BulkResult
}

export async function bulkBatchStatusAction(
  _prev: BulkBatchState,
  formData: FormData,
): Promise<BulkBatchState> {
  const user = await requireRole(UserRole.SUPERVISOR)

  const parsed = schema.safeParse({
    batchIds: formData.getAll('batchIds').map(String),
    status: formData.get('status'),
    note: formData.get('note') || undefined,
  })
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the selection.', at: Date.now() }
  }

  try {
    const result = await bulkSetBatchStatus(
      user.db,
      parsed.data.batchIds,
      parsed.data.status,
      { note: parsed.data.note ?? null },
      { userId: user.userId },
    )

    revalidatePath('/batches')
    return { result, at: Date.now() }
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message, at: Date.now() }

    console.error(error)
    return { error: 'Those batches could not be changed.', at: Date.now() }
  }
}
