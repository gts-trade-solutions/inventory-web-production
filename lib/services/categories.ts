import 'server-only'
import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { ApiError, ErrorCode } from '@/lib/api/errors'
import { AuditAction, writeAudit } from '@/lib/audit'

/**
 * Category administration (PROJECT_PLAN 7.4).
 *
 * Categories are a tree: a category has an optional parent, and items hang off
 * the leaves. Two rules carry all the risk.
 *
 * **A category cannot become its own ancestor.** Reparenting "Consumables"
 * under its own child "Gloves" produces a cycle, and every walk of the tree
 * afterwards — the picker, the filters, this service — runs forever. The
 * database cannot express that constraint, so it is enforced here and tested.
 *
 * **Nothing is deleted while it is in use.** A category with items or children
 * is refused rather than removed, because `Item.categoryId` is `ON DELETE SET
 * NULL`: deleting would silently uncategorise stock, and the only record that
 * it ever had a category would be the audit row.
 */

export interface CategoryNode {
  id: string
  name: string
  parentId: string | null
  active: boolean
  /** Items pointing at this category, whatever their own active flag. */
  itemCount: number
  /** Depth in the tree, 0 for a root. Drives the indent in the picker. */
  depth: number
}

/**
 * The whole tree, flattened in display order.
 *
 * Read in one query and assembled in memory. A recursive CTE would push it into
 * the database, but a category tree is tens of rows, not thousands, and the
 * version that anybody can read is worth more here than the clever one.
 */
export async function listCategories(db: PrismaClient): Promise<CategoryNode[]> {
  const rows = await db.category.findMany({
    where: { deletedAt: null },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      parentId: true,
      active: true,
      _count: { select: { items: true } },
    },
  })

  const byParent = new Map<string | null, typeof rows>()
  for (const row of rows) {
    const siblings = byParent.get(row.parentId) ?? []
    siblings.push(row)
    byParent.set(row.parentId, siblings)
  }

  const flattened: CategoryNode[] = []
  const seen = new Set<string>()

  const walk = (parentId: string | null, depth: number) => {
    for (const row of byParent.get(parentId) ?? []) {
      // A cycle should be impossible — updateCategory refuses to create one —
      // but this walk is what would hang if one ever existed, and a hung admin
      // screen gives nobody a way to fix the row that caused it. Visiting each
      // category once degrades a cycle into a truncated tree instead.
      if (seen.has(row.id)) continue
      seen.add(row.id)

      flattened.push({
        id: row.id,
        name: row.name,
        parentId: row.parentId,
        active: row.active,
        itemCount: row._count.items,
        depth,
      })
      walk(row.id, depth + 1)
    }
  }

  walk(null, 0)

  // A row whose parent was soft-deleted would otherwise vanish from the tree
  // entirely — present in the database, invisible in the only screen that
  // manages it. Orphans are shown at the root rather than lost.
  if (flattened.length !== rows.length) {
    const placed = new Set(flattened.map((node) => node.id))

    for (const row of rows) {
      if (placed.has(row.id)) continue
      flattened.push({
        id: row.id,
        name: row.name,
        parentId: row.parentId,
        active: row.active,
        itemCount: row._count.items,
        depth: 0,
      })
    }
  }

  return flattened
}

export interface CategoryInput {
  name: string
  parentId?: string | null
}

export async function createCategory(
  db: PrismaClient,
  input: CategoryInput,
  actor: { userId: string },
): Promise<CategoryNode> {
  const name = cleanName(input.name)
  const parentId = input.parentId || null

  if (parentId) await requireCategory(db, parentId)
  await requireNameFree(db, name, parentId, null)

  const created = await db.category.create({
    data: { id: randomUUID(), name, parentId, active: true },
  })

  await writeAudit(db, {
    actorUserId: actor.userId,
    action: AuditAction.CREATE,
    entity: 'Category',
    entityId: created.id,
    after: { name, parentId },
  })

  return {
    id: created.id,
    name: created.name,
    parentId: created.parentId,
    active: created.active,
    itemCount: 0,
    depth: 0,
  }
}

export interface CategoryChanges {
  name?: string
  parentId?: string | null
  active?: boolean
}

export async function updateCategory(
  db: PrismaClient,
  id: string,
  changes: CategoryChanges,
  actor: { userId: string },
): Promise<void> {
  const before = await requireCategory(db, id)

  const name = changes.name === undefined ? before.name : cleanName(changes.name)
  const parentId = changes.parentId === undefined ? before.parentId : changes.parentId || null
  const active = changes.active ?? before.active

  if (parentId !== before.parentId) {
    if (parentId === id) {
      throw new ApiError(ErrorCode.VALIDATION_FAILED, 'A category cannot be its own parent.')
    }
    if (parentId) {
      await requireCategory(db, parentId)
      await refuseCycle(db, id, parentId)
    }
  }

  if (name !== before.name || parentId !== before.parentId) {
    await requireNameFree(db, name, parentId, id)
  }

  if (before.active && !active) await refuseHidingStock(db, id, before.name)

  await db.category.update({ where: { id }, data: { name, parentId, active } })

  await writeAudit(db, {
    actorUserId: actor.userId,
    action: AuditAction.UPDATE,
    entity: 'Category',
    entityId: id,
    before: { name: before.name, parentId: before.parentId, active: before.active },
    after: { name, parentId, active },
  })
}

