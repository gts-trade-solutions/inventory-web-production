import 'server-only'
import { randomUUID } from 'node:crypto'
import { LocationZone } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import { ApiError, ErrorCode } from '@/lib/api/errors'
import { AuditAction, writeAudit } from '@/lib/audit'

/**
 * Location administration: structure and capacity.
 *
 * A location is a place stock sits. Locations nest — zone, aisle, rack, shelf —
 * to whatever depth a site needs, because a warehouse is a tree and a flat list
 * can only describe one by encoding the tree in a code string, where no query
 * can reach it.
 *
 * Two rules carry the risk, and both are invisible to the database:
 *
 * **Stock lives at LEAVES.** A place that contains other places is a grouping,
 * not somewhere a pallet goes. If both were allowed, "how full is Aisle A"
 * would have no single answer — its own stock, its children's, or both — and
 * every rollup would be arguable.
 *
 * **A location cannot become its own ancestor.** The database cannot say so,
 * and the consequence is not a bad row but every walk of the tree running for
 * ever, including the one inside the check meant to catch it.
 *
 * Capacity WARNS and never blocks. If the goods are physically on the shelf,
 * refusing the receipt would make the ledger disagree with the building — the
 * failure this whole system is built to avoid.
 */

export interface LocationNode {
  id: string
  siteId: string
  siteCode: string
  parentId: string | null
  code: string
  name: string
  zone: LocationZone
  active: boolean
  /** Depth in the tree, 0 for a top-level location. Drives the indent. */
  depth: number
  /** True when nothing hangs below it, so it is somewhere stock can sit. */
  isLeaf: boolean
  /** Units held here and everywhere below. For a leaf, its own stock. */
  onHand: number
  /** Distinct item/batch rows held here and below. */
  stockedLines: number
  /**
   * Units this place holds. For a branch, the sum of its descendants' — so a
   * rollup means something even when only the shelves carry a figure.
   * Null when nobody has said.
   */
  capacityUnits: number | null
  /** Its OWN capacity, which is what an admin edits. Null on a branch. */
  ownCapacityUnits: number | null
  /** 0-100+, or null when no capacity is known. Can exceed 100. */
  fillPercent: number | null
}

/**
 * The whole tree for a site, flattened in display order.
 *
 * Assembled in memory rather than with a recursive CTE. A warehouse is
 * thousands of rows at most, and the version somebody can read while holding a
 * bug report is worth more here than the clever one.
 */
export async function listLocations(
  db: PrismaClient,
  filters: { siteId?: string | null } = {},
): Promise<LocationNode[]> {
  const rows = await db.location.findMany({
    where: {
      deletedAt: null,
      ...(filters.siteId ? { siteId: filters.siteId } : {}),
    },
    orderBy: [{ site: { code: 'asc' } }, { zone: 'asc' }, { code: 'asc' }],
    select: {
      id: true,
      siteId: true,
      parentId: true,
      code: true,
      name: true,
      zone: true,
      active: true,
      capacityUnits: true,
      site: { select: { code: true } },
    },
  })

  const stock = await db.stockLevel.groupBy({
    by: ['locationId'],
    where: {
      quantity: { gt: 0 },
      locationId: { in: rows.map((row) => row.id) },
    },
    _count: { _all: true },
    _sum: { quantity: true },
  })

  const ownStock = new Map(
    stock.map((row) => [
      row.locationId,
      { onHand: row._sum.quantity ?? 0, lines: row._count._all },
    ]),
  )

  const childrenOf = new Map<string | null, typeof rows>()
  for (const row of rows) {
    const siblings = childrenOf.get(row.parentId) ?? []
    siblings.push(row)
    childrenOf.set(row.parentId, siblings)
  }

  const flattened: LocationNode[] = []
  const seen = new Set<string>()

  /**
   * Builds a subtree and returns its totals, so a branch reports what is below
   * it without a second pass.
   */
  const walk = (
    row: (typeof rows)[number],
    depth: number,
  ): { onHand: number; lines: number; capacity: number | null } => {
    // A cycle should be impossible; this walk is what would hang if one
    // existed, and a hung screen gives nobody a way to fix the row that caused
    // it. Visiting each location once degrades a cycle into a truncated tree.
    if (seen.has(row.id)) return { onHand: 0, lines: 0, capacity: null }
    seen.add(row.id)

    const node: LocationNode = {
      id: row.id,
      siteId: row.siteId,
      siteCode: row.site.code,
      parentId: row.parentId,
      code: row.code,
      name: row.name,
      zone: row.zone,
      active: row.active,
      depth,
      isLeaf: true,
      onHand: 0,
      stockedLines: 0,
      capacityUnits: null,
      ownCapacityUnits: row.capacityUnits,
      fillPercent: null,
    }
    flattened.push(node)

    const children = childrenOf.get(row.id) ?? []
    node.isLeaf = children.length === 0

    let onHand = ownStock.get(row.id)?.onHand ?? 0
    let lines = ownStock.get(row.id)?.lines ?? 0
    let capacity: number | null = node.isLeaf ? row.capacityUnits : null

    for (const child of children) {
      const below = walk(child, depth + 1)
      onHand += below.onHand
      lines += below.lines

      // Summed only across the children that HAVE a figure. A branch with one
      // measured shelf out of ten would otherwise report a capacity ten times
      // too small and show as wildly overfull.
      if (below.capacity !== null) capacity = (capacity ?? 0) + below.capacity
    }

    node.onHand = onHand
    node.stockedLines = lines
    node.capacityUnits = capacity
    node.fillPercent = capacity && capacity > 0 ? Math.round((onHand / capacity) * 100) : null

    return { onHand, lines, capacity }
  }

  for (const root of childrenOf.get(null) ?? []) walk(root, 0)

  // A location whose parent was soft-deleted would otherwise exist in the
  // database and appear on no screen, which means nobody can fix it.
  for (const row of rows) {
    if (!seen.has(row.id)) walk(row, 0)
  }

  return flattened
}

