import 'server-only'
import { randomUUID } from 'node:crypto'
import { CountMethod, CountStatus, MovementSource } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import type { Db } from '@/lib/db'
import {
  countKey,
  planCountPostings,
  reconcileCount,
  summariseCount,
  type CountLine,
  type CountSummary,
  type CountedLine,
} from '@/lib/domain/count'
import { NO_BATCH, fromBatchKey, toBatchKey } from '@/lib/domain/types'
import { decode } from '@/lib/domain/sgtin96'
import { ApiError, ErrorCode } from '@/lib/api/errors'
import { AuditAction, writeAudit } from '@/lib/audit'
import { recordMovementInTx } from './movements'
import { allocateDocNo } from './numbering'
import { withDeadlockRetry } from './tx'

/**
 * Cycle counts: submit, then approve.
 *
 * Submitting stores the variance and writes NOTHING to the ledger. A supervisor
 * reviews it and approves, and only then do the COUNT movements post (WADR-008).
 * This is the one behavioural difference from the mobile MVP, which posts
 * adjustments the moment a count is submitted — a miscount going straight to the
 * ledger is the fastest way to lose stock accuracy.
 *
 * Approval posts every line in ONE transaction. A half-approved count would
 * leave the ledger describing a count that never happened.
 */

export interface StartCountInput {
  id?: string
  siteId: string
  locationId: string
  method?: CountMethod
}

export async function startCount(
  prisma: PrismaClient,
  input: StartCountInput,
  actor: { userId: string },
): Promise<{ sessionId: string; docNo: string }> {
  return withDeadlockRetry(
    prisma,
    async (tx) => {
      const sessionId = input.id ?? randomUUID()

      const existing = await tx.countSession.findUnique({
        where: { id: sessionId },
        select: { id: true, docNo: true },
      })
      // Client-generated id, so a retried start is idempotent like everything else.
      if (existing) return { sessionId: existing.id, docNo: existing.docNo }

      const location = await tx.location.findFirst({
        where: { id: input.locationId, deletedAt: null },
        select: { id: true },
      })
      if (!location) throw new ApiError(ErrorCode.NOT_FOUND, 'That location does not exist.')

      const docNo = await allocateDocNo(tx, 'COUNT')

      await tx.countSession.create({
        data: {
          id: sessionId,
          docNo,
          siteId: input.siteId,
          locationId: input.locationId,
          method: input.method ?? CountMethod.BARCODE,
          status: CountStatus.COUNTING,
          startedById: actor.userId,
        },
      })

      return { sessionId, docNo }
    },
    { label: 'start count' },
  )
}

export interface TagRead {
  epc: string
  rssi?: number | null
  readAt?: Date
}

/**
 * Streams raw RFID reads into an open session.
 *
 * De-duplicated by (session, EPC), so sweeping the same pallet three times does
 * not count it three times — which is exactly what an RFID reader does, and the
 * single most common way a naive count triples its numbers.
 *
 * Each EPC is decoded to a serial unit, so the variance is per physical unit
 * rather than per quantity (ARCHITECTURE §5.4).
 */
export async function recordTagReads(
  prisma: PrismaClient,
  sessionId: string,
  tags: readonly TagRead[],
): Promise<{ accepted: number; duplicates: number; unknownEpcs: number }> {
  const session = await prisma.countSession.findUnique({
    where: { id: sessionId },
    select: { id: true, status: true },
  })
  if (!session) throw new ApiError(ErrorCode.NOT_FOUND, 'That count session does not exist.')
  if (session.status !== CountStatus.COUNTING) {
    throw new ApiError(ErrorCode.SESSION_ALREADY_SUBMITTED, 'That count is no longer open.')
  }

  const epcs = [...new Set(tags.map((tag) => tag.epc.toUpperCase()))]
  if (epcs.length === 0) return { accepted: 0, duplicates: 0, unknownEpcs: 0 }

  const units = await prisma.serialUnit.findMany({
    where: { epc: { in: epcs } },
    select: { id: true, epc: true, itemId: true },
  })
  const byEpc = new Map(units.map((unit) => [unit.epc, unit]))

  const before = await prisma.countTag.count({ where: { sessionId } })

  await prisma.countTag.createMany({
    data: tags.map((tag) => {
      const epc = tag.epc.toUpperCase()
      const unit = byEpc.get(epc)
      return {
        id: randomUUID(),
        sessionId,
        epc,
        serialUnitId: unit?.id ?? null,
        itemId: unit?.itemId ?? null,
        rssi: tag.rssi ?? null,
        readAt: tag.readAt ?? new Date(),
      }
    }),
    // The unique key on (sessionId, epc) does the de-duplication; skipping
    // duplicates means a re-sweep is free rather than an error.
    skipDuplicates: true,
  })

  const after = await prisma.countTag.count({ where: { sessionId } })
  const accepted = after - before

  return {
    accepted,
    duplicates: tags.length - accepted,
    // An EPC that decodes as SGTIN-96 but matches no unit is a real finding: a
    // tag from another site, or a unit never received into the system.
    unknownEpcs: epcs.filter((epc) => !byEpc.has(epc) && decode(epc) !== null).length,
  }
}

