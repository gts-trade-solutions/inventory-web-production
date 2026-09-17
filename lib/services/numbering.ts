import 'server-only'
import type { Db } from '@/lib/db'
import { MovementType } from '@prisma/client'

/**
 * Human-readable document numbers: RCV-2026-000123.
 *
 * Operators refer to paperwork by number, not by UUID. Numbers are allocated on
 * the SERVER at the moment of recording, so a movement queued offline on a phone
 * gets its number when it syncs — which keeps numbering gapless and unique
 * regardless of how many devices are out on the floor (WADR-021).
 *
 * The client-generated UUID remains the primary key and the idempotency key;
 * `docNo` is purely for humans.
 *
 * Reference: docs/ARCHITECTURE.md §4.4
 */

export const DOC_PREFIXES = {
  RECEIVE: 'RCV',
  ISSUE: 'ISS',
  MOVE: 'MOV',
  ADJUST: 'ADJ',
  SCRAP: 'SCR',
  COUNT: 'CNT',
  PRINT: 'PRN',
} as const

export type DocKey = keyof typeof DOC_PREFIXES

/** Document prefix for a ledger movement type. */
export function docKeyForMovement(type: MovementType): DocKey {
  switch (type) {
    case MovementType.RECEIVE:
      return 'RECEIVE'
    case MovementType.ISSUE:
      return 'ISSUE'
    case MovementType.MOVE:
      return 'MOVE'
    case MovementType.ADJUST:
      return 'ADJUST'
    case MovementType.SCRAP:
      return 'SCRAP'
    case MovementType.COUNT:
      return 'COUNT'
  }
}

/** Numbering restarts each calendar year, on the server's clock. */
export function currentPeriod(now: Date = new Date()): string {
  return String(now.getUTCFullYear())
}

/**
 * Allocates the next document number for `key`, atomically.
 *
 * MySQL's LAST_INSERT_ID(expr) trick makes the read-and-increment a single
 * statement: the UPDATE takes a row lock, stores the new value, and makes it
 * retrievable per-connection. Two concurrent callers cannot receive the same
 * number, and no SELECT ... FOR UPDATE round trip is needed.
 *
 * MUST be called inside the same transaction as the row it numbers. If that
 * transaction rolls back, the allocation rolls back with it — which is what
 * keeps the sequence gapless.
 */
export async function allocateDocNo(db: Db, key: DocKey, now: Date = new Date()): Promise<string> {
  const period = currentPeriod(now)
  const prefix = DOC_PREFIXES[key]

  // Create the row for a new year on first use. INSERT IGNORE so two concurrent
  // first-of-the-year callers don't collide on the primary key.
  await db.$executeRaw`
    INSERT IGNORE INTO number_sequences (\`key\`, period, prefix, nextValue, padding, updatedAt)
    VALUES (${key}, ${period}, ${prefix}, 1, 6, NOW(6))
  `

  const updated = await db.$executeRaw`
    UPDATE number_sequences
       SET nextValue = LAST_INSERT_ID(nextValue + 1), updatedAt = NOW(6)
     WHERE \`key\` = ${key} AND period = ${period}
  `

  if (updated !== 1) {
    throw new Error(`Failed to allocate a document number for ${key}/${period}.`)
  }

  // LAST_INSERT_ID() returned the value AFTER incrementing, so the number this
  // caller owns is one less.
  const [row] = await db.$queryRaw<Array<{ allocated: bigint }>>`
    SELECT LAST_INSERT_ID() AS allocated
  `
  if (!row) {
    throw new Error(`Failed to read back the allocated document number for ${key}/${period}.`)
  }

  const sequence = Number(row.allocated) - 1

  const [config] = await db.$queryRaw<Array<{ padding: number }>>`
    SELECT padding FROM number_sequences WHERE \`key\` = ${key} AND period = ${period}
  `
  const padding = config?.padding ?? 6

  return formatDocNo(prefix, period, sequence, padding)
}

export function formatDocNo(prefix: string, period: string, sequence: number, padding = 6): string {
  return `${prefix}-${period}-${String(sequence).padStart(padding, '0')}`
}

/** Parses a document number back into its parts, or null if it isn't one. */
export function parseDocNo(
  docNo: string,
): { prefix: string; period: string; sequence: number } | null {
  const match = /^([A-Z]{3})-(\d{4})-(\d+)$/.exec(docNo.trim().toUpperCase())
  if (!match) return null

  const [, prefix, period, sequence] = match
  if (!prefix || !period || !sequence) return null

  return { prefix, period, sequence: Number(sequence) }
}
