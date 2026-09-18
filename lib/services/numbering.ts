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
 * statement, taking one exclusive row lock. The row is then read back inside the
 * same transaction, which sees our own uncommitted increment while the lock
 * keeps everyone else out.
 *
 * MUST be called inside the same transaction as the row it numbers, for two
 * reasons: the read-back is only safe while we hold the lock, and a rollback
 * must release the number so the sequence stays gapless.
 *
 * The UPDATE comes FIRST and the INSERT only runs when the row does not yet
 * exist. The obvious ordering — INSERT IGNORE, then UPDATE — deadlocks under
 * concurrency: INSERT IGNORE takes a shared lock while checking for a duplicate,
 * and the UPDATE then has to upgrade it to exclusive. Two transactions doing
 * that at once each hold a shared lock and wait for the other to release it.
 * Verified in tests/numbering.integration.test.ts.
 */
export async function allocateDocNo(db: Db, key: DocKey, now: Date = new Date()): Promise<string> {
  const period = currentPeriod(now)
  const prefix = DOC_PREFIXES[key]

  // Hot path: the sequence row already exists, so this is a single statement
  // taking a single exclusive lock.
  let updated = await db.$executeRaw`
    UPDATE number_sequences
       SET nextValue = nextValue + 1, updatedAt = NOW(3)
     WHERE \`key\` = ${key} AND period = ${period}
  `

  if (updated === 0) {
    // First document of this period. INSERT IGNORE so two concurrent callers
    // racing to create the row don't collide on the primary key; whichever
    // loses simply proceeds to the UPDATE below.
    await db.$executeRaw`
      INSERT IGNORE INTO number_sequences (\`key\`, period, prefix, nextValue, padding, updatedAt)
      VALUES (${key}, ${period}, ${prefix}, 1, 6, NOW(3))
    `

    updated = await db.$executeRaw`
      UPDATE number_sequences
         SET nextValue = nextValue + 1, updatedAt = NOW(3)
       WHERE \`key\` = ${key} AND period = ${period}
    `
  }

  if (updated !== 1) {
    throw new Error(`Failed to allocate a document number for ${key}/${period}.`)
  }

  // Safe because we hold the exclusive lock on this row for the rest of the
  // transaction: nobody else can change it between the UPDATE and this read.
  //
  // The PREFIX is read from the row too, not taken from DOC_PREFIXES. The
  // constant is only the default used when the row is first created; an admin
  // who changes a prefix (lib/services/sequences.ts) expects the next document
  // to carry it, and reading the constant here made that screen a control that
  // silently did nothing.
  const [row] = await db.$queryRaw<Array<{ prefix: string; nextValue: number; padding: number }>>`
    SELECT prefix, nextValue, padding FROM number_sequences
     WHERE \`key\` = ${key} AND period = ${period}
  `
  if (!row) {
    throw new Error(`Failed to read back the allocated document number for ${key}/${period}.`)
  }

  // nextValue now points at the NEXT document, so the one we own is one less.
  return formatDocNo(row.prefix, period, row.nextValue - 1, row.padding)
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
