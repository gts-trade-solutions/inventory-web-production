import 'server-only'
import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { ApiError, ErrorCode } from '@/lib/api/errors'
import { AuditAction, writeAudit } from '@/lib/audit'

/**
 * Site administration (PROJECT_PLAN 7.4).
 *
 * A site is a physical warehouse. Everything else hangs off one: locations,
 * movements, count sessions, devices, and which sites a user may work in.
 *
 * The rules here are all about not making stock disappear. Deactivating a site
 * removes it from the pickers, so anything still sitting in it becomes
 * unreachable through the screens people actually use — the stock is still in
 * the ledger, which is exactly what makes it dangerous: the numbers still add
 * up, and nobody can find the goods.
 */

export interface SiteRow {
  id: string
  code: string
  name: string
  active: boolean
  locationCount: number
  /** Distinct place/batch rows holding a positive quantity in this site. */
  stockedPlaces: number
}

export async function listSites(db: PrismaClient): Promise<SiteRow[]> {
  const sites = await db.site.findMany({
    where: { deletedAt: null },
    orderBy: [{ active: 'desc' }, { code: 'asc' }],
    select: {
      id: true,
      code: true,
      name: true,
      active: true,
      _count: { select: { locations: true } },
    },
  })

  // One grouped query rather than one per site: this screen is small, but the
  // N+1 would be invisible until a customer had thirty sites.
  const stocked = await db.stockLevel.groupBy({
    by: ['locationId'],
    where: { quantity: { gt: 0 } },
    _count: { _all: true },
  })

  const locations = await db.location.findMany({
    where: { id: { in: stocked.map((row) => row.locationId) } },
    select: { id: true, siteId: true },
  })

  const siteOf = new Map(locations.map((row) => [row.id, row.siteId]))
  const perSite = new Map<string, number>()

  for (const row of stocked) {
    const siteId = siteOf.get(row.locationId)
    if (!siteId) continue
    perSite.set(siteId, (perSite.get(siteId) ?? 0) + row._count._all)
  }

  return sites.map((site) => ({
    id: site.id,
    code: site.code,
    name: site.name,
    active: site.active,
    locationCount: site._count.locations,
    stockedPlaces: perSite.get(site.id) ?? 0,
  }))
}

export interface SiteInput {
  code: string
  name: string
}

export async function createSite(
  db: PrismaClient,
  input: SiteInput,
  actor: { userId: string },
): Promise<SiteRow> {
  const code = cleanCode(input.code)
  const name = cleanName(input.name)

  await requireCodeFree(db, code, null)

  const created = await db.site.create({
    data: { id: randomUUID(), code, name, active: true },
  })

  await writeAudit(db, {
    actorUserId: actor.userId,
    action: AuditAction.CREATE,
    entity: 'Site',
    entityId: created.id,
    after: { code, name },
  })

  return { id: created.id, code, name, active: true, locationCount: 0, stockedPlaces: 0 }
}

export interface SiteChanges {
  code?: string
  name?: string
  active?: boolean
}

export async function updateSite(
  db: PrismaClient,
  id: string,
  changes: SiteChanges,
  actor: { userId: string },
): Promise<void> {
  const before = await requireSite(db, id)

  const code = changes.code === undefined ? before.code : cleanCode(changes.code)
  const name = changes.name === undefined ? before.name : cleanName(changes.name)
  const active = changes.active ?? before.active

  // A site code appears on paperwork and in the mobile app's site picker, so
  // changing one is not nothing. It is still allowed: a typo has to be fixable,
  // and the audit row below is what makes the change traceable afterwards.
  if (code !== before.code) await requireCodeFree(db, code, id)

  if (before.active && !active) {
    await refuseDeactivation(db, id, before.code)
  }

  await db.site.update({ where: { id }, data: { code, name, active } })

  await writeAudit(db, {
    actorUserId: actor.userId,
    action: AuditAction.UPDATE,
    entity: 'Site',
    entityId: id,
    before: { code: before.code, name: before.name, active: before.active },
    after: { code, name, active },
  })
}

// ---------------------------------------------------------------------------

function cleanCode(raw: string): string {
  // Uppercased rather than rejected: "wh1" and "WH1" naming two different sites
  // is a trap, and nobody types a site code the same way twice.
  const code = raw.trim().toUpperCase()

  if (!/^[A-Z0-9][A-Z0-9-]{0,15}$/.test(code)) {
    throw new ApiError(
      ErrorCode.VALIDATION_FAILED,
      'A site code is 1 to 16 characters: letters, digits and hyphens, starting with a letter or digit.',
    )
  }

  return code
}

function cleanName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, ' ')

  if (name.length === 0) throw new ApiError(ErrorCode.VALIDATION_FAILED, 'A site needs a name.')
  if (name.length > 120) {
    throw new ApiError(ErrorCode.VALIDATION_FAILED, 'A site name is at most 120 characters.')
  }

  return name
}

async function requireSite(db: PrismaClient, id: string) {
  const row = await db.site.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true,
      code: true,
      name: true,
      active: true,
      _count: { select: { locations: true } },
    },
  })

  if (!row) throw new ApiError(ErrorCode.NOT_FOUND, 'That site does not exist.')

  return { ...row, locationCount: row._count.locations }
}

async function requireCodeFree(
  db: PrismaClient,
  code: string,
  exceptId: string | null,
): Promise<void> {
  const clash = await db.site.findFirst({
    where: { code, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true, deletedAt: true },
  })

  if (clash) {
    throw new ApiError(
      ErrorCode.VALIDATION_FAILED,
      clash.deletedAt
        ? `Site code "${code}" belonged to a site that was removed. Codes are not reused, because old paperwork still refers to them.`
        : `Site code "${code}" is already in use.`,
    )
  }
}

/**
 * Refuses a deactivation that would strand stock or lock everybody out.
 *
 * Two separate reasons, and the messages say which, because "cannot deactivate"
 * on its own sends somebody hunting.
 */
async function refuseDeactivation(db: PrismaClient, id: string, code: string): Promise<void> {
  const remainingActive = await db.site.count({
    where: { active: true, deletedAt: null, id: { not: id } },
  })

  if (remainingActive === 0) {
    // Every movement needs a site. With none active, the next receipt has
    // nowhere to go and the system is unusable until somebody reads the
    // database directly.
    throw new ApiError(
      ErrorCode.VALIDATION_FAILED,
      `"${code}" is the only active site. Deactivating it would leave nowhere to receive stock into.`,
    )
  }

  const stranded = await db.stockLevel.count({
    where: { quantity: { gt: 0 }, location: { siteId: id } },
  })

  if (stranded > 0) {
    throw new ApiError(
      ErrorCode.VALIDATION_FAILED,
      `"${code}" still holds stock in ${stranded} place${stranded === 1 ? '' : 's'}. Deactivating it would hide that stock from every picker while leaving it in the ledger. Move or issue it first.`,
    )
  }
}
