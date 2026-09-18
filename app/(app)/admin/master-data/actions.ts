'use server'

import { revalidatePath } from 'next/cache'
import { UserRole } from '@prisma/client'
import { z } from 'zod'
import { requireRole } from '@/lib/auth/guards'
import { ApiError } from '@/lib/api/errors'
import { createCategory, deleteCategory, updateCategory } from '@/lib/services/categories'
import { createSite, updateSite } from '@/lib/services/sites'
import { updateSequence } from '@/lib/services/sequences'
import { DOC_PREFIXES, type DocKey } from '@/lib/services/numbering'

/**
 * Master data administration (PROJECT_PLAN 7.4).
 *
 * Thin. Every rule lives in the services, because the same rules have to hold
 * when a change arrives over `/api/v1` rather than from this form — a guard
 * that only exists in a Server Action is a guard the integration route does not
 * have.
 */

export interface MasterDataState {
  error?: string
  message?: string
}

/** Service errors carry a message written for the person reading the screen. */
function explain(error: unknown, fallback: string): MasterDataState {
  if (error instanceof ApiError) return { error: error.message }

  console.error(error)
  return { error: fallback }
}

// --- Categories ------------------------------------------------------------

const categorySchema = z.object({
  name: z.string().trim().min(1, 'Enter a category name.').max(120),
  parentId: z.string().uuid().nullable(),
})

export async function createCategoryAction(
  _prev: MasterDataState,
  formData: FormData,
): Promise<MasterDataState> {
  const user = await requireRole(UserRole.ADMIN)

  const parsed = categorySchema.safeParse({
    name: formData.get('name'),
    parentId: emptyToNull(formData.get('parentId')),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Check the form.' }

  try {
    await createCategory(user.db, parsed.data, { userId: user.userId })
  } catch (error) {
    return explain(error, 'The category could not be created.')
  }

  revalidatePath('/admin/master-data')
  return { message: `${parsed.data.name} added.` }
}

export async function updateCategoryAction(
  _prev: MasterDataState,
  formData: FormData,
): Promise<MasterDataState> {
  const user = await requireRole(UserRole.ADMIN)

  const id = String(formData.get('id') ?? '')
  if (!id) return { error: 'That category does not exist.' }

  // Only the fields the submitted form actually carried. Sending `undefined`
  // for the rest is what lets one small form edit a name without also
  // reasserting a parent it never showed.
  const changes: Parameters<typeof updateCategory>[2] = {}
  if (formData.has('name')) changes.name = String(formData.get('name') ?? '')
  if (formData.has('parentId')) changes.parentId = emptyToNull(formData.get('parentId'))
  if (formData.has('active')) changes.active = formData.get('active') === 'true'

  try {
    await updateCategory(user.db, id, changes, { userId: user.userId })
  } catch (error) {
    return explain(error, 'The category could not be changed.')
  }

  revalidatePath('/admin/master-data')
  return { message: 'Category updated.' }
}

export async function deleteCategoryAction(
  _prev: MasterDataState,
  formData: FormData,
): Promise<MasterDataState> {
  const user = await requireRole(UserRole.ADMIN)

  const id = String(formData.get('id') ?? '')
  if (!id) return { error: 'That category does not exist.' }

  try {
    await deleteCategory(user.db, id, { userId: user.userId })
  } catch (error) {
    return explain(error, 'The category could not be removed.')
  }

  revalidatePath('/admin/master-data')
  return { message: 'Category removed.' }
}

// --- Sites -----------------------------------------------------------------

const siteSchema = z.object({
  code: z.string().trim().min(1, 'Enter a site code.').max(16),
  name: z.string().trim().min(1, 'Enter a site name.').max(120),
})

export async function createSiteAction(
  _prev: MasterDataState,
  formData: FormData,
): Promise<MasterDataState> {
  const user = await requireRole(UserRole.ADMIN)

  const parsed = siteSchema.safeParse({ code: formData.get('code'), name: formData.get('name') })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Check the form.' }

  try {
    const site = await createSite(user.db, parsed.data, { userId: user.userId })
    revalidatePath('/admin/master-data')
    return { message: `${site.code} added.` }
  } catch (error) {
    return explain(error, 'The site could not be created.')
  }
}

export async function updateSiteAction(
  _prev: MasterDataState,
  formData: FormData,
): Promise<MasterDataState> {
  const user = await requireRole(UserRole.ADMIN)

  const id = String(formData.get('id') ?? '')
  if (!id) return { error: 'That site does not exist.' }

  const changes: Parameters<typeof updateSite>[2] = {}
  if (formData.has('code')) changes.code = String(formData.get('code') ?? '')
  if (formData.has('name')) changes.name = String(formData.get('name') ?? '')
  if (formData.has('active')) changes.active = formData.get('active') === 'true'

  try {
    await updateSite(user.db, id, changes, { userId: user.userId })
  } catch (error) {
    return explain(error, 'The site could not be changed.')
  }

  revalidatePath('/admin/master-data')
  return { message: 'Site updated.' }
}

// --- Number sequences ------------------------------------------------------

const sequenceSchema = z.object({
  key: z
    .string()
    .refine((value): value is DocKey => value in DOC_PREFIXES, 'Unknown document type.'),
  period: z.string().regex(/^\d{4}$/, 'A period is a four-digit year.'),
  prefix: z.string().trim().min(1).max(3),
  nextValue: z.coerce.number().int().min(1),
  padding: z.coerce.number().int().min(1).max(12),
})

export async function updateSequenceAction(
  _prev: MasterDataState,
  formData: FormData,
): Promise<MasterDataState> {
  const user = await requireRole(UserRole.ADMIN)

  const parsed = sequenceSchema.safeParse({
    key: formData.get('key'),
    period: formData.get('period'),
    prefix: formData.get('prefix'),
    nextValue: formData.get('nextValue'),
    padding: formData.get('padding'),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Check the form.' }

  const { key, period, ...changes } = parsed.data

  try {
    const updated = await updateSequence(user.db, key, period, changes, { userId: user.userId })
    revalidatePath('/admin/master-data')
    return { message: `The next one will be ${updated.preview}.` }
  } catch (error) {
    return explain(error, 'The sequence could not be changed.')
  }
}

// ---------------------------------------------------------------------------

function emptyToNull(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? '').trim()
  return text === '' ? null : text
}