/**
 * Removes a category, but only one nothing depends on.
 *
 * A soft delete, because the audit trail refers to it by id and a hard delete
 * would leave those rows pointing at nothing.
 */
export async function deleteCategory(
  db: PrismaClient,
  id: string,
  actor: { userId: string },
): Promise<void> {
  const before = await requireCategory(db, id)

  const [items, children] = await Promise.all([
    db.item.count({ where: { categoryId: id } }),
    db.category.count({ where: { parentId: id, deletedAt: null } }),
  ])

  if (items > 0) {
    // Deleting would set every one of those items' categoryId to NULL, which
    // looks like the items were never categorised at all.
    throw new ApiError(
      ErrorCode.VALIDATION_FAILED,
      `"${before.name}" still has ${items} item${items === 1 ? '' : 's'}. Move them to another category first, or deactivate this one instead.`,
    )
  }

  if (children > 0) {
    throw new ApiError(
      ErrorCode.VALIDATION_FAILED,
      `"${before.name}" still has ${children} sub-categor${children === 1 ? 'y' : 'ies'}. Remove or reparent them first.`,
    )
  }

  await db.category.update({
    where: { id },
    data: { deletedAt: new Date(), active: false },
  })

  await writeAudit(db, {
    actorUserId: actor.userId,
    action: AuditAction.DELETE,
    entity: 'Category',
    entityId: id,
    before: { name: before.name, parentId: before.parentId },
  })
}

// ---------------------------------------------------------------------------

function cleanName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, ' ')

  if (name.length === 0) {
    throw new ApiError(ErrorCode.VALIDATION_FAILED, 'A category needs a name.')
  }
  if (name.length > 120) {
    throw new ApiError(ErrorCode.VALIDATION_FAILED, 'A category name is at most 120 characters.')
  }

  return name
}

async function requireCategory(db: PrismaClient, id: string) {
  const row = await db.category.findFirst({ where: { id, deletedAt: null } })
  if (!row) throw new ApiError(ErrorCode.NOT_FOUND, 'That category does not exist.')

  return row
}

async function requireNameFree(
  db: PrismaClient,
  name: string,
  parentId: string | null,
  exceptId: string | null,
): Promise<void> {
  const clash = await db.category.findFirst({
    where: {
      name,
      parentId,
      deletedAt: null,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  })

  if (clash) {
    throw new ApiError(
      ErrorCode.VALIDATION_FAILED,
      parentId
        ? `There is already a "${name}" under that parent.`
        : `There is already a top-level category called "${name}".`,
    )
  }
}

/**
 * Refuses a reparent that would make `id` its own ancestor.
 *
 * Walks up from the proposed parent looking for `id`. The step counter is not
 * defensive padding: if a cycle already exists in the data, this walk is the
 * code that would hang, and hanging inside the check meant to prevent cycles is
 * the worst place to discover one.
 */
async function refuseCycle(db: PrismaClient, id: string, proposedParentId: string): Promise<void> {
  let cursor: string | null = proposedParentId

  for (let step = 0; cursor && step < 1000; step++) {
    if (cursor === id) {
      throw new ApiError(
        ErrorCode.VALIDATION_FAILED,
        'That would put the category inside one of its own sub-categories.',
      )
    }

    const parent: { parentId: string | null } | null = await db.category.findUnique({
      where: { id: cursor },
      select: { parentId: true },
    })

    cursor = parent?.parentId ?? null
  }
}

/**
 * Refuses to deactivate a category that still has items in stock.
 *
 * A deactivated category disappears from the pickers and filters, so stock
 * filed under it stops being findable by the route most people use. That is not
 * a tidy-up; it is inventory going quiet.
 */
async function refuseHidingStock(db: PrismaClient, id: string, name: string): Promise<void> {
  const withStock = await db.stockLevel.count({
    where: { quantity: { gt: 0 }, item: { categoryId: id } },
  })

  if (withStock > 0) {
    throw new ApiError(
      ErrorCode.VALIDATION_FAILED,
      `"${name}" still has stock on hand in ${withStock} place${withStock === 1 ? '' : 's'}. Deactivating it would hide that stock from the category filters. Move or issue the stock first.`,
    )
  }
}
