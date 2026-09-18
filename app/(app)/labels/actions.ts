'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/guards'
import { labelFieldsFor, submitPrintJob, type PrintJobResult } from '@/lib/services/printing'
import { allocateEpcBlock } from '@/lib/services/epc'
import { fromGtin13 } from '@/lib/domain/sgtin96'

/**
 * Printing a label from the console.
 *
 * The template declares which fields it needs; the server fills them from the
 * item, batch or location being printed for. Nothing about a label's layout
 * lives in this file, which is the point — a label can change without a release
 * (WADR-014).
 */

const schema = z.object({
  templateId: z.string().uuid('Choose a label.'),
  printerDeviceId: z.string().uuid().optional(),
  itemId: z.string().uuid().optional(),
  batchId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
  copies: z.coerce.number().int().min(1).max(99).default(1),
})

export interface PrintState {
  error?: string
  result?: PrintJobResult
}

export async function printLabelAction(_prev: PrintState, formData: FormData): Promise<PrintState> {
  const user = await requireUser()

  const parsed = schema.safeParse({
    templateId: formData.get('templateId'),
    printerDeviceId: formData.get('printerDeviceId') || undefined,
    itemId: formData.get('itemId') || undefined,
    batchId: formData.get('batchId') || undefined,
    locationId: formData.get('locationId') || undefined,
    copies: formData.get('copies') || 1,
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form.' }
  }

  const input = parsed.data

  try {
    const template = await user.db.labelTemplate.findUnique({
      where: { id: input.templateId },
      select: { rfidEncode: true, name: true },
    })
    if (!template) return { error: 'That label does not exist.' }

    const { fields, missing } = await labelFieldsFor(user.db, input)
    if (missing.length > 0) {
      // Named, so the operator knows what to choose rather than being told the
      // form is wrong.
      return {
        error: `"${template.name}" needs ${missing.join(', ')}. Choose ${
          missing.includes('batchNo') ? 'a batch' : 'an item'
        } that has ${missing.length === 1 ? 'it' : 'them'}.`,
      }
    }

    // An RFID template needs one EPC per label, and the server owns serials:
    // two phones minting their own would eventually encode the same tag twice
    // (WADR-009).
    let epcs: string[] | undefined
    if (template.rfidEncode) {
      if (!input.itemId) return { error: 'An RFID label has to be printed for an item.' }

      const block = await allocateEpcBlock(user.db, {
        itemId: input.itemId,
        count: input.copies,
      })
      epcs = Array.from({ length: input.copies }, (_, offset) =>
        fromGtin13(block.gtin13, block.serialFrom + offset),
      )
    }

    const result = await submitPrintJob(
      user.db,
      { ...input, fields, epcs, copies: epcs ? 1 : input.copies },
      { userId: user.userId },
      user.mode,
    )

    revalidatePath('/labels')
    return { result }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'That label could not be printed.',
    }
  }
}

/** Renders the label without printing it, so the preview is the real bytes. */
export async function previewLabelAction(input: {
  templateId: string
  itemId?: string
  batchId?: string
  locationId?: string
}): Promise<{ zpl?: string; missing?: string[]; error?: string }> {
  const user = await requireUser()

  if (!z.string().uuid().safeParse(input.templateId).success) {
    return { error: 'Choose a label.' }
  }

  const template = await user.db.labelTemplate.findUnique({
    where: { id: input.templateId },
    select: { zplBody: true, rfidEncode: true },
  })
  if (!template) return { error: 'That label does not exist.' }

  const { fields, missing } = await labelFieldsFor(user.db, input)
  if (missing.length > 0) return { missing }

  const { renderTemplate } = await import('@/lib/labels/zpl')
  // Deliberately the same render the printer gets. A preview built any other
  // way is a drawing of what we hope will print.
  return { zpl: renderTemplate(template.zplBody, fields) }
}
