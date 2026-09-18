import 'server-only'
import type { PrismaClient } from '@prisma/client'
import { ApiError, ErrorCode } from '@/lib/api/errors'
import { AuditAction, writeAudit } from '@/lib/audit'
import { DOC_PREFIXES, currentPeriod, formatDocNo, type DocKey } from './numbering'

/**
 * Document numbering administration (PROJECT_PLAN 7.4).
 *
 * Document numbers are how people refer to paperwork: RCV-2026-000123. The
 * sequences behind them are allocated inside the same transaction as the row
 * they number, so they are gapless and unique under any amount of concurrency
 * (see numbering.ts).
 *
 * This screen exists for the two legitimate reasons an admin needs to touch
 * them: matching the numbering a business already uses, and continuing from
 * wherever a previous system stopped.
 *
 * **`nextValue` may be raised but never lowered.** Lowering it reissues numbers
 * that already exist on documents somebody has printed, filed, or sent to a
 * customer. Two receipts called RCV-2026-000123 is not a numbering problem that
 * shows up when it happens — it shows up months later, in a recall, when the
 * paperwork for a batch turns out to describe a different delivery. Skipping
 * numbers leaves a gap, which is visible and harmless. Repeating one is
 * invisible and permanent, so the asymmetry is deliberate.
 */

export interface SequenceRow {
  key: DocKey
  /** What this prefix is for, in words. */
  purpose: string
  period: string
  prefix: string
  nextValue: number
  padding: number
  updatedAt: Date | null
  /** What the next document will actually be called. */
  preview: string
  /** False when no document of this kind has been issued this period yet. */
  exists: boolean
}

const PURPOSE: Record<DocKey, string> = {
  RECEIVE: 'Goods received',
  ISSUE: 'Stock issued',
  MOVE: 'Moves between locations',
  ADJUST: 'Adjustments',
  SCRAP: 'Scrapped stock',
  COUNT: 'Cycle counts',
  PRINT: 'Label print jobs',
}

/**
 * Every sequence for a period, including ones no document has used yet.
 *
 * The unused ones are shown deliberately. A sequence row is created lazily, by
 * the first document of its kind, so a screen listing only existing rows would
 * be empty in January and would hide exactly the sequences an admin wants to
 * set up before going live.
 */
export async function listSequences(
  db: PrismaClient,
  period: string = currentPeriod(),
): Promise<SequenceRow[]> {
  const rows = await db.numberSequence.findMany({ where: { period } })
  const byKey = new Map(rows.map((row) => [row.key, row]))

  return (Object.keys(DOC_PREFIXES) as DocKey[]).map((key) => {
    const row = byKey.get(key)
    const prefix = row?.prefix ?? DOC_PREFIXES[key]
    const nextValue = row?.nextValue ?? 1
    const padding = row?.padding ?? 6

    return {
      key,
      purpose: PURPOSE[key],
      period,
      prefix,
      nextValue,
      padding,
      updatedAt: row?.updatedAt ?? null,
      preview: formatDocNo(prefix, period, nextValue, padding),
      exists: row !== undefined,
    }
  })
}

export interface SequenceChanges {
  prefix?: string
  nextValue?: number
  padding?: number
}

