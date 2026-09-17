import { randomUUID } from 'node:crypto'
import { MovementSource } from '@prisma/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { decodeCursor, encodeCursor, pull, push, type PushMovement } from '@/lib/services/sync'
import { recordMovement } from '@/lib/services/movements'
import { onHand, prisma, seedSerialUnits, seedWarehouse, type Warehouse } from './helpers/warehouse'

/**
 * The sync contract, exercised the way a phone uses it.
 *
 * The mobile team codes against this and ships through app stores, so a breaking
 * change costs a release cycle (WADR-011). These tests are the guard on the
 * behaviour the contract promises, not on its wording.
 */

let wh: Warehouse

beforeEach(async () => {
  wh = await seedWarehouse()
})

afterAll(async () => {
  await prisma.$disconnect()
})

const actor = () => ({ userId: wh.userId, deviceId: null })

const movement = (overrides: Partial<PushMovement> & { type: PushMovement['type'] }): PushMovement => ({
  id: randomUUID(),
  itemId: wh.tapeId,
  quantity: 1,
  occurredAt: new Date().toISOString(),
  siteId: wh.siteId,
  ...overrides,
})

describe('cursor', () => {
  it('round-trips', () => {
    const at = new Date('2026-09-17T10:31:04.512Z')
    const decoded = decodeCursor(encodeCursor({ at, id: 'abc' }))

    expect(decoded?.at.toISOString()).toBe(at.toISOString())
    expect(decoded?.id).toBe('abc')
  })

  it('rejects anything it did not issue', () => {
    // A client that builds a cursor from its own clock skips every change in the
    // drift window — silent data loss. Refusing the input is the only defence.
    expect(() => decodeCursor('not-a-cursor')).toThrow(/cursor/i)
    expect(() => decodeCursor(Buffer.from('nonsense').toString('base64url'))).toThrow()
  })

  it('treats a missing cursor as a full sync', () => {
    expect(decodeCursor(null)).toBeNull()
    expect(decodeCursor(undefined)).toBeNull()
  })
})

describe('pull', () => {
  it('returns master data on a first sync', async () => {
    const result = await pull(prisma, {})

    expect(result.items.length).toBeGreaterThan(0)
    expect(result.locations.length).toBeGreaterThan(0)
    expect(result.nextCursor).toBeTruthy()
  })

  it('returns only what changed after a cursor', async () => {
    const first = await pull(prisma, {})

    // Nothing has changed since, so a second pull carries no items.
    const second = await pull(prisma, { since: first.nextCursor })
    expect(second.items).toHaveLength(0)

    await prisma.item.update({
      where: { id: wh.tapeId },
      data: { name: 'Packing tape, renamed' },
    })

    const third = await pull(prisma, { since: first.nextCursor })
    expect(third.items.map((item) => item.id)).toContain(wh.tapeId)
  })

  it('sends the sentinel batch as null, never as a UUID of zeros', async () => {
    await recordMovement(
      prisma,
      { siteId: wh.siteId, action: { kind: 'RECEIVE', itemId: wh.tapeId, toLocationId: wh.locationA, quantity: 5 } },
      { userId: wh.userId },
    )

    const result = await pull(prisma, {})
    const level = result.stockLevels.find((row) => row.itemId === wh.tapeId)

    expect(level?.batchId).toBeNull()
  })

  it('carries the barcodes a scanner needs', async () => {
    await prisma.itemBarcode.create({
      data: { id: randomUUID(), itemId: wh.tapeId, barcode: '8901234000045', packSize: 1, isPrimary: true },
    })

    const result = await pull(prisma, {})
    const item = result.items.find((row) => row.id === wh.tapeId)

    expect(item?.barcodes).toEqual([
      expect.objectContaining({ barcode: '8901234000045', packSize: 1 }),
    ])
  })

  it('reports a tombstone for soft-deleted master data', async () => {
    const before = await pull(prisma, {})
    await prisma.item.update({ where: { id: wh.tapeId }, data: { deletedAt: new Date() } })

    const after = await pull(prisma, { since: before.nextCursor })

    expect(after.tombstones).toContainEqual({ entity: 'ITEM', id: wh.tapeId })
    expect(after.items.map((item) => item.id)).not.toContain(wh.tapeId)
  })

  it('signals more pages when a batch fills the limit', async () => {
    const result = await pull(prisma, { limit: 1 })
    expect(result.hasMore).toBe(true)
  })
})