export interface LocationInput {
  siteId: string
  code: string
  name: string
  zone: LocationZone
  parentId?: string | null
  capacityUnits?: number | null
}

export async function createLocation(
  db: PrismaClient,
  input: LocationInput,
  actor: { userId: string },
): Promise<{ id: string; code: string }> {
  const code = cleanCode(input.code)
  const name = cleanName(input.name)
  const capacityUnits = cleanCapacity(input.capacityUnits)

  const site = await db.site.findFirst({
    where: { id: input.siteId, deletedAt: null },
    select: { id: true, code: true, active: true },
  })
  if (!site) throw new ApiError(ErrorCode.NOT_FOUND, 'That site does not exist.')

  if (!site.active) {
    throw new ApiError(
      ErrorCode.VALIDATION_FAILED,
      `Site ${site.code} is deactivated. Reactivate it before adding locations to it.`,
    )
  }

  const parentId = input.parentId || null
  if (parentId) await requireUsableParent(db, parentId, site.id)

  await requireCodeFree(db, site.id, code, null)

  const created = await db.location.create({
    data: {
      id: randomUUID(),
      siteId: site.id,
      parentId,
      code,
      name,
      zone: input.zone,
      capacityUnits,
      active: true,
    },
  })

  await writeAudit(db, {
    actorUserId: actor.userId,
    action: AuditAction.CREATE,
    entity: 'Location',
    entityId: created.id,
    after: { siteId: site.id, parentId, code, name, zone: input.zone, capacityUnits },
  })

  return { id: created.id, code }
}

export interface LocationChanges {
  code?: string
  name?: string
  zone?: LocationZone
  active?: boolean
  parentId?: string | null
  capacityUnits?: number | null
}

/**
 * Changes a location.
 *
 * The SITE is deliberately not changeable. A movement records its site
 * alongside its location, so moving a location to another site would leave
 * every historical movement claiming stock went somewhere it did not.
 */
export async function updateLocation(
  db: PrismaClient,
  id: string,
  changes: LocationChanges,
  actor: { userId: string },
): Promise<void> {
  const before = await requireLocation(db, id)

  const code = changes.code === undefined ? before.code : cleanCode(changes.code)
  const name = changes.name === undefined ? before.name : cleanName(changes.name)
  const zone = changes.zone ?? before.zone
  const active = changes.active ?? before.active
  const parentId = changes.parentId === undefined ? before.parentId : changes.parentId || null
  const capacityUnits =
    changes.capacityUnits === undefined
      ? before.capacityUnits
      : cleanCapacity(changes.capacityUnits)

  if (parentId !== before.parentId) {
    if (parentId === id) {
      throw new ApiError(ErrorCode.VALIDATION_FAILED, 'A location cannot be inside itself.')
    }
    if (parentId) {
      // Moving a STOCKED location is fine — it stays a leaf, it just hangs
      // somewhere else. The two things refused are making a stocked location
      // into a parent (requireUsableParent) and receiving into a branch
      // (recordMovement).
      await requireUsableParent(db, parentId, before.siteId, id)
      await refuseCycle(db, id, parentId)
    }
  }

  if (code !== before.code) await requireCodeFree(db, before.siteId, code, id)
  if (before.active && !active) await refuseDeactivation(db, before)

  await db.location.update({
    where: { id },
    data: { code, name, zone, active, parentId, capacityUnits },
  })

  await writeAudit(db, {
    actorUserId: actor.userId,
    action: AuditAction.UPDATE,
    entity: 'Location',
    entityId: id,
    before: {
      code: before.code,
      name: before.name,
      zone: before.zone,
      active: before.active,
      parentId: before.parentId,
      capacityUnits: before.capacityUnits,
    },
    after: { code, name, zone, active, parentId, capacityUnits },
  })
}

