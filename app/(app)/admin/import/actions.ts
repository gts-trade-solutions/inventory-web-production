'use server'

import { revalidatePath } from 'next/cache'
import { UserRole } from '@prisma/client'
import { z } from 'zod'
import { requireRole } from '@/lib/auth/guards'
import { applyImport, planImport, type ImportKind, type ImportOutcome } from '@/lib/services/import'
import { AuditAction, writeAudit } from '@/lib/audit'

/**
 * Importing a spreadsheet.
 *
 * Administrator only, and audited — an import can change thousands of rows, and
 * "who loaded that file" is the first question when the numbers look wrong.
 *
 * Always a dry run before a commit. The preview is not a convenience: an import
 * is the one operation that can be wrong five hundred times before anybody
 * notices.
 */

export interface ImportState {
  error?: string
  plan?: ImportOutcome
  /** Kept so the commit applies exactly what was previewed. */
  text?: string
  kind?: ImportKind
  committed?: boolean
}

const schema = z.object({
  kind: z.enum(['items', 'locations', 'balances']),
  text: z.string().min(1, 'Paste the file, or choose one.').max(4_000_000),
  commit: z.enum(['true', 'false']).optional(),
})

export async function importAction(_prev: ImportState, formData: FormData): Promise<ImportState> {
  const admin = await requireRole(UserRole.ADMIN)

  const parsed = schema.safeParse({
    kind: formData.get('kind'),
    text: formData.get('text'),
    commit: formData.get('commit') ?? undefined,
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form.' }
  }

  const { kind, text, commit } = parsed.data
  const siteId = admin.defaultSiteId ?? admin.siteIds[0]
  if (!siteId) return { error: 'Your account is not assigned to a site.' }

  try {
    if (commit !== 'true') {
      const plan = await planImport(admin.db, kind, text)
      return { plan: { ...plan, applied: 0, failures: [] }, text, kind }
    }

    const outcome = await applyImport(admin.db, kind, text, { userId: admin.userId, siteId })

    await writeAudit(admin.db, {
      actorUserId: admin.userId,
      action: AuditAction.CREATE,
      entity: 'Import',
      entityId: kind,
      after: {
        kind,
        applied: outcome.applied,
        rejected: outcome.problems.length,
        failed: outcome.failures.length,
      },
    })

    revalidatePath('/inventory')
    revalidatePath('/admin/import')

    return { plan: outcome, text, kind, committed: true }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'That file could not be read.' }
  }
}
