import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Db } from '@/lib/db'

/**
 * The audit trail for master data and admin actions.
 *
 * Stock changes are deliberately NOT written here. The ledger is already its own
 * audit trail — every movement records who, what, where, which device and when,
 * and it can never be edited or deleted (WADR-002). Duplicating it would create
 * a second record that can disagree with the first, which is worse than having
 * one.
 *
 * What belongs here is everything the ledger does not cover: an item's reorder
 * point changed, a user's role changed, a batch quarantined, a template edited,
 * a projection rebuilt.
 */

export const AuditAction = {
  CREATE: 'CREATE',
  UPDATE: 'UPDATE',
  DELETE: 'DELETE',
  APPROVE: 'APPROVE',
  REJECT: 'REJECT',
  QUARANTINE: 'QUARANTINE',
  RELEASE: 'RELEASE',
  LOGIN: 'LOGIN',
  REBUILD: 'REBUILD',
  DEMO_RESET: 'DEMO_RESET',
} as const
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction]

export interface AuditEntry {
  actorUserId: string | null
  action: AuditAction | string
  entity: string
  entityId?: string | null
  before?: unknown
  after?: unknown
  ip?: string | null
  userAgent?: string | null
}

/**
 * Writes one audit row.
 *
 * Pass the transaction handle when the audited change is itself transactional,
 * so a rolled-back change does not leave an audit row claiming it happened.
 */
export async function writeAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      id: randomUUID(),
      actorUserId: entry.actorUserId,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId ?? null,
      before: redact(entry.before),
      after: redact(entry.after),
      ip: entry.ip ?? null,
      userAgent: entry.userAgent?.slice(0, 255) ?? null,
    },
  })
}

/**
 * The fields of a record that actually changed.
 *
 * An audit row holding the whole object before and after is unreadable — the
 * reviewer has to diff two blobs by eye to find the one field that moved. This
 * keeps only what differs, which is the question anyone asks of an audit log.
 */
export function changedFields<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): { before: Partial<T>; after: Partial<T> } {
  const beforeChanged: Partial<T> = {}
  const afterChanged: Partial<T> = {}

  for (const key of Object.keys(after) as Array<keyof T>) {
    if (!sameValue(before[key], after[key])) {
      beforeChanged[key] = before[key]
      afterChanged[key] = after[key]
    }
  }

  return { before: beforeChanged, after: afterChanged }
}

const SENSITIVE_KEYS = new Set(['passwordHash', 'password', 'secretHash', 'secret', 'token'])

/**
 * Strips secrets before they reach the audit table.
 *
 * An audit log is widely readable by design — that is the point of it — so a
 * password hash landing in one turns a low-sensitivity table into a high-value
 * target.
 */
function redact(value: unknown): object | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object') return { value }

  const source = value as Record<string, unknown>
  const output: Record<string, unknown> = {}

  for (const [key, entry] of Object.entries(source)) {
    output[key] = SENSITIVE_KEYS.has(key) ? '[redacted]' : normalise(entry)
  }

  return output
}

function normalise(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'bigint') return Number(value)
  return value
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  if (a instanceof Date || b instanceof Date) {
    return normalise(a) === normalise(b)
  }
  return a === b
}