export interface SubmitCountResult {
  sessionId: string
  docNo: string
  status: CountStatus
  lines: CountLine[]
  summary: CountSummary
}

/**
 * Submits a count for approval. Writes no movements.
 *
 * `counted` may be given explicitly, or omitted to derive it from the RFID tags
 * already streamed into the session.
 */
export async function submitCount(
  prisma: PrismaClient,
  sessionId: string,
  counted?: readonly CountedLine[],
): Promise<SubmitCountResult> {
  return withDeadlockRetry(
    prisma,
    async (tx) => {
      const session = await tx.countSession.findUnique({
        where: { id: sessionId },
        select: { id: true, docNo: true, locationId: true, status: true },
      })
      if (!session) throw new ApiError(ErrorCode.NOT_FOUND, 'That count session does not exist.')
      if (session.status !== CountStatus.COUNTING) {
        throw new ApiError(
          ErrorCode.SESSION_ALREADY_SUBMITTED,
          'That count has already been submitted.',
        )
      }

      const countedLines = counted ?? (await countedFromTags(tx, sessionId))
      const expected = await expectedAtLocation(tx, session.locationId)
      const lines = reconcileCount(expected, countedLines)

      await tx.countLine.deleteMany({ where: { sessionId } })
      if (lines.length > 0) {
        await tx.countLine.createMany({
          data: lines.map((line) => ({
            sessionId,
            itemId: line.itemId,
            batchId: toBatchKey(line.batchId),
            expected: line.expected,
            counted: line.counted,
          })),
        })
      }

      await tx.countSession.update({
        where: { id: sessionId },
        data: { status: CountStatus.SUBMITTED, submittedAt: new Date() },
      })

      return {
        sessionId,
        docNo: session.docNo,
        status: CountStatus.SUBMITTED,
        lines,
        summary: summariseCount(lines),
      }
    },
    { label: 'submit count' },
  )
}

export interface ApproveCountResult {
  sessionId: string
  status: CountStatus
  postings: number
  movementIds: string[]
}

/**
 * Approves a count and posts the COUNT movements, all in one transaction.
 *
 * Every posting goes through the same write path as any other movement, so a
 * count correction is locked, validated and projected exactly like a receipt —
 * and shows up in the ledger with a document number somebody can point at.
 *
 * `acceptNegative` is on: a count IS the authority on what is physically there.
 * Refusing to record "the shelf holds three fewer than you think" because it
 * would make a number negative would be refusing the only reliable evidence in
 * the system.
 */
export async function approveCount(
  prisma: PrismaClient,
  sessionId: string,
  actor: { userId: string },
): Promise<ApproveCountResult> {
  return withDeadlockRetry(
    prisma,
    async (tx) => {
      const session = await tx.countSession.findUnique({
        where: { id: sessionId },
        select: { id: true, siteId: true, locationId: true, status: true, docNo: true },
      })
      if (!session) throw new ApiError(ErrorCode.NOT_FOUND, 'That count session does not exist.')
      if (session.status !== CountStatus.SUBMITTED) {
        throw new ApiError(
          ErrorCode.CONFLICT,
          `Only a submitted count can be approved; this one is ${session.status.toLowerCase()}.`,
        )
      }

      const stored = await tx.countLine.findMany({ where: { sessionId } })
      const lines: CountLine[] = stored.map((line) => ({
        itemId: line.itemId,
        batchId: fromBatchKey(line.batchId),
        expected: line.expected,
        counted: line.counted,
      }))

      const postings = planCountPostings(lines, session.locationId)
      const movementIds: string[] = []

      for (const posting of postings) {
        const outcome = await recordMovementInTx(
          tx,
          {
            siteId: session.siteId,
            countSessionId: sessionId,
            source: MovementSource.WEB,
            action: {
              kind: 'COUNT',
              itemId: posting.itemId,
              locationId: session.locationId,
              batchId: posting.batchId,
              // COUNT takes the COUNTED total and derives the difference itself,
              // rather than trusting a difference computed a moment ago against
              // stock that may have moved since.
              countedQuantity: countedTotalFor(lines, posting.itemId, posting.batchId),
              reasonCodeId: await countVarianceReasonId(tx),
              note: `Cycle count ${session.docNo}`,
            },
          },
          { userId: actor.userId },
          { acceptNegative: true },
        )

        if (outcome.status === 'REJECTED') {
          // NO_CHANGE means stock moved to match between submit and approve, so
          // there is nothing to post. Anything else is a real failure and must
          // abort the whole approval rather than post it half-applied.
          if (outcome.error.code === 'NO_CHANGE') continue
          throw new ApiError(outcome.error.code, outcome.error.message, outcome.error.details)
        }

        if (outcome.status === 'RECORDED' || outcome.status === 'FLAGGED') {
          movementIds.push(outcome.movementId)
        }
      }

      await tx.countSession.update({
        where: { id: sessionId },
        data: {
          status: CountStatus.APPROVED,
          approvedById: actor.userId,
          approvedAt: new Date(),
        },
      })

      await writeAudit(tx, {
        actorUserId: actor.userId,
        action: AuditAction.APPROVE,
        entity: 'CountSession',
        entityId: sessionId,
        after: { docNo: session.docNo, postings: movementIds.length },
      })

      return {
        sessionId,
        status: CountStatus.APPROVED,
        postings: movementIds.length,
        movementIds,
      }
    },
    { label: 'approve count', timeoutMs: 60_000 },
  )
}

