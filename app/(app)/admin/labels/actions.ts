'use server'

import { revalidatePath } from 'next/cache'
import { LabelKind, UserRole } from '@prisma/client'
import { z } from 'zod'
import { requireRole } from '@/lib/auth/guards'
import { saveTemplate, setTemplateActive } from '@/lib/services/label-templates'
import { AuditAction, writeAudit } from '@/lib/audit'

/**
 * Editing label templates.
 *
 * Administrator only, and audited. A label change is not cosmetic: it decides
 * what a barcode encodes and whether a tag is written, and "who changed the
 * item label before those labels stopped scanning" is a real question.
 */

export interface TemplateState {
  error?: string
  message?: string
}

const schema = z.object({
  templateId: z.string().uuid().optional(),
  name: z.string().trim().min(1, 'Give the template a name.').max(120),
  kind: z.nativeEnum(LabelKind),
  zplBody: z.string().trim().min(1, 'A template needs some ZPL.').max(20_000),
  widthMm: z.coerce.number().int().min(10).max(500),
  heightMm: z.coerce.number().int().min(10).max(500),
  dpi: z.coerce.number().int().refine((value) => [203, 300, 600].includes(value), {
    message: 'Zebra printers are 203, 300 or 600 dpi.',
  }),
  rfidEncode: z.enum(['on', 'off']).optional(),
})

export async function saveTemplateAction(
  _prev: TemplateState,
  formData: FormData,
): Promise<TemplateState> {
  const admin = await requireRole(UserRole.ADMIN)

  const parsed = schema.safeParse({
    templateId: formData.get('templateId') || undefined,
    name: formData.get('name'),
    kind: formData.get('kind'),
    zplBody: formData.get('zplBody'),
    widthMm: formData.get('widthMm'),
    heightMm: formData.get('heightMm'),
    dpi: formData.get('dpi'),
    rfidEncode: formData.get('rfidEncode') ?? undefined,
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form.' }
  }

  const { templateId, rfidEncode, ...rest } = parsed.data

  try {
    const saved = await saveTemplate(
      admin.db,
      { ...rest, rfidEncode: rfidEncode === 'on' },
      templateId,
    )

    await writeAudit(admin.db, {
      actorUserId: admin.userId,
      action: templateId ? AuditAction.UPDATE : AuditAction.CREATE,
      entity: 'LabelTemplate',
      entityId: saved.id,
      after: { name: saved.name, kind: saved.kind, rfidEncode: saved.rfidEncode },
    })

    revalidatePath('/admin/labels')
    revalidatePath('/labels')

    return {
      message: templateId
        ? `${saved.name} saved. Labels printed from now on use it; ones already printed are unchanged.`
        : `${saved.name} created.`,
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'That template could not be saved.' }
  }
}

export async function setTemplateActiveAction(
  _prev: TemplateState,
  formData: FormData,
): Promise<TemplateState> {
  const admin = await requireRole(UserRole.ADMIN)

  const templateId = String(formData.get('templateId') ?? '')
  const active = formData.get('active') === 'true'

  if (!z.string().uuid().safeParse(templateId).success) {
    return { error: 'That template could not be identified.' }
  }

  try {
    await setTemplateActive(admin.db, templateId, active)

    await writeAudit(admin.db, {
      actorUserId: admin.userId,
      action: active ? AuditAction.UPDATE : AuditAction.DELETE,
      entity: 'LabelTemplate',
      entityId: templateId,
      after: { active },
    })

    revalidatePath('/admin/labels')
    revalidatePath('/labels')

    return {
      message: active
        ? 'Back in use.'
        : 'Retired. It stays on every label already printed from it, and can be brought back.',
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'That change could not be saved.' }
  }
}
