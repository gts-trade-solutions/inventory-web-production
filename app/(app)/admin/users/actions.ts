'use server'

import { revalidatePath } from 'next/cache'
import { UserRole } from '@prisma/client'
import { z } from 'zod'
import { requireRole } from '@/lib/auth/guards'
import { createUser, resetPassword, updateUser } from '@/lib/services/users'
import { AuditAction, writeAudit } from '@/lib/audit'

/**
 * User administration.
 *
 * Administrator only, and audited: who was given access, by whom, and when, is
 * the first question asked after anything goes wrong.
 *
 * A generated password is returned once and never stored in plain text. There
 * is no email service yet, so an invitation link would go nowhere — a password
 * the administrator reads out is honest about that, and is how a warehouse
 * actually works when somebody is locked out at six in the morning.
 */

export interface UserFormState {
  error?: string
  message?: string
  /** Shown once, then gone. Never persisted and never re-displayable. */
  password?: string
  passwordFor?: string
}

const createSchema = z.object({
  email: z.string().trim().email('That is not an email address.').max(200),
  name: z.string().trim().min(1, 'Give the person a name.').max(120),
  role: z.nativeEnum(UserRole),
  siteIds: z.array(z.string().uuid()),
})

export async function createUserAction(
  _prev: UserFormState,
  formData: FormData,
): Promise<UserFormState> {
  const user = await requireRole(UserRole.ADMIN)

  const parsed = createSchema.safeParse({
    email: formData.get('email'),
    name: formData.get('name'),
    role: formData.get('role'),
    siteIds: formData.getAll('siteIds').map(String).filter(Boolean),
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form.' }
  }

  try {
    const created = await createUser(user.db, parsed.data)

    await writeAudit(user.db, {
      actorUserId: user.userId,
      action: AuditAction.CREATE,
      entity: 'User',
      entityId: created.user.id,
      // The password is deliberately absent. An audit entry is readable by
      // every administrator, for ever.
      after: { email: created.user.email, role: created.user.role },
    })

    revalidatePath('/admin/users')
    return {
      message: `${created.user.name} can now sign in.`,
      password: created.temporaryPassword,
      passwordFor: created.user.email,
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'That account could not be created.' }
  }
}

const updateSchema = z.object({
  userId: z.string().uuid(),
  role: z.nativeEnum(UserRole).optional(),
  active: z.enum(['true', 'false']).optional(),
  siteIds: z.array(z.string().uuid()).optional(),
})

export async function updateUserAction(
  _prev: UserFormState,
  formData: FormData,
): Promise<UserFormState> {
  const admin = await requireRole(UserRole.ADMIN)

  const siteIds = formData.getAll('siteIds').map(String).filter(Boolean)
  const parsed = updateSchema.safeParse({
    userId: formData.get('userId'),
    role: formData.get('role') || undefined,
    active: formData.get('active') || undefined,
    siteIds: formData.has('siteIds') ? siteIds : undefined,
  })

  if (!parsed.success) return { error: 'That change could not be read.' }

  const before = await admin.db.user.findUnique({
    where: { id: parsed.data.userId },
    select: { name: true, role: true, active: true },
  })

  try {
    const updated = await updateUser(
      admin.db,
      parsed.data.userId,
      {
        role: parsed.data.role,
        active: parsed.data.active === undefined ? undefined : parsed.data.active === 'true',
        siteIds: parsed.data.siteIds,
      },
      { userId: admin.userId },
    )

    await writeAudit(admin.db, {
      actorUserId: admin.userId,
      action: AuditAction.UPDATE,
      entity: 'User',
      entityId: updated.id,
      before: before ? { role: before.role, active: before.active } : undefined,
      after: { role: updated.role, active: updated.active },
    })

    revalidatePath('/admin/users')
    return { message: `${updated.name} updated.` }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'That change could not be saved.' }
  }
}

export async function resetPasswordAction(
  _prev: UserFormState,
  formData: FormData,
): Promise<UserFormState> {
  const admin = await requireRole(UserRole.ADMIN)

  const userId = String(formData.get('userId') ?? '')
  if (!z.string().uuid().safeParse(userId).success) {
    return { error: 'That account could not be identified.' }
  }

  try {
    const target = await admin.db.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    })
    const { temporaryPassword } = await resetPassword(admin.db, userId)

    await writeAudit(admin.db, {
      actorUserId: admin.userId,
      action: AuditAction.UPDATE,
      entity: 'User',
      entityId: userId,
      after: { passwordReset: true },
    })

    revalidatePath('/admin/users')
    return {
      message: `${target?.name ?? 'That account'} has a new password. Every signed-in session was ended.`,
      password: temporaryPassword,
      passwordFor: target?.email ?? userId,
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'That password could not be reset.',
    }
  }
}