export async function rejectCount(
  prisma: PrismaClient,
  sessionId: string,
  actor: { userId: string },
  note?: string,
): Promise<{ sessionId: string; status: CountStatus }> {
  const session = await prisma.countSession.findUnique({
    where: { id: sessionId },
    select: { status: true, docNo: true },
  })
  if (!session) throw new ApiError(ErrorCode.NOT_FOUND, 'That count session does not exist.')
  if (session.status !== CountStatus.SUBMITTED) {
    throw new ApiError(ErrorCode.CONFLICT, 'Only a submitted count can be rejected.')
  }

  await prisma.$transaction(async (tx) => {
    await tx.countSession.update({
      where: { id: sessionId },
      data: { status: CountStatus.REJECTED, rejectedNote: note ?? null },
    })
    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: AuditAction.REJECT,
      entity: 'CountSession',
      entityId: sessionId,
      after: { docNo: session.docNo, note: note ?? null },
    })
  })

  // Nothing posted, so the operator recounts and the ledger never saw it.
  return { sessionId, status: CountStatus.REJECTED }
}

// ---------------------------------------------------------------------------

async function expectedAtLocation(tx: Db, locationId: string): Promise<Map<string, number>> {
  const levels = await tx.stockLevel.findMany({ where: { locationId } })

  const expected = new Map<string, number>()
  for (const level of levels) {
    expected.set(countKey(level.itemId, fromBatchKey(level.batchId)), level.quantity)
  }
  return expected
}

/** Derives counted quantities from the de-duplicated tag reads. */
/**
 * What the tags read so far add up to, per item and batch.
 *
 * Exported so the counting sheet can show the operator what the reader found
 * BEFORE they submit. Deriving it twice — once for the screen and once inside
 * submit — would let the two disagree, and the number on the screen is the one
 * somebody is accountable for.
 */
export function countedFromSessionTags(
  db: PrismaClient,
  sessionId: string,
): Promise<CountedLine[]> {
  return countedFromTags(db, sessionId)
}

async function countedFromTags(tx: Db, sessionId: string): Promise<CountedLine[]> {
  const rows = await tx.countTag.findMany({
    where: { sessionId, itemId: { not: null } },
    select: { itemId: true, serialUnit: { select: { batchId: true } } },
  })

  const totals = new Map<string, CountedLine>()
  for (const row of rows) {
    if (!row.itemId) continue
    const batchId = row.serialUnit?.batchId ?? null
    const key = countKey(row.itemId, batchId)
    const existing = totals.get(key)

    if (existing) existing.quantity += 1
    else totals.set(key, { itemId: row.itemId, batchId, quantity: 1 })
  }

  return [...totals.values()]
}

function countedTotalFor(
  lines: readonly CountLine[],
  itemId: string,
  batchId: string | null,
): number {
  const match = lines.find(
    (line) => line.itemId === itemId && toBatchKey(line.batchId) === toBatchKey(batchId),
  )
  return match?.counted ?? 0
}

/** The reason code every count posting carries. Seeded as COUNT_VAR. */
async function countVarianceReasonId(tx: Db): Promise<string> {
  const reason = await tx.reasonCode.findFirst({
    where: { code: 'COUNT_VAR' },
    select: { id: true },
  })

  if (!reason) {
    throw new ApiError(
      ErrorCode.INTERNAL,
      'The COUNT_VAR reason code is missing. Run the seed before approving counts.',
    )
  }

  return reason.id
}

export { NO_BATCH }
