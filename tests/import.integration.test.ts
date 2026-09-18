import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { applyImport, planImport } from '@/lib/services/import'
import { findProjectionDrift } from '@/lib/services/projection'
import { onHand, prisma, seedWarehouse, type Warehouse } from './helpers/warehouse'

/**
 * Importing from a spreadsheet.
 *
 * Two properties carry the weight: a dry run writes NOTHING, and an opening
 * balance goes through the ledger like any other receipt. The second is the one
 * that would be tempting to skip — writing stock_levels directly is simpler and
 * produces stock no movement explains, which is precisely the corruption
 * findProjectionDrift exists to catch.
 */

let wh: Warehouse

beforeEach(async () => {
  wh = await seedWarehouse()
})

afterAll(async () => {
  await prisma.$disconnect()
})

const actor = () => ({ userId: wh.userId, siteId: wh.siteId })

describe('a dry run writes nothing', () => {
  it('for items', async () => {
    const before = await prisma.item.count()

    const plan = await planImport(prisma, 'items', 'sku,name\nNEW-1,Something new')

    expect(plan.create).toBe(1)
    expect(await prisma.item.count()).toBe(before)
  })

  it('for opening balances', async () => {
    const plan = await planImport(
      prisma,
      'balances',
      `sku,location,quantity\nPKG-1004,A-01,50`,
    )

    expect(plan.create).toBe(1)
    expect(await onHand(wh.tapeId, wh.locationA)).toBe(0)
    expect(await prisma.movement.count()).toBe(0)
  })
})

