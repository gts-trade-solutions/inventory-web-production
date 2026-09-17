'use server'

import { randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { BarcodeType, TrackingMode, UserRole } from '@prisma/client'
import { z } from 'zod'
import { requireRole } from '@/lib/auth/guards'
import { AuditAction, changedFields, writeAudit } from '@/lib/audit'
import { isValidEan13, normaliseBarcode } from '@/lib/domain/gtin'

/**
 * Creating and editing items. Admin only.
 *
 * `trackingMode` is the consequential field: it decides whether a movement of
 * this item carries a batch, named units, or neither (WADR-017). Changing it
 * once stock exists is refused — the ledger's grain for this item is already
 * set, and switching it would leave existing movements describing a shape the
 * item no longer has.
 */

const barcodeSchema = z.object({
  barcode: z.string().trim().min(4).max(64),
  type: z.nativeEnum(BarcodeType),
  packSize: z.coerce.number().int().positive().max(10_000),
  isPrimary: z.boolean(),
})

const itemSchema = z.object({
  sku: z.string().trim().min(1, 'Enter a SKU.').max(64),
  name: z.string().trim().min(1, 'Enter a name.').max(200),
  unit: z.string().trim().min(1, 'Enter a unit, e.g. pcs or rolls.').max(24),
  categoryId: z.string().uuid().optional().nullable(),
  reorderPoint: z.coerce.number().int().min(0).max(1_000_000),
  maxLevel: z.coerce.number().int().min(0).max(1_000_000).optional().nullable(),
  trackingMode: z.nativeEnum(TrackingMode),
  expiryRequired: z.boolean(),
  shelfLifeDays: z.coerce.number().int().positive().max(20_000).optional().nullable(),
  nearExpiryDays: z.coerce.number().int().min(0).max(3650),
  active: z.boolean(),
  barcodes: z.array(barcodeSchema).max(20),
})

export interface ItemFormState {
  error?: string
  fieldErrors?: Record<string, string>
  message?: string
}

export async function saveItemAction(
  _prev: ItemFormState,
  formData: FormData,
): Promise<ItemFormState> {
  const user = await requireRole(UserRole.ADMIN)

  const itemId = String(formData.get('itemId') ?? '') || null

  let barcodes: z.infer<typeof barcodeSchema>[]
  try {
    barcodes = z.array(barcodeSchema).parse(JSON.parse(String(formData.get('barcodes') ?? '[]')))
  } catch {
    return { error: 'The barcodes could not be read.' }
  }

  const parsed = itemSchema.safeParse({
    sku: formData.get('sku'),
    name: formData.get('name'),
    unit: formData.get('unit'),
    categoryId: formData.get('categoryId') || null,
    reorderPoint: formData.get('reorderPoint') || 0,
    maxLevel: formData.get('maxLevel') || null,
    trackingMode: formData.get('trackingMode'),
    expiryRequired: formData.get('expiryRequired') === 'on',
    shelfLifeDays: formData.get('shelfLifeDays') || null,
    nearExpiryDays: formData.get('nearExpiryDays') || 30,
    active: formData.get('active') !== 'off',
    barcodes,
  })

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {}
    for (const issue of parsed.error.issues) {
      fieldErrors[issue.path.map(String).join('.') || 'form'] ??= issue.message
    }
    return { error: parsed.error.issues[0]?.message ?? 'Check the form.', fieldErrors }
  }

  const input = parsed.data

  // Only BATCH items can require an expiry, and only they have a shelf life.
  // Leaving these set on a NONE item would be invisible until somebody switched
  // the tracking mode and got behaviour they never configured.
  if (input.trackingMode !== TrackingMode.BATCH) {
    input.expiryRequired = false
    input.shelfLifeDays = null
  }

  const barcodeError = validateBarcodes(input.barcodes)
  if (barcodeError) return { error: barcodeError, fieldErrors: { barcodes: barcodeError } }

  const normalisedBarcodes = input.barcodes.map((barcode) => ({
    ...barcode,
    barcode: normaliseBarcode(barcode.barcode),
  }))

  // Uniqueness is enforced by the database, but catching it here names the
  // offending code instead of surfacing a constraint violation.
  const clash = await user.db.itemBarcode.findFirst({
    where: {
      barcode: { in: normalisedBarcodes.map((b) => b.barcode) },
      ...(itemId ? { itemId: { not: itemId } } : {}),
    },
    select: { barcode: true, item: { select: { sku: true, name: true } } },
  })
  if (clash) {
    return {
      error: `Barcode ${clash.barcode} already belongs to ${clash.item.name} (${clash.item.sku}).`,
      fieldErrors: { barcodes: 'Already used by another item.' },
    }
  }

  const skuClash = await user.db.item.findFirst({
    where: { sku: input.sku, ...(itemId ? { id: { not: itemId } } : {}) },
    select: { id: true },
  })
  if (skuClash) return { error: `SKU ${input.sku} is already in use.`, fieldErrors: { sku: '' } }

  let savedId = itemId

  try {
    await user.db.$transaction(async (tx) => {
      if (itemId) {
        const before = await tx.item.findUniqueOrThrow({ where: { id: itemId } })

        // The ledger's grain for this item is already set. Movements already
        // recorded describe a shape the item would no longer have.
        if (before.trackingMode !== input.trackingMode) {
          const movements = await tx.movement.count({ where: { itemId } })
          if (movements > 0) {
            throw new TrackingModeLocked(before.trackingMode, movements)
          }
        }

        const after = await tx.item.update({
          where: { id: itemId },
          data: {
            sku: input.sku,
            name: input.name,
            unit: input.unit,
            categoryId: input.categoryId,
            reorderPoint: input.reorderPoint,
            maxLevel: input.maxLevel,
            trackingMode: input.trackingMode,
            expiryRequired: input.expiryRequired,
            shelfLifeDays: input.shelfLifeDays,
            nearExpiryDays: input.nearExpiryDays,
            active: input.active,
          },
        })

        const diff = changedFields(before as never, after as never)
        await writeAudit(tx, {
          actorUserId: user.userId,
          action: AuditAction.UPDATE,
          entity: 'Item',
          entityId: itemId,
          before: diff.before,
          after: diff.after,
        })
      } else {
        const created = await tx.item.create({
          data: {
            id: randomUUID(),
            sku: input.sku,
            name: input.name,
            unit: input.unit,
            categoryId: input.categoryId,
            reorderPoint: input.reorderPoint,
            maxLevel: input.maxLevel,
            trackingMode: input.trackingMode,
            expiryRequired: input.expiryRequired,
            shelfLifeDays: input.shelfLifeDays,
            nearExpiryDays: input.nearExpiryDays,
            active: input.active,
          },
        })
        savedId = created.id

        await writeAudit(tx, {
          actorUserId: user.userId,
          action: AuditAction.CREATE,
          entity: 'Item',
          entityId: created.id,
          after: { sku: created.sku, name: created.name, trackingMode: created.trackingMode },
        })
      }

      // Barcodes are replaced wholesale. They are a short list an admin edits as
      // a set, and diffing them would add complexity for no benefit.
      await tx.itemBarcode.deleteMany({ where: { itemId: savedId! } })
      if (normalisedBarcodes.length > 0) {
        await tx.itemBarcode.createMany({
          data: normalisedBarcodes.map((barcode) => ({
            id: randomUUID(),
            itemId: savedId!,
            barcode: barcode.barcode,
            type: barcode.type,
            packSize: barcode.packSize,
            isPrimary: barcode.isPrimary,
          })),
        })
      }
    })
  } catch (error) {
    if (error instanceof TrackingModeLocked) {
      return {
        error: `This item already has ${error.movements} movement${error.movements === 1 ? '' : 's'}, so its tracking cannot change from ${error.current}. Create a new item instead.`,
        fieldErrors: { trackingMode: 'Locked once stock has moved.' },
      }
    }
    throw error
  }

  revalidatePath('/inventory')
  revalidatePath(`/inventory/${savedId}`)
  redirect(`/inventory/${savedId}`)
}

class TrackingModeLocked extends Error {
  constructor(
    readonly current: TrackingMode,
    readonly movements: number,
  ) {
    super('Tracking mode is locked once stock has moved.')
  }
}

function validateBarcodes(barcodes: z.infer<typeof barcodeSchema>[]): string | null {
  const seen = new Set<string>()

  for (const barcode of barcodes) {
    const code = normaliseBarcode(barcode.barcode)

    if (seen.has(code)) return `Barcode ${code} is listed twice.`
    seen.add(code)

    // Only EAN-13 carries a check digit we can verify. A wrong one means the
    // barcode was mistyped, and it would then never scan.
    if (barcode.type === BarcodeType.EAN13 && !isValidEan13(code)) {
      return `${code} is not a valid EAN-13 — check the digits.`
    }
  }

  if (barcodes.length > 0 && !barcodes.some((barcode) => barcode.isPrimary)) {
    return 'Mark one barcode as the primary one; it is the one printed on labels.'
  }

  if (barcodes.filter((barcode) => barcode.isPrimary).length > 1) {
    return 'Only one barcode can be the primary one.'
  }

  return null
}