export async function updateSequence(
  db: PrismaClient,
  key: DocKey,
  period: string,
  changes: SequenceChanges,
  actor: { userId: string },
): Promise<SequenceRow> {
  if (!(key in DOC_PREFIXES)) {
    throw new ApiError(ErrorCode.NOT_FOUND, 'That document type does not exist.')
  }

  const existing = await db.numberSequence.findUnique({ where: { key_period: { key, period } } })

  const before = {
    prefix: existing?.prefix ?? DOC_PREFIXES[key],
    nextValue: existing?.nextValue ?? 1,
    padding: existing?.padding ?? 6,
  }

  const prefix = changes.prefix === undefined ? before.prefix : cleanPrefix(changes.prefix)
  const padding = changes.padding === undefined ? before.padding : cleanPadding(changes.padding)
  const nextValue =
    changes.nextValue === undefined ? before.nextValue : cleanNextValue(changes.nextValue)

  if (nextValue < before.nextValue) {
    throw new ApiError(
      ErrorCode.VALIDATION_FAILED,
      `The next number can be raised but not lowered. ${formatDocNo(before.prefix, period, before.nextValue - 1, before.padding)} and everything before it has already been issued, and reusing a number would give two different documents the same name.`,
    )
  }

  await refusePrefixClash(db, key, period, prefix)

  // upsert, because the row may not exist yet: sequences are created lazily by
  // the first document of their kind, and an admin setting numbering up before
  // go-live is precisely the case where it does not.
  await db.numberSequence.upsert({
    where: { key_period: { key, period } },
    create: { key, period, prefix, nextValue, padding },
    update: { prefix, nextValue, padding },
  })

  await writeAudit(db, {
    actorUserId: actor.userId,
    action: AuditAction.UPDATE,
    entity: 'NumberSequence',
    entityId: `${key}/${period}`,
    before,
    after: { prefix, nextValue, padding },
  })

  return {
    key,
    purpose: PURPOSE[key],
    period,
    prefix,
    nextValue,
    padding,
    updatedAt: new Date(),
    preview: formatDocNo(prefix, period, nextValue, padding),
    exists: true,
  }
}

// ---------------------------------------------------------------------------

function cleanPrefix(raw: string): string {
  const prefix = raw.trim().toUpperCase()

  // Three letters, because parseDocNo reads them back with /^([A-Z]{3})-/. A
  // prefix this rejects would produce numbers the rest of the system cannot
  // parse — the trace lookup would stop finding the documents it created.
  if (!/^[A-Z]{3}$/.test(prefix)) {
    throw new ApiError(
      ErrorCode.VALIDATION_FAILED,
      'A prefix is exactly three letters, like RCV. Document numbers are read back by that shape elsewhere.',
    )
  }

  return prefix
}

function cleanPadding(raw: number): number {
  if (!Number.isInteger(raw) || raw < 1 || raw > 12) {
    throw new ApiError(ErrorCode.VALIDATION_FAILED, 'Padding is a whole number between 1 and 12.')
  }

  return raw
}

function cleanNextValue(raw: number): number {
  if (!Number.isInteger(raw) || raw < 1) {
    throw new ApiError(ErrorCode.VALIDATION_FAILED, 'The next number is a whole number from 1 up.')
  }
  if (raw > 99_999_999) {
    throw new ApiError(ErrorCode.VALIDATION_FAILED, 'That next number is implausibly large.')
  }

  return raw
}

/**
 * Refuses a prefix already used by another document type in the same period.
 *
 * Two types sharing a prefix produces numbers that cannot be told apart: an
 * ADJ-2026-000042 that is sometimes an adjustment and sometimes a scrap. The
 * ledger still knows which is which; the person holding the printout does not.
 */
async function refusePrefixClash(
  db: PrismaClient,
  key: DocKey,
  period: string,
  prefix: string,
): Promise<void> {
  const clash = await db.numberSequence.findFirst({
    where: { period, prefix, key: { not: key } },
    select: { key: true },
  })

  if (clash) {
    throw new ApiError(
      ErrorCode.VALIDATION_FAILED,
      `"${prefix}" is already the prefix for ${PURPOSE[clash.key as DocKey] ?? clash.key}. Two document types sharing a prefix produce numbers nobody can tell apart.`,
    )
  }

  // The defaults matter too: an unused sequence still hands out its default
  // prefix the moment somebody records that kind of document.
  const defaultClash = (Object.keys(DOC_PREFIXES) as DocKey[]).find(
    (other) => other !== key && DOC_PREFIXES[other] === prefix,
  )

  if (defaultClash) {
    const overridden = await db.numberSequence.findUnique({
      where: { key_period: { key: defaultClash, period } },
      select: { prefix: true },
    })

    // Only a clash if that type is still using its default.
    if (!overridden || overridden.prefix === prefix) {
      throw new ApiError(
        ErrorCode.VALIDATION_FAILED,
        `"${prefix}" is the prefix ${PURPOSE[defaultClash]} uses. Change that one first if you mean to swap them.`,
      )
    }
  }
}