describe('push', () => {
  it('applies an outbox and returns a verdict per row', async () => {
    const outbox: PushMovement[] = [
      movement({ type: 'RECEIVE', toLocationId: wh.locationA, quantity: 20 }),
      movement({ type: 'ISSUE', fromLocationId: wh.locationA, quantity: 5 }),
    ]

    const { results } = await push(prisma, outbox, actor())

    expect(results.map((r) => r.status)).toEqual(['ACCEPTED', 'ACCEPTED'])
    expect(await onHand(wh.tapeId, wh.locationA)).toBe(15)
  })

  it('numbers movements on arrival, so an offline one is not left without a document', async () => {
    const { results } = await push(
      prisma,
      [movement({ type: 'RECEIVE', toLocationId: wh.locationA, quantity: 3 })],
      actor(),
    )

    const first = results[0]!
    expect(first.status).toBe('ACCEPTED')
    if (first.status === 'ACCEPTED') expect(first.docNo).toMatch(/^RCV-\d{4}-\d{6}$/)
  })

  it('reports a replayed push as DUPLICATE and applies it once', async () => {
    // A phone retrying after a dropped connection must not double the stock.
    const outbox = [movement({ type: 'RECEIVE', toLocationId: wh.locationA, quantity: 8 })]

    const first = await push(prisma, outbox, actor())
    const second = await push(prisma, outbox, actor())

    expect(first.results[0]?.status).toBe('ACCEPTED')
    expect(second.results[0]?.status).toBe('DUPLICATE')
    expect(await onHand(wh.tapeId, wh.locationA)).toBe(8)
  })

  it('accepts an offline over-issue and flags it', async () => {
    // Two devices both issued the last units in a dead zone. Rejecting the
    // second discards work somebody physically did (WADR-007).
    await push(prisma, [movement({ type: 'RECEIVE', toLocationId: wh.locationA, quantity: 2 })], actor())

    const { results } = await push(
      prisma,
      [movement({ type: 'ISSUE', fromLocationId: wh.locationA, quantity: 5 })],
      actor(),
    )

    expect(results[0]?.status).toBe('FLAGGED')
    expect(await onHand(wh.tapeId, wh.locationA)).toBe(-3)
  })

  it('does not let one bad row block the batch', async () => {
    // A phone that cannot sync because of a single malformed entry is a phone
    // that stops being used.
    const outbox: PushMovement[] = [
      movement({ type: 'RECEIVE', toLocationId: wh.locationA, quantity: 5 }),
      movement({ type: 'ISSUE', fromLocationId: randomUUID(), quantity: 1 }),
      movement({ type: 'RECEIVE', toLocationId: wh.locationA, quantity: 7 }),
    ]

    const { results } = await push(prisma, outbox, actor())

    expect(results.map((r) => r.status)).toEqual(['ACCEPTED', 'REJECTED', 'ACCEPTED'])
    expect(await onHand(wh.tapeId, wh.locationA)).toBe(12)
  })

  it('records the source as MOBILE, so the ledger says where it came from', async () => {
    const pushed = movement({ type: 'RECEIVE', toLocationId: wh.locationA, quantity: 4 })
    await push(prisma, [pushed], actor())

    const stored = await prisma.movement.findUniqueOrThrow({ where: { id: pushed.id } })

    expect(stored.source).toBe(MovementSource.MOBILE)
  })

  it('keeps the device clock separate from the server clock', async () => {
    // occurredAt is the operator's timeline; recordedAt is what ordering and
    // cursors use. A drifting phone must not reorder the ledger.
    const occurredAt = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()
    const pushed = movement({ type: 'RECEIVE', toLocationId: wh.locationA, quantity: 2, occurredAt })

    await push(prisma, [pushed], actor())
    const stored = await prisma.movement.findUniqueOrThrow({ where: { id: pushed.id } })

    expect(stored.occurredAt.toISOString()).toBe(occurredAt)
    expect(stored.recordedAt.getTime()).toBeGreaterThan(stored.occurredAt.getTime())
  })

  it('carries named units through a serial push', async () => {
    const units = await seedSerialUnits(wh.drillId, wh.locationA, 2)
    await prisma.$executeRaw`
      INSERT INTO stock_levels (itemId, locationId, batchId, quantity, updatedAt)
      VALUES (${wh.drillId}, ${wh.locationA}, '00000000-0000-0000-0000-000000000000', 2, NOW(6))
    `

    const { results } = await push(
      prisma,
      [
        movement({
          type: 'ISSUE',
          itemId: wh.drillId,
          fromLocationId: wh.locationA,
          quantity: 1,
          serialUnitIds: [units[0]!],
        }),
      ],
      actor(),
    )

    expect(results[0]?.status).toBe('ACCEPTED')
    const unit = await prisma.serialUnit.findUniqueOrThrow({ where: { id: units[0]! } })
    expect(unit.status).toBe('ISSUED')
  })

  it('rejects a second device issuing the same unit', async () => {
    const units = await seedSerialUnits(wh.drillId, wh.locationA, 1)
    await prisma.$executeRaw`
      INSERT INTO stock_levels (itemId, locationId, batchId, quantity, updatedAt)
      VALUES (${wh.drillId}, ${wh.locationA}, '00000000-0000-0000-0000-000000000000', 1, NOW(6))
    `

    const issue = () =>
      movement({
        type: 'ISSUE',
        itemId: wh.drillId,
        fromLocationId: wh.locationA,
        quantity: 1,
        serialUnitIds: [units[0]!],
      })

    const first = await push(prisma, [issue()], actor())
    const second = await push(prisma, [issue()], actor())

    expect(first.results[0]?.status).toBe('ACCEPTED')
    // Physically impossible, so arithmetic cannot reconcile it (WADR-020).
    expect(second.results[0]?.status).toBe('REJECTED')
  })

  it('applies rows in the order the operator worked', async () => {
    // Receive then issue succeeds; the reverse would be an over-issue. The order
    // the client sends is the order the work happened.
    const { results } = await push(
      prisma,
      [
        movement({ type: 'RECEIVE', toLocationId: wh.locationA, quantity: 10 }),
        movement({ type: 'ISSUE', fromLocationId: wh.locationA, quantity: 10 }),
      ],
      actor(),
    )

    expect(results.every((r) => r.status === 'ACCEPTED')).toBe(true)
  })
})

describe('a full offline cycle', () => {
  it('queues work offline, pushes it, and pulls back a consistent picture', async () => {
    const start = await pull(prisma, {})

    // The phone works in a dead zone: twelve movements accumulate in its outbox.
    const outbox: PushMovement[] = []
    for (let i = 0; i < 6; i++) {
      outbox.push(movement({ type: 'RECEIVE', toLocationId: wh.locationA, quantity: 10 }))
      outbox.push(movement({ type: 'ISSUE', fromLocationId: wh.locationA, quantity: 4 }))
    }

    const { results } = await push(prisma, outbox, actor())
    expect(results.filter((r) => r.status === 'ACCEPTED')).toHaveLength(12)

    const after = await pull(prisma, { since: start.nextCursor })
    const level = after.stockLevels.find(
      (row) => row.itemId === wh.tapeId && row.locationId === wh.locationA,
    )

    expect(level?.quantity).toBe(36)
    expect(await onHand(wh.tapeId, wh.locationA)).toBe(36)
  })
})
