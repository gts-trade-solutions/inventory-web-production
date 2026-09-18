import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { auditFacets, describeChange, listAuditEntries } from '@/lib/services/audit-log'
import { AuditAction, writeAudit } from '@/lib/audit'
import { prisma, seedWarehouse, type Warehouse } from './helpers/warehouse'

/**
 * Reading the audit log.
 *
 * Several decisions in this system are justified by being "audited". That claim
 * is worth nothing if the log cannot be read back — so these check that an
 * entry written by one part of the system comes out legible at the other end.
 */

let wh: Warehouse

beforeEach(async () => {
  wh = await seedWarehouse()
  await prisma.auditLog.deleteMany()
})

afterAll(async () => {
  await prisma.$disconnect()
})

const entry = (overrides: Partial<Parameters<typeof writeAudit>[1]> = {}) =>
  writeAudit(prisma, {
    actorUserId: wh.userId,
    action: AuditAction.UPDATE,
    entity: 'Item',
    entityId: wh.tapeId,
    ...overrides,
  })

describe('listing', () => {
  it('returns entries newest first', async () => {
    await entry({ action: AuditAction.CREATE })
    await entry({ action: AuditAction.UPDATE })
    await entry({ action: AuditAction.APPROVE })

    const { entries } = await listAuditEntries(prisma)

    expect(entries.map((row) => row.action)).toEqual(['APPROVE', 'UPDATE', 'CREATE'])
  })

  it('names the actor', async () => {
    await entry()

    const { entries } = await listAuditEntries(prisma)

    expect(entries[0]?.actor).toBe('Tester')
    expect(entries[0]?.actorEmail).toBe('tester@inventory.local')
  })

  it('survives the actor being gone', async () => {
    // A deleted user, or a demo reset that replaced everybody. The entry is the
    // record; the link to a live row is not.
    await writeAudit(prisma, {
      actorUserId: null,
      action: AuditAction.DEMO_RESET,
      entity: 'DemoDatabase',
      entityId: 'demo',
      after: { ok: true, resetBy: 'admin@inventory.local' },
    })

    const { entries } = await listAuditEntries(prisma)

    expect(entries[0]?.actor).toBeNull()
    expect(entries[0]?.after).toMatchObject({ resetBy: 'admin@inventory.local' })
  })

  it('filters by action and by entity', async () => {
    await entry({ action: AuditAction.CREATE, entity: 'Item' })
    await entry({ action: AuditAction.APPROVE, entity: 'CountSession' })

    expect((await listAuditEntries(prisma, { action: 'APPROVE' })).entries).toHaveLength(1)
    expect((await listAuditEntries(prisma, { entity: 'Item' })).entries).toHaveLength(1)
  })

  it('finds an entry somebody half-remembers', async () => {
    await entry({ action: AuditAction.QUARANTINE, entity: 'Batch' })

    const { entries } = await listAuditEntries(prisma, { search: 'QUARANT' })

    expect(entries).toHaveLength(1)
  })

  it('pages without repeating or skipping', async () => {
    // The id breaks ties, so entries written in the same millisecond have a
    // stable order. Without it a page boundary can show a row twice or not at
    // all, which in an audit log is worse than useless.
    for (let i = 0; i < 25; i++) await entry({ entityId: randomUUID() })

    const first = await listAuditEntries(prisma, { limit: 10 })
    expect(first.entries).toHaveLength(10)
    expect(first.nextCursor).toBeTruthy()

    const second = await listAuditEntries(prisma, { limit: 10, cursor: first.nextCursor! })
    const seen = new Set([...first.entries, ...second.entries].map((row) => row.id))

    expect(seen.size).toBe(20)
  })

  it('stops offering a cursor at the end', async () => {
    await entry()
    expect((await listAuditEntries(prisma, { limit: 10 })).nextCursor).toBeNull()
  })

  it('caps an absurd page size', async () => {
    for (let i = 0; i < 5; i++) await entry({ entityId: randomUUID() })
    expect((await listAuditEntries(prisma, { limit: 100_000 })).entries.length).toBeLessThan(500)
  })
})

describe('facets', () => {
  it('lists the actions and entities actually present', async () => {
    await entry({ action: AuditAction.CREATE, entity: 'Item' })
    await entry({ action: AuditAction.APPROVE, entity: 'CountSession' })
    await entry({ action: AuditAction.APPROVE, entity: 'CountSession' })

    const facets = await auditFacets(prisma)

    expect(facets.actions).toEqual(['APPROVE', 'CREATE'])
    expect(facets.entities).toEqual(['CountSession', 'Item'])
  })
})

describe('describeChange', () => {
  it('lists only what actually differs', async () => {
    // The question somebody opening an entry is asking is "what changed?", not
    // "what was the whole row?".
    const changes = describeChange(
      { status: 'ACTIVE', name: 'Tape', reorderPoint: 10 },
      { status: 'QUARANTINE', name: 'Tape', reorderPoint: 10 },
    )

    expect(changes).toEqual([{ field: 'status', from: 'ACTIVE', to: 'QUARANTINE' }])
  })

  it('shows a field that appeared or vanished', () => {
    expect(describeChange({}, { note: 'Damaged on arrival' })).toEqual([
      { field: 'note', from: '—', to: 'Damaged on arrival' },
    ])
  })

  it('distinguishes null from absent', () => {
    // "Set to nothing" and "not recorded" are different facts, and an audit log
    // that conflates them cannot answer the question it exists for.
    expect(describeChange({ note: 'x' }, { note: null })).toEqual([
      { field: 'note', from: 'x', to: 'none' },
    ])
  })

  it('is empty when nothing changed', () => {
    expect(describeChange({ a: 1 }, { a: 1 })).toEqual([])
    expect(describeChange(null, null)).toEqual([])
  })

  it('does not fall over on a non-object payload', () => {
    expect(describeChange('a string', 42)).toEqual([])
  })
})
