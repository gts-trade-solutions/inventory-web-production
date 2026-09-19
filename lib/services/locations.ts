import 'server-only'
import { randomUUID } from 'node:crypto'
import { LocationZone } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import { ApiError, ErrorCode } from '@/lib/api/errors'
import { AuditAction, writeAudit } from '@/lib/audit'

/**
 * Location administration (PROJECT_PLAN, master data).
 *
 * A location is a place stock sits: a rack, a dock, a bay. Everything the
 * warehouse does names one — receipts go to it, issues come from it, counts
 * cover it, and every `stock_levels` row is keyed by it.
 *
 * This screen existed as a greyed-out "not built yet" entry in the sidebar for
 * a long time. Locations could only be created by CSV import, which meant a new
 * site could be set up and then not be usable through any screen.
 *
 * The rules mirror sites, and for the same reason: deactivating a place that
 * still holds stock does not remove the stock, it removes the way anybody finds
 * it. The ledger still balances and the goods are lost.
 */

export interface LocationRow {
  id: string
  siteId: string
  siteCode: string
  code: string
  name: string
  zone: LocationZone
  active: boolean
  /** Distinct item/batch rows holding a positive quantity here. */
  stockedLines: number
  /** Total units on hand, which is what somebody scanning the list looks for. */
  onHand: number
}

export async function listLocations(
  db: PrismaClient,
  filters: { siteId?: string | null } = {},
): Promise<LocationRow[]> {
  const locations = await db.location.findMany({
    where: {
      deletedAt: null,
      ...(filters.siteId ? { siteId: filters.siteId } : {}),
    },
    orderBy: [{ site: { code: 'asc' } }, { zone: 'asc' }, { code: 'asc' }],
    select: {
      id: true,
      siteId: true,
      code: true,
      name: true,
      zone: true,
      active: true,
      site: { select: { code: true } },
    },
  })

  // One grouped query rather than one per row. The screen is small today and
  // the N+1 would only show up on a site with hundreds of bays — which is the
  // size at which somebody actually needs this screen.
  const stock = await db.stockLevel.groupBy({
    by: ['locationId'],
    where: {
      quantity: { gt: 0 },
      locationId: { in: locations.map((location) => location.id) },
    },
    _count: { _all: true },
    _sum: { quantity: true },
  })

  const byLocation = new Map(stock.map((row) => [row.locationId, row]))

  return locations.map((location) => ({
    id: location.id,
    siteId: location.siteId,
    siteCode: location.site.code,
    code: location.code,
    name: location.name,
    zone: location.zone,
    active: location.active,
    stockedLines: byLocation.get(location.id)?._count._all ?? 0,
    onHand: byLocation.get(location.id)?._sum.quantity ?? 0,
  }))
}

export interface LocationInput {
  siteId: string
  code: string
  name: string
  zone: LocationZone
}

export async function createLocation(
  db: PrismaClient,
  input: LocationInput,
  actor: { userId: string },
): Promise<{ id: string; code: string }> {
  const code = cleanCode(input.code)
  const name = cleanName(input.name)

  const site = await db.site.findFirst({
    where: { id: input.siteId, deletedAt: null },
    select: { id: true, code: true, active: true },
  })
  if (!site) throw new ApiError(ErrorCode.NOT_FOUND, 'That site does not exist.')

  if (!site.active) {
    // Otherwise the location is created into a site nothing can use, and the
    // failure surfaces later as "why can I not receive into this".
    throw new ApiError(
      ErrorCode.VALIDATION_FAILED,
      `Site ${site.code} is deactivated. Reactivate it before adding locations to it.`,
    )
  }

  await requireCodeFree(db, site.id, code, null)

  const created = await db.location.create({
    data: { id: randomUUID(), siteId: site.id, code, name, zone: input.zone, active: true },
  })

  await writeAudit(db, {
    actorUserId: actor.userId,
    action: AuditAction.CREATE,
    entity: 'Location',
    entityId: created.id,
    after: { siteId: site.id, code, name, zone: input.zone },
  })

  return { id: created.id, code }
}

export interface LocationChanges {
  code?: string
  name?: string
  zone?: LocationZone
  active?: boolean
}

/**
 * Changes a location.
 *
 * The SITE is deliberately not changeable. A movement records its site
 * alongside its location, so moving a location to another site would leave
 * every historical movement claiming stock went somewhere it did not — and
 * every report split by site would disagree with the ledger. If a location
 * belongs somewhere else, make it there and retire this one.
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

  if (code !== before.code) await requireCodeFree(db, before.siteId, code, id)
  if (before.active && !active) await refuseDeactivation(db, before)

  await db.location.update({ where: { id }, data: { code, name, zone, active } })

  await writeAudit(db, {
    actorUserId: actor.userId,
    action: AuditAction.UPDATE,
    entity: 'Location',
    entityId: id,
    before: { code: before.code, name: before.name, zone: before.zone, active: before.active },
    after: { code, name, zone, active },
  })
}

/**
 * Removes a location, but only one nothing depends on.
 *
 * A soft delete. `stock_levels`, `movements`, `count_sessions` and
 * `serial_units` all reference a location with ON DELETE RESTRICT, so a hard
 * delete would either fail or, worse, need those rows removed first — and the
 * ledger is append-only.
 */
export async function deleteLocation(
  db: PrismaClient,
  id: string,
  actor: { userId: string },
): Promise<void> {
  const before = await requireLocation(db, id)

  const [stocked, movements] = await Promise.all([
    db.stockLevel.count({ where: { locationId: id, quantity: { not: 0 } } }),
    db.movement.count({
      where: { OR: [{ fromLocationId: id }, { toLocationId: id }] },
    }),
  ])

  if (stocked > 0) {
    throw new ApiError(
      ErrorCode.VALIDATION_FAILED,
      `${before.code} still holds stock. Move or issue it first.`,
    )
  }

  if (movements > 0) {
    // History refers to this location by name on every document. Removing it
    // would leave that paperwork pointing at nothing.
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
  // Uppercased rather than rejected, as with site codes: "a-01" and "A-01"
  // naming two different racks is a trap nobody recovers from.
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

async function requireLocation(db: PrismaClient, id: string) {
  const row = await db.location.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, siteId: true, code: true, name: true, zone: true, active: true },
  })

  if (!row) throw new ApiError(ErrorCode.NOT_FOUND, 'That location does not exist.')

  return row
}

async function requireCodeFree(
  db: PrismaClient,
  siteId: string,
  code: string,
  exceptId: string | null,
): Promise<void> {
  // Scoped to the site, matching the database's own @@unique([siteId, code]):
  // two warehouses both having an A-01 is normal and expected.
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
 * Refuses a deactivation that would strand stock or empty a site.
 *
 * Two reasons, and the message says which, because "cannot deactivate" alone
 * sends somebody hunting through screens.
 */
async function refuseDeactivation(
  db: PrismaClient,
  location: { id: string; siteId: string; code: string },
): Promise<void> {
  const stocked = await db.stockLevel.aggregate({
    where: { locationId: location.id, quantity: { gt: 0 } },
    _sum: { quantity: true },
  })

  const onHand = stocked._sum.quantity ?? 0
  if (onHand > 0) {
    throw new ApiError(
      ErrorCode.VALIDATION_FAILED,
      `${location.code} still holds ${onHand} unit${onHand === 1 ? '' : 's'}. Deactivating it would hide that stock from every picker while leaving it in the ledger. Move or issue it first.`,
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