/**
 * Removes a location, but only one nothing depends on.
 *
 * A soft delete. `stock_levels`, `movements`, `count_sessions` and
 * `serial_units` all reference a location with ON DELETE RESTRICT, and the
 * ledger is append-only.
 */
export async function deleteLocation(
  db: PrismaClient,
  id: string,
  actor: { userId: string },
): Promise<void> {
  const before = await requireLocation(db, id)

  const [stocked, movements, children] = await Promise.all([
    db.stockLevel.count({ where: { locationId: id, quantity: { not: 0 } } }),
    db.movement.count({ where: { OR: [{ fromLocationId: id }, { toLocationId: id }] } }),
    db.location.count({ where: { parentId: id, deletedAt: null } }),
  ])

  if (stocked > 0) {
    throw new ApiError(
      ErrorCode.VALIDATION_FAILED,
      `${before.code} still holds stock. Move or issue it first.`,
    )
  }

  if (children > 0) {
    throw new ApiError(
      ErrorCode.VALIDATION_FAILED,
      `${before.code} contains ${children} other location${children === 1 ? '' : 's'}. Remove or move them first.`,
    )
  }

  if (movements > 0) {
    throw new ApiError(
      ErrorCode.VALIDATION_FAILED,
      `${before.code} has ${movements} movement${movements === 1 ? '' : 's'} recorded against it, so it cannot be removed. Deactivate it instead — it stays out of the pickers and the history keeps its name.`,
    )
  }

  await db.location.update({ where: { id }, data: { deletedAt: new Date(), active: false } })

  await writeAudit(db, {
    actorUserId: actor.userId,
    action: AuditAction.DELETE,
    entity: 'Location',
    entityId: id,
    before: { code: before.code, name: before.name, siteId: before.siteId },
  })
}

// ---------------------------------------------------------------------------

function cleanCode(raw: string): string {
  const code = raw.trim().toUpperCase()

  if (!/^[A-Z0-9][A-Z0-9-]{0,31}$/.test(code)) {
    throw new ApiError(
      ErrorCode.VALIDATION_FAILED,
      'A location code is 1 to 32 characters: letters, digits and hyphens, starting with a letter or digit.',
    )
  }

  return code
}

function cleanName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, ' ')

  if (name.length === 0) throw new ApiError(ErrorCode.VALIDATION_FAILED, 'A location needs a name.')
  if (name.length > 120) {
    throw new ApiError(ErrorCode.VALIDATION_FAILED, 'A location name is at most 120 characters.')
  }

  return name
}

/**
 * Capacity, or null for "nobody has said".
 *
 * Zero is refused rather than stored. A capacity of 0 reads as "holds nothing",
 * which no real place does, and it would make every location on the screen show
 * as infinitely overfull. Somebody meaning "unknown" should leave it blank, and
 * somebody meaning "do not use this" should deactivate it.
 */
function cleanCapacity(raw: number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null

  if (!Number.isInteger(raw) || raw < 1) {
    throw new ApiError(
      ErrorCode.VALIDATION_FAILED,
      'Capacity is a whole number of units, from 1 up. Leave it blank if it is not known.',
    )
  }
  if (raw > 100_000_000) {
    throw new ApiError(ErrorCode.VALIDATION_FAILED, 'That capacity is implausibly large.')
  }

  return raw
}

async function requireLocation(db: PrismaClient, id: string) {
  const row = await db.location.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true,
      siteId: true,
      parentId: true,
      code: true,
      name: true,
      zone: true,
      active: true,
      capacityUnits: true,
    },
  })

  if (!row) throw new ApiError(ErrorCode.NOT_FOUND, 'That location does not exist.')

  return row
}

/**
 * A parent must exist, be in the same site, and not already hold stock.
 *
 * Same site, because a tree spanning two warehouses describes neither. Not
 * holding stock, because stock lives at leaves: putting a location inside one
 * that already has pallets in it would create a branch with its own stock, and
 * every rollup below it becomes ambiguous.
 */
