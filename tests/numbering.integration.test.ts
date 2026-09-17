import { PrismaClient } from '@prisma/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { allocateDocNo, formatDocNo, parseDocNo } from '@/lib/services/numbering'
import { withDeadlockRetry } from '@/lib/services/tx'
import type { Db } from '@/lib/db'

/**
 * Document numbering, against a real MySQL database.
 *
 * `allocateDocNo` relies on MySQL's LAST_INSERT_ID(expr) trick, which is
 * CONNECTION-SCOPED. That makes it correct only when the UPDATE and the
 * read-back run on the same connection — which is exactly what an interactive
 * transaction guarantees and what a pooled call does not. A mocked Prisma client
 * cannot demonstrate either way, so this test uses the demo database.
 *
 * Reference: docs/ARCHITECTURE.md §4.4
 */

const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL_TEST })

/**
 * Callers always go through `withDeadlockRetry`, exactly as the movement service
 * will. Numbering takes a row lock, and lock contention is normal — correctness
 * comes from retrying the whole transaction, not from never colliding.
 */
const allocate = (key: Parameters<typeof allocateDocNo>[1]) =>
  withDeadlockRetry(prisma, (tx) => allocateDocNo(tx, key), { label: `allocate ${key}` })

const sequenceOf = (docNo: string) => parseDocNo(docNo)!.sequence

beforeEach(async () => {
  await prisma.$executeRawUnsafe('DELETE FROM number_sequences')
})

afterAll(async () => {
  await prisma.$executeRawUnsafe('DELETE FROM number_sequences')
  await prisma.$disconnect()
})

describe('allocateDocNo', () => {
  it('starts at 1 and increments', async () => {
    const year = String(new Date().getUTCFullYear())

    expect(await allocate('RECEIVE')).toBe(`RCV-${year}-000001`)
    expect(await allocate('RECEIVE')).toBe(`RCV-${year}-000002`)
    expect(await allocate('RECEIVE')).toBe(`RCV-${year}-000003`)
  })

  it('never issues the same number twice under concurrency', async () => {
    // The failure this guards against is two operators receiving the same
    // document number for different stock, which is unrecoverable paperwork.
    const allocated = await Promise.all(Array.from({ length: 25 }, () => allocate('ISSUE')))

    expect(new Set(allocated).size).toBe(25)
  })

  it('stays gapless under concurrency', async () => {
    const allocated = await Promise.all(Array.from({ length: 25 }, () => allocate('ISSUE')))
    const sequences = allocated.map(sequenceOf).sort((a, b) => a - b)

    expect(sequences).toEqual(Array.from({ length: 25 }, (_, i) => i + 1))
  })

  it('keeps an independent counter per document type', async () => {
    await allocate('RECEIVE')
    await allocate('RECEIVE')

    // ISSUE must not inherit RECEIVE's position.
    expect(sequenceOf(await allocate('ISSUE'))).toBe(1)
    expect(sequenceOf(await allocate('ADJUST'))).toBe(1)
    expect(sequenceOf(await allocate('RECEIVE'))).toBe(3)
  })

  it('releases the number when the caller transaction rolls back', async () => {
    // This is why allocation must happen inside the same transaction as the row
    // it numbers: a failed movement must not burn a document number.
    const first = await allocate('SCRAP')

    await expect(
      prisma.$transaction(async (tx) => {
        await allocateDocNo(tx as Db, 'SCRAP')
        throw new Error('deliberate rollback')
      }),
    ).rejects.toThrow('deliberate rollback')

    expect(sequenceOf(await allocate('SCRAP'))).toBe(sequenceOf(first) + 1)
  })

  it('survives concurrent first-of-the-period creation', async () => {
    // The cold-start race: two transactions both find no sequence row and both
    // try to create it, which InnoDB resolves by killing one. The retry wrapper
    // is what makes that invisible to the caller.
    const [a, b] = await Promise.all([allocate('COUNT'), allocate('COUNT')])

    expect([sequenceOf(a), sequenceOf(b)].sort()).toEqual([1, 2])
  })

  it('numbers a cold start under heavy concurrency without gaps or duplicates', async () => {
    const allocated = await Promise.all(Array.from({ length: 20 }, () => allocate('MOVE')))

    expect(new Set(allocated).size).toBe(20)
    expect(allocated.map(sequenceOf).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    )
  })
})

describe('formatDocNo / parseDocNo', () => {
  it('round-trips', () => {
    const docNo = formatDocNo('RCV', '2026', 123)

    expect(docNo).toBe('RCV-2026-000123')
    expect(parseDocNo(docNo)).toEqual({ prefix: 'RCV', period: '2026', sequence: 123 })
  })

  it('respects a custom padding width', () => {
    expect(formatDocNo('ISS', '2026', 7, 4)).toBe('ISS-2026-0007')
  })

  it('does not truncate a sequence that outgrows its padding', () => {
    expect(formatDocNo('ISS', '2026', 1_234_567)).toBe('ISS-2026-1234567')
  })

  it('rejects anything that is not a document number', () => {
    for (const bad of ['', 'RCV-2026', 'not a doc no', '2026-000123', 'RCVX-2026-000123']) {
      expect(parseDocNo(bad)).toBeNull()
    }
  })
})