describe('importing items', () => {
  it('creates and updates in one file', async () => {
    const csv = 'sku,name,unit,reorderPoint,tracking\nPKG-1004,Packing tape,rolls,20,NONE\nNEW-9,Brand new,pcs,5,NONE'

    const plan = await planImport(prisma, 'items', csv)
    expect(plan).toMatchObject({ create: 1, update: 1, problems: [] })

    const outcome = await applyImport(prisma, 'items', csv, actor())

    expect(outcome.applied).toBe(2)
    expect(await prisma.item.findUnique({ where: { sku: 'NEW-9' } })).not.toBeNull()
    const updated = await prisma.item.findUniqueOrThrow({ where: { sku: 'PKG-1004' } })
    expect(updated.reorderPoint).toBe(20)
  })

  it('attaches a barcode', async () => {
    await applyImport(
      prisma,
      'items',
      'sku,name,barcode\nBAR-1,Barcoded thing,8901234000045',
      actor(),
    )

    const item = await prisma.item.findUniqueOrThrow({
      where: { sku: 'BAR-1' },
      include: { barcodes: true },
    })
    expect(item.barcodes[0]?.barcode).toBe('8901234000045')
  })

  it('refuses a barcode with a bad check digit', async () => {
    // A barcode no scanner will read produces an item nobody can find by
    // scanning — the one thing the barcode was for.
    const plan = await planImport(
      prisma,
      'items',
      'sku,name,barcode\nBAD-1,Bad barcode,8901234000047',
    )

    expect(plan.problems[0]?.message).toMatch(/check the last digit/i)
    expect(plan.create).toBe(0)
  })

  it('reports the same SKU appearing twice, rather than letting one win', async () => {
    const plan = await planImport(prisma, 'items', 'sku,name\nA,First\nA,Second')

    expect(plan.problems[0]?.message).toMatch(/also appears on row 2/)
    expect(plan.create).toBe(1)
  })

  it('names the row a problem is on, counting as a spreadsheet does', async () => {
    const plan = await planImport(prisma, 'items', 'sku,name\nA,Fine\n,No SKU here')

    expect(plan.problems[0]?.line).toBe(3)
  })

  it('refuses an unknown tracking mode', async () => {
    const plan = await planImport(prisma, 'items', 'sku,name,tracking\nA,Thing,MAGIC')

    expect(plan.problems[0]?.message).toMatch(/NONE, BATCH or SERIAL/)
  })

  it('says which column is missing before reading any row', async () => {
    await expect(
      planImport(prisma, 'items', 'Item Code,Description\nA,B'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })
})

describe('importing opening balances', () => {
  it('receives them through the ledger, with a document number', async () => {
    await applyImport(prisma, 'balances', 'sku,location,quantity\nPKG-1004,A-01,120', actor())

    expect(await onHand(wh.tapeId, wh.locationA)).toBe(120)

    const movement = await prisma.movement.findFirstOrThrow({ where: { itemId: wh.tapeId } })
    expect(movement.type).toBe('RECEIVE')
    expect(movement.docNo).toMatch(/^RCV-/)
    expect(movement.source).toBe('IMPORT')
    expect(movement.reference).toBe('Opening balance')
  })

  it('leaves the projection matching the ledger', async () => {
    // The whole reason not to write stock_levels directly.
    await applyImport(
      prisma,
      'balances',
      'sku,location,quantity\nPKG-1004,A-01,120\nPKG-1004,B-01,40',
      actor(),
    )

    expect(await findProjectionDrift(prisma)).toEqual([])
  })

  it('refuses a serial item given a bare quantity', async () => {
    // Stock with no units behind it: the next RFID count reports all of it
    // missing.
    const plan = await planImport(prisma, 'balances', 'sku,location,quantity\nTLS-0015,A-01,5')

    expect(plan.problems[0]?.message).toMatch(/serial-tracked/i)
    expect(plan.create).toBe(0)
  })

  it('requires a batch for a batch-tracked item', async () => {
    const plan = await planImport(prisma, 'balances', 'sku,location,quantity\nCHM-2001,A-01,5')

    expect(plan.problems[0]?.message).toMatch(/needs a batch/i)
  })

  it('accepts a batch that exists', async () => {
    await applyImport(
      prisma,
      'balances',
      'sku,location,quantity,batch\nCHM-2001,A-01,5,LOT-FRESH',
      actor(),
    )

    const level = await prisma.stockLevel.findFirstOrThrow({
      where: { itemId: wh.adhesiveId, batchId: wh.freshBatchId },
    })
    expect(level.quantity).toBe(5)
  })

  it('names a batch that does not exist', async () => {
    const plan = await planImport(
      prisma,
      'balances',
      'sku,location,quantity,batch\nCHM-2001,A-01,5,NO-SUCH-LOT',
    )

    expect(plan.problems[0]?.message).toMatch(/no batch "NO-SUCH-LOT"/i)
  })

  it('refuses an unknown item, and says to import items first', async () => {
    const plan = await planImport(prisma, 'balances', 'sku,location,quantity\nGHOST,A-01,5')

    expect(plan.problems[0]?.message).toMatch(/Import items first/)
  })

  it('refuses a quantity that is not a positive whole number', async () => {
    const plan = await planImport(
      prisma,
      'balances',
      'sku,location,quantity\nPKG-1004,A-01,-5\nPKG-1004,B-01,lots',
    )

    expect(plan.problems).toHaveLength(2)
  })
})

describe('applying', () => {
  it('skips the rows the dry run rejected and applies the rest', async () => {
    // One bad row must not abandon the others. An import that stops half way
    // leaves somebody working out which rows landed.
    const csv = 'sku,name\nGOOD-1,Fine\n,No SKU\nGOOD-2,Also fine'

    const outcome = await applyImport(prisma, 'items', csv, actor())

    expect(outcome.applied).toBe(2)
    expect(outcome.problems).toHaveLength(1)
    expect(outcome.failures).toEqual([])
  })

  it('re-validates rather than trusting an earlier dry run', async () => {
    // The dry run may have been minutes ago, and somebody else may have changed
    // something since.
    const csv = 'sku,location,quantity\nPKG-1004,A-01,10'
    await planImport(prisma, 'balances', csv)

    await prisma.location.update({ where: { id: wh.locationA }, data: { deletedAt: new Date() } })

    const outcome = await applyImport(prisma, 'balances', csv, actor())

    expect(outcome.applied).toBe(0)
    expect(outcome.problems[0]?.message).toMatch(/No location/)
  })
})

describe('importing locations', () => {
  it('creates them', async () => {
    const outcome = await applyImport(
      prisma,
      'locations',
      'code,name,zone\nC-01,Aisle C · Rack 01,STORAGE\nDSP-2,Second dispatch bay,OUTBOUND',
      actor(),
    )

    expect(outcome.applied).toBe(2)
    expect(await prisma.location.findFirst({ where: { code: 'DSP-2' } })).not.toBeNull()
  })

  it('upper-cases the code, so a-01 and A-01 are one bin', async () => {
    await applyImport(prisma, 'locations', 'code,name\na-01,Aisle A Rack 01', actor())

    const locations = await prisma.location.findMany({ where: { code: 'A-01' } })
    expect(locations).toHaveLength(1)
  })

  it('refuses an unknown zone, and lists the real ones', async () => {
    const plan = await planImport(prisma, 'locations', 'code,name,zone\nX-1,Somewhere,BASEMENT')

    expect(plan.problems[0]?.message).toMatch(/STORAGE/)
  })
})
