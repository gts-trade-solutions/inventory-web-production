'use server'

import { randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { ReasonScope, UserRole } from '@prisma/client'
import { z } from 'zod'
import { requireRole } from '@/lib/auth/guards'
import { AuditAction, writeAudit } from '@/lib/audit'

/**
 * Reason codes: the controlled list behind every adjustment and scrap.
 *
 * Free-text reasons are unauditable and unreportable — "damaged", "Damaged",
 * "dmg" and "broke in transit" are the same fact and no report can group them
 * (WADR-022). This is where the list is curated.
 */

const schema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(32)
    .regex(/^[A-Z0-9_]+$/, 'Use capitals, digits and underscores, e.g. WATER_DAMAGE.'),
  label: z.string().trim().min(1, 'Enter a label operators will recognise.').max(120),
  appliesTo: z.nativeEnum(ReasonScope),
  requiresNote: z.boolean(),
})

export interface ReasonCodeState {
  error?: string
  message?: string
}

export async function createReasonCodeAction(
  _prev: ReasonCodeState,
  formData: FormData,
): Promise<ReasonCodeState> {
  const user = await requireRole(UserRole.ADMIN)

  const parsed = schema.safeParse({
    code: String(formData.get('code') ?? '').toUpperCase(),
    label: formData.get('label'),
    appliesTo: formData.get('appliesTo'),
    requiresNote: formData.get('requiresNote') === 'on',
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form.' }
  }

  const existing = await user.db.reasonCode.findUnique({
    where: { code: parsed.data.code },
    select: { id: true, active: true },
  })

  if (existing) {
    return {
      error: existing.active
        ? `${parsed.data.code} already exists.`
        : `${parsed.data.code} exists but is retired. Restore it instead of creating a duplicate.`,
    }
  }

  await user.db.$transaction(async (tx) => {
    const created = await tx.reasonCode.create({ data: { id: randomUUID(), ...parsed.data } })
    await writeAudit(tx, {
      actorUserId: user.userId,
      action: AuditAction.CREATE,
      entity: 'ReasonCode',
      entityId: created.id,
      after: parsed.data,
    })
  })

  revalidatePath('/admin/reason-codes')
  return { message: `${parsed.data.code} added.` }
}

/**
 * Retires or restores a code.
 *
 * Never deletes. Movements reference reason codes, and the ledger is
 * append-only — removing the row would leave recorded movements pointing at
 * nothing, and the reason a correction was made is part of why it is auditable.
 * Retiring hides it from the pickers and leaves history intact.
 */
export async function toggleReasonCodeAction(
  _prev: ReasonCodeState,
  formData: FormData,
): Promise<ReasonCodeState> {
  const user = await requireRole(UserRole.ADMIN)

  const id = String(formData.get('id') ?? '')
  const active = formData.get('active') === 'true'

  const reason = await user.db.reasonCode.findUnique({
    where: { id },
    select: { id: true, code: true, active: true },
  })
  if (!reason) return { error: 'That reason code does not exist.' }

  await user.db.$transaction(async (tx) => {
    await tx.reasonCode.update({ where: { id }, data: { active } })
    await writeAudit(tx, {
      actorUserId: user.userId,
      action: AuditAction.UPDATE,
      entity: 'ReasonCode',
      entityId: id,
      before: { active: reason.active },
      after: { active },
    })
  })

  revalidatePath('/admin/reason-codes')
  return { message: active ? `${reason.code} restored.` : `${reason.code} retired.` }
}
