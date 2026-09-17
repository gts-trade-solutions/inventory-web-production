'use server'

import { revalidatePath } from 'next/cache'
import { BatchStatus, UserRole } from '@prisma/client'
import { z } from 'zod'
import { requireRole } from '@/lib/auth/guards'
import { AuditAction, writeAudit } from '@/lib/audit'

/**
 * Quarantine and release.
 *
 * Quarantining does NOT move stock — the units stay exactly where they are and
 * keep counting towards on-hand. It only makes them unusable, which is what an
 * investigation actually needs: find it, freeze it, decide later. Moving it
 * would destroy the evidence of where it was.
 *
 * Supervisor or above (ARCHITECTURE §6).
 */

const schema = z.object({
  batchId: z.string().uuid(),
  status: z.enum([BatchStatus.QUARANTINE, BatchStatus.BLOCKED, BatchStatus.ACTIVE]),
  note: z.string().max(1000).optional(),
})

export interface BatchActionState {
  error?: string
  message?: string
}

export async function setBatchStatusAction(
  _prev: BatchActionState,
  formData: FormData,
): Promise<BatchActionState> {
  const user = await requireRole(UserRole.SUPERVISOR)

  const parsed = schema.safeParse({
    batchId: formData.get('batchId'),
    status: formData.get('status'),
    note: formData.get('note') || undefined,
  })
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'That request is not valid.' }
  }

  const { batchId, status, note } = parsed.data

  const batch = await user.db.batch.findUnique({
    where: { id: batchId },
    select: { id: true, batchNo: true, status: true, notes: true },
  })
  if (!batch) return { error: 'That batch does not exist.' }
  if (batch.status === status) return { error: `That batch is already ${status.toLowerCase()}.` }

  await user.db.$transaction(async (tx) => {
    await tx.batch.update({
      where: { id: batchId },
      data: { status, notes: note ?? batch.notes },
    })

    await writeAudit(tx, {
      actorUserId: user.userId,
      action: status === BatchStatus.ACTIVE ? AuditAction.RELEASE : AuditAction.QUARANTINE,
      entity: 'Batch',
      entityId: batchId,
      before: { status: batch.status },
      after: { status, note: note ?? null },
    })
  })

  revalidatePath(`/batches/${batchId}`)
  revalidatePath('/batches')

  return {
    message:
      status === BatchStatus.ACTIVE
        ? `${batch.batchNo} released. It can be issued again.`
        : `${batch.batchNo} is ${status.toLowerCase()}. Its stock stays on the shelf but cannot be issued.`,
  }
}
