import { randomUUID } from 'node:crypto'
import { LocationZone, PrismaClient, TrackingMode, UserRole } from '@prisma/client'

/**
 * A disposable warehouse in the DEMO database, for integration tests.
 *
 * Integration tests run against real MySQL because the properties under test —
 * row locking, transaction isolation, atomic upserts, deadlock behaviour — are
 * properties of the database, not of our code. A mocked client would assert that
 * our mock behaves as we imagined MySQL behaves, which is worth nothing.
 */

export const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL_DEMO })

export interface Warehouse {
  siteId: string
  userId: string
  locationA: string
  locationB: string
  tapeId: string
  adhesiveId: string
  drillId: string
  freshBatchId: string
  soonBatchId: string
  reasonCodeId: string
}

/**
 * Wipes every transactional table, in foreign-key-safe order.
 *
 * Deliberately NOT a transaction rollback: these tests run real concurrent
 * transactions against each other, so they cannot all live inside one.
 */
export async function resetWarehouse(): Promise<void> {
  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0')
  for (const table of [
    'movement_serials',
    'count_tags',
    'count_lines',
    'count_sessions',
    'print_jobs',
    'movements',
    'stock_levels',
    'serial_units',
    'batches',
    'epc_serial_blocks',
    'item_barcodes',
    'items',
    'locations',
    'number_sequences',
    'audit_log',
  ]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`)
  }
  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1')
}

export async function seedWarehouse(): Promise<Warehouse> {
  await resetWarehouse()

  const site = await prisma.site.upsert({
    where: { code: 'TEST' },
    update: {},
    create: { id: randomUUID(), code: 'TEST', name: 'Test warehouse' },
  })

  const user = await prisma.user.upsert({
    where: { email: 'tester@inventory.local' },
    update: {},
    create: {
      id: randomUUID(),
      email: 'tester@inventory.local',
      name: 'Tester',
      passwordHash: 'not-used',
      role: UserRole.ADMIN,
    },
  })

  const reason = await prisma.reasonCode.upsert({
    where: { code: 'TEST_ADJ' },
    update: {},
    create: { id: randomUUID(), code: 'TEST_ADJ', label: 'Test adjustment', appliesTo: 'ADJUST' },
  })

  const [locationA, locationB] = await Promise.all([
    prisma.location.create({
      data: {
        id: randomUUID(),
        siteId: site.id,
        code: 'A-01',
        name: 'Aisle A',
        zone: LocationZone.STORAGE,
      },
    }),
    prisma.location.create({
      data: {
        id: randomUUID(),
        siteId: site.id,
        code: 'B-01',
        name: 'Aisle B',
        zone: LocationZone.STORAGE,
      },
    }),
  ])

  const tape = await prisma.item.create({
    data: {
      id: randomUUID(),
      sku: 'PKG-1004',
      name: 'Packing tape',
      unit: 'rolls',
      reorderPoint: 10,
      trackingMode: TrackingMode.NONE,
    },
  })

  const adhesive = await prisma.item.create({
    data: {
      id: randomUUID(),
      sku: 'CHM-2001',
      name: 'Industrial adhesive',
      unit: 'cans',
      reorderPoint: 5,
      trackingMode: TrackingMode.BATCH,
      expiryRequired: true,
    },
  })

  const drill = await prisma.item.create({
    data: {
      id: randomUUID(),
      sku: 'TLS-0015',
      name: 'Cordless drill',
      unit: 'pcs',
      reorderPoint: 3,
      trackingMode: TrackingMode.SERIAL,
    },
  })

  const [fresh, soon] = await Promise.all([
    prisma.batch.create({
      data: {
        id: randomUUID(),
        itemId: adhesive.id,
        batchNo: 'LOT-FRESH',
        expiryDate: new Date('2027-09-01'),
      },
    }),
    prisma.batch.create({
      data: {
        id: randomUUID(),
        itemId: adhesive.id,
        batchNo: 'LOT-SOON',
        expiryDate: new Date('2026-10-01'),
      },
    }),
  ])

  return {
    siteId: site.id,
    userId: user.id,
    locationA: locationA.id,
    locationB: locationB.id,
    tapeId: tape.id,
    adhesiveId: adhesive.id,
    drillId: drill.id,
    freshBatchId: fresh.id,
    soonBatchId: soon.id,
    reasonCodeId: reason.id,
  }
}

/** Creates serial units already in stock at a location. */
export async function seedSerialUnits(
  itemId: string,
  locationId: string,
  count: number,
): Promise<string[]> {
  const ids: string[] = []

  for (let i = 0; i < count; i++) {
    const unit = await prisma.serialUnit.create({
      data: {
        id: randomUUID(),
        itemId,
        serialNo: `SN-${String(i + 1).padStart(4, '0')}`,
        locationId,
      },
    })
    ids.push(unit.id)
  }

  return ids
}

/** On-hand from the projection, summed across batches. */
export async function onHand(itemId: string, locationId: string): Promise<number> {
  const rows = await prisma.stockLevel.findMany({ where: { itemId, locationId } })
  return rows.reduce((sum, row) => sum + row.quantity, 0)
}

export async function ledgerCount(itemId: string): Promise<number> {
  return prisma.movement.count({ where: { itemId } })
}