async function requireUsableParent(
  db: PrismaClient,
  parentId: string,
  siteId: string,
  exceptId?: string,
): Promise<void> {
  const parent = await db.location.findFirst({
    where: { id: parentId, deletedAt: null },
    select: { id: true, siteId: true, code: true },
  })

  if (!parent) throw new ApiError(ErrorCode.NOT_FOUND, 'That parent location does not exist.')
  if (parent.id === exceptId) {
    throw new ApiError(ErrorCode.VALIDATION_FAILED, 'A location cannot be inside itself.')
  }

  if (parent.siteId !== siteId) {
    throw new ApiError(
      ErrorCode.VALIDATION_FAILED,
      `${parent.code} is in a different site. A location can only sit inside another in the same site.`,
    )
  }

  const held = await db.stockLevel.aggregate({
    where: { locationId: parentId, quantity: { gt: 0 } },
    _sum: { quantity: true },
  })

  const onHand = held._sum.quantity ?? 0
  if (onHand > 0) {
    throw new ApiError(
      ErrorCode.VALIDATION_FAILED,
      `${parent.code} holds ${onHand} unit${onHand === 1 ? '' : 's'} of its own, so it cannot also contain other locations. Stock sits in the places at the bottom of the tree. Move that stock first.`,
    )
  }
}

async function requireCodeFree(
  db: PrismaClient,
  siteId: string,
  code: string,
  exceptId: string | null,
): Promise<void> {
  const clash = await db.location.findFirst({
    where: { siteId, code, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true, deletedAt: true },
  })

  if (clash) {
    throw new ApiError(
      ErrorCode.VALIDATION_FAILED,
      clash.deletedAt
        ? `Location code "${code}" belonged to a location that was removed. Codes are not reused, because old paperwork still refers to them.`
        : `Location code "${code}" is already used in this site.`,
    )
  }
}

/**
 * Refuses a reparent that would make a location its own ancestor.
 *
 * Walks up from the proposed parent looking for `id`. The step counter is not
 * padding: if a cycle somehow already exists, this walk is the code that would
 * hang, and hanging inside the check meant to prevent cycles is the worst place
 * to discover one.
 */
async function refuseCycle(db: PrismaClient, id: string, proposedParentId: string): Promise<void> {
  let cursor: string | null = proposedParentId

  for (let step = 0; cursor && step < 1000; step++) {
    if (cursor === id) {
      throw new ApiError(
        ErrorCode.VALIDATION_FAILED,
        'That would put the location inside one of the places it already contains.',
      )
    }

    const parent: { parentId: string | null } | null = await db.location.findUnique({
      where: { id: cursor },
      select: { parentId: true },
    })

    cursor = parent?.parentId ?? null
  }
}

/**
 * Every location at or below this one.
 *
 * Breadth-first rather than recursive SQL, and bounded, for the same reason the
 * cycle check is bounded: if a cycle somehow existed, this is code that would
 * otherwise run for ever.
 */
async function subtreeIds(db: PrismaClient, rootId: string): Promise<string[]> {
  const ids = [rootId]
  let frontier = [rootId]

  for (let depth = 0; frontier.length > 0 && depth < 100; depth++) {
    const children: Array<{ id: string }> = await db.location.findMany({
      where: { parentId: { in: frontier }, deletedAt: null },
      select: { id: true },
    })

    frontier = children.map((child) => child.id).filter((id) => !ids.includes(id))
    ids.push(...frontier)
  }

  return ids
}

/** Refuses a deactivation that would strand stock or empty a site. */
async function refuseDeactivation(
  db: PrismaClient,
  location: { id: string; siteId: string; code: string },
): Promise<void> {
  /**
   * The WHOLE SUBTREE, not just this location's own stock.
   *
   * Deactivating "Aisle A" hides every rack inside it from the pickers just as
   * completely as deactivating a rack hides that rack — and an aisle's own
   * stock is always zero, because stock sits at the leaves. Checking only the
   * location itself let a branch holding a thousand units be switched off
   * without a murmur. Found by clicking the button rather than by a test.
   */
  const withinTree = await subtreeIds(db, location.id)

  const stocked = await db.stockLevel.aggregate({
    where: { locationId: { in: withinTree }, quantity: { gt: 0 } },
    _sum: { quantity: true },
  })

  const onHand = stocked._sum.quantity ?? 0
  if (onHand > 0) {
    const inside = withinTree.length > 1 ? ' inside it' : ''

    throw new ApiError(
      ErrorCode.VALIDATION_FAILED,
      `${location.code} still holds ${onHand} unit${onHand === 1 ? '' : 's'}${inside}. Deactivating it would hide that stock from every picker while leaving it in the ledger. Move or issue it first.`,
    )
  }

  const remaining = await db.location.count({
    where: { siteId: location.siteId, active: true, deletedAt: null, id: { not: location.id } },
  })

  if (remaining === 0) {
    throw new ApiError(
      ErrorCode.VALIDATION_FAILED,
      `${location.code} is the only active location in this site. Deactivating it would leave nowhere to receive stock into.`,
    )
  }
}

export { LocationZone }
