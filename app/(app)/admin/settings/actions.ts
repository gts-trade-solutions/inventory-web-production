'use server'

import { revalidatePath } from 'next/cache'
import { UserRole } from '@prisma/client'
import { requireRole } from '@/lib/auth/guards'
import { clearSetting, isSettingKey, setSetting } from '@/lib/services/settings'
import { AuditAction, writeAudit } from '@/lib/audit'

/**
 * Changing operating policy.
 *
 * Administrator only, and audited: these change what the system refuses to do,
 * and "who raised the adjustment limit before that write-off" is a question
 * somebody will eventually ask.
 */

export interface SettingsState {
  error?: string
  message?: string
}

export async function saveSettingAction(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const admin = await requireRole(UserRole.ADMIN)

  const key = String(formData.get('key') ?? '')
  const raw = String(formData.get('value') ?? '').trim()
  const siteId = String(formData.get('siteId') ?? '')

  if (!isSettingKey(key)) return { error: 'That setting does not exist.' }

  const before = await admin.db.setting.findFirst({
    where: { key, siteId },
    select: { value: true },
  })

  try {
    if (raw === '') {
      // An empty box means "use the default", not "set it to nothing". For a
      // nullable numeric setting those happen to coincide; for the rest,
      // clearing the override is the only sensible reading.
      await clearSetting(admin.db, key, siteId)
    } else {
      // Numbers arrive from a form as text. Anything that is not a number is
      // passed through as a string for the setting's own schema to judge.
      const value = /^-?\d+$/.test(raw) ? Number(raw) : raw
      await setSetting(admin.db, key, value, siteId)
    }

    await writeAudit(admin.db, {
      actorUserId: admin.userId,
      action: AuditAction.UPDATE,
      entity: 'Setting',
      entityId: key,
      before: { value: before?.value ?? null },
      after: { value: raw === '' ? null : raw },
    })

    revalidatePath('/admin/settings')
    return {
      message:
        raw === ''
          ? 'Cleared. The shipped default applies again.'
          : 'Saved. It takes effect on the next movement.',
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'That setting could not be saved.' }
  }
}

