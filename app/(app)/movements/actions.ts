'use server'

import { randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { MovementSource, UserRole } from '@prisma/client'
import { z } from 'zod'
import { requireUser, roleAtLeast } from '@/lib/auth/guards'
import { recordMovement } from '@/lib/services/movements'
import type { StockAction } from '@/lib/domain/movement'

/**
 * Server Actions for recording stock movements.
 *
 * Thin by design: authenticate, validate with Zod, call the service, respond.
 * The rules live in lib/domain and the transaction in lib/services, so a
 * movement recorded here behaves identically to one pushed by the phone
 * (ARCHITECTURE §3).
 */

const baseSchema = z.object({
  itemId: z.string().uuid(),
  siteId: z.string().uuid(),
  quantity: z.coerce.number().int().positive('Enter a quantity of at least 1.'),
  batchId: z.string().uuid().optional().nullable(),
  serialUnitIds: z.array(z.string().uuid()).optional(),
  reasonCodeId: z.string().uuid().optional().nullable(),
  note: z.string().max(1000).optional().nullable(),
  reference: z.string().max(120).optional().nullable(),
  /** Set when the operator picked a batch other than the FEFO proposal. */
  fefoOverride: z.boolean().optional(),
})

const schemas = {
  RECEIVE: baseSchema.extend({ kind: z.literal('RECEIVE'), toLocationId: z.string().uuid() }),
  ISSUE: baseSchema.extend({ kind: z.literal('ISSUE'), fromLocationId: z.string().uuid() }),
  MOVE: baseSchema.extend({
    kind: z.literal('MOVE'),
    fromLocationId: z.string().uuid(),
    toLocationId: z.string().uuid(),
  }),
  SCRAP: baseSchema.extend({
    kind: z.literal('SCRAP'),
    fromLocationId: z.string().uuid(),
    reasonCodeId: z.string().uuid('Choose a reason for scrapping.'),
  }),
  ADJUST: baseSchema.omit({ quantity: true }).extend({
    kind: z.literal('ADJUST'),
    locationId: z.string().uuid(),
    countedQuantity: z.coerce.number().int().min(0, 'A counted quantity cannot be negative.'),
    reasonCodeId: z.string().uuid('Choose a reason for this adjustment.'),
  }),
}

export interface MovementFormState {
  error?: string
  fieldErrors?: Record<string, string>
  success?: { docNo: string; message: string }
}

export async function recordMovementAction(
  _prev: MovementFormState,
  formData: FormData,
): Promise<MovementFormState> {
  const user = await requireUser()

  const kind = String(formData.get('kind') ?? '')
  const schema = schemas[kind as keyof typeof schemas]
  if (!schema) return { error: 'Choose what kind of movement to record.' }

  const raw = {
    kind,
    itemId: formData.get('itemId'),
    siteId: formData.get('siteId'),
    quantity: formData.get('quantity'),
    countedQuantity: formData.get('countedQuantity'),
    fromLocationId: formData.get('fromLocationId') || undefined,
    toLocationId: formData.get('toLocationId') || undefined,
    locationId: formData.get('locationId') || undefined,
    batchId: formData.get('batchId') || undefined,
    serialUnitIds: formData.getAll('serialUnitIds').map(String).filter(Boolean),
    reasonCodeId: formData.get('reasonCodeId') || undefined,
    note: formData.get('note') || undefined,
    reference: formData.get('reference') || undefined,
    fefoOverride: formData.get('fefoOverride') === '1',
  }

  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {}
    for (const issue of parsed.error.issues) {
      const field = issue.path.map(String).join('.') || 'form'
      fieldErrors[field] ??= issue.message
    }
    return { error: parsed.error.issues[0]?.message ?? 'Check the form.', fieldErrors }
  }

  const input = parsed.data

  // Site scoping applies on top of role. An operator cannot record against a
  // site they are not assigned to, whatever the form says.
  if (user.role !== UserRole.ADMIN && !user.siteIds.includes(input.siteId)) {
    return { error: 'You do not have access to that site.' }
  }

  // Overriding FEFO, or issuing expired stock, is a supervisor decision — and
  // the movement records that it happened.
  const supervisor = roleAtLeast(user.role, UserRole.SUPERVISOR)
  if (input.fefoOverride && !supervisor) {
    return { error: 'Only a supervisor can override the suggested batch.' }
  }

  const action = toStockAction(input)

  const outcome = await recordMovement(
    user.db,
    {
      id: randomUUID(),
      siteId: input.siteId,
      action,
      source: MovementSource.WEB,
      allowExpiredOverride: supervisor && input.fefoOverride,
    },
    { userId: user.userId },
  )

  if (outcome.status === 'REJECTED') {
    return { error: outcome.error.message, fieldErrors: fieldFor(outcome.error.code) }
  }

  revalidatePath('/movements')
  revalidatePath(`/inventory/${input.itemId}`)
  revalidatePath('/batches')

  if (outcome.status === 'FLAGGED') {
    return {
      success: {
        docNo: outcome.docNo,
        message: `Recorded as ${outcome.docNo}, but it left stock negative. A supervisor will need to review it.`,
      },
    }
  }

  return {
    success: {
      docNo: outcome.docNo,
      message: `Recorded as ${outcome.docNo}.`,
    },
  }
}

function toStockAction(input: z.infer<(typeof schemas)[keyof typeof schemas]>): StockAction {
  const shared = {
    itemId: input.itemId,
    batchId: input.batchId ?? null,
    serialUnitIds: input.serialUnitIds,
    reasonCodeId: input.reasonCodeId ?? null,
    note: input.note ?? null,
    reference: input.reference ?? null,
  }

  switch (input.kind) {
    case 'RECEIVE':
      return { ...shared, kind: 'RECEIVE', toLocationId: input.toLocationId, quantity: input.quantity }
    case 'ISSUE':
      return { ...shared, kind: 'ISSUE', fromLocationId: input.fromLocationId, quantity: input.quantity }
    case 'MOVE':
      return {
        ...shared,
        kind: 'MOVE',
        fromLocationId: input.fromLocationId,
        toLocationId: input.toLocationId,
        quantity: input.quantity,
      }
    case 'SCRAP':
      return {
        ...shared,
        kind: 'SCRAP',
        fromLocationId: input.fromLocationId,
        quantity: input.quantity,
        reasonCodeId: input.reasonCodeId,
      }
    case 'ADJUST':
      return {
        ...shared,
        kind: 'ADJUST',
        locationId: input.locationId,
        countedQuantity: input.countedQuantity,
        reasonCodeId: input.reasonCodeId,
      }
  }
}

/** Points the error at the field that caused it, rather than at the form. */
function fieldFor(code: string): Record<string, string> | undefined {
  const map: Record<string, string> = {
    INSUFFICIENT_STOCK: 'quantity',
    INVALID_QUANTITY: 'quantity',
    BATCH_REQUIRED: 'batchId',
    UNKNOWN_BATCH: 'batchId',
    BATCH_EXPIRED: 'batchId',
    BATCH_BLOCKED: 'batchId',
    SERIALS_REQUIRED: 'serialUnitIds',
    SERIAL_COUNT_MISMATCH: 'serialUnitIds',
    SERIAL_NOT_AT_LOCATION: 'serialUnitIds',
    SERIAL_ALREADY_ISSUED: 'serialUnitIds',
    REASON_CODE_REQUIRED: 'reasonCodeId',
    SAME_LOCATION: 'toLocationId',
    UNKNOWN_LOCATION: 'fromLocationId',
  }

  const field = map[code]
  return field ? { [field]: '' } : undefined
}
