import 'server-only'
import type { PrismaClient } from '@prisma/client'

/**
 * Reading the audit log.
 *
 * Several decisions in this system are justified by being "audited" — approving
 * a count, quarantining a batch, resetting the demo. That claim is worth
 * nothing while the log is write-only: an audit trail nobody can read is a
 * table, not an audit trail.
 */

export interface AuditRow {
  id: string
  at: Date
  action: string
  entity: string
  entityId: string | null
  actor: string | null
  /** Present only when the actor's user row still exists. */
  actorEmail: string | null
  before: unknown
  after: unknown
  ip: string | null
}

export interface AuditFilter {
  action?: string
  entity?: string
  entityId?: string
  actorUserId?: string
  /** Free text over action and entity, for somebody who half-remembers. */
  search?: string
  from?: Date
  to?: Date
  limit?: number
  cursor?: string
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

export async function listAuditEntries(
  db: PrismaClient,
  filter: AuditFilter = {},
): Promise<{ entries: AuditRow[]; nextCursor: string | null }> {
  const take = Math.min(Math.max(filter.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)

  const rows = await db.auditLog.findMany({
    where: {
      ...(filter.action ? { action: filter.action } : {}),
      ...(filter.entity ? { entity: filter.entity } : {}),
      ...(filter.entityId ? { entityId: filter.entityId } : {}),
      ...(filter.actorUserId ? { actorUserId: filter.actorUserId } : {}),
      ...(filter.search
        ? {
            OR: [{ action: { contains: filter.search } }, { entity: { contains: filter.search } }],
          }
        : {}),
      ...(filter.from || filter.to
        ? {
            at: {
              ...(filter.from ? { gte: filter.from } : {}),
              ...(filter.to ? { lte: filter.to } : {}),
            },
          }
        : {}),
    },
    select: {
      id: true,
      at: true,
      action: true,
      entity: true,
      entityId: true,
      before: true,
      after: true,
      ip: true,
      actor: { select: { name: true, email: true } },
    },
    // Newest first, with the id as a tiebreaker so two entries written in the
    // same millisecond have a stable order and paging cannot repeat or skip.
    orderBy: [{ at: 'desc' }, { id: 'desc' }],
    take: take + 1,
    ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
  })

  const page = rows.slice(0, take)

  return {
    entries: page.map((row) => ({
      id: row.id,
      at: row.at,
      action: row.action,
      entity: row.entity,
      entityId: row.entityId,
      // Null when the actor's row is gone — a deleted user, or a demo reset
      // that replaced everybody. The entry survives; the link does not.
      actor: row.actor?.name ?? null,
      actorEmail: row.actor?.email ?? null,
      before: row.before,
      after: row.after,
      ip: row.ip,
    })),
    nextCursor: rows.length > take ? (page[page.length - 1]?.id ?? null) : null,
  }
}

/** The distinct actions and entities present, for the filter controls. */
export async function auditFacets(
  db: PrismaClient,
): Promise<{ actions: string[]; entities: string[] }> {
  const [actions, entities] = await Promise.all([
    db.auditLog.findMany({
      select: { action: true },
      distinct: ['action'],
      orderBy: { action: 'asc' },
    }),
    db.auditLog.findMany({
      select: { entity: true },
      distinct: ['entity'],
      orderBy: { entity: 'asc' },
    }),
  ])

  return {
    actions: actions.map((row) => row.action),
    entities: entities.map((row) => row.entity),
  }
}

/**
 * What changed, as a list a person can read.
 *
 * The log stores before and after as JSON, which is right for machines and
 * unhelpful on a screen. This reduces them to the fields that actually differ —
 * the question somebody opening an audit entry is asking is "what changed?",
 * not "what was the whole row?".
 */
export function describeChange(
  before: unknown,
  after: unknown,
): Array<{ field: string; from: string; to: string }> {
  const b = asRecord(before)
  const a = asRecord(after)
  if (!b && !a) return []

  const fields = [...new Set([...Object.keys(b ?? {}), ...Object.keys(a ?? {})])].sort()

  return fields
    .map((field) => ({
      field,
      from: display(b?.[field]),
      to: display(a?.[field]),
    }))
    .filter((change) => change.from !== change.to)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function display(value: unknown): string {
  if (value === undefined) return '—'
  if (value === null) return 'none'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}
